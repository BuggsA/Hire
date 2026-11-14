// The client portal API. Every route needs a signed-in client (checked in worker.js), and every
// lookup is scoped to that client: another client's project, file or invoice answers 404, the same as
// one that doesn't exist. Clients can save, submit and ask for exceptions; only the studio approves.
import { all, first, run, activity } from "../lib/db.js";
import { fail, readJson, text, parse } from "../lib/http.js";
import { loadProject, projectState, answerReview, STATUSES } from "../lib/workflow.js";
import { saveFile, serveFile, removeFile } from "../lib/files.js";
import { acceptAgreement, agreementDocument, CONSENT_TEXT } from "../lib/agreements.js";
import { invoiceCheckout, subscriptionCheckout, stripeReady } from "../lib/stripe.js";
import { alertStudio, business } from "../lib/notify.js";
import { idOf } from "../router.js";

async function ownProject(env, client, id) {
  const bundle = await loadProject(env, idOf(id));
  if (!bundle || bundle.project.client_id !== client.id || bundle.project.status === "cancelled") fail(404, "Project not found");
  return bundle;
}

/** What a client may see of an onboarding item (everything except nothing private: items have no private fields). */
const itemView = (i, files) => ({
  id: i.id, key: i.key, section: i.section, label: i.label, help: i.help, fields: parse(i.fields, []), allow_files: !!i.allow_files,
  required: !!i.required, value: parse(i.value, {}), status: i.status, admin_note: i.admin_note,
  exception_requested: !!i.exception_requested, exception_reason: i.exception_reason, submitted_at: i.submitted_at,
  files: files.filter((f) => f.item_id === i.id),
});

const fileView = (f) => ({ id: f.id, name: f.name, content_type: f.content_type, size: f.size, kind: f.kind, uploaded_by: f.uploaded_by, item_id: f.item_id, created_at: f.created_at });

