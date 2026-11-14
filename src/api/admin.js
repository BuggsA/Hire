// The studio's API (Admin dashboard). Every route needs a verified admin login (checked in worker.js).
import { all, first, run, activity, getSetting, setSetting, closedDates } from "../lib/db.js";
import { fail, readJson, text, req, cents, int, email as cleanEmail, parse, money, siteUrl, esc, isDateStr } from "../lib/http.js";
import { loadProject, projectState, setStatus, canMove, advance, createChecklist, sendPreview, completeProject, STATUSES, refreshDue, fmtDate } from "../lib/workflow.js";
import { ONBOARDING_TEMPLATE } from "../lib/seed.js";
import { saveFile, serveFile, removeFile } from "../lib/files.js";
import { issueAgreement, agreementDocument } from "../lib/agreements.js";
import { markInvoicePaid, revenueSummary, cancelSubscription, stripeReady } from "../lib/stripe.js";
import { emailClient, sendEmail, business, alertStudio } from "../lib/notify.js";
import { createLoginToken } from "../lib/auth.js";
import { attention, runDaily } from "../lib/automation.js";
import { triageLead, aiReady } from "../lib/ai.js";
import { todayET } from "../lib/timeline.js";
import { idOf } from "../router.js";
import { contentRoutes } from "./content.js";

const STUDIO = "studio";

