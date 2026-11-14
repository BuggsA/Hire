// Payments: amounts come from the database, status changes only from signed webhooks, each event once.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSite, stripeSignature } from "./support/site.mjs";
import { quoteSent, acceptAgreement, webhook, paidEvent, project } from "./support/flow.mjs";

let site;
before(async () => (site = await startSite()));
after(() => site.stop());
beforeEach(() => site.reset());

const deposit = (id) => site.db.first("SELECT * FROM invoices WHERE project_id = ? AND required_for_start = 1 AND status != 'void'", id);

test("sending a quote makes a deposit (before the build) and a final payment (at launch)", async () => {
  const { id } = await quoteSent(site, { price: "150" });
  const inv = await site.db.all("SELECT * FROM invoices WHERE project_id = ? AND status != 'void' ORDER BY id", id);
  assert.deepEqual(inv.map((i) => [i.kind, i.amount_cents, i.status]), [["deposit", 7500, "open"], ["final", 7500, "draft"]]);
  assert.equal(inv[1].required_for_launch, 1);
});

test("the deposit can't be paid before the agreement is accepted", async () => {
  const { id, cookie } = await quoteSent(site);
  const inv = await deposit(id);
  assert.equal((await site.call("POST", `/api/portal/invoices/${inv.id}/checkout`, { as: cookie })).status, 409);
});

test("checkout uses the invoice amount from the database, never the browser", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  const r = await site.call("POST", `/api/portal/invoices/${inv.id}/checkout`, { as: cookie, body: { amount: 1 } });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /^https:\/\/checkout\.stripe\.com\//);
  const call = site.outside.stripe.find((c) => c.path === "/v1/checkout/sessions");
  assert.equal(call.params["line_items[0][price_data][unit_amount]"], String(inv.amount_cents));
  assert.equal(call.params["metadata[invoice_id]"], String(inv.id));
  assert.equal(call.params.mode, "payment");
  assert.ok(call.headers["idempotency-key"]);
});

test("returning from Stripe doesn't mark anything paid; only a signed webhook does", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  await site.call("GET", `/portal/?paid=${inv.id}`, { as: cookie });
  assert.equal((await deposit(id)).status, "open");

  const event = paidEvent(inv);
  const payload = JSON.stringify(event);
  assert.equal((await webhook(site, event, "t=1,v1=deadbeef")).status, 400, "bad signature");
  assert.equal((await webhook(site, event, await stripeSignature(payload, { secret: "whsec_wrong" }))).status, 400, "wrong secret");
  assert.equal((await webhook(site, event, await stripeSignature(payload, { t: Math.floor(Date.now() / 1000) - 3600 }))).status, 400, "replayed old event");
  assert.equal((await deposit(id)).status, "open");

  assert.equal((await webhook(site, event)).status, 200);
  assert.equal((await deposit(id)).status, "paid");
  assert.equal((await project(site, id)).status, "awaiting_onboarding", "agreement + deposit → onboarding opens");
});

test("a webhook delivered twice records one payment", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const event = paidEvent(await deposit(id));
  await webhook(site, event);
  const again = await webhook(site, event);
  assert.equal(again.data.result, "duplicate");
  // Even a different event for the same payment intent doesn't double count
  await webhook(site, { ...event, id: event.id + "_b" });
  assert.equal((await site.db.first("SELECT COUNT(*) AS n FROM payments")).n, 1);
});

test("a payment for the wrong amount is not accepted and the studio is alerted", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  const r = await webhook(site, paidEvent(inv, { amount_total: 100 }));
  assert.equal(r.data.result, "amount mismatch");
  assert.equal((await deposit(id)).status, "open");
  assert.ok(site.outside.alerts.some((a) => /mismatch/i.test(a)));
});

test("unpaid checkouts (bank transfers still clearing) don't count", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  await webhook(site, paidEvent(inv, { payment_status: "unpaid" }));
  assert.equal((await deposit(id)).status, "open");
});

test("the studio can record an offline payment, with a note, once", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  assert.equal((await site.call("POST", `/api/admin/invoices/${inv.id}/mark-paid`, { as: "admin", body: {} })).status, 400, "needs a note");
  assert.equal((await site.call("POST", `/api/admin/invoices/${inv.id}/mark-paid`, { as: "admin", body: { note: "Check #1042" } })).status, 200);
  assert.equal((await site.call("POST", `/api/admin/invoices/${inv.id}/mark-paid`, { as: "admin", body: { note: "again" } })).status, 409);
  assert.equal((await project(site, id)).status, "awaiting_onboarding");
  assert.ok((await site.db.first("SELECT * FROM activity WHERE action = 'payment'")).detail.includes("Check #1042"));
});

