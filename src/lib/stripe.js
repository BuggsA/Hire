// Stripe: hosted Checkout for invoices (deposits, milestones, final payments, installments, custom
// invoices) and for care-plan subscriptions. Card details only ever go to Stripe's own page.
// Payment status changes come from verified webhooks only, never from the browser's return trip.
//
// Secrets: STRIPE_SECRET_KEY (sk_live_… or sk_test_…) and STRIPE_WEBHOOK_SECRET (whsec_…).
// Webhook endpoint: https://<site>/api/stripe/webhook with the events listed in README.
import { first, run, all, activity } from "./db.js";
import { safeEqual, siteUrl, money } from "./http.js";
import { advance, loadProject } from "./workflow.js";
import { alertStudio, emailClient } from "./notify.js";

const API = (env) => env.STRIPE_API_URL || "https://api.stripe.com";

/** Stripe's form encoding for nested objects: a[b][0][c]=… */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, body, idempotencyKey) {
  const r = await fetch(API(env) + path, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2024-06-20",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? form(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Stripe HTTP ${r.status}`), { status: 502 });
  return data;
}

export const stripeReady = (env) => !!env.STRIPE_SECRET_KEY;

async function customerFor(env, client) {
  if (client.stripe_customer_id) return client.stripe_customer_id;
  const c = await stripe(env, "POST", "/v1/customers", { email: client.email, name: client.name, metadata: { client_id: client.id } }, `customer-${client.id}`);
  await run(env, "UPDATE clients SET stripe_customer_id = ? WHERE id = ?", c.id, client.id);
  return c.id;
}

/** A Checkout page for one open invoice. The amount always comes from the database. */
export async function invoiceCheckout(env, invoice, client) {
  if (invoice.status !== "open") throw Object.assign(new Error(invoice.status === "paid" ? "This invoice is already paid" : "This invoice isn't ready to pay yet"), { status: 409 });
  const base = siteUrl(env);
  const hash = invoice.project_id ? `#/project/${invoice.project_id}/billing` : "";
  const session = await stripe(
    env,
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "payment",
      customer: await customerFor(env, client),
      client_reference_id: String(invoice.id),
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: invoice.amount_cents, product_data: { name: `${invoice.label} · ${invoice.number}` } } }],
      payment_intent_data: { description: `${invoice.number}: ${invoice.label}`, metadata: { invoice_id: invoice.id } },
      metadata: { invoice_id: invoice.id, kind: "invoice" },
      success_url: `${base}/portal/?paid=${invoice.id}${hash}`,
      cancel_url: `${base}/portal/${hash}`,
    },
    // One Checkout page per invoice amount per 10 minutes; a second click reuses it
    `inv-${invoice.id}-${invoice.amount_cents}-${Math.floor(Date.now() / 600_000)}`
  );
  await run(env, "UPDATE invoices SET stripe_session_id = ? WHERE id = ?", session.id, invoice.id);
  return session.url;
}

/** A Checkout page that starts a monthly subscription for an offered care plan. */
export async function subscriptionCheckout(env, sub, client) {
  if (sub.status !== "offered") throw Object.assign(new Error("This plan is already set up"), { status: 409 });
  const hash = sub.project_id ? `#/project/${sub.project_id}/billing` : "";
  const session = await stripe(
    env,
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      customer: await customerFor(env, client),
      client_reference_id: `sub-${sub.id}`,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: sub.monthly_cents, recurring: { interval: "month" }, product_data: { name: sub.name } } }],
      subscription_data: { metadata: { subscription_id: sub.id } },
      metadata: { subscription_id: sub.id, kind: "subscription" },
      success_url: `${siteUrl(env)}/portal/?subscribed=${sub.id}${hash}`,
      cancel_url: `${siteUrl(env)}/portal/${hash}`,
    },
    `sub-${sub.id}-${Math.floor(Date.now() / 600_000)}`
  );
  await run(env, "UPDATE subscriptions SET stripe_session_id = ? WHERE id = ?", session.id, sub.id);
  return session.url;
}