export function portalRoutes(r) {
  r.get("/api/portal/me", async ({ env, client }) => {
    const projects = await all(env, "SELECT id, title, status, due_date, start_date, updated_at FROM projects WHERE client_id = ? AND status != 'cancelled' ORDER BY id DESC", client.id);
    return {
      client: { name: client.name, email: client.email, business: client.business },
      projects: projects.map((p) => ({ ...p, statusLabel: STATUSES[p.status]?.client })),
      business: await business(env),
    };
  });

  r.get("/api/portal/projects/:id", async ({ env, client, params }) => {
    const bundle = await ownProject(env, client, params.id);
    const p = bundle.project;
    const [files, messages, milestones, payments, subscriptions, agreements] = await Promise.all([
      all(env, "SELECT * FROM files WHERE project_id = ? AND deleted_at IS NULL AND visible_to_client = 1 ORDER BY id DESC", p.id),
      all(env, "SELECT id, sender, body, created_at, read_at FROM messages WHERE project_id = ? ORDER BY id", p.id),
      all(env, "SELECT * FROM milestones WHERE project_id = ? ORDER BY sort, id", p.id),
      all(env, "SELECT amount_cents, method, paid_at, invoice_id, subscription_id FROM payments WHERE client_id = ? AND (invoice_id IN (SELECT id FROM invoices WHERE project_id = ?) OR subscription_id IN (SELECT id FROM subscriptions WHERE project_id = ?)) ORDER BY paid_at DESC", client.id, p.id, p.id),
      all(env, "SELECT id, name, monthly_cents, term_months, status, started_at, commitment_ends, plan_slug FROM subscriptions WHERE client_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY id DESC", client.id, p.id),
      all(env, "SELECT id, template_slug, version, title, body, body_hash, status, accepted_at, accepted_name, subscription_id FROM agreements WHERE client_id = ? AND (project_id = ? OR project_id IS NULL) AND status != 'void' ORDER BY id", client.id, p.id),
    ]);
    // Opening the project marks studio messages read
    await run(env, "UPDATE messages SET read_at = datetime('now') WHERE project_id = ? AND sender != 'client' AND read_at IS NULL", p.id);
    const state = await projectState(env, bundle);
    return {
      project: {
        id: p.id, title: p.title, status: p.status, package_slug: p.package_slug, scope: parse(p.scope, []), addons: parse(p.addons, []),
        price_cents: p.price_cents, turnaround_days: p.turnaround_days, fast_track: !!p.fast_track, feedback_days: p.feedback_days,
        revision_rounds: p.revision_rounds, revisions_used: p.revisions_used, support_days: p.support_days, start_date: p.start_date,
        due_date: p.due_date, preview_url: p.preview_url, live_url: p.live_url, launched_at: p.launched_at, completed_at: p.completed_at,
        pause_reason: p.pause_reason, quote_expires: p.quote_expires,
      },
      state,
      items: bundle.items.map((i) => itemView(i, files)),
      files: files.map(fileView),
      messages,
      milestones,
      reviews: bundle.reviews.filter((x) => x.status !== "superseded"),
      invoices: bundle.invoices.filter((i) => i.status !== "draft").map((i) => ({ id: i.id, number: i.number, label: i.label, kind: i.kind, amount_cents: i.amount_cents, due_date: i.due_date, due_trigger: i.due_trigger, status: i.status, paid_at: i.paid_at, required_for_start: !!i.required_for_start })),
      upcoming: bundle.invoices.filter((i) => i.status === "draft").map((i) => ({ label: i.label, amount_cents: i.amount_cents, due_trigger: i.due_trigger })),
      payments,
      subscriptions,
      agreements,
      consentText: CONSENT_TEXT,
      payOnline: stripeReady(env),
    };
  });

  // ───────── Onboarding ─────────
  async function ownItem(env, client, projectId, itemId) {
    const bundle = await ownProject(env, client, projectId);
    const item = bundle.items.find((i) => i.id === idOf(itemId)) ?? fail(404, "Item not found");
    if (["quote", "completed"].includes(bundle.project.status)) fail(409, bundle.project.status === "quote" ? "Onboarding opens once the agreement is accepted and the deposit is paid" : "This project is complete");
    return { bundle, item };
  }

  r.put("/api/portal/projects/:id/items/:item", async ({ request, env, client, params }) => {
    const { bundle, item } = await ownItem(env, client, params.id, params.item);
    if (item.status === "approved" || item.status === "exception_approved") fail(409, "This item is already approved. Send a message if something needs to change.");
    const b = await readJson(request, 60_000);
    const fields = parse(item.fields, []);
    const value = {};
    for (const f of fields) {
      const v = b.value?.[f.name];
      value[f.name] = text(v, f.type === "textarea" ? 8000 : 500) || "";
    }
    if (b.submit) {
      const blank = fields.filter((f) => f.required && !value[f.name]);
      const files = await first(env, "SELECT COUNT(*) AS n FROM files WHERE item_id = ? AND deleted_at IS NULL", item.id);
      if (blank.length) fail(400, `Please fill in: ${blank.map((f) => f.label).join(", ")}`);
      if (item.allow_files && !fields.some((f) => value[f.name]) && !files.n) fail(400, "Please add at least one file or a note");
      await run(env, "UPDATE onboarding_items SET value = ?, status = 'submitted', submitted_at = datetime('now'), exception_requested = 0, exception_reason = NULL WHERE id = ?", JSON.stringify(value), item.id);
      await activity(env, bundle.project.id, `client:${client.id}`, "submitted", item.label);
      const left = await first(env, "SELECT COUNT(*) AS n FROM onboarding_items WHERE project_id = ? AND required = 1 AND status IN ('not_started','needs_changes') AND exception_requested = 0", bundle.project.id);
      if (!left.n) await alertStudio(env, `Project #${bundle.project.id}: onboarding complete, ready for your review`, { title: "Onboarding complete", path: `/admin/#/project/${bundle.project.id}/onboarding` });
      return { ok: true, status: "submitted" };
    }
    // Saving a draft never changes the status (an item that needs changes stays that way until submitted)
    await run(env, "UPDATE onboarding_items SET value = ? WHERE id = ?", JSON.stringify(value), item.id);
    return { ok: true, status: item.status };
  });

  r.post("/api/portal/projects/:id/items/:item/exception", async ({ request, env, client, params }) => {
    const { bundle, item } = await ownItem(env, client, params.id, params.item);
    if (item.status === "approved" || item.status === "exception_approved") fail(409, "This item is already approved");
    const b = await readJson(request, 10_000);
    const reason = text(b.reason, 2000) ?? fail(400, "Please explain why this isn't available");
    await run(env, "UPDATE onboarding_items SET exception_requested = 1, exception_reason = ?, status = CASE WHEN status = 'needs_changes' THEN 'not_started' ELSE status END WHERE id = ?", reason, item.id);
    await activity(env, bundle.project.id, `client:${client.id}`, "exception_requested", `${item.label}: ${reason}`);
    await alertStudio(env, `Project #${bundle.project.id}: exception requested`, { title: "Exception requested", path: `/admin/#/project/${bundle.project.id}/onboarding` });
    return { ok: true };
  });

  r.post("/api/portal/projects/:id/items/:item/files", async ({ request, env, client, params }) => {
    const { bundle, item } = await ownItem(env, client, params.id, params.item);
    if (!item.allow_files) fail(400, "This item doesn't take files");
    if (item.status === "approved" || item.status === "exception_approved") fail(409, "This item is already approved");
    const f = await saveFile(env, request, { project_id: bundle.project.id, item_id: item.id, kind: "onboarding", by: "client", actor: `client:${client.id}` });
    return { ok: true, file: fileView(f) };
  });

  // General project files from the client (anything not tied to a checklist item)
  r.post("/api/portal/projects/:id/files", async ({ request, env, client, params }) => {
    const bundle = await ownProject(env, client, params.id);
    if (bundle.project.status === "quote") fail(409, "Uploads open once the project is confirmed");
    const f = await saveFile(env, request, { project_id: bundle.project.id, kind: "onboarding", by: "client", actor: `client:${client.id}` });
    return { ok: true, file: fileView(f) };
  });

  async function ownFile(env, client, id) {
    const f = await first(
      env,
      "SELECT f.* FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ? AND p.client_id = ? AND f.deleted_at IS NULL AND f.visible_to_client = 1",
      idOf(id), client.id
    );
    return f ?? fail(404, "File not found");
  }

  r.get("/api/portal/files/:id", async ({ env, client, params, url }) => serveFile(env, await ownFile(env, client, params.id), { download: url.searchParams.has("download") }));

  r.delete("/api/portal/files/:id", async ({ env, client, params }) => {
    const f = await ownFile(env, client, params.id);
    if (f.uploaded_by !== "client") fail(403, "Only files you uploaded can be removed");
    if (f.item_id) {
      const item = await first(env, "SELECT status FROM onboarding_items WHERE id = ?", f.item_id);
      if (item && ["approved", "exception_approved"].includes(item.status)) fail(409, "This item is already approved");
    }
    await removeFile(env, f, `client:${client.id}`);
    return { ok: true };
  });

  // ───────── Messages ─────────
  r.post("/api/portal/projects/:id/messages", async ({ request, env, client, params }) => {
    const bundle = await ownProject(env, client, params.id);
    const b = await readJson(request, 20_000);
    const body = text(b.body, 8000) ?? fail(400, "Write a message first");
    await run(env, "INSERT INTO messages (project_id, sender, body) VALUES (?, 'client', ?)", bundle.project.id, body);
    await alertStudio(env, `New message on project #${bundle.project.id}`, { title: `Message from ${client.name.split(/\s+/)[0]}`, path: `/admin/#/project/${bundle.project.id}/messages` });
    return { ok: true };
  });

  // ───────── Previews: approve or request changes ─────────
  r.post("/api/portal/projects/:id/review", async ({ request, env, client, params }) => {
    const bundle = await ownProject(env, client, params.id);
    const b = await readJson(request, 20_000);
    const decision = b.decision === "approve" ? "approve" : b.decision === "changes" ? "changes" : fail(400, "Approve or request changes");
    const open = bundle.reviews.find((x) => x.status === "open");
    if (decision === "approve" && open?.kind === "final" && (b.confirm !== true || !text(b.name, 120))) fail(400, "Please type your name and tick the box to sign off the final website");
    return answerReview(env, bundle.project.id, client.id, { decision, response: text(b.response, 8000), name: text(b.name, 120) });
  });

  // ───────── Agreements ─────────
  r.post("/api/portal/agreements/:id/accept", async ({ request, env, client, params }) => {
    const b = await readJson(request, 5000);
    await acceptAgreement(env, idOf(params.id), client, {
      name: b.name, consent: b.consent, hash: b.hash,
      ip: request.headers.get("cf-connecting-ip"), ua: request.headers.get("user-agent"),
    });
    return { ok: true };
  });

  r.get("/api/portal/agreements/:id/document", async ({ env, client, params }) => {
    const a = await first(env, "SELECT * FROM agreements WHERE id = ? AND client_id = ? AND status != 'void'", idOf(params.id), client.id);
    if (!a) fail(404, "Agreement not found");
    return new Response(agreementDocument(a, await business(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });
  });

  // ───────── Payments ─────────
  r.post("/api/portal/invoices/:id/checkout", async ({ env, client, params }) => {
    if (!stripeReady(env)) fail(503, "Online payment isn't switched on yet. Please reply to your invoice email and I'll help.");
    const inv = await first(env, "SELECT * FROM invoices WHERE id = ? AND client_id = ?", idOf(params.id), client.id);
    if (!inv) fail(404, "Invoice not found");
    if (inv.project_id) {
      // A deposit can only be paid once the agreement it belongs to is accepted
      const bundle = await loadProject(env, inv.project_id);
      const pending = bundle.agreements.find((a) => !a.subscription_id && a.status === "pending");
      if (inv.required_for_start && bundle.project.status === "quote" && pending) fail(409, "Please accept the agreement first");
    }
    return { url: await invoiceCheckout(env, inv, client) };
  });

  r.post("/api/portal/subscriptions/:id/checkout", async ({ env, client, params }) => {
    if (!stripeReady(env)) fail(503, "Online payment isn't switched on yet.");
    const sub = await first(env, "SELECT * FROM subscriptions WHERE id = ? AND client_id = ?", idOf(params.id), client.id);
    if (!sub) fail(404, "Plan not found");
    const agreement = await first(env, "SELECT status FROM agreements WHERE subscription_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1", sub.id);
    if (agreement?.status !== "accepted") fail(409, "Please review and accept the care agreement first");
    return { url: await subscriptionCheckout(env, sub, client) };
  });

}
