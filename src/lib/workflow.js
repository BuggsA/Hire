// Project workflow: statuses, what happens on each change, and who acts next.
// Every change goes through setStatus(), which writes the audit trail, opens or closes clock holds and
// tells the client. advance() is safe to call any time (after a payment, an approval, the daily run):
// it only moves a project forward when the rules say it may.
import { all, first, run, activity, closedDates } from "./db.js";
import { schedule, startBlockers, onboardingProgress, todayET, startDateFor, addBusinessDays } from "./timeline.js";
import { parse, esc, siteUrl, money } from "./http.js";
import { emailClient, alertStudio } from "./notify.js";

export const STATUSES = {
  quote: { label: "Quote", client: "Quote ready for you" },
  awaiting_onboarding: { label: "Awaiting onboarding", client: "Onboarding" },
  ready_to_start: { label: "Ready to start", client: "Ready to start" },
  in_development: { label: "In development", client: "In development" },
  awaiting_feedback: { label: "Awaiting client feedback", client: "Waiting for your feedback" },
  in_revision: { label: "In revision", client: "In revision" },
  ready_for_launch: { label: "Ready for launch", client: "Ready for launch" },
  completed: { label: "Completed", client: "Completed" },
  paused: { label: "Paused", client: "Paused" },
  cancelled: { label: "Cancelled", client: "Cancelled" },
};

// Which status may follow which (studio actions). Client actions are separate functions below.
const ALLOWED = {
  quote: ["awaiting_onboarding", "cancelled"],
  awaiting_onboarding: ["ready_to_start", "paused", "cancelled"],
  ready_to_start: ["in_development", "paused", "cancelled"],
  in_development: ["awaiting_feedback", "ready_for_launch", "paused", "cancelled"],
  awaiting_feedback: ["in_development", "in_revision", "ready_for_launch", "paused", "cancelled"],
  in_revision: ["awaiting_feedback", "in_development", "paused", "cancelled"],
  ready_for_launch: ["completed", "in_revision", "paused", "cancelled"],
  paused: [], // leaving a pause goes back to the status before it (resume)
  completed: [],
  cancelled: [],
};
export const canMove = (from, to) => (ALLOWED[from] || []).includes(to);

export async function loadProject(env, id) {
  const project = await first(env, "SELECT * FROM projects WHERE id = ?", id);
  if (!project) return null;
  const [items, invoices, holds, agreements, reviews, client] = await Promise.all([
    all(env, "SELECT * FROM onboarding_items WHERE project_id = ? ORDER BY sort, id", id),
    all(env, "SELECT * FROM invoices WHERE project_id = ? AND status != 'void' ORDER BY id", id),
    all(env, "SELECT * FROM project_holds WHERE project_id = ? ORDER BY id", id),
    all(env, "SELECT id, template_slug, version, title, status, accepted_at, accepted_name, subscription_id, body_hash FROM agreements WHERE project_id = ? AND status != 'void' ORDER BY id", id),
    all(env, "SELECT * FROM reviews WHERE project_id = ? ORDER BY id DESC", id),
    first(env, "SELECT id, email, name, business FROM clients WHERE id = ?", project.client_id),
  ]);
  return { project, items, invoices, holds, agreements, reviews, client };
}

/** The client has accepted a project agreement (a later revision waiting for acceptance doesn't undo that). */
export const agreementAccepted = (bundle) => bundle.agreements.some((a) => !a.subscription_id && a.template_slug === "project" && a.status === "accepted");

/** Everything the dashboards show about where a project stands. */
export async function projectState(env, bundle, today = todayET()) {
  const { project, items, invoices, holds } = bundle;
  const closed = await closedDates(env);
  const sched = schedule({ start: project.start_date, turnaround: project.turnaround_days, holds, closed, today });
  const blockers = startBlockers({ items, invoices, agreementAccepted: agreementAccepted(bundle) });
  return {
    schedule: sched,
    blockers: blockers.missing,
    canStart: blockers.ok,
    progress: onboardingProgress(items),
    next: nextAction(bundle, blockers, sched),
    statusLabel: STATUSES[project.status]?.label || project.status,
    clientStatusLabel: STATUSES[project.status]?.client || project.status,
  };
}

