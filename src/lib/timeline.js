// The delivery clock. Pure functions (no database), so the rules are easy to read and to test.
//
// The rules, in plain words:
//  1. The clock does not start until the agreement is accepted, every required onboarding item is
//     approved (or has an approved exception), and every payment marked "required to start" is paid.
//  2. Day 1 is the first business day after that moment (weekdays, minus the studio's closed dates).
//  3. The build takes `turnaround` business days, so the target is day 1 + (turnaround − 1).
//  4. While a preview waits on the client, the client has `grace` business days to answer. Any
//     business days beyond that push the target back by the same number of days.
//  5. A pause pushes the target back by every business day it lasts.

/** Today's date in Virginia (YYYY-MM-DD), optionally shifted by whole days. */
export function todayET(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export const isDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

export function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toSet = (closed) => (closed instanceof Set ? closed : new Set(closed || []));

export function isBusinessDay(date, closed) {
  const wd = new Date(date + "T12:00:00Z").getUTCDay();
  return wd !== 0 && wd !== 6 && !toSet(closed).has(date);
}

/** The first business day strictly after `date`. */
export function nextBusinessDay(date, closed) {
  const c = toSet(closed);
  let d = addDays(date, 1);
  while (!isBusinessDay(d, c)) d = addDays(d, 1);
  return d;
}

/** `date` moved forward by n business days (n = 0 → the same date, or the next business day if it isn't one). */
export function addBusinessDays(date, n, closed) {
  const c = toSet(closed);
  let d = date;
  while (!isBusinessDay(d, c)) d = addDays(d, 1);
  for (let i = 0; i < n; i++) d = nextBusinessDay(d, c);
  return d;
}

/** Business days in [from, to) — `from` counted, `to` not. 0 if to <= from. */
export function businessDaysBetween(from, to, closed) {
  const c = toSet(closed);
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) if (isBusinessDay(d, c)) n++;
  return n;
}

/** Business days a hold pushed the target back by (as of `today` for a hold still open). */
export function holdDelay(hold, today, closed) {
  const end = hold.end_date || today;
  // A hold that is still open counts today as a held day; a closed one stops the day it ended
  const until = hold.end_date ? end : addDays(end, 1);
  const days = businessDaysBetween(hold.start_date, until, closed);
  return Math.max(0, days - (hold.grace_days || 0));
}

/**
 * The project's schedule. start: day 1 (YYYY-MM-DD) or null. Returns
 * { start, baseDue, delay, due, held, daysTotal, daysUsed, daysLeft }.
 */
export function schedule({ start, turnaround, holds = [], closed = [], today }) {
  if (!start || !turnaround) return { start: null, due: null, baseDue: null, delay: 0, held: false, daysTotal: turnaround || null, daysUsed: 0, daysLeft: turnaround || null };
  const c = toSet(closed);
  const baseDue = addBusinessDays(start, Math.max(0, turnaround - 1), c);
  const relevant = holds.filter((h) => h.start_date <= (h.end_date || today));
  const delay = relevant.reduce((sum, h) => sum + holdDelay(h, today, c), 0);
  const due = addBusinessDays(baseDue, delay, c);
  const held = relevant.some((h) => !h.end_date && holdDelay(h, today, c) > 0) || holds.some((h) => !h.end_date && h.kind === "pause");
  // Build days used so far: business days since start up to and including today, minus held days
  const elapsed = today < start ? 0 : businessDaysBetween(start, addDays(today, 1), c);
  const daysUsed = Math.min(turnaround, Math.max(0, elapsed - delay));
  return { start, baseDue, delay, due, held, daysTotal: turnaround, daysUsed, daysLeft: turnaround - daysUsed };
}

/** Day 1 for a project that became ready on `readyDate`: the next business day. */
export const startDateFor = (readyDate, closed) => nextBusinessDay(readyDate, closed);

// ───────── Can the clock start? ─────────
export const DONE_ITEM = new Set(["approved", "exception_approved"]);

/**
 * What is still blocking the start. items: onboarding rows; invoices: invoice rows; agreementAccepted: bool.
 * Returns { ok, missing: [{who, what}] }.
 */
export function startBlockers({ items = [], invoices = [], agreementAccepted }) {
  const missing = [];
  if (!agreementAccepted) missing.push({ who: "client", what: "Accept the project agreement" });
  for (const inv of invoices) if (inv.required_for_start && inv.status !== "paid" && inv.status !== "void") missing.push({ who: "client", what: `Pay ${inv.label}` });
  const required = items.filter((i) => i.required);
  const todo = required.filter((i) => !DONE_ITEM.has(i.status));
  const waitingOnStudio = todo.filter((i) => i.status === "submitted" || (i.exception_requested && i.status !== "needs_changes"));
  const waitingOnClient = todo.filter((i) => !waitingOnStudio.includes(i));
  if (waitingOnClient.length) missing.push({ who: "client", what: `Complete ${waitingOnClient.length} onboarding item${waitingOnClient.length === 1 ? "" : "s"}` });
  if (waitingOnStudio.length) missing.push({ who: "studio", what: `Review ${waitingOnStudio.length} submitted item${waitingOnStudio.length === 1 ? "" : "s"}` });
  return { ok: missing.length === 0, missing };
}

/** Onboarding progress: { done, total, percent } over required items. */
export function onboardingProgress(items = []) {
  const req = items.filter((i) => i.required);
  const done = req.filter((i) => DONE_ITEM.has(i.status)).length;
  const submitted = req.filter((i) => i.status === "submitted").length;
  return { done, submitted, total: req.length, percent: req.length ? Math.round((done / req.length) * 100) : 100 };
}
