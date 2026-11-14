// The routine follow-up, done automatically so nothing depends on remembering to check:
//  • projects start on their day 1, and delivery targets are recalculated
//  • clients are reminded about missing onboarding materials (every 3 days, naming exactly what's missing)
//  • clients are nudged when a preview has waited past their feedback window
//  • open invoices past due get up to 3 weekly reminders; unanswered quotes get one follow-up
//  • the studio gets one morning digest of everything waiting on them (only when there is something)
// Every email is sent at most once per key (sent_log), so running twice in a day is harmless.
import { all, first, claimOnce, closedDates, activity } from "./db.js";
import { advance, refreshDue, loadProject, projectState, fmtDate, STATUSES } from "./workflow.js";
import { todayET, isBusinessDay, businessDaysBetween, addDays, DONE_ITEM } from "./timeline.js";
import { emailClient, emailStudio } from "./notify.js";
import { esc, siteUrl, money } from "./http.js";

const ACTIVE = ["quote", "awaiting_onboarding", "ready_to_start", "in_development", "awaiting_feedback", "in_revision", "ready_for_launch", "paused"];

/** Everything waiting on the studio, for the dashboard's "Needs you" list and the morning digest. */
export async function attention(env, today = todayET()) {
  const closed = await closedDates(env);
  const [toReview, exceptions, unread, newLeads, overdueInvoices, projects] = await Promise.all([
    all(env, `SELECT i.id, i.label, i.project_id, p.title FROM onboarding_items i JOIN projects p ON p.id = i.project_id WHERE i.status = 'submitted' AND p.status NOT IN ('cancelled','completed') ORDER BY i.submitted_at`),
    all(env, `SELECT i.id, i.label, i.exception_reason, i.project_id, p.title FROM onboarding_items i JOIN projects p ON p.id = i.project_id WHERE i.exception_requested = 1 AND i.status NOT IN ('approved','exception_approved','needs_changes') AND p.status NOT IN ('cancelled','completed')`),
    all(env, `SELECT m.project_id, p.title, COUNT(*) AS n, MIN(m.created_at) AS since FROM messages m JOIN projects p ON p.id = m.project_id WHERE m.sender = 'client' AND m.read_at IS NULL GROUP BY m.project_id`),
    all(env, "SELECT id, name, business, created_at FROM leads WHERE status = 'new' ORDER BY id DESC"),
    all(env, "SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status = 'open' AND i.due_date IS NOT NULL AND i.due_date < ? ORDER BY i.due_date", today),
    all(env, `SELECT * FROM projects WHERE status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY id`, ...ACTIVE),
  ]);
  const late = [];
  const dueSoon = [];
  const feedbackOverdue = [];
  const changes = [];
  const launch = [];
  for (const p of projects) {
    if (["in_development", "in_revision"].includes(p.status) && p.due_date) {
      if (p.due_date < today) late.push(p);
      else if (businessDaysBetween(today, p.due_date, closed) <= 1) dueSoon.push(p);
    }
    if (p.status === "in_revision") changes.push(p);
    if (p.status === "ready_for_launch") launch.push(p);
    if (p.status === "awaiting_feedback") {
      const hold = await first(env, "SELECT * FROM project_holds WHERE project_id = ? AND kind = 'feedback' AND end_date IS NULL", p.id);
      if (hold && businessDaysBetween(hold.start_date, addDays(today, 1), closed) > hold.grace_days) feedbackOverdue.push({ ...p, waiting_since: hold.start_date });
    }
  }
  return { toReview, exceptions, unread, newLeads, overdueInvoices, late, dueSoon, feedbackOverdue, changes, launch };
}

export const attentionCount = (a) => a.toReview.length + a.exceptions.length + a.unread.length + a.newLeads.length + a.overdueInvoices.length + a.late.length + a.changes.length + a.launch.length;

const portalLink = (env, id, tab = "") => `${siteUrl(env)}/portal/#/project/${id}${tab ? "/" + tab : ""}`;

