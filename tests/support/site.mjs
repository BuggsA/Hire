// Test helper: the real Worker (src/worker.js) running in Node against a throwaway local D1 database and
// R2 bucket (Wrangler's getPlatformProxy; nothing is saved). Admin logins are real Cloudflare Access tokens
// signed with a test key; clients sign in through the real email-link flow. Everything that would leave
// the Worker (email, phone alerts, Turnstile, Stripe, Anthropic) goes to fakes that record what was sent.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import worker from "../../src/worker.js";
import { resetSchemaCache } from "../../src/lib/db.js";

export const ADMIN = "studio@example.com";
export const HOST = "https://fiveday.studio";
const TEAM = "test-team.cloudflareaccess.com";
const AUD = "test-admin-aud";
export const WEBHOOK_SECRET = "whsec_test_secret";

// ───────── Access tokens ─────────
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test-kid", alg: "RS256" };
const b64url = (b) => Buffer.from(b).toString("base64url");
export async function accessToken(email, { aud = AUD, exp = Math.floor(Date.now() / 1000) + 3600, kid = "test-kid", signWith = keys.privateKey } = {}) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = b64url(JSON.stringify({ email, aud: [aud], exp, iat: Math.floor(Date.now() / 1000) }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signWith, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
export const otherKey = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign", "verify"]).then((k) => k.privateKey);

// ───────── Fakes for the outside world ─────────
const realFetch = globalThis.fetch;
export const outside = { emails: [], alerts: [], stripe: [], anthropic: [], stripeSessions: 0, anthropicReply: null };
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return realFetch(input, init);
  const body = req ? await req.clone().text() : init.body;
  if (url.hostname === TEAM) return Response.json({ keys: [publicJwk] });
  if (url.hostname === "api.resend.com") {
    outside.emails.push(JSON.parse(body));
    return Response.json({ id: `email-${outside.emails.length}` });
  }
  if (url.hostname === "ntfy.sh") {
    outside.alerts.push(String(body));
    return new Response("ok");
  }
  if (url.hostname === "challenges.cloudflare.com") {
    const token = new URLSearchParams(String(body)).get("response");
    return Response.json({ success: token === "human", action: "quote", hostname: "fiveday.studio" });
  }
  if (url.hostname === "api.stripe.com") {
    const params = new URLSearchParams(String(body || ""));
    outside.stripe.push({ path: url.pathname, params: Object.fromEntries(params), headers: init.headers });
    if (url.pathname === "/v1/customers") return Response.json({ id: `cus_${outside.stripe.length}` });
    if (url.pathname === "/v1/checkout/sessions") {
      const n = ++outside.stripeSessions;
      return Response.json({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}` });
    }
    if (url.pathname.startsWith("/v1/subscriptions/")) return Response.json({ id: url.pathname.split("/").pop(), cancel_at_period_end: true });
    return Response.json({ error: { message: "unexpected" } }, { status: 400 });
  }
  if (url.hostname === "api.anthropic.com") {
    outside.anthropic.push(JSON.parse(body));
    const reply = outside.anthropicReply || { summary: "A bakery wants a simple site.", suggested_package: "starter", complexity: "standard", fits_one_week: true, missing_information: ["Photos"], questions_to_ask: ["Do you have a logo?"], flags: [] };
    return Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 10, output_tokens: 10 } });
  }
  throw new Error(`The test tried to reach ${url.href}`);
};

// ───────── Static files, served like Cloudflare does ─────────
const PUBLIC = new URL("../../public/", import.meta.url);
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp", ico: "image/x-icon", xml: "application/xml", txt: "text/plain", json: "application/json" };
async function serveStatic(request) {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.includes("..")) return new Response("Bad path", { status: 400 });
  const tries = path.endsWith("/") ? [`${path}index.html`] : [path, `${path}.html`, `${path}/index.html`];
  for (const t of tries) {
    try {
      const body = await readFile(new URL("." + t, PUBLIC));
      return new Response(body, { headers: { "content-type": TYPES[t.split(".").pop()] || "application/octet-stream" } });
    } catch {}
  }
  return new Response("Not found", { status: 404 });
}

/** Sign a webhook payload the way Stripe does. */
export async function stripeSignature(payload, { secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`))).toString("hex");
  return `t=${t},v1=${sig}`;
}

export async function startSite(vars = {}) {
  const proxy = await getPlatformProxy({ configPath: new URL("../../wrangler.toml", import.meta.url).pathname, persist: false });
  const env = {
    DB: proxy.env.DB,
    FILES: proxy.env.FILES,
    ASSETS: { fetch: serveStatic },
    SITE_URL: HOST,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ADMIN_EMAILS: ADMIN,
    RESEND_API_KEY: "re_test",
    NTFY_TOPIC: "test-topic-0123456789abcdef",
    TURNSTILE_SECRET: "ts-secret",
    TURNSTILE_SITE_KEY: "ts-site",
    TURNSTILE_HOSTNAMES: "fiveday.studio",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...vars,
  };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete env[k];
  const setVars = (v) => {
    for (const [k, val] of Object.entries(v)) if (val === undefined) delete env[k];
    else env[k] = val;
  };

  /** One request. as: "admin" | { cookie } | nothing. Waits for background work. */
  async function call(method, path, { as, body, headers = {}, host = HOST, token, raw } = {}) {
    const h = new Headers(headers);
    if (as === "admin" || token) h.set("cf-access-jwt-assertion", token || (await accessToken(ADMIN)));
    else if (as?.cookie) h.set("cookie", as.cookie);
    if (!["GET", "HEAD"].includes(method) && !h.has("origin")) h.set("origin", host);
    let payload = body;
    if (body !== undefined && !(body instanceof Uint8Array) && typeof body !== "string" && !raw) {
      payload = JSON.stringify(body);
      h.set("content-type", "application/json");
    }
    const pending = [];
    const res = await worker.fetch(new Request(host + path, { method, headers: h, body: payload, redirect: "manual" }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.allSettled(pending);
    const type = res.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await res.json() : type.startsWith("text/") || type.includes("xml") ? await res.text() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }

  const db = {
    all: async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results,
    first: (sql, ...a) => env.DB.prepare(sql).bind(...a).first(),
    run: (sql, ...a) => env.DB.prepare(sql).bind(...a).run(),
  };

  /** Sign a client in through the real email-link flow. Returns { cookie }. */
  async function signIn(email) {
    const before = outside.emails.length;
    const r = await call("POST", "/api/auth/login", { body: { email } });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    const mail = outside.emails.slice(before).find((m) => m.to[0] === email && /sign-in/i.test(m.subject));
    if (!mail) throw new Error(`no sign-in email for ${email}`);
    const token = mail.text.match(/#([0-9a-f]{64})/)[1];
    const v = await call("POST", "/api/auth/verify", { body: { token } });
    if (v.status !== 200) throw new Error(`verify failed ${v.status}`);
    return { cookie: v.headers.get("set-cookie").split(";")[0] };
  }

  const TABLES = ["settings", "packages", "addons", "care_plans", "portfolio", "testimonials", "faqs", "agreement_templates", "agreements", "leads", "clients", "login_tokens", "sessions", "projects", "project_holds", "milestones", "onboarding_items", "files", "messages", "reviews", "invoices", "payments", "subscriptions", "stripe_events", "activity", "sent_log", "event_log"];

  return {
    env, call, db, signIn, setVars, outside,
    async cron(expression = "30 13 * * *") {
      const pending = [];
      await worker.scheduled({ cron: expression, scheduledTime: Date.now() }, env, { waitUntil: (p) => pending.push(p) });
      for (const r of await Promise.allSettled(pending)) if (r.status === "rejected") throw r.reason;
    },
    async reset() {
      await call("GET", "/robots.txt");
      await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
      resetSchemaCache();
      await call("GET", "/robots.txt"); // re-seeds the catalog
      const listed = await env.FILES.list();
      if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
      for (const k of ["emails", "alerts", "stripe", "anthropic"]) outside[k].length = 0;
      outside.anthropicReply = null;
    },
    async serve() {
      const pending = [];
      const server = createServer(async (req, res) => {
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
          const login = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(headers.get("cookie") || "");
          if (login) headers.set("cf-access-jwt-assertion", login[1]);
          const request = new Request(`http://localhost:${server.address().port}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: "manual" });
          const out = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
          const h = {};
          out.headers.forEach((v, k) => (h[k] = k === "set-cookie" ? out.headers.getSetCookie() : v));
          res.writeHead(out.status, h);
          res.end(Buffer.from(await out.arrayBuffer()));
        } catch (e) {
          res.writeHead(500);
          res.end(String(e.stack || e));
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return { url: `http://localhost:${server.address().port}`, settle: async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); }, close: () => new Promise((r) => server.close(r)) };
    },
    stop: () => proxy.dispose(),
  };
}