async function newInvoice(env, f) {
  const row = await first(
    env,
    `INSERT INTO invoices (number, project_id, client_id, kind, label, amount_cents, due_date, due_trigger, required_for_start, required_for_launch, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    `tmp-${crypto.randomUUID()}`, f.project_id ?? null, f.client_id, f.kind || "custom", f.label, f.amount_cents, f.due_date || null, f.due_trigger || "date",
    f.required_for_start ? 1 : 0, f.required_for_launch ? 1 : 0, f.status || "draft"
  );
  return first(env, "UPDATE invoices SET number = printf('FD-%04d', id) WHERE id = ? RETURNING *", row.id);
}

/** Email the client a fresh sign-in link that opens their project (7 days, works once). */
async function inviteClient(env, client, { subject, heading, paragraphs, projectId }) {
  const token = await createLoginToken(env, client.id, 7 * 24 * 60);
  const next = projectId ? `#/project/${projectId}` : "";
  return emailClient(env, client, {
    subject,
    heading,
    paragraphs: [...paragraphs, "The button signs you in (it works once, for 7 days). After that, sign in any time with your email at the client portal."],
    button: { label: "Open your project", url: `${siteUrl(env)}/portal/signin?next=${encodeURIComponent(next)}#${token}` },
  });
}

async function findOrCreateClient(env, { client_id, name, email, business: biz, phone }) {
  if (client_id) return (await first(env, "SELECT * FROM clients WHERE id = ?", idOf(client_id))) ?? fail(404, "Client not found");
  const e = cleanEmail(email) ?? fail(400, "A valid client email is required");
  const existing = await first(env, "SELECT * FROM clients WHERE email = ?", e);
  if (existing) return existing;
  return first(env, "INSERT INTO clients (email, name, business, phone) VALUES (?, ?, ?, ?) RETURNING *", e, req(name, "Client name", 120), text(biz, 160), text(phone, 40));
}

export function adminRoutes(r) {
  contentRoutes(r);

  // ───────── Overview ─────────
  r.get("/api/admin/overview", async ({ env }) => {
    const [a, revenue, projects, recent] = await Promise.all([
      attention(env),
      revenueSummary(env),
      all(env, "SELECT p.id, p.title, p.status, p.due_date, p.start_date, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.status NOT IN ('completed','cancelled') ORDER BY p.id DESC"),
      all(env, "SELECT a.*, p.title FROM activity a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.id DESC LIMIT 25"),
    ]);
    const withState = [];
    for (const p of projects) {
      const bundle = await loadProject(env, p.id);
      const s = await projectState(env, bundle);
      withState.push({ ...p, statusLabel: STATUSES[p.status]?.label, next: s.next, progress: s.progress, schedule: s.schedule });
    }
    return { attention: a, revenue, projects: withState, recent, today: todayET(), statuses: STATUSES };
  });

  // ───────── Leads ─────────
  r.get("/api/admin/leads", async ({ env }) => {
    const leads = await all(env, "SELECT * FROM leads ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'quoted' THEN 2 ELSE 3 END, id DESC LIMIT 300");
    const addons = await all(env, "SELECT id, name FROM addons");
    const names = Object.fromEntries(addons.map((a) => [a.id, a.name]));
    return { leads: leads.map((l) => ({ ...l, addons: parse(l.addons, []).map((id) => names[id] || `#${id}`), ai_summary: parse(l.ai_summary, null) })), aiReady: aiReady(env) };
  });

  r.patch("/api/admin/leads/:id", async ({ request, env, params }) => {
    const b = await readJson(request);
    const id = idOf(params.id);
    const status = b.status && ["new", "contacted", "quoted", "won", "lost"].includes(b.status) ? b.status : null;
    await run(env, "UPDATE leads SET status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?", status, b.notes === undefined ? null : text(b.notes, 5000) ?? "", id);
    if (status) await activity(env, null, STUDIO, "lead", `Lead #${id} → ${status}`);
    return { ok: true };
  });

  r.post("/api/admin/leads/:id/triage", async ({ env, params }) => {
    if (!aiReady(env)) fail(503, "AI suggestions need the ANTHROPIC_API_KEY secret");
    const lead = (await first(env, "SELECT * FROM leads WHERE id = ?", idOf(params.id))) ?? fail(404, "Lead not found");
    const ids = parse(lead.addons, []);
    const names = ids.length ? (await all(env, `SELECT name FROM addons WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)).map((a) => a.name) : [];
    const s = await triageLead(env, { ...lead, addon_names: names });
    if (!s) fail(502, "The AI suggestion didn't come back. Try again later.");
    return { suggestion: s };
  });

  // ───────── Clients ─────────
  r.get("/api/admin/clients", async ({ env }) => ({
    clients: await all(env, "SELECT c.*, (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS projects, (SELECT COALESCE(SUM(amount_cents),0) FROM payments y WHERE y.client_id = c.id) AS paid_cents FROM clients c ORDER BY c.id DESC"),
  }));
  r.post("/api/admin/clients", async ({ request, env }) => {
    const c = await findOrCreateClient(env, await readJson(request));
    return { client: c };
  });
  r.patch("/api/admin/clients/:id", async ({ request, env, params }) => {
    const b = await readJson(request);
    const id = idOf(params.id);
    const e = b.email !== undefined ? cleanEmail(b.email) ?? fail(400, "Invalid email") : null;
    if (e && (await first(env, "SELECT id FROM clients WHERE email = ? AND id != ?", e, id))) fail(409, "Another client already uses that email");
    await run(env, "UPDATE clients SET name = COALESCE(?, name), email = COALESCE(?, email), business = COALESCE(?, business), phone = COALESCE(?, phone), notes = COALESCE(?, notes) WHERE id = ?", text(b.name, 120), e, text(b.business, 160), text(b.phone, 40), text(b.notes, 5000), id);
    if (e) await run(env, "DELETE FROM sessions WHERE client_id = ?", id); // a changed email signs them out everywhere
    return { ok: true };
  });
  r.post("/api/admin/clients/:id/invite", async ({ env, params }) => {
    const c = (await first(env, "SELECT * FROM clients WHERE id = ?", idOf(params.id))) ?? fail(404, "Client not found");
    const sent = await inviteClient(env, c, { subject: "Your client portal", heading: "Your client portal is ready", paragraphs: ["Everything about your project lives here: onboarding, previews, messages, files and payments."] });
    if (sent === null) fail(503, "Email isn't set up (RESEND_API_KEY)");
    return { ok: !!sent };
  });

  // ───────── Projects ─────────
  r.get("/api/admin/projects", async ({ env }) => ({
    projects: await all(env, "SELECT p.*, c.name AS client_name, c.business AS client_business FROM projects p JOIN clients c ON c.id = p.client_id ORDER BY CASE WHEN p.status IN ('completed','cancelled') THEN 1 ELSE 0 END, p.id DESC"),
    statuses: STATUSES,
  }));

  /** New project (a quote in draft) from a lead or from scratch. */
  r.post("/api/admin/projects", async ({ request, env }) => {
    const b = await readJson(request);
    let lead = null;
    if (b.lead_id) lead = (await first(env, "SELECT * FROM leads WHERE id = ?", idOf(b.lead_id))) ?? fail(404, "Lead not found");
    const client = await findOrCreateClient(env, {
      client_id: b.client_id,
      name: b.client_name ?? lead?.name,
      email: b.client_email ?? lead?.email,
      business: b.client_business ?? lead?.business,
      phone: lead?.phone,
    });
    const pkg = (await first(env, "SELECT * FROM packages WHERE slug = ?", b.package_slug || lead?.package_slug || "starter")) || {};
    const leadAddons = lead ? parse(lead.addons, []) : [];
    const addons = leadAddons.length ? await all(env, `SELECT name, price_cents FROM addons WHERE id IN (${leadAddons.map(() => "?").join(",")})`, ...leadAddons) : [];
    const price = cents(b.price) ?? (pkg.price_cents || 0) + addons.reduce((s, a) => s + (a.price_cents || 0), 0);
    const p = await first(
      env,
      `INSERT INTO projects (client_id, lead_id, title, package_slug, scope, addons, price_cents, turnaround_days, fast_track, revision_rounds, support_days, feedback_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      client.id, lead?.id ?? null, text(b.title, 160) || `${pkg.name || "Website"} for ${client.business || client.name}`, pkg.slug || null,
      JSON.stringify(Array.isArray(b.scope) ? b.scope.map((s) => text(s, 300)).filter(Boolean) : parse(pkg.features, [])), JSON.stringify(addons),
      price, int(b.turnaround_days, { min: 1, max: 365 }) ?? pkg.turnaround_days ?? null, pkg.fast_track ? 1 : 0, pkg.revision_rounds ?? 1, pkg.support_days ?? 7, int(b.feedback_days, { min: 1, max: 20 }) ?? 2
    );
    await createChecklist(env, p.id, ONBOARDING_TEMPLATE);
    if (lead) await run(env, "UPDATE leads SET status = 'quoted', project_id = ?, updated_at = datetime('now') WHERE id = ?", p.id, lead.id);
    await activity(env, p.id, STUDIO, "created", `Quote drafted: ${p.title} (${money(p.price_cents)})`);
    return { project: p };
  });

  r.get("/api/admin/projects/:id", async ({ env, params }) => {
    const bundle = (await loadProject(env, idOf(params.id))) ?? fail(404, "Project not found");
    const id = bundle.project.id;
    const [files, messages, milestones, log, subscriptions, payments, agreementsFull] = await Promise.all([
      all(env, "SELECT * FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY id DESC", id),
      all(env, "SELECT * FROM messages WHERE project_id = ? ORDER BY id", id),
      all(env, "SELECT * FROM milestones WHERE project_id = ? ORDER BY sort, id", id),
      all(env, "SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 200", id),
      all(env, "SELECT * FROM subscriptions WHERE client_id = ? ORDER BY id DESC", bundle.project.client_id),
      all(env, "SELECT * FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE project_id = ?) ORDER BY paid_at DESC", id),
      all(env, "SELECT id, template_slug, version, title, status, accepted_at, accepted_name, accepted_email, accepted_ip, body_hash, subscription_id, created_at FROM agreements WHERE project_id = ? OR (client_id = ? AND project_id IS NULL) ORDER BY id DESC", id, bundle.project.client_id),
    ]);
    await run(env, "UPDATE messages SET read_at = datetime('now') WHERE project_id = ? AND sender = 'client' AND read_at IS NULL", id);
    const allInvoices = await all(env, "SELECT * FROM invoices WHERE project_id = ? ORDER BY id", id);
    return {
      ...bundle,
      project: { ...bundle.project, scope: parse(bundle.project.scope, []), addons: parse(bundle.project.addons, []) },
      items: bundle.items.map((i) => ({ ...i, fields: parse(i.fields, []), value: parse(i.value, {}) })),
      invoices: allInvoices,
      agreements: agreementsFull,
      state: await projectState(env, bundle),
      files, messages, milestones, log, subscriptions, payments,
      statuses: STATUSES,
      allowedMoves: Object.keys(STATUSES).filter((s) => canMove(bundle.project.status, s)),
      stripe: stripeReady(env),
    };
  });

  r.patch("/api/admin/projects/:id", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const p = (await first(env, "SELECT * FROM projects WHERE id = ?", id)) ?? fail(404, "Project not found");
    const b = await readJson(request);
    const quote = p.status === "quote";
    // Price, scope and terms are commitments: they can change freely while it's a quote. After the client has
    // accepted, change them by sending a new quote (a new agreement for them to accept), never silently.
    const committed = ["price", "scope", "addons", "turnaround_days", "revision_rounds", "support_days", "feedback_days"].filter((k) => b[k] !== undefined);
    if (!quote && committed.length) fail(409, `“${committed.join(", ")}” are part of the accepted agreement. Use “Revise quote” to change them with the client's agreement.`);
    const sets = [];
    const args = [];
    const set = (col, v) => {
      sets.push(`${col} = ?`);
      args.push(v);
    };
    if (b.title !== undefined) set("title", req(b.title, "Title", 160));
    if (b.notes !== undefined) set("notes", text(b.notes, 10000));
    if (b.preview_url !== undefined) set("preview_url", text(b.preview_url, 500));
    if (b.live_url !== undefined) set("live_url", text(b.live_url, 500));
    if (b.fast_track !== undefined) set("fast_track", b.fast_track ? 1 : 0);
    if (b.quote_expires !== undefined) set("quote_expires", b.quote_expires && isDateStr(b.quote_expires) ? b.quote_expires : null);
    if (b.price !== undefined) set("price_cents", cents(b.price) ?? 0);
    if (b.scope !== undefined) set("scope", JSON.stringify((Array.isArray(b.scope) ? b.scope : String(b.scope).split("\n")).map((s) => text(s, 300)).filter(Boolean)));
    if (b.addons !== undefined) set("addons", JSON.stringify((b.addons || []).map((a) => ({ name: req(a.name, "Add-on name", 160), price_cents: cents(a.price) })).slice(0, 50)));
    if (b.turnaround_days !== undefined) set("turnaround_days", int(b.turnaround_days, { min: 1, max: 365 }));
    if (b.revision_rounds !== undefined) set("revision_rounds", int(b.revision_rounds, { min: 0, max: 20 }));
    if (b.support_days !== undefined) set("support_days", int(b.support_days, { min: 0, max: 365 }));
    if (b.feedback_days !== undefined) set("feedback_days", int(b.feedback_days, { min: 1, max: 30 }));
    if (!sets.length) return { ok: true };
    await run(env, `UPDATE projects SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, ...args, id);
    await activity(env, id, STUDIO, "edited", Object.keys(b).join(", "));
    return { ok: true };
  });

  /**
   * Send (or re-send) the quote: makes the payment schedule if there isn't one (deposit before the build,
   * balance at launch), freezes the agreement text, and emails the client a sign-in link.
   * Re-sending after a change voids the unaccepted agreement and unpaid draft invoices and makes new ones.
   */
  r.post("/api/admin/projects/:id/send-quote", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const b = await readJson(request);
    let bundle = (await loadProject(env, id)) ?? fail(404, "Project not found");
    const p = { ...bundle.project };
    const revising = p.status !== "quote";
    if (revising && !b.revise) fail(409, "This project is past the quote stage. Send a revised quote to change its terms.");
    if (revising && ["completed", "cancelled"].includes(p.status)) fail(409, "This project is closed");
    if (revising) {
      // New terms: the client must accept a new agreement; unpaid invoices are rebuilt from the new price
      const price = b.price !== undefined ? cents(b.price) : p.price_cents;
      const scope = b.scope !== undefined ? JSON.stringify((Array.isArray(b.scope) ? b.scope : String(b.scope).split("\n")).map((x) => text(x, 300)).filter(Boolean)) : p.scope;
      await run(env, "UPDATE projects SET price_cents = ?, scope = ?, updated_at = datetime('now') WHERE id = ?", price, scope, id);
      await activity(env, id, STUDIO, "revised", `Terms revised: ${money(p.price_cents)} → ${money(price)}`);
      b.reset_schedule = true;
      bundle = await loadProject(env, id);
      p.price_cents = price;
    }
    if (!p.price_cents && !b.allow_free) fail(400, "Set a price first");
    const pkg = p.package_slug ? await first(env, "SELECT deposit_percent FROM packages WHERE slug = ?", p.package_slug) : null;
    const paid = bundle.invoices.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount_cents, 0);
    if (!revising || b.reset_schedule) {
      // Unpaid invoices are rebuilt from the current price; paid ones stay as they are
      await run(env, "UPDATE invoices SET status = 'void' WHERE project_id = ? AND status IN ('draft','open')", id);
      const remaining = Math.max(0, p.price_cents - paid);
      const pct = b.deposit_percent !== undefined ? int(b.deposit_percent, { min: 0, max: 100 }) : pkg?.deposit_percent ?? 50;
      const deposit = revising ? 0 : Math.round((remaining * pct) / 100);
      if (deposit > 0) await newInvoice(env, { project_id: id, client_id: p.client_id, kind: "deposit", label: `Deposit (${pct}%)`, amount_cents: deposit, due_trigger: "start", required_for_start: true, status: "open" });
      if (remaining - deposit > 0) await newInvoice(env, { project_id: id, client_id: p.client_id, kind: "final", label: revising ? "Balance (revised)" : "Final payment", amount_cents: remaining - deposit, due_trigger: "launch", required_for_launch: true, status: "draft" });
    }
    bundle = await loadProject(env, id);
    await issueAgreement(env, { slug: "project", project: bundle.project, client: bundle.client });
    await run(env, "UPDATE projects SET quote_sent_at = datetime('now'), quote_expires = COALESCE(quote_expires, date('now', '+14 days')) WHERE id = ?", id);
    await activity(env, id, STUDIO, "quote_sent", `${revising ? "Revised quote" : "Quote"} sent: ${money(p.price_cents)}`);
    const sent = await inviteClient(env, bundle.client, {
      subject: `${revising ? "Updated quote" : "Your quote"} · ${p.title}`,
      heading: revising ? "Your quote has been updated" : `Your quote for ${esc(p.title)}`,
      paragraphs: [
        `Price: <strong>${money(p.price_cents)}</strong>. Your project page has the full scope, the payment schedule and the agreement to read.`,
        revising ? "Please review the changes and accept the updated agreement to continue." : "When you're happy, accept the agreement and pay the deposit to book your build. Then your onboarding checklist opens.",
      ],
      projectId: id,
    });
    return { ok: true, emailed: !!sent };
  });

  r.post("/api/admin/projects/:id/status", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const b = await readJson(request);
    const p = (await first(env, "SELECT * FROM projects WHERE id = ?", id)) ?? fail(404, "Project not found");
    if (b.action === "resume") {
      if (p.status !== "paused") fail(409, "The project isn't paused");
      const back = p.status_before_pause || "in_development";
      await setStatus(env, id, back, STUDIO);
      await advance(env, id, STUDIO);
      return { ok: true, status: back };
    }
    const to = String(b.to || "");
    if (!STATUSES[to]) fail(400, "Unknown status");
    if (!canMove(p.status, to)) fail(409, `Can't move from “${STATUSES[p.status].label}” to “${STATUSES[to].label}”`);
    // The automatic rules own these two moves, so the start rule can't be skipped by hand
    if (to === "awaiting_onboarding") fail(409, "This happens by itself once the agreement is accepted and the deposit is paid");
    if (to === "ready_to_start") fail(409, "This happens by itself once onboarding is approved. Approve the items or grant exceptions.");
    if (to === "awaiting_feedback") fail(409, "Send a preview to ask for feedback");
    if (to === "completed") fail(409, "Use “Mark launched” to complete the project");
    if (to === "ready_for_launch" && !b.override_reason) fail(409, "The client approves the final site from their portal. To skip that, give a reason.");
    if (to === "paused" && !text(b.reason, 300)) fail(400, "Give a reason for the pause (the client sees it)");
    await setStatus(env, id, to, STUDIO, { reason: text(b.reason, 300) || text(b.override_reason, 300), owner: b.owner === "studio" ? "studio" : "client" });
    return { ok: true, status: to };
  });

  r.post("/api/admin/projects/:id/advance", async ({ env, params }) => ({ status: await advance(env, idOf(params.id), STUDIO) }));

  r.post("/api/admin/projects/:id/preview", async ({ request, env, params }) => {
    const b = await readJson(request);
    try {
      await sendPreview(env, idOf(params.id), { title: req(b.title, "Title", 200), url: text(b.url, 500), note: text(b.note, 4000), kind: b.kind === "final" ? "final" : "design" });
    } catch (e) {
      fail(e.status || 409, e.message);
    }
    return { ok: true };
  });

  r.post("/api/admin/projects/:id/complete", async ({ request, env, params }) => {
    const b = await readJson(request);
    await completeProject(env, idOf(params.id), { live_url: text(b.live_url, 500) });
    return { ok: true };
  });

  r.post("/api/admin/projects/:id/cancel", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const b = await readJson(request);
    const p = (await first(env, "SELECT status FROM projects WHERE id = ?", id)) ?? fail(404, "Project not found");
    if (["completed", "cancelled"].includes(p.status)) fail(409, "Already closed");
    await run(env, "UPDATE invoices SET status = 'void' WHERE project_id = ? AND status IN ('draft','open')", id);
    await run(env, "UPDATE agreements SET status = 'void' WHERE project_id = ? AND status = 'pending'", id);
    await run(env, "UPDATE project_holds SET end_date = ? WHERE project_id = ? AND end_date IS NULL", todayET(), id);
    await run(env, "UPDATE projects SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?", id);
    await activity(env, id, STUDIO, "status", `Cancelled${b.reason ? `: ${text(b.reason, 300)}` : ""}`);
    return { ok: true };
  });

  // ───────── Onboarding review (only the studio approves) ─────────
  r.post("/api/admin/items/:id/review", async ({ request, env, params }) => {
    const item = (await first(env, "SELECT * FROM onboarding_items WHERE id = ?", idOf(params.id))) ?? fail(404, "Item not found");
    const b = await readJson(request);
    const note = text(b.note, 2000);
    const actions = {
      approve: ["approved", "Approved"],
      needs_changes: ["needs_changes", "Needs changes"],
      approve_exception: ["exception_approved", "Exception approved"],
      decline_exception: ["needs_changes", "Exception declined"],
      reopen: ["not_started", "Reopened"],
    };
    const a = actions[b.action] ?? fail(400, "Unknown action");
    if (b.action === "needs_changes" && !note) fail(400, "Tell the client what to change");
    if (b.action === "approve" && !["submitted", "needs_changes", "not_started"].includes(item.status)) fail(409, "Nothing to approve");
    if (b.action === "approve" && item.status === "not_started" && !b.force) fail(409, "The client hasn't submitted this yet");
    if (b.action === "approve_exception" && !item.exception_requested && !note) fail(400, "Explain the exception (the client didn't request one)");
    await run(
      env,
      "UPDATE onboarding_items SET status = ?, admin_note = ?, reviewed_at = datetime('now'), exception_requested = CASE WHEN ? IN ('decline_exception','reopen') THEN 0 ELSE exception_requested END WHERE id = ?",
      a[0], note, b.action, item.id
    );
    await activity(env, item.project_id, STUDIO, "review", `${item.label}: ${a[1]}${note ? ` (${note})` : ""}`);
    const bundle = await loadProject(env, item.project_id);
    if (["needs_changes", "decline_exception"].includes(b.action))
      await emailClient(env, bundle.client, {
        subject: `One onboarding item needs a change · ${bundle.project.title}`,
        heading: `“${item.label}” needs a change`,
        paragraphs: [note ? esc(note) : "Please take another look."],
        button: { label: "Update it", url: `${siteUrl(env)}/portal/#/project/${item.project_id}/onboarding` },
      });
    const status = await advance(env, item.project_id, STUDIO);
    return { ok: true, projectStatus: status };
  });

  r.patch("/api/admin/items/:id", async ({ request, env, params }) => {
    const item = (await first(env, "SELECT * FROM onboarding_items WHERE id = ?", idOf(params.id))) ?? fail(404, "Item not found");
    const b = await readJson(request);
    await run(env, "UPDATE onboarding_items SET required = COALESCE(?, required), label = COALESCE(?, label), help = COALESCE(?, help) WHERE id = ?", b.required === undefined ? null : b.required ? 1 : 0, text(b.label, 200), text(b.help, 1000), item.id);
    await activity(env, item.project_id, STUDIO, "checklist", `${item.label}: ${b.required === undefined ? "edited" : b.required ? "now required" : "now optional"}`);
    await advance(env, item.project_id, STUDIO);
    return { ok: true };
  });

  r.post("/api/admin/projects/:id/items", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const b = await readJson(request);
    const label = req(b.label, "Label", 200);
    const max = await first(env, "SELECT COALESCE(MAX(sort), 0) AS s FROM onboarding_items WHERE project_id = ?", id);
    await run(
      env,
      "INSERT INTO onboarding_items (project_id, key, section, label, help, fields, allow_files, required, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, `custom-${crypto.randomUUID().slice(0, 8)}`, text(b.section, 80) || "Anything else", label, text(b.help, 1000),
      JSON.stringify([{ name: "answer", label: text(b.field_label, 200) || "Your answer", type: "textarea", required: !b.allow_files }]), b.allow_files ? 1 : 0, b.required === false ? 0 : 1, max.s + 1
    );
    await activity(env, id, STUDIO, "checklist", `Added “${label}”`);
    return { ok: true };
  });

  // ───────── Messages, milestones, files ─────────
  r.post("/api/admin/projects/:id/messages", async ({ request, env, params }) => {
    const bundle = (await loadProject(env, idOf(params.id))) ?? fail(404, "Project not found");
    const body = req((await readJson(request)).body, "Message", 8000);
    await run(env, "INSERT INTO messages (project_id, sender, body) VALUES (?, 'studio', ?)", bundle.project.id, body);
    await emailClient(env, bundle.client, {
      subject: `New message about ${bundle.project.title}`,
      heading: "You have a new message",
      paragraphs: [esc(body).replace(/\n/g, "<br>")],
      button: { label: "Reply in your portal", url: `${siteUrl(env)}/portal/#/project/${bundle.project.id}/messages` },
    });
    return { ok: true };
  });

  r.post("/api/admin/projects/:id/milestones", async ({ request, env, params }) => {
    const id = idOf(params.id);
    const b = await readJson(request);
    await run(env, "INSERT INTO milestones (project_id, title, target_date, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort),0)+1 FROM milestones WHERE project_id = ?))", id, req(b.title, "Title", 200), isDateStr(b.target_date) ? b.target_date : null, id);
    return { ok: true };
  });
  r.patch("/api/admin/milestones/:id", async ({ request, env, params }) => {
    const m = (await first(env, "SELECT * FROM milestones WHERE id = ?", idOf(params.id))) ?? fail(404, "Not found");
    const b = await readJson(request);
    if (b.delete) {
      await run(env, "DELETE FROM milestones WHERE id = ?", m.id);
      return { ok: true };
    }
    await run(env, "UPDATE milestones SET done_at = ? WHERE id = ?", b.done ? new Date().toISOString().slice(0, 19).replace("T", " ") : null, m.id);
    if (b.done) {
      await activity(env, m.project_id, STUDIO, "milestone", `Milestone reached: ${m.title}`);
      const bundle = await loadProject(env, m.project_id);
      await emailClient(env, bundle.client, { subject: `Milestone reached · ${bundle.project.title}`, heading: `Milestone reached: ${esc(m.title)}`, paragraphs: ["Your project is moving along. Details are in your dashboard."], button: { label: "Open your project", url: `${siteUrl(env)}/portal/#/project/${m.project_id}` } });
    }
    return { ok: true };
  });

  r.post("/api/admin/projects/:id/files", async ({ request, env, params, url }) => {
    const id = idOf(params.id);
    (await first(env, "SELECT id FROM projects WHERE id = ?", id)) ?? fail(404, "Project not found");
    const kind = ["preview", "deliverable", "agreement", "onboarding"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "deliverable";
    const f = await saveFile(env, request, { project_id: id, kind, by: "studio", visible: url.searchParams.get("private") !== "1", actor: STUDIO });
    return { file: f };
  });
  r.get("/api/admin/files/:id", async ({ env, params, url }) => {
    const f = (await first(env, "SELECT * FROM files WHERE id = ? AND deleted_at IS NULL", idOf(params.id))) ?? fail(404, "File not found");
    return serveFile(env, f, { download: url.searchParams.has("download") });
  });
  r.delete("/api/admin/files/:id", async ({ env, params }) => {
    const f = (await first(env, "SELECT * FROM files WHERE id = ? AND deleted_at IS NULL", idOf(params.id))) ?? fail(404, "File not found");
    await removeFile(env, f, STUDIO);
    return { ok: true };
  });

  // ───────── Money ─────────
  r.get("/api/admin/money", async ({ env }) => ({
    revenue: await revenueSummary(env),
    invoices: await all(env, "SELECT i.*, c.name AS client_name, p.title AS project_title FROM invoices i JOIN clients c ON c.id = i.client_id LEFT JOIN projects p ON p.id = i.project_id WHERE i.status != 'void' ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, i.id DESC LIMIT 300"),
    payments: await all(env, "SELECT y.*, c.name AS client_name FROM payments y JOIN clients c ON c.id = y.client_id ORDER BY y.paid_at DESC LIMIT 200"),
    subscriptions: await all(env, "SELECT s.*, c.name AS client_name FROM subscriptions s JOIN clients c ON c.id = s.client_id ORDER BY s.id DESC"),
    plans: await all(env, "SELECT * FROM care_plans WHERE active = 1 ORDER BY sort"),
    stripe: stripeReady(env),
  }));

  r.post("/api/admin/invoices", async ({ request, env }) => {
    const b = await readJson(request);
    let clientId = b.client_id ? idOf(b.client_id) : null;
    let projectId = b.project_id ? idOf(b.project_id) : null;
    if (projectId) clientId = ((await first(env, "SELECT client_id FROM projects WHERE id = ?", projectId)) ?? fail(404, "Project not found")).client_id;
    if (!clientId) fail(400, "Choose a client or project");
    const amount = cents(b.amount) ?? fail(400, "Amount is required");
    if (amount < 50) fail(400, "Invoices must be at least $0.50 (Stripe's minimum)");
    const inv = await newInvoice(env, {
      project_id: projectId, client_id: clientId, kind: ["deposit", "milestone", "final", "installment", "custom"].includes(b.kind) ? b.kind : "custom",
      label: req(b.label, "Label", 160), amount_cents: amount, due_date: isDateStr(b.due_date) ? b.due_date : null,
      due_trigger: ["start", "launch", "date"].includes(b.due_trigger) ? b.due_trigger : "date",
      required_for_start: !!b.required_for_start, required_for_launch: !!b.required_for_launch, status: "draft",
    });
    await activity(env, projectId, STUDIO, "invoice", `${inv.number} created: ${inv.label} ${money(amount)}`);
    if (b.send) await sendInvoice(env, inv.id);
    return { invoice: inv };
  });

  async function sendInvoice(env, id) {
    const inv = (await first(env, "SELECT * FROM invoices WHERE id = ?", id)) ?? fail(404, "Invoice not found");
    if (!["draft", "open"].includes(inv.status)) fail(409, `This invoice is ${inv.status}`);
    await run(env, "UPDATE invoices SET status = 'open', sent_at = datetime('now') WHERE id = ?", id);
    const client = await first(env, "SELECT * FROM clients WHERE id = ?", inv.client_id);
    await inviteClient(env, client, {
      subject: `Invoice ${inv.number}: ${money(inv.amount_cents)}`,
      heading: `Invoice ${inv.number}`,
      paragraphs: [`${esc(inv.label)}: <strong>${money(inv.amount_cents)}</strong>${inv.due_date ? `, due ${fmtDate(inv.due_date)}` : ""}. Pay securely by card from your dashboard.`],
      projectId: inv.project_id,
    });
    await activity(env, inv.project_id, STUDIO, "invoice", `${inv.number} sent`);
  }

  r.post("/api/admin/invoices/:id/send", async ({ env, params }) => {
    await sendInvoice(env, idOf(params.id));
    return { ok: true };
  });

  r.patch("/api/admin/invoices/:id", async ({ request, env, params }) => {
    const inv = (await first(env, "SELECT * FROM invoices WHERE id = ?", idOf(params.id))) ?? fail(404, "Invoice not found");
    if (inv.status === "paid" || inv.status === "void") fail(409, `A ${inv.status} invoice can't be changed`);
    const b = await readJson(request);
    const amount = b.amount !== undefined ? cents(b.amount) : null;
    if (amount !== null && amount < 50) fail(400, "Invoices must be at least $0.50");
    await run(
      env,
      "UPDATE invoices SET label = COALESCE(?, label), amount_cents = COALESCE(?, amount_cents), due_date = CASE WHEN ? THEN ? ELSE due_date END, required_for_start = COALESCE(?, required_for_start), required_for_launch = COALESCE(?, required_for_launch), stripe_session_id = NULL WHERE id = ?",
      text(b.label, 160), amount, b.due_date !== undefined ? 1 : 0, isDateStr(b.due_date) ? b.due_date : null,
      b.required_for_start === undefined ? null : b.required_for_start ? 1 : 0, b.required_for_launch === undefined ? null : b.required_for_launch ? 1 : 0, inv.id
    );
    await activity(env, inv.project_id, STUDIO, "invoice", `${inv.number} changed${amount !== null ? `: ${money(inv.amount_cents)} → ${money(amount)}` : ""}`);
    if (inv.project_id) await advance(env, inv.project_id, STUDIO);
    return { ok: true };
  });

  r.post("/api/admin/invoices/:id/void", async ({ env, params }) => {
    const inv = (await first(env, "SELECT * FROM invoices WHERE id = ?", idOf(params.id))) ?? fail(404, "Invoice not found");
    if (inv.status === "paid") fail(409, "A paid invoice can't be voided. Refund it in Stripe instead.");
    await run(env, "UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
    await activity(env, inv.project_id, STUDIO, "invoice", `${inv.number} voided`);
    if (inv.project_id) await advance(env, inv.project_id, STUDIO);
    return { ok: true };
  });

  r.post("/api/admin/invoices/:id/mark-paid", async ({ request, env, params }) => {
    const inv = (await first(env, "SELECT * FROM invoices WHERE id = ?", idOf(params.id))) ?? fail(404, "Invoice not found");
    if (inv.status === "paid" || inv.status === "void") fail(409, `This invoice is already ${inv.status}`);
    const note = req((await readJson(request)).note, "How it was paid (e.g. “check #1042”)", 200);
    await markInvoicePaid(env, inv, { method: "manual", reference: `manual-${inv.id}`, amount_cents: inv.amount_cents, note, actor: STUDIO });
    return { ok: true };
  });

  /** Split an unpaid invoice into installments. */
  r.post("/api/admin/invoices/:id/split", async ({ request, env, params }) => {
    const inv = (await first(env, "SELECT * FROM invoices WHERE id = ?", idOf(params.id))) ?? fail(404, "Invoice not found");
    if (!["draft", "open"].includes(inv.status)) fail(409, "Only unpaid invoices can be split");
    const b = await readJson(request);
    const n = int(b.count, { min: 2, max: 24 }) ?? fail(400, "How many installments?");
    const firstDue = isDateStr(b.first_due) ? b.first_due : todayET();
    const every = int(b.every_days, { min: 1, max: 120 }) ?? 30;
    const base = Math.floor(inv.amount_cents / n);
    if (base < 50) fail(400, "Each installment must be at least $0.50");
    await run(env, "UPDATE invoices SET status = 'void' WHERE id = ?", inv.id);
    for (let i = 0; i < n; i++) {
      const d = new Date(firstDue + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + every * i);
      await newInvoice(env, {
        project_id: inv.project_id, client_id: inv.client_id, kind: "installment", label: `${inv.label}: installment ${i + 1} of ${n}`,
        amount_cents: i === n - 1 ? inv.amount_cents - base * (n - 1) : base, due_date: d.toISOString().slice(0, 10), due_trigger: "date",
        required_for_start: i === 0 && inv.required_for_start, required_for_launch: inv.required_for_launch, status: inv.status,
      });
    }
    await activity(env, inv.project_id, STUDIO, "invoice", `${inv.number} split into ${n} installments`);
    return { ok: true };
  });

  // Care plans / subscriptions
  r.post("/api/admin/subscriptions", async ({ request, env }) => {
    const b = await readJson(request);
    const client = (await first(env, "SELECT * FROM clients WHERE id = ?", idOf(b.client_id))) ?? fail(404, "Client not found");
    const plan = b.plan_slug ? await first(env, "SELECT * FROM care_plans WHERE slug = ?", b.plan_slug) : null;
    const monthly = cents(b.monthly) ?? plan?.monthly_cents ?? fail(400, "Monthly price is required");
    const term = int(b.term_months, { min: 0, max: 60 }) ?? plan?.term_months ?? 0;
    const name = text(b.name, 160) || plan?.name || "Website care";
    const projectId = b.project_id ? idOf(b.project_id) : null;
    const sub = await first(env, "INSERT INTO subscriptions (client_id, project_id, plan_slug, name, monthly_cents, term_months) VALUES (?, ?, ?, ?, ?, ?) RETURNING *", client.id, projectId, plan?.slug || null, name, monthly, term);
    await issueAgreement(env, { slug: plan?.kind === "waas" ? "waas" : "care", client, sub, project: projectId ? await first(env, "SELECT * FROM projects WHERE id = ?", projectId) : null });
    await activity(env, projectId, STUDIO, "subscription", `Offered ${name}: ${money(monthly)}/mo, ${term ? `${term}-month term` : "month to month"}`);
    await inviteClient(env, client, {
      subject: `Your care plan: ${name}`,
      heading: "A care plan for your website",
      paragraphs: [`${esc(name)}: <strong>${money(monthly)}/month</strong>${term ? `, ${term}-month minimum` : ", month to month"}. Review the agreement and subscribe from your dashboard if it suits you.`],
      projectId,
    });
    return { subscription: sub };
  });

  r.post("/api/admin/subscriptions/:id/cancel", async ({ env, params }) => {
    const sub = (await first(env, "SELECT * FROM subscriptions WHERE id = ?", idOf(params.id))) ?? fail(404, "Not found");
    if (sub.status === "offered") {
      await run(env, "UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now') WHERE id = ?", sub.id);
      await run(env, "UPDATE agreements SET status = 'void' WHERE subscription_id = ? AND status = 'pending'", sub.id);
    } else await cancelSubscription(env, sub);
    await activity(env, sub.project_id, STUDIO, "subscription", `${sub.name}: cancellation requested`);
    return { ok: true };
  });

  // ───────── Agreements ─────────
  r.get("/api/admin/agreements/:id/document", async ({ env, params }) => {
    const a = (await first(env, "SELECT * FROM agreements WHERE id = ?", idOf(params.id))) ?? fail(404, "Not found");
    return new Response(agreementDocument(a, await business(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  });

  // ───────── Activity, setup, automation ─────────
  r.get("/api/admin/activity", async ({ env, url }) => {
    const pid = url.searchParams.get("project");
    return {
      activity: pid ? await all(env, "SELECT * FROM activity WHERE project_id = ? ORDER BY id DESC LIMIT 300", idOf(pid)) : await all(env, "SELECT a.*, p.title FROM activity a LEFT JOIN projects p ON p.id = a.project_id ORDER BY a.id DESC LIMIT 300"),
      events: await all(env, "SELECT * FROM event_log ORDER BY id DESC LIMIT 100"),
    };
  });

  r.get("/api/admin/setup", async ({ env }) => {
    const checks = [
      ["Database", !!env.DB, "D1 binding DB"],
      ["File storage", !!env.FILES, "R2 binding FILES (private bucket)"],
      ["Admin login", !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.ADMIN_EMAILS), "ACCESS_TEAM_DOMAIN, ACCESS_AUD, ADMIN_EMAILS"],
      ["Email", !!env.RESEND_API_KEY, "RESEND_API_KEY (and EMAIL_FROM on a verified domain)"],
      ["Phone alerts", !!env.NTFY_TOPIC, "NTFY_TOPIC (optional; email is used otherwise)"],
      ["Spam protection", !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY), "TURNSTILE_SITE_KEY and TURNSTILE_SECRET"],
      ["Card payments", stripeReady(env), "STRIPE_SECRET_KEY"],
      ["Payment webhooks", !!env.STRIPE_WEBHOOK_SECRET, "STRIPE_WEBHOOK_SECRET"],
      ["AI suggestions", aiReady(env), "ANTHROPIC_API_KEY (optional)"],
    ].map(([name, ok, how]) => ({ name, ok, how }));
    return { checks, site: siteUrl(env) };
  });

  r.post("/api/admin/setup/test-email", async ({ env, admin }) => {
    const ok = await sendEmail(env, { to: admin, subject: "Test email", heading: "Email works", paragraphs: ["This is a test from your studio dashboard."] });
    if (ok === null) fail(503, "RESEND_API_KEY isn't set");
    return { ok };
  });
  r.post("/api/admin/setup/test-alert", async ({ env }) => {
    await alertStudio(env, "Test alert from the dashboard", { title: "Test" });
    return { ok: true };
  });
  r.post("/api/admin/run-daily", async ({ env }) => ({ report: await runDaily(env) }));

  // Settings: business details, homepage text and closed dates
  r.get("/api/admin/settings", async ({ env }) => ({
    business: await business(env),
    home: await getSetting(env, "home", {}),
    closed_dates: [...(await closedDates(env))].sort(),
  }));
  r.put("/api/admin/settings/:key", async ({ request, env, params }) => {
    const b = await readJson(request, 50_000);
    if (params.key === "closed_dates") {
      const dates = (Array.isArray(b.value) ? b.value : []).filter(isDateStr).slice(0, 400);
      await setSetting(env, "closed_dates", [...new Set(dates)].sort());
      // Closed days move delivery targets
      for (const { id } of await all(env, "SELECT id FROM projects WHERE start_date IS NOT NULL AND status NOT IN ('completed','cancelled')")) await refreshDue(env, id);
    } else if (params.key === "business" || params.key === "home") {
      const clean = Object.fromEntries(Object.entries(b.value || {}).filter(([k]) => /^[a-z_]{1,40}$/.test(k)).map(([k, v]) => [k, String(v ?? "").slice(0, 3000)]));
      await setSetting(env, params.key, clean);
    } else fail(404, "Unknown setting");
    await activity(env, null, STUDIO, "settings", `Updated ${params.key}`);
    return { ok: true };
  });

}