/** Who has to do something next, and what. { who: client|studio|none, text } */
export function nextAction(bundle, blockers, sched) {
  const { project, invoices, reviews } = bundle;
  const unpaid = (pred) => invoices.find((i) => pred(i) && i.status === "open");
  switch (project.status) {
    case "quote": {
      if (!agreementAccepted(bundle)) return { who: "client", text: "Review the quote and accept the agreement" };
      const dep = unpaid((i) => i.required_for_start);
      if (dep) return { who: "client", text: `Pay ${dep.label} (${money(dep.amount_cents)})` };
      return { who: "studio", text: "Open onboarding" };
    }
    case "awaiting_onboarding": {
      const clientTodo = blockers.missing.filter((m) => m.who === "client");
      const studioTodo = blockers.missing.filter((m) => m.who === "studio");
      if (clientTodo.length) return { who: "client", text: clientTodo.map((m) => m.what).join(" · ") };
      if (studioTodo.length) return { who: "studio", text: studioTodo.map((m) => m.what).join(" · ") };
      return { who: "studio", text: "Start the build" };
    }
    case "ready_to_start":
      return { who: "studio", text: `Build starts ${fmtDate(project.start_date)}` };
    case "in_development":
      return { who: "studio", text: sched?.due ? `Building · delivery target ${fmtDate(sched.due)}` : "Building" };
    case "awaiting_feedback": {
      const r = reviews.find((x) => x.status === "open");
      return { who: "client", text: r ? `Review “${r.title}” and approve it or request changes` : "Review the latest preview" };
    }
    case "in_revision":
      return { who: "studio", text: "Making the requested changes" };
    case "ready_for_launch": {
      const fin = unpaid((i) => i.required_for_launch);
      if (fin) return { who: "client", text: `Pay ${fin.label} (${money(fin.amount_cents)}) so the site can launch` };
      return { who: "studio", text: "Launch the site" };
    }
    case "paused":
      return { who: project.pause_owner === "studio" ? "studio" : "client", text: project.pause_reason ? `Paused: ${project.pause_reason}` : "Paused" };
    default:
      return { who: "none", text: STATUSES[project.status]?.label || project.status };
  }
}

export const fmtDate = (d) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "");

/** Recalculate and store the delivery target (call after any hold opens or closes). */
export async function refreshDue(env, projectId, today = todayET()) {
  const p = await first(env, "SELECT start_date, turnaround_days FROM projects WHERE id = ?", projectId);
  if (!p?.start_date || !p.turnaround_days) return null;
  const holds = await all(env, "SELECT * FROM project_holds WHERE project_id = ?", projectId);
  const s = schedule({ start: p.start_date, turnaround: p.turnaround_days, holds, closed: await closedDates(env), today });
  await run(env, "UPDATE projects SET due_date = ?, updated_at = datetime('now') WHERE id = ?", s.due, projectId);
  return s;
}

const CLIENT_UPDATES = {
  awaiting_onboarding: ["Your onboarding checklist is ready", "Thanks! Your project is confirmed. The next step is your onboarding checklist: business details, photos, logo and the other materials the site needs. The build week starts the business day after everything is approved."],
  ready_to_start: ["Everything's approved: your build week is booked", null],
  in_development: ["Your build has started", null],
  ready_for_launch: ["Your website is approved and ready to launch", "Thanks for approving the final site."],
  completed: ["Your project is complete", "Your website is live. Thank you for working with me!"],
  paused: ["Your project is paused", null],
};

/**
 * Change a project's status (studio, system or the client's own actions). Opens/closes clock holds,
 * writes the audit trail and emails the client about milestones. Returns the new bundle.
 */
