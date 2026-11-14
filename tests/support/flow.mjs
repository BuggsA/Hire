// Steps of a real project, through the real API, for tests to build on.
import assert from "node:assert/strict";
import { stripeSignature } from "./site.mjs";

/** The studio creates a quote and sends it. Returns { id, cookie } (the client signed in). */
export async function quoteSent(site, { email = "jo@example.com", name = "Jo Baker", price = "150", pkg = "starter" } = {}) {
  const c = await site.call("POST", "/api/admin/projects", { as: "admin", body: { client_name: name, client_email: email, client_business: "Harbor Bakery", package_slug: pkg, price } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.project.id;
  const s = await site.call("POST", `/api/admin/projects/${id}/send-quote`, { as: "admin", body: {} });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const cookie = await site.signIn(email);
  return { id, cookie };
}

export async function acceptAgreement(site, cookie, id) {
  const d = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  const a = d.data.agreements.find((x) => x.status === "pending" && !x.subscription_id);
  const r = await site.call("POST", `/api/portal/agreements/${a.id}/accept`, { as: cookie, body: { name: "Jo Baker", consent: true, hash: a.body_hash } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return a;
}

/** Deliver a Stripe webhook event, signed. */
export async function webhook(site, event, sig) {
  const payload = JSON.stringify(event);
  return site.call("POST", "/api/stripe/webhook", { body: payload, headers: { "stripe-signature": sig ?? (await stripeSignature(payload)), "content-type": "application/json" }, raw: true });
}

let n = 0;
export const paidEvent = (invoice, overrides = {}) => ({
  id: `evt_${++n}_${Date.now()}`,
  type: "checkout.session.completed",
  data: { object: { id: `cs_${n}`, mode: "payment", payment_status: "paid", amount_total: invoice.amount_cents, currency: "usd", payment_intent: `pi_${n}_${Date.now()}`, metadata: { invoice_id: String(invoice.id), kind: "invoice" }, ...overrides } },
});

/** Pay every invoice required to start, through the webhook. */
export async function payDeposit(site, id) {
  const deposits = await site.db.all("SELECT * FROM invoices WHERE project_id = ? AND required_for_start = 1 AND status = 'open'", id);
  for (const inv of deposits) assert.equal((await webhook(site, paidEvent(inv))).status, 200);
}

/** The client fills in and submits every required item. */
export async function submitOnboarding(site, cookie, id) {
  const d = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  for (const item of d.data.items.filter((i) => i.required)) {
    if (item.allow_files) {
      const up = await site.call("POST", `/api/portal/projects/${id}/items/${item.id}/files`, { as: cookie, body: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), headers: { "content-type": "image/jpeg", "x-file-name": "photo.jpg" } });
      assert.equal(up.status, 200, JSON.stringify(up.data));
    }
    const value = Object.fromEntries(item.fields.map((f) => [f.name, f.type === "email" ? "hello@harbor.example" : `Answer for ${f.label}`]));
    const r = await site.call("PUT", `/api/portal/projects/${id}/items/${item.id}`, { as: cookie, body: { value, submit: true } });
    assert.equal(r.status, 200, `${item.label}: ${JSON.stringify(r.data)}`);
  }
}

export async function approveAll(site, id) {
  const items = await site.db.all("SELECT id FROM onboarding_items WHERE project_id = ? AND required = 1", id);
  let last;
  for (const i of items) last = await site.call("POST", `/api/admin/items/${i.id}/review`, { as: "admin", body: { action: "approve" } });
  return last;
}

/** Everything up to a project that's ready to start. */
export async function readyProject(site, opts) {
  const { id, cookie } = await quoteSent(site, opts);
  await acceptAgreement(site, cookie, id);
  await payDeposit(site, id);
  await submitOnboarding(site, cookie, id);
  await approveAll(site, id);
  return { id, cookie };
}

export const project = (site, id) => site.db.first("SELECT * FROM projects WHERE id = ?", id);