export async function runDaily(env, { now = new Date() } = {}) {
  const today = todayET(now);
  const closed = await closedDates(env);
  const workday = isBusinessDay(today, closed);
  const projects = await all(env, `SELECT id FROM projects WHERE status IN (${ACTIVE.map(() => "?").join(",")})`, ...ACTIVE);
  const report = { started: 0, onboardingReminders: 0, feedbackNudges: 0, invoiceReminders: 0, quoteFollowUps: 0, digest: false };

  for (const { id } of projects) {
    const before = (await first(env, "SELECT status FROM projects WHERE id = ?", id)).status;
    const after = await advance(env, id, "system", today);
    if (before !== after && after === "in_development") report.started++;
    await refreshDue(env, id, today);
    if (!workday) continue; // reminders only go out on business days
    const bundle = await loadProject(env, id);
    const p = bundle.project;

    // Missing onboarding materials, every 3 days, listing exactly what's missing
    if (p.status === "awaiting_onboarding") {
      const missing = bundle.items.filter((i) => i.required && !DONE_ITEM.has(i.status) && i.status !== "submitted" && !(i.exception_requested && i.status !== "needs_changes"));
      const last = await first(env, "SELECT MAX(sent_at) AS at FROM sent_log WHERE key LIKE ?", `onboarding:${id}:%`);
      const openedDays = Math.floor((now - new Date(p.updated_at.replace(" ", "T") + "Z")) / 86400_000);
      const due = last?.at ? (now - new Date(last.at.replace(" ", "T") + "Z")) / 86400_000 >= 2.9 : openedDays >= 2;
      if (missing.length && due && (await claimOnce(env, `onboarding:${id}:${today}`))) {
        const changes = missing.filter((i) => i.status === "needs_changes");
        await emailClient(env, bundle.client, {
          subject: `${missing.length} item${missing.length === 1 ? "" : "s"} left before your build week · ${p.title}`,
          heading: "A few things left before your build week starts",
          paragraphs: [
            "Your build week starts the business day after your onboarding is approved. Still needed:",
            `<ul>${missing.map((i) => `<li>${esc(i.label)}${i.status === "needs_changes" ? ` <em>(needs changes${i.admin_note ? `: ${esc(i.admin_note)}` : ""})</em>` : ""}</li>`).join("")}</ul>`,
            changes.length ? "" : "If something isn't available, you can request an exception on that item and explain why.",
          ].filter(Boolean),
          button: { label: "Finish onboarding", url: portalLink(env, id, "onboarding") },
        });
        await activity(env, id, "system", "reminder", `Onboarding reminder: ${missing.length} item(s) missing`);
        report.onboardingReminders++;
      }
    }

    // Preview waiting past the feedback window: nudge on the first overdue day, then every 3 business days
    if (p.status === "awaiting_feedback") {
      const hold = bundle.holds.find((h) => h.kind === "feedback" && !h.end_date);
      if (hold) {
        const waited = businessDaysBetween(hold.start_date, addDays(today, 1), closed);
        const over = waited - hold.grace_days;
        const last = await first(env, "SELECT MAX(sent_at) AS at FROM sent_log WHERE key LIKE ?", `feedback:${id}:${hold.id}:%`);
        const recent = last?.at && (now - new Date(last.at.replace(" ", "T") + "Z")) / 86400_000 < 2.9;
        if (over >= 1 && !recent && (await claimOnce(env, `feedback:${id}:${hold.id}:${today}`))) {
          const review = bundle.reviews.find((r) => r.status === "open");
          const state = await projectState(env, bundle, today);
          await emailClient(env, bundle.client, {
            subject: `Waiting on your feedback · ${p.title}`,
            heading: "Your preview is waiting for you",
            paragraphs: [
              `“${esc(review?.title || "Your preview")}” has been ready since ${fmtDate(hold.start_date)}. While it waits, your delivery date moves back a day for each business day.`,
              state.schedule.due ? `Current delivery target: <strong>${fmtDate(state.schedule.due)}</strong>.` : "",
            ].filter(Boolean),
            button: { label: "Review it now", url: portalLink(env, id, "previews") },
          });
          await activity(env, id, "system", "reminder", `Feedback overdue by ${over} business day(s)`);
          report.feedbackNudges++;
        }
      }
    }

    // Quote not answered after 4 days: one follow-up
    if (p.status === "quote" && p.quote_sent_at) {
      const age = (now - new Date(p.quote_sent_at.replace(" ", "T") + "Z")) / 86400_000;
      if (age >= 4 && (await claimOnce(env, `quote-followup:${id}`))) {
        await emailClient(env, bundle.client, {
          subject: `Your quote is ready when you are · ${p.title}`,
          heading: "Just checking in on your quote",
          paragraphs: ["Your quote and agreement are waiting in your project dashboard. Questions? Reply to this email and I'll help."],
          button: { label: "View your quote", url: portalLink(env, id) },
        });
        report.quoteFollowUps++;
      }
    }
  }

  // Overdue invoices: weekly, up to 3 reminders
  if (workday) {
    const overdue = await all(env, "SELECT * FROM invoices WHERE status = 'open' AND due_date IS NOT NULL AND due_date < ? AND reminder_count < 3", today);
    for (const inv of overdue) {
      if (inv.reminded_at && (now - new Date(inv.reminded_at.replace(" ", "T") + "Z")) / 86400_000 < 6.9) continue;
      if (!(await claimOnce(env, `invoice:${inv.id}:${inv.reminder_count + 1}`))) continue;
      const client = await first(env, "SELECT * FROM clients WHERE id = ?", inv.client_id);
      await emailClient(env, client, {
        subject: `Reminder: ${inv.number} is due · ${money(inv.amount_cents)}`,
        heading: "A friendly payment reminder",
        paragraphs: [`${esc(inv.label)} (${inv.number}) for <strong>${money(inv.amount_cents)}</strong> was due ${fmtDate(inv.due_date)}. You can pay securely by card from your dashboard.`],
        button: { label: "Pay now", url: inv.project_id ? portalLink(env, inv.project_id, "billing") : `${siteUrl(env)}/portal/` },
      });
      await env.DB.prepare("UPDATE invoices SET reminder_count = reminder_count + 1, reminded_at = datetime('now') WHERE id = ?").bind(inv.id).run();
      await activity(env, inv.project_id, "system", "reminder", `Payment reminder ${inv.reminder_count + 1} of 3 for ${inv.number}`);
      report.invoiceReminders++;
    }
  }

  // Morning digest for the studio
  const a = await attention(env, today);
  const lines = [];
  const L = (arr, f) => arr.forEach((x) => lines.push(f(x)));
  L(a.toReview, (x) => `Review “${esc(x.label)}” · ${esc(x.title)}`);
  L(a.exceptions, (x) => `Exception requested: “${esc(x.label)}” · ${esc(x.title)}`);
  L(a.changes, (x) => `Revisions to make · ${esc(x.title)}`);
  L(a.late, (x) => `<strong>Past delivery target</strong> (${fmtDate(x.due_date)}) · ${esc(x.title)}`);
  L(a.dueSoon, (x) => `Due ${fmtDate(x.due_date)} · ${esc(x.title)}`);
  L(a.launch, (x) => `Ready to launch · ${esc(x.title)}`);
  L(a.unread, (x) => `${x.n} unread message${x.n === 1 ? "" : "s"} · ${esc(x.title)}`);
  L(a.newLeads, (x) => `New inquiry: ${esc(x.name)}${x.business ? ` (${esc(x.business)})` : ""}`);
  L(a.overdueInvoices, (x) => `Overdue ${x.number}: ${money(x.amount_cents)} · ${esc(x.client_name)}`);
  L(a.feedbackOverdue, (x) => `Client feedback overdue since ${fmtDate(x.waiting_since)} · ${esc(x.title)} (clock held)`);
  if (lines.length && workday && (await claimOnce(env, `digest:${today}`))) {
    await emailStudio(env, {
      subject: `Today: ${lines.length} thing${lines.length === 1 ? "" : "s"} for you`,
      heading: `Good morning. ${lines.length} thing${lines.length === 1 ? "" : "s"} need${lines.length === 1 ? "s" : ""} you today`,
      paragraphs: [`<ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`],
      button: { label: "Open the dashboard", url: `${siteUrl(env)}/admin/` },
    });
    report.digest = true;
  }
  return report;
}

/** Hourly: only start projects whose day 1 has arrived (so the client hears on time). */
export async function runHourly(env) {
  const due = await all(env, "SELECT id FROM projects WHERE status = 'ready_to_start' AND start_date <= ?", todayET());
  for (const { id } of due) await advance(env, id, "system");
}

export { STATUSES };
