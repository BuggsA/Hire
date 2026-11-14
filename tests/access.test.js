// Who can get in, and each client seeing only their own things.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSite, accessToken, otherKey, ADMIN } from "./support/site.mjs";
import { quoteSent } from "./support/flow.mjs";

let site;
before(async () => (site = await startSite()));
after(() => site.stop());
beforeEach(() => site.reset());

test("the dashboard and its API need the studio's login", async () => {
  assert.equal((await site.call("GET", "/api/admin/overview")).status, 401);
  assert.equal((await site.call("GET", "/admin/")).status, 401);
  assert.equal((await site.call("GET", "/api/admin/overview", { as: "admin" })).status, 200);
});

test("forged, expired, wrong-app and non-studio logins are refused", async () => {
  const tokens = [
    await accessToken(ADMIN, { signWith: await otherKey() }),
    await accessToken(ADMIN, { exp: Math.floor(Date.now() / 1000) - 60 }),
    await accessToken(ADMIN, { aud: "some-other-app" }),
    await accessToken(ADMIN, { kid: "unknown" }),
    await accessToken("someone@example.com"),
    "not.a.token",
  ];
  for (const token of tokens) assert.equal((await site.call("GET", "/api/admin/overview", { token })).status, 401);
});

test("an empty ADMIN_EMAILS locks everyone out and says why", async () => {
  site.setVars({ ADMIN_EMAILS: "" });
  try {
    const r = await site.call("GET", "/api/admin/overview", { as: "admin" });
    assert.equal(r.status, 401);
    assert.match(r.data.error, /ADMIN_EMAILS/);
  } finally {
    site.setVars({ ADMIN_EMAILS: ADMIN });
  }
});

test("the local dev bypass only works on localhost", async () => {
  site.setVars({ DEV_ADMIN_BYPASS: "1" });
  try {
    assert.equal((await site.call("GET", "/api/admin/overview")).status, 401);
    assert.equal((await site.call("GET", "/api/admin/overview", { host: "http://localhost:8787" })).status, 200);
  } finally {
    site.setVars({ DEV_ADMIN_BYPASS: undefined });
  }
});

test("changes from another website are refused, even when signed in", async () => {
  const r = await site.call("POST", "/api/admin/clients", { as: "admin", body: { name: "X", email: "x@example.com" }, headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
});

test("the client portal needs a sign-in", async () => {
  assert.equal((await site.call("GET", "/api/portal/me")).status, 401);
  assert.equal((await site.call("GET", "/api/portal/me", { as: { cookie: "fd_session=" + "a".repeat(64) } })).status, 401);
});

test("sign-in links work once, expire, and don't reveal who has an account", async () => {
  await quoteSent(site, { email: "jo@example.com" });
  const unknown = await site.call("POST", "/api/auth/login", { body: { email: "nobody@example.com" } });
  const known = await site.call("POST", "/api/auth/login", { body: { email: "jo@example.com" } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.message, known.data.message);
  assert.ok(!site.outside.emails.some((e) => e.to[0] === "nobody@example.com"));

  const mail = site.outside.emails.filter((e) => e.to[0] === "jo@example.com" && /sign-in/i.test(e.subject)).pop();
  const token = mail.text.match(/#([0-9a-f]{64})/)[1];
  assert.equal((await site.call("POST", "/api/auth/verify", { body: { token } })).status, 200);
  assert.equal((await site.call("POST", "/api/auth/verify", { body: { token } })).status, 401, "a link works only once");

  await site.call("POST", "/api/auth/login", { body: { email: "jo@example.com" } });
  const t2 = site.outside.emails.filter((e) => /sign-in/i.test(e.subject)).pop().text.match(/#([0-9a-f]{64})/)[1];
  await site.db.run("UPDATE login_tokens SET expires_at = datetime('now', '-1 minute')");
  assert.equal((await site.call("POST", "/api/auth/verify", { body: { token: t2 } })).status, 401, "expired links fail");
  // Only hashes are stored
  const stored = await site.db.all("SELECT token_hash FROM login_tokens");
  assert.ok(stored.every((r) => r.token_hash !== token && r.token_hash !== t2));
});

test("sign-in emails are limited to 5 an hour", async () => {
  await quoteSent(site, { email: "jo@example.com" });
  const before = site.outside.emails.length;
  for (let i = 0; i < 8; i++) await site.call("POST", "/api/auth/login", { body: { email: "jo@example.com" } });
  const sent = site.outside.emails.slice(before).filter((e) => /sign-in/i.test(e.subject)).length;
  assert.ok(sent <= 5, `sent ${sent}`);
});

test("signing out ends the session on the server", async () => {
  const { cookie } = await quoteSent(site);
  assert.equal((await site.call("GET", "/api/portal/me", { as: cookie })).status, 200);
  await site.call("POST", "/api/auth/logout", { as: cookie });
  assert.equal((await site.call("GET", "/api/portal/me", { as: cookie })).status, 401);
});

test("a client never sees another client's project, invoices, files or agreements", async () => {
  const a = await quoteSent(site, { email: "a@example.com", name: "Ann" });
  const b = await quoteSent(site, { email: "b@example.com", name: "Bo" });
  const mine = await site.call("GET", "/api/portal/me", { as: a.cookie });
  assert.deepEqual(mine.data.projects.map((p) => p.id), [a.id]);
  assert.equal((await site.call("GET", `/api/portal/projects/${b.id}`, { as: a.cookie })).status, 404);
  const bInvoice = await site.db.first("SELECT id FROM invoices WHERE project_id = ?", b.id);
  assert.equal((await site.call("POST", `/api/portal/invoices/${bInvoice.id}/checkout`, { as: a.cookie })).status, 404);
  const bAgreement = await site.db.first("SELECT id FROM agreements WHERE project_id = ?", b.id);
  assert.equal((await site.call("POST", `/api/portal/agreements/${bAgreement.id}/accept`, { as: a.cookie, body: { name: "Ann", consent: true } })).status, 404);
  assert.equal((await site.call("GET", `/api/portal/agreements/${bAgreement.id}/document`, { as: a.cookie })).status, 404);
  const bItem = await site.db.first("SELECT id FROM onboarding_items WHERE project_id = ?", b.id);
  assert.equal((await site.call("PUT", `/api/portal/projects/${b.id}/items/${bItem.id}`, { as: a.cookie, body: { value: {} } })).status, 404);
  // Even with A's own project id in the path, B's item can't be reached
  assert.equal((await site.call("PUT", `/api/portal/projects/${a.id}/items/${bItem.id}`, { as: a.cookie, body: { value: {} } })).status, 404);
});

test("a client can't see the studio's private notes", async () => {
  const { id, cookie } = await quoteSent(site);
  await site.call("PATCH", `/api/admin/projects/${id}`, { as: "admin", body: { notes: "Secret: tough negotiator" } });
  const r = await site.call("GET", `/api/portal/projects/${id}`, { as: cookie });
  assert.ok(!JSON.stringify(r.data).includes("tough negotiator"));
});

test("client sessions don't open the dashboard", async () => {
  const { cookie } = await quoteSent(site);
  assert.equal((await site.call("GET", "/api/admin/overview", { as: cookie })).status, 401);
});