/** Ask Stripe to stop a subscription at the end of the current period. */
export async function cancelSubscription(env, sub) {
  if (sub.stripe_subscription_id && stripeReady(env)) await stripe(env, "POST", `/v1/subscriptions/${sub.stripe_subscription_id}`, { cancel_at_period_end: "true" });
}

// ───────── Webhooks ─────────
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Check the Stripe-Signature header (HMAC-SHA256 of "t.payload", 5-minute tolerance). */
export async function verifySignature(env, payload, header, nowSec = Math.floor(Date.now() / 1000)) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(",").map((s) => s.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, expected));
}

/** Record a payment on an invoice (Stripe or manual). Idempotent per reference. Returns true if newly paid. */
export async function markInvoicePaid(env, invoice, { method, reference, amount_cents, note, actor }) {
  const ins = await run(
    env,
    "INSERT INTO payments (client_id, invoice_id, amount_cents, method, reference, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(method, reference) DO NOTHING",
    invoice.client_id, invoice.id, amount_cents, method, reference, note || null
  );
  if (!ins.meta?.changes) return false;
  const upd = await run(env, "UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status != 'paid'", invoice.id);
  await activity(env, invoice.project_id, actor, "payment", `${invoice.number} paid: ${money(amount_cents)} (${method})${note ? `: ${note}` : ""}`);
  if (invoice.project_id) await advance(env, invoice.project_id, actor);
  return !!upd.meta?.changes;
}

/** Handle one verified event. Returns a short description for the log. */
export async function handleEvent(env, event) {
  // Each event is handled once, however many times Stripe delivers it
  const fresh = await run(env, "INSERT INTO stripe_events (id, type) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", event.id, event.type);
  if (!fresh.meta?.changes) return "duplicate";
  try {
    return await dispatch(env, event);
  } catch (e) {
    // Let Stripe retry later
    await run(env, "DELETE FROM stripe_events WHERE id = ?", event.id);
    throw e;
  }
}

