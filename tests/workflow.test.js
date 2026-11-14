// The project workflow: agreements, onboarding approvals and exceptions, the start rule, previews,
// revisions, clock holds, launch, and the automatic reminders.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "./support/site.mjs";
import { runDaily } from "../src/lib/automation.js";
import { quoteSent, acceptAgreement, payDeposit, submitOnboarding, approveAll, readyProject, webhook, paidEvent, project } from "./support/flow.mjs";
import { todayET, nextBusinessDay, addBusinessDays, addDays, isBusinessDay, businessDaysBetween } from "../src/lib/timeline.js";

let site;
before(async () => (site = await startSite()));
after(() => site.stop());
beforeEach(() => site.reset());

const items = (id) => site.db.all("SELECT * FROM onboarding_items WHERE project_id = ? ORDER BY sort", id);
const emailsTo = (to, re) => site.outside.emails.filter((e) => e.to[0] === to && (!re || re.test(e.subject)));
/** A date `n` business days before today. */
const businessDaysAgo = (n) => {
  let d = todayET();
  let k = 0;
  while (k < n) {
    d = addDays(d, -1);
    if (isBusinessDay(d)) k++;
  }
  return d;
};

// ───────── Agreements ─────────
test("accepting an agreement needs the consent box, a typed name and the unchanged text", async () => {
  const { id, cookie } = await quoteSent(site);
  const a = await site.db.first("SELECT * FROM agreements WHERE project_id = ? AND status = 'pending'", id);
  assert.match(a.body, /DRAFT FOR ATTORNEY REVIEW/);
  assert.match(a.body, /\$150/);
  const url = `/api/portal/agreements/${a.id}/accept`;
  assert.equal((await site.call("POST", url, { as: cookie, body: { name: "Jo Baker" } })).status, 400, "no consent");
  assert.equal((await site.call("POST", url, { as: cookie, body: { consent: true, name: " " } })).status, 400, "no name");
  assert.equal((await site.call("POST", url, { as: cookie, body: { consent: "yes", name: "Jo" } })).status, 400, "consent must be true");
  assert.equal((await site.call("POST", url, { as: cookie, body: { consent: true, name: "Jo Baker", hash: "0".repeat(64) } })).status, 409, "text changed");
  const ok = await site.call("POST", url, { as: cookie, body: { consent: true, name: "Jo Baker", hash: a.body_hash }, headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "TestBrowser" } });
  assert.equal(ok.status, 200);
  const rec = await site.db.first("SELECT * FROM agreements WHERE id = ?", a.id);
  assert.equal(rec.status, "accepted");
  assert.equal(rec.accepted_name, "Jo Baker");
  assert.equal(rec.accepted_email, "jo@example.com");
  assert.equal(rec.accepted_ip, "203.0.113.9");
  assert.equal(rec.version, 1);
  assert.ok(rec.accepted_at && rec.consent_text);
  assert.equal((await site.call("POST", url, { as: cookie, body: { consent: true, name: "Jo" } })).status, 409, "only once");
  // The printable copy shows the acceptance record
  const doc = await site.call("GET", `/api/portal/agreements/${a.id}/document`, { as: cookie });
  assert.match(doc.data, /Accepted<\/strong> by Jo Baker/);
  assert.equal((await project(site, id)).status, "quote", "still waiting on the deposit");
});

test("editing a template makes a new version; accepted agreements keep their exact text", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const before = await site.db.first("SELECT body FROM agreements WHERE project_id = ?", id);
  const r = await site.call("POST", "/api/admin/agreement-templates", { as: "admin", body: { slug: "project", title: "Website Project Agreement", body: "New terms {{price}}" } });
  assert.equal(r.data.version, 2);
  assert.equal((await site.db.first("SELECT body FROM agreements WHERE project_id = ? AND status = 'accepted'", id)).body, before.body);
  const { id: id2 } = await quoteSent(site, { email: "new@example.com" });
  assert.equal((await site.db.first("SELECT version, body FROM agreements WHERE project_id = ?", id2)).body, "New terms $150");
});