test("paid invoices can't be edited or voided; clients can't pay drafts", async () => {
  const { id, cookie } = await quoteSent(site);
  await acceptAgreement(site, cookie, id);
  const inv = await deposit(id);
  await webhook(site, paidEvent(inv));
  assert.equal((await site.call("PATCH", `/api/admin/invoices/${inv.id}`, { as: "admin", body: { amount: "1" } })).status, 409);
  assert.equal((await site.call("POST", `/api/admin/invoices/${inv.id}/void`, { as: "admin" })).status, 409);
  const fin = await site.db.first("SELECT * FROM invoices WHERE project_id = ? AND kind = 'final'", id);
  assert.equal((await site.call("POST", `/api/portal/invoices/${fin.id}/checkout`, { as: cookie })).status, 409, "the final payment isn't due yet");
});

test("custom invoices and installment plans", async () => {
  const { id, cookie } = await quoteSent(site);
  const r = await site.call("POST", "/api/admin/invoices", { as: "admin", body: { project_id: id, label: "Extra pages", amount: "100", send: true } });
  assert.equal(r.status, 200);
  assert.equal((await site.db.first("SELECT status FROM invoices WHERE id = ?", r.data.invoice.id)).status, "open");
  assert.ok(site.outside.emails.some((e) => /Invoice FD-/.test(e.subject)));
  const split = await site.call("POST", `/api/admin/invoices/${r.data.invoice.id}/split`, { as: "admin", body: { count: 3, first_due: "2026-12-01", every_days: 30 } });
  assert.equal(split.status, 200);
  const parts = await site.db.all("SELECT amount_cents, due_date FROM invoices WHERE kind = 'installment' ORDER BY id");
  assert.deepEqual(parts.map((p) => p.amount_cents), [3333, 3333, 3334]);
  assert.deepEqual(parts.map((p) => p.due_date), ["2026-12-01", "2026-12-31", "2027-01-30"]);
  const d = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  assert.equal(d.data.invoices.filter((i) => i.kind === "installment").length, 3);
});

test("care plans: agreement first, then a Stripe subscription; renewals and cancellation tracked", async () => {
  const { id, cookie } = await quoteSent(site);
  const client = await site.db.first("SELECT client_id FROM projects WHERE id = ?", id);
  const offer = await site.call("POST", "/api/admin/subscriptions", { as: "admin", body: { client_id: client.client_id, project_id: id, plan_slug: "care-6" } });
  assert.equal(offer.status, 200);
  const sub = offer.data.subscription;
  assert.equal(sub.monthly_cents, 2000);
  assert.equal(sub.term_months, 6);
  assert.equal((await site.call("POST", `/api/portal/subscriptions/${sub.id}/checkout`, { as: cookie })).status, 409, "agreement first");
  const a = await site.db.first("SELECT * FROM agreements WHERE subscription_id = ?", sub.id);
  assert.equal(a.template_slug, "care");
  assert.match(a.body, /\$20 per month/);
  await site.call("POST", `/api/portal/agreements/${a.id}/accept`, { as: cookie, body: { name: "Jo Baker", consent: true } });
  const co = await site.call("POST", `/api/portal/subscriptions/${sub.id}/checkout`, { as: cookie });
  assert.equal(co.status, 200);
  const call = site.outside.stripe.filter((c) => c.path === "/v1/checkout/sessions").pop();
  assert.equal(call.params.mode, "subscription");
  assert.equal(call.params["line_items[0][price_data][recurring][interval]"], "month");
  assert.equal(call.params["line_items[0][price_data][unit_amount]"], "2000");

  await webhook(site, { id: "evt_sub1", type: "checkout.session.completed", data: { object: { id: "cs_sub", mode: "subscription", subscription: "sub_123", metadata: { subscription_id: String(sub.id) } } } });
  let s = await site.db.first("SELECT * FROM subscriptions WHERE id = ?", sub.id);
  assert.equal(s.status, "active");
  assert.ok(s.commitment_ends);
  await webhook(site, { id: "evt_inv1", type: "invoice.paid", data: { object: { id: "in_1", subscription: "sub_123", amount_paid: 2000 } } });
  await webhook(site, { id: "evt_inv2", type: "invoice.payment_failed", data: { object: { id: "in_2", subscription: "sub_123" } } });
  assert.equal((await site.db.first("SELECT status FROM subscriptions WHERE id = ?", sub.id)).status, "past_due");
  await webhook(site, { id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_123", status: "canceled" } } });
  s = await site.db.first("SELECT * FROM subscriptions WHERE id = ?", sub.id);
  assert.equal(s.status, "canceled");
  assert.equal((await site.db.first("SELECT COUNT(*) AS n FROM payments WHERE subscription_id = ?", sub.id)).n, 1);
  const rev = await site.call("GET", "/api/admin/money", { as: "admin" });
  assert.equal(rev.data.revenue.all_time, 2000);
});

test("without Stripe keys, online payment says so instead of failing", async () => {
  site.setVars({ STRIPE_SECRET_KEY: undefined });
  try {
    const { id, cookie } = await quoteSent(site);
    await acceptAgreement(site, cookie, id);
    const r = await site.call("POST", `/api/portal/invoices/${(await deposit(id)).id}/checkout`, { as: cookie });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /isn't switched on/);
  } finally {
    site.setVars({ STRIPE_SECRET_KEY: "sk_test_x" });
  }
});
