// Service agreements. The studio keeps versioned templates (Admin → Content → Agreements). When a quote
// or care plan is offered, the template is filled in for that client and frozen: the client reads that
// exact text, and acceptance records the version, a SHA-256 of the text, the typed name, the time, IP
// and browser, and the consent sentence they ticked. Nothing is accepted automatically.
import { first, run, all, activity } from "./db.js";
import { sha256Hex, money, parse, esc } from "./http.js";
import { business } from "./notify.js";
import { advance, fmtDate } from "./workflow.js";

export const CONSENT_TEXT = "I have read this agreement in full, I am authorized to accept it for the business named, and I agree to its terms.";

export const latestTemplate = (env, slug) =>
  first(env, "SELECT * FROM agreement_templates WHERE slug = ? AND active = 1 ORDER BY version DESC LIMIT 1", slug);

function fill(body, values) {
  return body.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

const termText = (m) => (m === 0 ? "none (month to month)" : m ? `${m} months` : "as agreed in writing");

export async function renderAgreement(env, template, { project, client, invoices = [], sub }) {
  const biz = await business(env);
  const scope = project ? parse(project.scope, []) : [];
  const addons = project ? parse(project.addons, []) : [];
  const plan = sub?.plan_slug ? await first(env, "SELECT * FROM care_plans WHERE slug = ?", sub.plan_slug) : null;
  const values = {
    studio_name: biz.name,
    client_name: client.name,
    client_business: client.business ? `, for ${client.business}` : "",
    date: fmtDate(new Date().toISOString().slice(0, 10)),
    project_title: project?.title || "",
    scope: [...scope, ...addons.map((a) => `${a.name}${a.price_cents != null ? ` (${money(a.price_cents)})` : ""}`)].map((s) => `- ${typeof s === "string" ? s : s.name}`).join("\n") || "- As described in the quote",
    price: project ? money(project.price_cents) : "",
    payment_schedule:
      invoices
        .filter((i) => i.status !== "void")
        .map((i) => `- ${i.label}: ${money(i.amount_cents)}, due ${i.due_trigger === "start" ? "before the build begins" : i.due_trigger === "launch" ? "when the final website is approved, before launch" : i.due_date ? fmtDate(i.due_date) : "on receipt"}`)
        .join("\n") || "- As set out in the quote",
    turnaround: project?.turnaround_days ? `${project.turnaround_days} business days` : "the timeline in the quote",
    revision_rounds: project?.revision_rounds ?? 1,
    support_days: project?.support_days ?? 7,
    feedback_days: project?.feedback_days ?? 2,
    plan_name: sub?.name || "",
    monthly: sub ? money(sub.monthly_cents) : "",
    term: sub ? termText(sub.term_months) : "",
    plan_features: plan ? parse(plan.features, []).join("; ") : "as described in the plan",
  };
  return fill(template.body, values);
}

/** Freeze a template for this project or subscription. Any earlier pending copy is voided. */
export async function issueAgreement(env, { slug, project, client, sub }) {
  const template = await latestTemplate(env, slug);
  if (!template) throw Object.assign(new Error(`No active “${slug}” agreement template`), { status: 409 });
  const invoices = project ? await all(env, "SELECT * FROM invoices WHERE project_id = ? AND status != 'void' ORDER BY id", project.id) : [];
  const body = await renderAgreement(env, template, { project, client, invoices, sub });
  if (project && !sub) await run(env, "UPDATE agreements SET status = 'void' WHERE project_id = ? AND subscription_id IS NULL AND status = 'pending'", project.id);
  if (sub) await run(env, "UPDATE agreements SET status = 'void' WHERE subscription_id = ? AND status = 'pending'", sub.id);
  const row = await first(
    env,
    "INSERT INTO agreements (project_id, client_id, subscription_id, template_id, template_slug, version, title, body, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    project?.id ?? sub?.project_id ?? null, client.id, sub?.id ?? null, template.id, slug, template.version, template.title, body, await sha256Hex(body)
  );
  return row.id;
}

/** The client accepts. Requires the consent box, their typed name, and the text unchanged since issue. */
export async function acceptAgreement(env, id, client, { name, consent, hash, ip, ua }) {
  const a = await first(env, "SELECT * FROM agreements WHERE id = ? AND client_id = ?", id, client.id);
  if (!a) throw Object.assign(new Error("Agreement not found"), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(a.status === "accepted" ? "This agreement is already accepted" : "This agreement was replaced by a newer version"), { status: 409 });
  if (consent !== true) throw Object.assign(new Error("Please tick the box to confirm you agree"), { status: 400 });
  const typed = String(name || "").trim();
  if (typed.length < 2) throw Object.assign(new Error("Please type your full name"), { status: 400 });
  if (hash && hash !== a.body_hash) throw Object.assign(new Error("The agreement changed while you were reading it. Please review it again."), { status: 409 });
  if ((await sha256Hex(a.body)) !== a.body_hash) throw Object.assign(new Error("This agreement can't be accepted. Please contact the studio."), { status: 409 });
  const r = await run(
    env,
    "UPDATE agreements SET status = 'accepted', accepted_at = datetime('now'), accepted_name = ?, accepted_email = ?, accepted_ip = ?, accepted_ua = ?, consent_text = ? WHERE id = ? AND status = 'pending'",
    typed.slice(0, 120), client.email, ip || null, String(ua || "").slice(0, 300), CONSENT_TEXT, id
  );
  if (!r.meta?.changes) throw Object.assign(new Error("This agreement is already accepted"), { status: 409 });
  await activity(env, a.project_id, `client:${client.id}`, "agreement", `Accepted “${a.title}” v${a.version} (signed “${typed}”, text ${a.body_hash.slice(0, 12)}…)`);
  if (a.project_id && !a.subscription_id) await advance(env, a.project_id, `client:${client.id}`);
  return true;
}

/** A printable, downloadable copy with the acceptance record. */
export function agreementDocument(a, biz) {
  const body = esc(a.body)
    .split(/\n{2,}/)
    .map((block) => {
      if (block.startsWith("# ")) return `<h1>${block.slice(2)}</h1>`;
      if (block.startsWith("## ")) return `<h2>${block.slice(3)}</h2>`;
      if (/^- /m.test(block)) return `<ul>${block.split("\n").map((l) => (l.startsWith("- ") ? `<li>${l.slice(2)}</li>` : l ? `<p>${l}</p>` : "")).join("")}</ul>`;
      return `<p>${block.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  const record =
    a.status === "accepted"
      ? `<p><strong>Accepted</strong> by ${esc(a.accepted_name)} (${esc(a.accepted_email)}) on ${esc(a.accepted_at)} UTC from ${esc(a.accepted_ip || "unknown IP")}.<br>Consent: “${esc(a.consent_text)}”<br>Template: ${esc(a.template_slug)} v${a.version}. Text fingerprint (SHA-256): <code>${esc(a.body_hash)}</code></p>`
      : `<p><strong>Not yet accepted.</strong> Template ${esc(a.template_slug)} v${a.version}. Fingerprint <code>${esc(a.body_hash)}</code></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(a.title)} · ${esc(biz.name)}</title>
<style>body{font:16px/1.6 Georgia,serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#191813;background:#fff}h1{font-size:1.7rem}h2{font-size:1.15rem;margin-top:1.6rem}.rec{border-top:1px solid #ccc;margin-top:2rem;padding-top:1rem;font:14px/1.5 system-ui,sans-serif}code{word-break:break-all}@media print{.noprint{display:none}}</style></head>
<body><p class="noprint"><button onclick="print()">Print or save as PDF</button></p>${body}<div class="rec">${record}</div></body></html>`;
}