test("price and scope are locked once accepted; a revised quote needs a new acceptance", async () => {
  const { id, cookie } = await quoteSent(site);
  assert.equal((await site.call("PATCH", `/api/admin/projects/${id}`, { as: "admin", body: { price: "200" } })).status, 200, "free to change while it's a quote");
  await site.call("POST", `/api/admin/projects/${id}/send-quote`, { as: "admin", body: {} });
  assert.equal((await site.db.all("SELECT * FROM agreements WHERE project_id = ? AND status = 'pending'", id)).length, 1, "re-sending voids the older copy");
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  assert.equal((await site.call("PATCH", `/api/admin/projects/${id}`, { as: "admin", body: { price: "999" } })).status, 409);
  assert.equal((await site.call("PATCH", `/api/admin/projects/${id}`, { as: "admin", body: { scope: ["More"] } })).status, 409);
  assert.equal((await project(site, id)).price_cents, 20000);
  const rev = await site.call("POST", `/api/admin/projects/${id}/send-quote`, { as: "admin", body: { revise: true, price: "300" } });
  assert.equal(rev.status, 200);
  assert.equal((await project(site, id)).price_cents, 30000);
  assert.equal((await site.db.first("SELECT COUNT(*) AS n FROM agreements WHERE project_id = ? AND status = 'pending'", id)).n, 1, "client must accept the revision");
  const open = await site.db.all("SELECT amount_cents, status FROM invoices WHERE project_id = ? AND status NOT IN ('void','paid')", id);
  assert.deepEqual(open.map((i) => i.amount_cents), [20000], "balance = new price − deposit already paid");
});

// ───────── Onboarding approvals ─────────
test("only the studio can approve; clients submit, and approved items are locked", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  const [contact] = await items(id);
  const put = (body) => site.call("PUT", `/api/portal/projects/${id}/items/${contact.id}`, { as: cookie, body });
  // Trying to set a status from the client does nothing
  await put({ value: { business_name: "Harbor" }, status: "approved" });
  assert.equal((await site.db.first("SELECT status FROM onboarding_items WHERE id = ?", contact.id)).status, "not_started");
  assert.equal((await put({ value: { business_name: "Harbor" }, submit: true })).status, 400, "required fields missing");
  assert.equal((await put({ value: { business_name: "Harbor", public_email: "hi@harbor.example" }, submit: true })).status, 200);
  assert.equal((await site.db.first("SELECT status FROM onboarding_items WHERE id = ?", contact.id)).status, "submitted");
  // There's no client route for reviewing at all
  assert.equal((await site.call("POST", `/api/admin/items/${contact.id}/review`, { as: cookie, body: { action: "approve" } })).status, 401);
  assert.equal((await site.call("POST", `/api/admin/items/${contact.id}/review`, { as: "admin", body: { action: "approve" } })).status, 200);
  assert.equal((await put({ value: { business_name: "Changed" } })).status, 409, "approved items are locked");
  assert.ok((await site.db.first("SELECT * FROM activity WHERE action = 'review' AND actor = 'studio'")));
});

test("needs changes: the client is told exactly what, and can resubmit", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  const about = (await items(id)).find((i) => i.key === "description");
  await site.call("PUT", `/api/portal/projects/${id}/items/${about.id}`, { as: cookie, body: { value: { about: "We bake." }, submit: true } });
  assert.equal((await site.call("POST", `/api/admin/items/${about.id}/review`, { as: "admin", body: { action: "needs_changes" } })).status, 400, "needs a note");
  await site.call("POST", `/api/admin/items/${about.id}/review`, { as: "admin", body: { action: "needs_changes", note: "Add when you opened and your specialties" } });
  const mail = emailsTo("jo@example.com", /needs a change/).pop();
  assert.match(mail.html, /Add when you opened/);
  // Saving a draft keeps "needs changes" until they resubmit
  await site.call("PUT", `/api/portal/projects/${id}/items/${about.id}`, { as: cookie, body: { value: { about: "We bake. Since 2019." } } });
  assert.equal((await site.db.first("SELECT status FROM onboarding_items WHERE id = ?", about.id)).status, "needs_changes");
  await site.call("PUT", `/api/portal/projects/${id}/items/${about.id}`, { as: cookie, body: { value: { about: "We bake. Since 2019." }, submit: true } });
  assert.equal((await site.db.first("SELECT status FROM onboarding_items WHERE id = ?", about.id)).status, "submitted");
});