export async function setStatus(env, projectId, to, actor, { reason, owner, today = todayET(), quiet = false } = {}) {
  const bundle = await loadProject(env, projectId);
  const p = bundle.project;
  const from = p.status;
  if (from === to) return bundle;
  // Close any open hold this change ends
  if (from === "awaiting_feedback") await run(env, "UPDATE project_holds SET end_date = ? WHERE project_id = ? AND kind = 'feedback' AND end_date IS NULL", today, projectId);
  if (from === "paused") await run(env, "UPDATE project_holds SET end_date = ? WHERE project_id = ? AND kind = 'pause' AND end_date IS NULL", today, projectId);

  const sets = ["status = ?", "updated_at = datetime('now')"];
  const args = [to];
  if (to === "awaiting_feedback" && p.start_date)
    await run(env, "INSERT INTO project_holds (project_id, kind, owner, start_date, grace_days) VALUES (?, 'feedback', 'client', ?, ?)", projectId, today, p.feedback_days ?? 2);
  if (to === "paused") {
    sets.push("status_before_pause = ?", "pause_reason = ?", "pause_owner = ?");
    args.push(from, reason || null, owner || "client");
    if (p.start_date) await run(env, "INSERT INTO project_holds (project_id, kind, owner, reason, start_date, grace_days) VALUES (?, 'pause', ?, ?, ?, 0)", projectId, owner || "client", reason || null, today);
  }
  if (from === "paused") sets.push("status_before_pause = NULL", "pause_reason = NULL", "pause_owner = NULL");
  if (to === "completed") sets.push("completed_at = datetime('now')");
  await run(env, `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, ...args, projectId);
  await activity(env, projectId, actor, "status", `${STATUSES[from]?.label || from} → ${STATUSES[to]?.label || to}${reason ? ` (${reason})` : ""}`);
  await refreshDue(env, projectId, today);

  // Final invoice becomes due when the site is ready to launch
  if (to === "ready_for_launch") {
    const due = addBusinessDays(today, 3, await closedDates(env));
    await run(env, "UPDATE invoices SET status = 'open', sent_at = datetime('now'), due_date = COALESCE(due_date, ?) WHERE project_id = ? AND status = 'draft' AND due_trigger = 'launch'", due, projectId);
  }

  const after = await loadProject(env, projectId);
  if (!quiet) await tellClient(env, after, to, reason);
  return after;
}

async function tellClient(env, bundle, to, reason) {
  const u = CLIENT_UPDATES[to];
  if (!u || !bundle.client) return;
  const p = bundle.project;
  const paragraphs = [];
  if (u[1]) paragraphs.push(u[1]);
  if (to === "ready_to_start") paragraphs.push(`Day 1 of your build is <strong>${fmtDate(p.start_date)}</strong>, and the delivery target is <strong>${fmtDate(p.due_date)}</strong>. You can follow along in your project dashboard.`);
  if (to === "in_development") paragraphs.push(`The delivery target is <strong>${fmtDate(p.due_date)}</strong>. I'll send a preview for your review.`);
  if (to === "paused" && reason) paragraphs.push(`Reason: ${esc(reason)}`);
  if (to === "ready_for_launch") {
    const fin = bundle.invoices.find((i) => i.required_for_launch && i.status === "open");
    if (fin) paragraphs.push(`The final payment of <strong>${money(fin.amount_cents)}</strong> is now due. You can pay it securely from your dashboard.`);
  }
  await emailClient(env, bundle.client, {
    subject: `${u[0]} · ${p.title}`,
    heading: u[0],
    paragraphs,
    button: { label: "Open your project", url: `${siteUrl(env)}/portal/#/project/${p.id}` },
  });
}

/**
 * Move a project forward if the rules allow. Safe to call any time; returns the (possibly new) status.
 *  quote → awaiting_onboarding: agreement accepted and the deposit (if any) paid
 *  awaiting_onboarding → ready_to_start: nothing blocking (see timeline.startBlockers); day 1 = next business day
 *  ready_to_start → in_development: on day 1
 */
export async function advance(env, projectId, actor = "system", today = todayET()) {
  let bundle = await loadProject(env, projectId);
  if (!bundle) return null;
  let p = bundle.project;
  const blockers = startBlockers({ items: bundle.items, invoices: bundle.invoices, agreementAccepted: agreementAccepted(bundle) });

  if (p.status === "quote") {
    const paid = !bundle.invoices.some((i) => i.required_for_start && i.status !== "paid");
    if (agreementAccepted(bundle) && paid) {
      bundle = await setStatus(env, projectId, "awaiting_onboarding", actor, { today });
      p = bundle.project;
      await alertStudio(env, `Project #${projectId} confirmed: agreement accepted and deposit paid`, { title: "Project confirmed", path: `/admin/#/project/${projectId}` });
    }
  }
  if (p.status === "awaiting_onboarding" && blockers.ok) {
    const closed = await closedDates(env);
    const start = startDateFor(today, closed);
    await run(env, "UPDATE projects SET ready_at = datetime('now'), start_date = ? WHERE id = ?", start, projectId);
    await activity(env, projectId, actor, "clock", `Onboarding approved and payment received. Build day 1 is ${start}.`);
    bundle = await setStatus(env, projectId, "ready_to_start", actor, { today });
    p = bundle.project;
    await alertStudio(env, `Project #${projectId} is ready: build starts ${fmtDate(start)}`, { title: "Ready to build", path: `/admin/#/project/${projectId}` });
  }
  if (p.status === "ready_to_start" && p.start_date && today >= p.start_date) {
    bundle = await setStatus(env, projectId, "in_development", "system", { today });
    p = bundle.project;
  }
  return p.status;
}

/** Turn the onboarding template into rows for a new project. */
export async function createChecklist(env, projectId, template) {
  const stmts = template.map((t, i) =>
    env.DB.prepare("INSERT OR IGNORE INTO onboarding_items (project_id, key, section, label, help, fields, allow_files, required, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      projectId, t.key, t.section, t.label, t.help || null, JSON.stringify(t.fields || []), t.allow_files ? 1 : 0, t.required === 0 ? 0 : 1, i
    )
  );
  if (stmts.length) await env.DB.batch(stmts);
}

// ───────── Previews, approvals and revisions ─────────
export async function sendPreview(env, projectId, { title, url, note, kind = "design" }, actor = "studio") {
  const bundle = await loadProject(env, projectId);
  const p = bundle.project;
  if (!["in_development", "in_revision", "awaiting_feedback"].includes(p.status)) throw new Error(`A preview can't be sent while the project is “${STATUSES[p.status].label}”`);
  await run(env, "UPDATE reviews SET status = 'superseded' WHERE project_id = ? AND status = 'open'", projectId);
  await run(env, "INSERT INTO reviews (project_id, kind, title, url, note) VALUES (?, ?, ?, ?, ?)", projectId, kind, title, url || null, note || null);
  if (url) await run(env, "UPDATE projects SET preview_url = ? WHERE id = ?", url, projectId);
  await activity(env, projectId, actor, "preview", `${kind === "final" ? "Final site" : "Preview"} sent: ${title}`);
  await setStatus(env, projectId, "awaiting_feedback", actor, { quiet: true });
  await emailClient(env, bundle.client, {
    subject: `${kind === "final" ? "Your finished website is ready to approve" : "A new preview is ready"} · ${p.title}`,
    heading: kind === "final" ? "Your finished website is ready for approval" : "A new preview is ready for you",
    paragraphs: [
      `“${esc(title)}”${note ? `: ${esc(note)}` : ""}`,
      `Please take a look and either approve it or send your changes as one list. You have ${p.feedback_days} business days to reply before the delivery date starts moving.`,
    ],
    button: { label: "Review it", url: `${siteUrl(env)}/portal/#/project/${projectId}/previews` },
  });
}

/**
 * The client answers the open review. decision: approve | changes.
 * Approving a final review moves to ready_for_launch; approving a design continues development.
 * Changes use up a revision round; past the included rounds the studio is alerted to quote extras.
 */
export async function answerReview(env, projectId, clientId, { decision, response, name }) {
  const bundle = await loadProject(env, projectId);
  const p = bundle.project;
  if (p.client_id !== clientId) throw Object.assign(new Error("Not your project"), { status: 404 });
  if (p.status !== "awaiting_feedback") throw Object.assign(new Error("There's nothing waiting for your review right now"), { status: 409 });
  const r = bundle.reviews.find((x) => x.status === "open");
  if (!r) throw Object.assign(new Error("There's nothing waiting for your review right now"), { status: 409 });
  const actor = `client:${clientId}`;
  if (decision === "approve") {
    await run(env, "UPDATE reviews SET status = 'approved', response = ?, responded_at = datetime('now'), responded_name = ? WHERE id = ?", response || null, name || null, r.id);
    await activity(env, projectId, actor, r.kind === "final" ? "final_approval" : "approval", `${r.kind === "final" ? "Final website approved" : "Approved"}: ${r.title}${name ? ` (signed: ${name})` : ""}`);
    await setStatus(env, projectId, r.kind === "final" ? "ready_for_launch" : "in_development", actor);
    await alertStudio(env, `Project #${projectId}: ${r.kind === "final" ? "final site approved" : "preview approved"}`, { title: "Approved", path: `/admin/#/project/${projectId}` });
    return { ok: true };
  }
  if (decision !== "changes" || !response) throw Object.assign(new Error("Please list the changes you'd like"), { status: 400 });
  const extra = p.revisions_used >= p.revision_rounds;
  await run(env, "UPDATE reviews SET status = 'changes_requested', response = ?, responded_at = datetime('now'), responded_name = ?, counts_as_revision = 1 WHERE id = ?", response, name || null, r.id);
  await run(env, "UPDATE projects SET revisions_used = revisions_used + 1 WHERE id = ?", projectId);
  await activity(env, projectId, actor, "revision", `Changes requested on “${r.title}”${extra ? ` (beyond the ${p.revision_rounds} included round${p.revision_rounds === 1 ? "" : "s"})` : ""}`);
  await setStatus(env, projectId, "in_revision", actor, { quiet: true });
  await alertStudio(env, `Project #${projectId}: changes requested${extra ? " (extra round: quote before starting)" : ""}`, {
    title: "Changes requested",
    path: `/admin/#/project/${projectId}`,
  });
  return { ok: true, extra };
}

/** Studio marks the site live. Needs an approved final review and every launch payment paid. */
export async function completeProject(env, projectId, { live_url } = {}, actor = "studio") {
  const bundle = await loadProject(env, projectId);
  const p = bundle.project;
  if (p.status !== "ready_for_launch") throw Object.assign(new Error("The client hasn't approved the final website yet"), { status: 409 });
  const unpaid = bundle.invoices.filter((i) => i.required_for_launch && i.status !== "paid");
  if (unpaid.length) throw Object.assign(new Error(`Waiting on payment: ${unpaid.map((i) => i.label).join(", ")}`), { status: 409 });
  await run(env, "UPDATE projects SET launched_at = datetime('now'), live_url = COALESCE(?, live_url) WHERE id = ?", live_url || null, projectId);
  return setStatus(env, projectId, "completed", actor);
}

export const projectSummary = (p) => ({ ...p, scope: parse(p.scope, []), addons: parse(p.addons, []) });