async function dispatch(env, event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (o.mode === "payment") {
        if (o.payment_status !== "paid") return "awaiting payment";
        const invoice = await first(env, "SELECT * FROM invoices WHERE id = ?", Number(o.metadata?.invoice_id));
        if (!invoice) return "unknown invoice";
        // The amount and currency must match what the invoice says
        if (o.amount_total !== invoice.amount_cents || String(o.currency).toLowerCase() !== "usd") {
          await activity(env, invoice.project_id, "stripe", "payment_mismatch", `Checkout ${o.id} paid ${o.amount_total} ${o.currency} for ${invoice.number} (${invoice.amount_cents} usd expected). Not marked paid.`);
          await alertStudio(env, `Payment amount mismatch on ${invoice.number}: check Stripe`, { title: "Payment needs a look" });
          return "amount mismatch";
        }
        const newly = await markInvoicePaid(env, invoice, { method: "stripe", reference: o.payment_intent || o.id, amount_cents: o.amount_total, actor: "stripe" });
        if (newly) {
          await alertStudio(env, `${invoice.number} paid: ${money(invoice.amount_cents)}`, { title: "Payment received", path: invoice.project_id ? `/admin/#/project/${invoice.project_id}` : "/admin/#/money" });
          const client = await first(env, "SELECT * FROM clients WHERE id = ?", invoice.client_id);
          if (client)
            await emailClient(env, client, {
              subject: `Payment received · ${invoice.number}`,
              heading: "Thank you, payment received",
              paragraphs: [`${invoice.label}: <strong>${money(invoice.amount_cents)}</strong>. A receipt from Stripe is on its way too.`],
            });
        }
        return "invoice paid";
      }
      if (o.mode === "subscription") {
        const id = Number(o.metadata?.subscription_id);
        const sub = await first(env, "SELECT * FROM subscriptions WHERE id = ?", id);
        if (!sub) return "unknown subscription";
        await run(
          env,
          "UPDATE subscriptions SET status = 'active', stripe_subscription_id = ?, started_at = COALESCE(started_at, date('now')), commitment_ends = CASE WHEN term_months > 0 THEN date('now', '+' || term_months || ' months') END WHERE id = ?",
          o.subscription, id
        );
        await activity(env, sub.project_id, "stripe", "subscription", `${sub.name} started (${money(sub.monthly_cents)}/mo)`);
        await alertStudio(env, `Care plan started: ${sub.name}`, { title: "New subscription", path: "/admin/#/money" });
        return "subscription started";
      }
      return "ignored";
    }
    case "checkout.session.async_payment_failed": {
      const invoice = await first(env, "SELECT * FROM invoices WHERE id = ?", Number(o.metadata?.invoice_id));
      if (invoice) await activity(env, invoice.project_id, "stripe", "payment_failed", `${invoice.number}: bank payment failed`);
      return "payment failed";
    }
    case "invoice.paid": {
      // Monthly subscription charges (Stripe's own invoices, not ours)
      const subId = o.subscription || o.parent?.subscription_details?.subscription;
      const sub = subId ? await first(env, "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", subId) : null;
      if (!sub) return "not ours";
      await run(env, "INSERT INTO payments (client_id, subscription_id, amount_cents, method, reference, note) VALUES (?, ?, ?, 'stripe', ?, ?) ON CONFLICT(method, reference) DO NOTHING", sub.client_id, sub.id, o.amount_paid, o.id, `${sub.name} monthly`);
      if (sub.status === "past_due") await run(env, "UPDATE subscriptions SET status = 'active' WHERE id = ?", sub.id);
      return "subscription payment";
    }
    case "invoice.payment_failed": {
      const subId = o.subscription || o.parent?.subscription_details?.subscription;
      const sub = subId ? await first(env, "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", subId) : null;
      if (!sub) return "not ours";
      await run(env, "UPDATE subscriptions SET status = 'past_due' WHERE id = ?", sub.id);
      await activity(env, sub.project_id, "stripe", "subscription", `${sub.name}: monthly payment failed`);
      await alertStudio(env, `Care plan payment failed: ${sub.name}`, { title: "Payment failed", path: "/admin/#/money" });
      return "subscription past due";
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = await first(env, "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", o.id);
      if (!sub) return "not ours";
      const map = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete_expired: "canceled" };
      const status = event.type === "customer.subscription.deleted" ? "canceled" : map[o.status] || sub.status;
      await run(env, `UPDATE subscriptions SET status = ?${status === "canceled" ? ", canceled_at = datetime('now')" : ""} WHERE id = ?`, status, sub.id);
      if (status !== sub.status) await activity(env, sub.project_id, "stripe", "subscription", `${sub.name}: ${sub.status} → ${status}`);
      return `subscription ${status}`;
    }
    default:
      return "ignored";
  }
}

/** For the admin Money tab. */
export async function revenueSummary(env) {
  const [byMonth, totals, mrr, open] = await Promise.all([
    all(env, "SELECT substr(paid_at, 1, 7) AS month, SUM(amount_cents) AS cents, COUNT(*) AS n FROM payments GROUP BY month ORDER BY month DESC LIMIT 12"),
    first(env, "SELECT COALESCE(SUM(amount_cents), 0) AS all_time, COALESCE(SUM(CASE WHEN paid_at >= date('now', 'start of year') THEN amount_cents END), 0) AS this_year FROM payments"),
    first(env, "SELECT COALESCE(SUM(monthly_cents), 0) AS cents, COUNT(*) AS n FROM subscriptions WHERE status IN ('active', 'past_due')"),
    first(env, "SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM invoices WHERE status = 'open'"),
  ]);
  return { byMonth, ...totals, mrr: mrr.cents, subscriptions: mrr.n, outstanding: open.cents, openInvoices: open.n };
}

export { loadProject };