test("exceptions: the client explains, only the studio grants, and a granted exception counts as done", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  await submitOnboarding(site, cookie, id);
  const team = (await items(id)).find((i) => i.key === "team");
  // Approve everything except the team bios
  for (const i of await items(id)) if (i.required && i.id !== team.id) await site.call("POST", `/api/admin/items/${i.id}/review`, { as: "admin", body: { action: "approve" } });
  await site.call("POST", `/api/admin/items/${team.id}/review`, { as: "admin", body: { action: "needs_changes", note: "Bio for Sam?" } });
  assert.equal((await site.call("POST", `/api/portal/projects/${id}/items/${team.id}/exception`, { as: cookie, body: {} })).status, 400, "a reason is required");
  assert.equal((await site.call("POST", `/api/portal/projects/${id}/items/${team.id}/exception`, { as: cookie, body: { reason: "Sam left the company" } })).status, 200);
  const att = await site.call("GET", "/api/admin/overview", { as: "admin" });
  assert.equal(att.data.attention.exceptions.length, 1);
  assert.equal((await project(site, id)).status, "awaiting_onboarding", "a requested exception still blocks the start");
  const r = await site.call("POST", `/api/admin/items/${team.id}/review`, { as: "admin", body: { action: "approve_exception", note: "Launch with the owner's bio only" } });
  assert.equal(r.data.projectStatus, "ready_to_start");
  assert.equal((await site.db.first("SELECT status FROM onboarding_items WHERE id = ?", team.id)).status, "exception_approved");
});

// ───────── The start rule ─────────
test("the clock starts the business day after agreement, deposit and onboarding are all done", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await submitOnboarding(site, cookie, id).catch(() => {}); // onboarding isn't open yet
  assert.equal((await project(site, id)).status, "quote");
  await payDeposit(site, id);
  assert.equal((await project(site, id)).status, "awaiting_onboarding");
  assert.ok(emailsTo("jo@example.com", /onboarding checklist/).length);
  await submitOnboarding(site, cookie, id);
  assert.equal((await project(site, id)).status, "awaiting_onboarding", "submitting isn't approval");
  assert.ok(site.outside.alerts.some((a) => /onboarding complete/i.test(a)), "the studio hears when everything is in");
  await approveAll(site, id);
  const p = await project(site, id);
  assert.equal(p.status, "ready_to_start");
  const start = nextBusinessDay(todayET());
  assert.equal(p.start_date, start);
  assert.equal(p.due_date, addBusinessDays(start, 4));
  assert.ok(emailsTo("jo@example.com", /build week is booked/).length);
});

test("the studio can't skip the start rule by changing the status by hand", async () => {
  const { id } = await quoteSent(site);
  for (const to of ["awaiting_onboarding", "ready_to_start", "in_development", "completed"])
    assert.notEqual((await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { to } })).status, 200, to);
  assert.equal((await project(site, id)).status, "quote");
});

test("making an item optional can unblock the start; adding a required item blocks it", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  await submitOnboarding(site, cookie, id);
  await site.call("POST", `/api/admin/projects/${id}/items`, { as: "admin", body: { label: "Menu PDF", allow_files: true } });
  await approveAll(site, id); // the new item isn't submitted, so approving it is refused
  assert.equal((await project(site, id)).status, "awaiting_onboarding");
  const menu = (await items(id)).find((i) => i.label === "Menu PDF");
  await site.call("PATCH", `/api/admin/items/${menu.id}`, { as: "admin", body: { required: false } });
  assert.equal((await project(site, id)).status, "ready_to_start");
});

test("on day 1 the build starts by itself and the client is told", async () => {
  const { id } = await readyProject(site);
  await site.db.run("UPDATE projects SET start_date = ? WHERE id = ?", todayET(), id);
  await site.cron("5 * * * *");
  assert.equal((await project(site, id)).status, "in_development");
  assert.ok(emailsTo("jo@example.com", /build has started/).length);
});

// ───────── Previews, revisions, holds, launch ─────────
async function building() {
  const r = await readyProject(site);
  await site.db.run("UPDATE projects SET start_date = ? WHERE id = ?", businessDaysAgo(1), r.id);
  await site.cron("5 * * * *");
  return r;
}

