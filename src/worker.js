// Fiveday Studio: Cloudflare Worker entry.
//  /api/admin/*   the studio's API       → verified Cloudflare Access login (ADMIN_EMAILS)
//  /api/portal/*  the client portal API  → signed-in client (email link + session cookie)
//  /admin/*       the dashboard page     → same admin login
//  /portal/*      the client portal page (static; it signs in through the API)
//  everything else: public pages rendered from the database, or static files from /public
import { ensureSchema } from "./lib/db.js";
import { json } from "./lib/http.js";
import { adminEmail, currentClient } from "./lib/auth.js";
import { makeRouter } from "./router.js";
import { publicRoutes } from "./api/public.js";
import { portalRoutes } from "./api/portal.js";
import { adminRoutes } from "./api/admin.js";
import { runDaily, runHourly } from "./lib/automation.js";
import * as pages from "./pages/public.js";

const router = makeRouter();
publicRoutes(router);
portalRoutes(router);
adminRoutes(router);

const PAGES = {
  "/": pages.homePage,
  "/pricing": pages.pricingPage,
  "/work": pages.workPage,
  "/process": pages.processPage,
  "/about": pages.aboutPage,
  "/faq": pages.faqPage,
  "/quote": pages.quotePage,
  "/web-design-northern-virginia": pages.localPage,
  "/privacy": pages.privacyPage,
};

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'self'; frame-ancestors 'none'";

const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": CSP, ...SECURITY, ...extra } });

function withSecurity(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY)) if (!h.has(k)) h.set(k, v);
  if ((h.get("content-type") || "").includes("text/html") && !h.has("content-security-policy")) h.set("content-security-policy", CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(ensureSchema(env).then(() => (event.cron === "5 * * * *" ? runHourly(env) : runDaily(env))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    const waitUntil = (p) => ctx.waitUntil(p);

    // One address per page: /pricing/ → /pricing
    if (path.length > 1 && path.endsWith("/") && !path.startsWith("/admin/") && !path.startsWith("/portal/") && !path.startsWith("/api/")) {
      return Response.redirect(url.origin + path.replace(/\/+$/, "") + url.search, 301);
    }

    const isAdmin = path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/admin/");
    const isPortalApi = path.startsWith("/api/portal/");

    // Changes to the dashboard or a client's project must come from this site itself (on top of the logins)
    if ((isAdmin || isPortalApi || path.startsWith("/api/auth/")) && !["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Not allowed from another website" }, 403);
    }

    if (!env.DB) return path.startsWith("/api/") ? json({ error: "The database isn't connected yet" }, 503) : env.ASSETS.fetch(request);
    await ensureSchema(env);

    let admin = null;
    if (isAdmin) {
      admin = await adminEmail(request, env);
      if (!admin) {
        const unset = !String(env.ADMIN_EMAILS || "").trim();
        const why = unset ? "The dashboard is locked because ADMIN_EMAILS isn't set (see README)." : "This area is for the studio only.";
        return path.startsWith("/api/") ? json({ error: unset ? why : "Not authorized" }, 401) : new Response(why, { status: 401, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY } });
      }
    }

    if (path.startsWith("/api/") || path.startsWith("/media/")) {
      let client = null;
      if (isPortalApi) {
        client = await currentClient(request, env);
        if (!client) return json({ error: "Please sign in" }, 401);
      }
      const res = await router.handle({ request, env, url, admin, client, waitUntil }, path);
      return res ? withSecurity(res) : json({ error: "Not found" }, 404);
    }

    // Robots, sitemap and public pages (rendered from the database)
    if (path === "/robots.txt") return new Response(pages.robots(env), { headers: { "content-type": "text/plain" } });
    if (path === "/sitemap.xml") return new Response(await pages.sitemap(env), { headers: { "content-type": "application/xml" } });
    if (["GET", "HEAD"].includes(request.method)) {
      if (PAGES[path]) return html(await PAGES[path](env));
      const work = path.match(/^\/work\/([a-z0-9-]{1,60})$/);
      if (work) {
        const out = await pages.casePage(env, work[1]);
        if (out) return html(out);
        return html(await pages.notFoundPage(env), 404);
      }
    }

    // Static files: the portal and dashboard apps, CSS, JS and images
    if (path === "/admin") return Response.redirect(url.origin + "/admin/", 302);
    if (path === "/portal") return Response.redirect(url.origin + "/portal/", 302);
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && !/\.\w+$/.test(path)) return html(await pages.notFoundPage(env), 404);
    const out = withSecurity(res);
    if (/^\/(css|js)\//.test(path)) out.headers.set("cache-control", "public, max-age=300, stale-while-revalidate=86400");
    if (path.startsWith("/img/")) out.headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
    if (path.startsWith("/admin/") || path.startsWith("/portal/")) {
      out.headers.set("cache-control", "no-store");
      out.headers.set("x-robots-tag", "noindex");
    }
    return out;
  },
};
