// Public endpoints: the quote request form, client sign-in, and Stripe's webhook.
import { all, first, activity } from "../lib/db.js";
import { fail, readJson, text, email as cleanEmail, siteUrl, esc, parse } from "../lib/http.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { alertStudio, sendEmail, business as studioBusiness } from "../lib/notify.js";
import { triageLead } from "../lib/ai.js";
import { createLoginToken, recentLoginTokens, redeemLoginToken, sessionCookie, endSession, clearCookie } from "../lib/auth.js";
import { verifySignature, handleEvent } from "../lib/stripe.js";
import { idOf } from "../router.js";

export function publicRoutes(r) {
  // ───────── Quote request ─────────
  r.post("/api/quote", async ({ request, env, waitUntil }) => {
    const b = await readJson(request, 40_000);
    // Bots: a hidden field people never see, and forms sent within 3 seconds of loading
    if (b.company_website || (Number(b.started) && Date.now() - Number(b.started) < 3000)) return { ok: true };
    const name = text(b.name, 120) ?? fail(400, "Please tell me your name");
    const email = cleanEmail(b.email) ?? fail(400, "Please enter a valid email address");
    const message = text(b.message, 5000);
    const business = text(b.business, 160);
    if (!message && !business) fail(400, "Tell me a little about your business or project");
    const check = await verifyTurnstile(env, request, b.turnstile);
    if (!check.ok) {
      await activity(env, null, "system", "spam_blocked", `Quote form from ${email}`);
      fail(check.status, check.error);
    }
    const pkg = text(b.package, 60);
    const validPkg = pkg ? await first(env, "SELECT slug FROM packages WHERE slug = ? AND active = 1", pkg) : null;
    const addonIds = Array.isArray(b.addons) ? b.addons.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 40) : [];
    const addons = addonIds.length ? await all(env, `SELECT id, name FROM addons WHERE active = 1 AND id IN (${addonIds.map(() => "?").join(",")})`, ...addonIds) : [];
    const lead = await first(
      env,
      `INSERT INTO leads (name, email, phone, business, website, package_slug, addons, care_plan, budget, timeline, location, message, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      name, email, text(b.phone, 40), business, text(b.website, 300), validPkg?.slug || null, JSON.stringify(addons.map((a) => a.id)),
      text(b.care_plan, 60), text(b.budget, 60), text(b.timeline, 120), text(b.location, 120), message, text(b.source, 200)
    );
    await activity(env, null, "system", "lead", `New inquiry #${lead.id} from ${name}`);
    const biz = await studioBusiness(env);
    waitUntil(
      (async () => {
        await alertStudio(env, `New inquiry from ${name.split(/\s+/)[0]}${validPkg ? ` (${validPkg.slug})` : ""}`, {
          title: "New quote request",
          path: `/admin/#/leads/${lead.id}`,
          email: {
            subject: `New quote request: ${name}${business ? `, ${business}` : ""}`,
            heading: `New quote request from ${name}`,
            paragraphs: [
              `${esc(email)}${b.phone ? ` · ${esc(b.phone)}` : ""}${business ? `<br>${esc(business)}` : ""}`,
              `Package: ${esc(validPkg?.slug || "not chosen")}${addons.length ? `<br>Add-ons: ${addons.map((a) => esc(a.name)).join(", ")}` : ""}`,
              message ? esc(message).replace(/\n/g, "<br>") : "",
            ].filter(Boolean),
          },
        });
        await sendEmail(env, {
          to: email,
          subject: `Thanks, ${name.split(/\s+/)[0]}: I've got your request`,
          heading: "Thanks for getting in touch",
          paragraphs: [
            "I'll read your request properly and reply within one business day with questions or a quote.",
            "Nothing is booked or charged until you've seen a written quote and accepted the agreement.",
          ],
          replyTo: env.EMAIL_REPLY_TO || biz.email,
        });
        await triageLead(env, { ...lead, addon_names: addons.map((a) => a.name) });
      })()
    );
    return { ok: true };
  });

  // ───────── Client sign-in (email link) ─────────
  r.post("/api/auth/login", async ({ request, env }) => {
    const b = await readJson(request, 2000);
    const email = cleanEmail(b.email) ?? fail(400, "Please enter a valid email address");
    const client = await first(env, "SELECT * FROM clients WHERE email = ?", email);
    // Same answer whether or not we know the address (no account fishing)
    const answer = { ok: true, message: "If that email has a project with me, a sign-in link is on its way. It works once, for 30 minutes." };
    if (!client || (await recentLoginTokens(env, client.id)) >= 5) return answer;
    const token = await createLoginToken(env, client.id, 30);
    await sendEmail(env, {
      to: client.email,
      subject: "Your sign-in link",
      heading: "Sign in to your project",
      paragraphs: ["Use this button to sign in. It works once and expires in 30 minutes. If you didn't ask for it, you can ignore this email."],
      button: { label: "Sign in", url: `${siteUrl(env)}/portal/signin#${token}` },
    });
    return answer;
  });

  r.post("/api/auth/verify", async ({ request, env }) => {
    const b = await readJson(request, 2000);
    const result = await redeemLoginToken(env, b.token);
    if (!result) fail(401, "That sign-in link has expired or was already used. Ask for a new one.");
    await activity(env, null, `client:${result.clientId}`, "signin", "Signed in");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": sessionCookie(result.session, request), "cache-control": "no-store" },
    });
  });

  r.post("/api/auth/logout", async ({ request, env }) => {
    await endSession(request, env);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": clearCookie() } });
  });

  // ───────── Stripe ─────────
  r.post("/api/stripe/webhook", async ({ request, env }) => {
    const payload = await request.text();
    if (!(await verifySignature(env, payload, request.headers.get("stripe-signature")))) fail(400, "Bad signature");
    const event = parse(payload, null) ?? fail(400, "Bad payload");
    const result = await handleEvent(env, event);
    return { received: true, result };
  });

  // Public portfolio images uploaded through the dashboard (only files marked public)
  r.get("/media/:id", async ({ env, params }) => {
    const f = await first(env, "SELECT * FROM files WHERE id = ? AND kind = 'public' AND deleted_at IS NULL", idOf(params.id));
    if (!f) fail(404, "Not found");
    const obj = await env.FILES.get(f.r2_key);
    if (!obj) fail(404, "Not found");
    return new Response(obj.body, { headers: { "content-type": f.content_type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  });

}