test("previews hold the clock after the reply window; changes use revision rounds", async () => {
  const { id, cookie } = await building();
  const send = (body) => site.call("POST", `/api/admin/projects/${id}/preview`, { as: "admin", body });
  assert.equal((await send({ title: "Homepage", url: "https://preview.example/1" })).status, 200);
  assert.equal((await project(site, id)).status, "awaiting_feedback");
  assert.ok(emailsTo("jo@example.com", /preview is ready/).length);
  const hold = await site.db.first("SELECT * FROM project_holds WHERE project_id = ? AND kind = 'feedback'", id);
  assert.equal(hold.grace_days, 2);
  const dueBefore = (await project(site, id)).due_date;

  // The client goes quiet for several business days: 2 are their reply window, the rest move the date
  const since = businessDaysAgo(4);
  await site.db.run("UPDATE project_holds SET start_date = ? WHERE id = ?", since, hold.id);
  const held = businessDaysBetween(since, addDays(todayET(), 1)) - 2;
  assert.ok(held >= 2);
  const view = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  assert.equal(view.data.state.next.who, "client");
  assert.equal(view.data.state.schedule.delay, held);
  assert.equal(view.data.state.schedule.held, true);
  await site.cron();
  assert.equal((await project(site, id)).due_date, addBusinessDays(dueBefore, held));
  const nudges = isBusinessDay(todayET()) ? 1 : 0; // reminders only go out on business days
  assert.equal(emailsTo("jo@example.com", /Waiting on your feedback/).length, nudges);
  await site.cron();
  assert.equal(emailsTo("jo@example.com", /Waiting on your feedback/).length, nudges, "the same nudge isn't sent twice");

  // Changes: round 1 of 1
  assert.equal((await site.call("POST", `/api/portal/projects/${id}/review`, { as: cookie, body: { decision: "changes" } })).status, 400);
  const ch = await site.call("POST", `/api/portal/projects/${id}/review`, { as: cookie, body: { decision: "changes", response: "Bigger logo" } });
  assert.equal(ch.data.extra, false);
  const p = await project(site, id);
  assert.equal(p.status, "in_revision");
  assert.equal(p.revisions_used, 1);
  assert.ok((await site.db.first("SELECT end_date FROM project_holds WHERE id = ?", hold.id)).end_date, "answering closes the hold");
  // A second round is beyond what's included: allowed, but flagged to the studio
  await send({ title: "Homepage v2" });
  const extra = await site.call("POST", `/api/portal/projects/${id}/review`, { as: cookie, body: { decision: "changes", response: "And a new color" } });
  assert.equal(extra.data.extra, true);
  assert.ok(site.outside.alerts.some((a) => /extra round/.test(a)));
});

test("final sign-off, final payment, then launch", async () => {
  const { id, cookie } = await building();
  await site.call("POST", `/api/admin/projects/${id}/preview`, { as: "admin", body: { title: "Finished site", kind: "final" } });
  const review = (body) => site.call("POST", `/api/portal/projects/${id}/review`, { as: cookie, body });
  assert.equal((await review({ decision: "approve" })).status, 400, "sign-off needs a name and the box ticked");
  assert.equal((await review({ decision: "approve", name: "Jo Baker" })).status, 400);
  assert.equal((await review({ decision: "approve", name: "Jo Baker", confirm: true })).status, 200);
  assert.equal((await project(site, id)).status, "ready_for_launch");
  assert.ok(await site.db.first("SELECT * FROM activity WHERE action = 'final_approval' AND detail LIKE '%Jo Baker%'"));
  const fin = await site.db.first("SELECT * FROM invoices WHERE project_id = ? AND kind = 'final'", id);
  assert.equal(fin.status, "open", "the final payment becomes due");
  assert.ok(emailsTo("jo@example.com", /ready to launch/).length);
  assert.equal((await site.call("POST", `/api/admin/projects/${id}/complete`, { as: "admin", body: {} })).status, 409, "not before the final payment");
  await webhook(site, paidEvent(fin));
  assert.equal((await site.call("POST", `/api/admin/projects/${id}/complete`, { as: "admin", body: { live_url: "https://harbor.example" } })).status, 200);
  const p = await project(site, id);
  assert.equal(p.status, "completed");
  assert.equal(p.live_url, "https://harbor.example");
});

test("the studio can't approve the final site for the client without a stated reason", async () => {
  const { id } = await building();
  assert.equal((await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { to: "ready_for_launch" } })).status, 409);
  assert.equal((await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { to: "ready_for_launch", override_reason: "Client approved by phone on 11/20" } })).status, 200);
  assert.ok(await site.db.first("SELECT * FROM activity WHERE detail LIKE '%approved by phone%'"));
});

