// Private uploads: who can upload, who can download, what's accepted.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "./support/site.mjs";
import { quoteSent, acceptAgreement, payDeposit } from "./support/flow.mjs";

let site;
before(async () => (site = await startSite()));
after(() => site.stop());
beforeEach(() => site.reset());

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const put = (cookie, id, item, body = JPEG, type = "image/jpeg", name = "logo.jpg") =>
  site.call("POST", `/api/portal/projects/${id}/items/${item}/files`, { as: cookie, body, headers: { "content-type": type, "x-file-name": encodeURIComponent(name) } });

async function confirmed(email) {
  const p = await quoteSent(site, { email, name: email.split("@")[0] });
  await acceptAgreement(site, p.cookie, p.id);
  await payDeposit(site, p.id);
  const logo = await site.db.first("SELECT id FROM onboarding_items WHERE project_id = ? AND key = 'logo'", p.id);
  return { ...p, logo: logo.id };
}

test("uploads open only after the project is confirmed", async () => {
  const { id, cookie } = await quoteSent(site);
  const logo = await site.db.first("SELECT id FROM onboarding_items WHERE project_id = ? AND key = 'logo'", id);
  assert.equal((await put(cookie, id, logo.id)).status, 409);
});

test("a client's upload is private: only they and the studio can download it", async () => {
  const a = await confirmed("a@example.com");
  const b = await confirmed("b@example.com");
  const up = await put(a.cookie, a.id, a.logo);
  assert.equal(up.status, 200);
  const fid = up.data.file.id;
  const row = await site.db.first("SELECT * FROM files WHERE id = ?", fid);
  assert.match(row.r2_key, /^projects\/\d+\/[0-9a-f-]{36}\.jpg$/, "stored under a random key, not the file name");
  assert.ok(await site.env.FILES.get(row.r2_key));

  const mine = await site.call("GET", `/api/portal/files/${fid}`, { as: a.cookie });
  assert.equal(mine.status, 200);
  assert.deepEqual([...mine.data], [...JPEG]);
  assert.equal(mine.headers.get("cache-control"), "private, no-store");
  assert.equal((await site.call("GET", `/api/portal/files/${fid}`, { as: b.cookie })).status, 404, "another client");
  assert.equal((await site.call("GET", `/api/portal/files/${fid}`)).status, 401, "signed out");
  assert.equal((await site.call("GET", `/api/admin/files/${fid}`)).status, 401, "admin route without login");
  assert.equal((await site.call("GET", `/api/admin/files/${fid}`, { as: "admin" })).status, 200);
  assert.equal((await site.call("GET", `/media/${fid}`)).status, 404, "client files are never public media");
  // And B can't upload into A's item
  assert.equal((await put(b.cookie, a.id, a.logo)).status, 404);
  assert.equal((await put(b.cookie, b.id, a.logo)).status, 404);
});

test("only accepted file types, up to 25 MB", async () => {
  const a = await confirmed("a@example.com");
  assert.equal((await put(a.cookie, a.id, a.logo, new Uint8Array([1, 2]), "text/html", "x.html")).status, 415);
  assert.equal((await put(a.cookie, a.id, a.logo, new Uint8Array([1, 2]), "application/x-msdownload", "x.exe")).status, 415);
  const big = await site.call("POST", `/api/portal/projects/${a.id}/items/${a.logo}/files`, { as: a.cookie, body: new Uint8Array(1), headers: { "content-type": "image/png", "content-length": String(26 * 1024 * 1024) } });
  assert.equal(big.status, 413);
});

test("SVGs and documents download instead of opening in the browser", async () => {
  const a = await confirmed("a@example.com");
  const up = await put(a.cookie, a.id, a.logo, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "logo.svg");
  const r = await site.call("GET", `/api/portal/files/${up.data.file.id}`, { as: a.cookie });
  assert.match(r.headers.get("content-disposition"), /^attachment/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("clients remove only their own files, and not once the item is approved", async () => {
  const a = await confirmed("a@example.com");
  const up = await put(a.cookie, a.id, a.logo);
  const fid = up.data.file.id;
  await site.call("POST", `/api/admin/items/${a.logo}/review`, { as: "admin", body: { action: "approve", force: true } });
  assert.equal((await site.call("DELETE", `/api/portal/files/${fid}`, { as: a.cookie })).status, 409);
  await site.call("POST", `/api/admin/items/${a.logo}/review`, { as: "admin", body: { action: "reopen" } });
  assert.equal((await site.call("DELETE", `/api/portal/files/${fid}`, { as: a.cookie })).status, 200);
  const row = await site.db.first("SELECT * FROM files WHERE id = ?", fid);
  assert.ok(row.deleted_at);
  assert.equal(await site.env.FILES.get(row.r2_key), null, "removed from storage too");
  // A studio file can't be deleted by the client
  const studio = await site.call("POST", `/api/admin/projects/${a.id}/files?kind=deliverable`, { as: "admin", body: JPEG, headers: { "content-type": "image/jpeg", "x-file-name": "mock.jpg" } });
  assert.equal((await site.call("DELETE", `/api/portal/files/${studio.data.file.id}`, { as: a.cookie })).status, 403);
});

test("studio files marked private stay hidden from the client", async () => {
  const a = await confirmed("a@example.com");
  const up = await site.call("POST", `/api/admin/projects/${a.id}/files?kind=deliverable&private=1`, { as: "admin", body: JPEG, headers: { "content-type": "image/jpeg", "x-file-name": "internal.jpg" } });
  const d = await site.call("GET", `/api/portal/projects/${a.id}`, { as: a.cookie });
  assert.ok(!d.data.files.some((f) => f.id === up.data.file.id));
  assert.equal((await site.call("GET", `/api/portal/files/${up.data.file.id}`, { as: a.cookie })).status, 404);
});
