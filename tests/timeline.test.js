// The delivery-clock rules, without a database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addBusinessDays, nextBusinessDay, businessDaysBetween, schedule, startBlockers, holdDelay, todayET } from "../src/lib/timeline.js";

// 2026-11-16 is a Monday
test("business days skip weekends and closed dates", () => {
  assert.equal(nextBusinessDay("2026-11-13"), "2026-11-16"); // Fri → Mon
  assert.equal(addBusinessDays("2026-11-16", 4), "2026-11-20"); // Mon + 4 = Fri
  assert.equal(addBusinessDays("2026-11-16", 4, ["2026-11-18"]), "2026-11-23"); // a closed Wednesday pushes to Mon
  assert.equal(addBusinessDays("2026-11-14", 0), "2026-11-16"); // a Saturday start rolls to Monday
  assert.equal(businessDaysBetween("2026-11-16", "2026-11-23"), 5);
});

test("a five-day build that starts Monday is due Friday", () => {
  const s = schedule({ start: "2026-11-16", turnaround: 5, today: "2026-11-16" });
  assert.equal(s.due, "2026-11-20");
  assert.equal(s.daysUsed, 1);
  assert.equal(s.delay, 0);
});

test("the target spans weekends and holidays", () => {
  const s = schedule({ start: "2026-11-19", turnaround: 5, closed: ["2026-11-26", "2026-11-27"], today: "2026-11-19" });
  assert.equal(s.due, "2026-11-25"); // Thu, Fri, Mon, Tue, Wed
  const s2 = schedule({ start: "2026-11-24", turnaround: 5, closed: ["2026-11-26", "2026-11-27"], today: "2026-11-24" });
  assert.equal(s2.due, "2026-12-02"); // Tue, Wed, (Thanksgiving off) Mon, Tue, Wed
});

test("an answer within the client's reply window doesn't move the date", () => {
  const hold = { kind: "feedback", start_date: "2026-11-17", end_date: "2026-11-19", grace_days: 2 }; // Tue → answered Thu morning
  assert.equal(holdDelay(hold, "2026-11-19"), 0);
  assert.equal(schedule({ start: "2026-11-16", turnaround: 5, holds: [hold], today: "2026-11-19" }).due, "2026-11-20");
});

test("each business day past the reply window moves the date by a day", () => {
  const hold = { kind: "feedback", start_date: "2026-11-17", end_date: "2026-11-23", grace_days: 2 }; // Tue → answered next Mon
  // Held business days: Tue, Wed, Thu, Fri = 4, minus 2 grace = 2
  assert.equal(holdDelay(hold, "2026-11-23"), 2);
  assert.equal(schedule({ start: "2026-11-16", turnaround: 5, holds: [hold], today: "2026-11-23" }).due, "2026-11-24");
});

test("a hold that's still open counts today, and shows the clock as held", () => {
  const hold = { kind: "feedback", start_date: "2026-11-17", end_date: null, grace_days: 2 };
  assert.equal(holdDelay(hold, "2026-11-18"), 0); // still inside the window
  const s = schedule({ start: "2026-11-16", turnaround: 5, holds: [hold], today: "2026-11-20" });
  assert.equal(s.delay, 2); // Tue, Wed grace; Thu, Fri held
  assert.equal(s.due, "2026-11-24");
  assert.equal(s.held, true);
});

test("a pause moves the date by every business day paused", () => {
  const pause = { kind: "pause", start_date: "2026-11-18", end_date: "2026-11-25", grace_days: 0 };
  assert.equal(schedule({ start: "2026-11-16", turnaround: 5, holds: [pause], today: "2026-11-25" }).due, "2026-11-27");
});

test("the clock can't start until agreement, payment and every required item are done", () => {
  const items = [
    { required: 1, status: "approved" },
    { required: 1, status: "exception_approved" },
    { required: 0, status: "not_started" }, // optional items never block
  ];
  const paid = [{ required_for_start: 1, status: "paid", label: "Deposit" }];
  assert.equal(startBlockers({ items, invoices: paid, agreementAccepted: true }).ok, true);
  assert.equal(startBlockers({ items, invoices: paid, agreementAccepted: false }).ok, false);
  assert.equal(startBlockers({ items, invoices: [{ required_for_start: 1, status: "open", label: "Deposit" }], agreementAccepted: true }).ok, false);
  const pending = startBlockers({ items: [...items, { required: 1, status: "submitted" }], invoices: paid, agreementAccepted: true });
  assert.equal(pending.ok, false);
  assert.deepEqual(pending.missing.map((m) => m.who), ["studio"]); // submitted: the studio's turn
  const exception = startBlockers({ items: [{ required: 1, status: "not_started", exception_requested: 1 }], invoices: [], agreementAccepted: true });
  assert.equal(exception.ok, false, "a requested (not yet approved) exception still blocks");
  assert.equal(exception.missing[0].who, "studio");
});

test("today is computed in Virginia, not UTC", () => {
  assert.equal(todayET(new Date("2026-11-17T03:30:00Z")), "2026-11-16"); // 10:30pm Monday in Reston
});