test("pausing needs a reason, holds the clock and resumes where it left off", async () => {
  const { id, cookie } = await building();
  assert.equal((await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { to: "paused" } })).status, 400);
  await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { to: "paused", reason: "Waiting on the new logo", owner: "client" } });
  const v = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  assert.equal(v.data.state.next.who, "client");
  assert.match(v.data.state.next.text, /new logo/);
  assert.equal(v.data.state.schedule.held, true);
  await site.db.run("UPDATE project_holds SET start_date = ? WHERE project_id = ? AND kind = 'pause'", businessDaysAgo(2), id);
  const dueBefore = (await project(site, id)).due_date;
  await site.call("POST", `/api/admin/projects/${id}/status`, { as: "admin", body: { action: "resume" } });
  const p = await project(site, id);
  assert.equal(p.status, "in_development");
  assert.equal(p.due_date, addBusinessDays(dueBefore, 2), "two paused business days move the date by two");
});

// ───────── Automation ─────────
// Reminders only go out on business days, so these run the daily job as if it were the next weekday morning
const workdayMorning = () => new Date(`${isBusinessDay(todayET()) ? todayET() : nextBusinessDay(todayET())}T15:00:00Z`);
const daily = () => runDaily(site.env, { now: workdayMorning() });
test("missing materials: one reminder email naming exactly what's missing, and a studio digest", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  await site.db.run("UPDATE projects SET updated_at = datetime('now', '-3 days') WHERE id = ?", id);
  const logo = (await items(id)).find((i) => i.key === "logo");
  await site.call("PUT", `/api/portal/projects/${id}/items/${logo.id}`, { as: cookie, body: { value: { notes: "attached" } } });
  const where = (await items(id)).find((i) => i.key === "location");
  await site.call("PUT", `/api/portal/projects/${id}/items/${where.id}`, { as: cookie, body: { value: { based: "Reston" }, submit: true } });
  await daily();
  await daily();
  const reminders = emailsTo("jo@example.com", /left before your build week/);
  assert.equal(reminders.length, 1, "sent once, however often the job runs");
  assert.match(reminders[0].html, /Photos and visual assets/);
  assert.match(reminders[0].html, /Logo files/);
  assert.ok(!reminders[0].html.includes("Location and service area"), "submitted items aren't nagged about");
  const digest = emailsTo("studio@example.com", /thing.* for you/);
  assert.equal(digest.length, 1, "one morning digest");
  assert.match(digest[0].html, /Review “Location and service area”/);
});

test("no reminders go out on weekends", async () => {
  const { id } = await quoteSent(site);
  await site.db.run("UPDATE projects SET quote_sent_at = datetime('now', '-5 days') WHERE id = ?", id);
  let sat = todayET();
  while (new Date(sat + "T12:00:00Z").getUTCDay() !== 6) sat = addDays(sat, 1);
  await runDaily(site.env, { now: new Date(`${sat}T15:00:00Z`) });
  assert.equal(emailsTo("jo@example.com", /quote is ready when you are/).length, 0);
});

test("a quote left unanswered gets one follow-up", async () => {
  const { id } = await quoteSent(site);
  await site.db.run("UPDATE projects SET quote_sent_at = datetime('now', '-5 days') WHERE id = ?", id);
  await daily();
  await daily();
  assert.equal(emailsTo("jo@example.com", /quote is ready when you are/).length, 1);
});

test("overdue invoices get at most three weekly reminders", async () => {
  const { id } = await quoteSent(site);
  const inv = await site.call("POST", "/api/admin/invoices", { as: "admin", body: { project_id: id, label: "Extra", amount: "50", due_date: addDays(todayET(), -10), send: true } });
  for (let i = 0; i < 5; i++) {
    await daily();
    await site.db.run("UPDATE invoices SET reminded_at = datetime('now', '-8 days') WHERE id = ? AND reminded_at IS NOT NULL", inv.data.invoice.id);
  }
  assert.equal(emailsTo("jo@example.com", /Reminder: FD-/).length, 3);
});

test("the dashboard shows whose turn it is on every project", async () => {
  const a = await quoteSent(site, { email: "a@example.com" });
  const b = await readyProject(site, { email: "b@example.com" });
  const o = await site.call("GET", "/api/admin/overview", { as: "admin" });
  const byId = Object.fromEntries(o.data.projects.map((p) => [p.id, p]));
  assert.equal(byId[a.id].next.who, "client");
  assert.equal(byId[b.id].next.who, "studio");
});

test("every change is in the audit trail with who did it", async () => {
  const { id } = await readyProject(site);
  const actors = new Set((await site.db.all("SELECT actor FROM activity WHERE project_id = ?", id)).map((r) => r.actor.split(":")[0]));
  for (const a of ["studio", "client", "stripe"]) assert.ok(actors.has(a), a);
});
