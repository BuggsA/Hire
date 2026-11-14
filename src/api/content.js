// Admin → Content: edit packages, add-ons, care plans, portfolio, testimonials, FAQs and agreement
// templates. One small generic editor, with a whitelist of fields per table.
import { all, first, run, activity } from "../lib/db.js";
import { fail, readJson, text, cents, int } from "../lib/http.js";
import { saveFile } from "../lib/files.js";
import { idOf } from "../router.js";

const str = (max) => (v) => text(v, max);
const money = (v) => cents(v);
const bool = (v) => (v ? 1 : 0);
const num = (min, max) => (v) => int(v, { min, max });
const list = (v) => JSON.stringify((Array.isArray(v) ? v : String(v ?? "").split("\n")).map((s) => text(s, 400)).filter(Boolean).slice(0, 60));
const slug = (v) => {
  const s = String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return s || fail(400, "A short web address name (slug) is required");
};

export const TABLES = {
  packages: { slug, name: str(80), tagline: str(240), price_cents: money, price_prefix: str(20), turnaround_days: num(1, 365), turnaround_text: str(80), support_days: num(0, 365), revision_rounds: num(0, 20), deposit_percent: num(0, 100), fast_track: bool, features: list, featured: bool, sort: num(0, 999), active: bool },
  addons: { category: str(60), name: str(120), description: str(400), price_cents: money, price_prefix: str(20), unit: str(30), extends_timeline: bool, sort: num(0, 999), active: bool },
  care_plans: { slug, name: str(80), kind: (v) => (v === "waas" ? "waas" : "care"), monthly_cents: money, term_months: num(0, 60), description: str(600), features: list, sort: num(0, 999), active: bool },
  portfolio: { slug, title: str(120), url: str(300), kind: str(160), summary: str(600), story: str(6000), built: list, stack: list, image: str(300), image_mobile: str(300), status: (v) => (v === "preview" ? "preview" : "live"), permission: bool, published: bool, featured: bool, sort: num(0, 999) },
  testimonials: { quote: str(1200), name: str(120), role: str(160), published: bool, sort: num(0, 999) },
  faqs: { question: str(300), answer: str(3000), page: (v) => (["faq", "pricing", "home"].includes(v) ? v : "faq"), sort: num(0, 999), published: bool },
};
const JSON_COLS = new Set(["features", "built", "stack"]);
const REQUIRED = { packages: ["slug", "name"], addons: ["category", "name"], care_plans: ["slug", "name"], portfolio: ["slug", "title"], testimonials: ["quote", "name"], faqs: ["question", "answer"] };

const tableOf = (t) => (TABLES[t] ? t : fail(404, "Unknown content type"));
const decode = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, JSON_COLS.has(k) ? JSON.parse(v || "[]") : v]));

function clean(table, body, partial) {
  const out = {};
  for (const [k, f] of Object.entries(TABLES[table])) if (body[k] !== undefined) out[k] = f(body[k]);
  if (!partial) for (const k of REQUIRED[table]) if (out[k] === null || out[k] === undefined || out[k] === "") fail(400, `${k} is required`);
  // Client work is only published with the client's permission
  if (table === "portfolio" && out.published && body.permission !== undefined && !out.permission) fail(400, "Tick “client gave permission” before publishing someone else's project");
  return out;
}

export function contentRoutes(r) {
  r.get("/api/admin/content/:table", async ({ env, params }) => {
    const t = tableOf(params.table);
    return { rows: (await all(env, `SELECT * FROM ${t} ORDER BY ${t === "addons" ? "category, sort" : "sort"}, id`)).map(decode) };
  });

  r.post("/api/admin/content/:table", async ({ request, env, params }) => {
    const t = tableOf(params.table);
    const v = clean(t, await readJson(request, 60_000), false);
    const cols = Object.keys(v);
    try {
      const row = await first(env, `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING *`, ...Object.values(v));
      await activity(env, null, "studio", "content", `Added to ${t}: ${v.name || v.title || v.question || v.quote?.slice(0, 40)}`);
      return { row: decode(row) };
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) fail(409, "That slug is already used");
      throw e;
    }
  });

  r.patch("/api/admin/content/:table/:id", async ({ request, env, params }) => {
    const t = tableOf(params.table);
    const id = idOf(params.id);
    const body = await readJson(request, 60_000);
    const v = clean(t, body, true);
    if (t === "portfolio" && v.published) {
      const cur = await first(env, "SELECT permission FROM portfolio WHERE id = ?", id);
      if (!(v.permission ?? cur?.permission)) fail(400, "Tick “client gave permission” before publishing someone else's project");
    }
    const cols = Object.keys(v);
    if (!cols.length) return { ok: true };
    const row = await first(env, `UPDATE ${t} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? RETURNING *`, ...Object.values(v), id);
    if (!row) fail(404, "Not found");
    await activity(env, null, "studio", "content", `Edited ${t} #${id}: ${cols.join(", ")}`);
    return { row: decode(row) };
  });

  r.delete("/api/admin/content/:table/:id", async ({ env, params }) => {
    const t = tableOf(params.table);
    await run(env, `DELETE FROM ${t} WHERE id = ?`, idOf(params.id));
    await activity(env, null, "studio", "content", `Deleted ${t} #${params.id}`);
    return { ok: true };
  });

  // Images for portfolio entries (stored in R2, served publicly at /media/<id>)
  r.post("/api/admin/media", async ({ request, env }) => {
    const type = String(request.headers.get("content-type") || "");
    if (!/^image\/(jpeg|png|webp|avif)/.test(type)) fail(415, "Upload a JPEG, PNG, WebP or AVIF image");
    const f = await saveFile(env, request, { kind: "public", by: "studio", actor: "studio" });
    return { url: `/media/${f.id}` };
  });

  // ───────── Agreement templates (versioned) ─────────
  r.get("/api/admin/agreement-templates", async ({ env }) => ({
    templates: await all(env, "SELECT t.*, (SELECT COUNT(*) FROM agreements a WHERE a.template_id = t.id AND a.status = 'accepted') AS accepted_count FROM agreement_templates t ORDER BY slug, version DESC"),
  }));

  /** Save edits as a NEW version (accepted agreements keep the exact text their client saw). */
  r.post("/api/admin/agreement-templates", async ({ request, env }) => {
    const b = await readJson(request, 100_000);
    const s = ["project", "care", "waas"].includes(b.slug) ? b.slug : fail(400, "Template type must be project, care or waas");
    const body = text(b.body, 60_000) ?? fail(400, "The agreement text is required");
    const latest = await first(env, "SELECT MAX(version) AS v FROM agreement_templates WHERE slug = ?", s);
    const version = (latest?.v || 0) + 1;
    await run(env, "UPDATE agreement_templates SET active = 0 WHERE slug = ?", s);
    await run(env, "INSERT INTO agreement_templates (slug, version, title, body, attorney_approved, active) VALUES (?, ?, ?, ?, ?, 1)", s, version, text(b.title, 160) || "Agreement", body, b.attorney_approved ? 1 : 0);
    await activity(env, null, "studio", "agreement_template", `${s} template v${version} saved${b.attorney_approved ? " (marked attorney-approved)" : ""}`);
    return { ok: true, version };
  });
}
