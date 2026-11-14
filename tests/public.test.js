// The public website, the quote form, editable content and the AI suggestion.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "./support/site.mjs";

let site;
before(async () => (site = await startSite()));
after(() => site.stop());
beforeEach(() => site.reset());

const quote = (body) => site.call("POST", "/api/quote", { body: { name: "Pat Lee", email: "pat@example.com", business: "Lee Plumbing", message: "Need a site", turnstile: "human", ...body } });

test("every public page renders with a title, description, canonical link and structured data", async () => {
  for (const p of ["/", "/pricing", "/work", "/work/walks-for-lucy", "/process", "/about", "/faq", "/quote", "/web-design-northern-virginia", "/privacy"]) {
    const r = await site.call("GET", p);
    assert.equal(r.status, 200, p);
    assert.match(r.data, /<title>[^<]{10,}<\/title>/, p);
    assert.match(r.data, /<meta name="description" content="[^"]{40,}">/, p);
    assert.match(r.data, new RegExp(`<link rel="canonical" href="https://fiveday.studio${p === "/" ? "/" : p}">`), p);
    assert.match(r.data, /<h1/, p);
    assert.ok(r.headers.get("content-security-policy"), p);
    assert.equal(r.headers.get("x-frame-options"), "DENY", p);
  }
  const home = (await site.call("GET", "/")).data;
  assert.match(home, /"@type":"ProfessionalService"/);
  assert.match(home, /"@type":"FAQPage"/);
  assert.match((await site.call("GET", "/pricing")).data, /"@type":"OfferCatalog"/);
});

test("prices come from the dashboard: change one and every page shows it", async () => {
  assert.match((await site.call("GET", "/")).data, /\$150/);
  const pk = await site.db.first("SELECT id FROM packages WHERE slug = 'starter'");
  await site.call("PATCH", `/api/admin/content/packages/${pk.id}`, { as: "admin", body: { price_cents: "175" } });
  for (const p of ["/", "/pricing", "/quote", "/web-design-northern-virginia"]) assert.match((await site.call("GET", p)).data, /\$175/, p);
  const addon = await site.db.first("SELECT id FROM addons WHERE name = 'Extra page'");
  await site.call("PATCH", `/api/admin/content/addons/${addon.id}`, { as: "admin", body: { price_cents: "" } });
  assert.match((await site.call("GET", "/pricing")).data, /Extra page<\/b><span class="p">Custom quote/);
});

test("the pricing page lists add-ons by category and says third-party fees are separate", async () => {
  const html = (await site.call("GET", "/pricing")).data;
  for (const c of ["Design &amp; experience", "Business features", "Payments &amp; commerce", "Advanced development"]) assert.ok(html.includes(c), c);
  assert.match(html, /aren't included in these prices/);
  assert.match(html, /Month to month|month to month/i);
});

test("client work is only shown with permission; previews are labelled", async () => {
  assert.equal((await site.call("GET", "/work/right-2-arms")).status, 404, "seeded hidden until permission is confirmed");
  assert.ok(!(await site.call("GET", "/work")).data.includes("Right 2 Arms"));
  const row = await site.db.first("SELECT id FROM portfolio WHERE slug = 'right-2-arms'");
  const refused = await site.call("PATCH", `/api/admin/content/portfolio/${row.id}`, { as: "admin", body: { published: true } });
  assert.equal(refused.status, 400);
  assert.equal((await site.call("PATCH", `/api/admin/content/portfolio/${row.id}`, { as: "admin", body: { published: true, permission: true } })).status, 200);
  const page = await site.call("GET", "/work/right-2-arms");
  assert.equal(page.status, 200);
  assert.match(page.data, /Preview/);
  assert.match(page.data, /work in progress/);
});

test("the sitemap lists the pages and published case studies; private areas are off limits to robots", async () => {
  const map = (await site.call("GET", "/sitemap.xml")).data;
  assert.match(map, /<loc>https:\/\/fiveday.studio\/work\/paybook<\/loc>/);
  assert.ok(!map.includes("right-2-arms"));
  assert.ok(!map.includes("/portal"));
  const robots = (await site.call("GET", "/robots.txt")).data;
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Disallow: \/portal\//);
  assert.match(robots, /Sitemap: https:\/\/fiveday.studio\/sitemap.xml/);
});

test("trailing slashes redirect to one address per page", async () => {
  const r = await site.call("GET", "/pricing/");
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://fiveday.studio/pricing");
});

test("a quote request saves a lead, alerts the studio and thanks the visitor", async () => {
  const addon = await site.db.first("SELECT id FROM addons WHERE name = 'Online appointment scheduling'");
  const r = await quote({ package: "business", addons: [addon.id, 99999] });
  assert.equal(r.status, 200);
  const lead = await site.db.first("SELECT * FROM leads");
  assert.equal(lead.package_slug, "business");
  assert.deepEqual(JSON.parse(lead.addons), [addon.id], "unknown add-ons are dropped");
  assert.ok(site.outside.alerts.some((a) => /New inquiry from Pat/.test(a)));
  assert.ok(!site.outside.alerts.some((a) => a.includes("pat@example.com")), "phone alerts carry no contact details");
  assert.ok(site.outside.emails.some((e) => e.to[0] === "pat@example.com" && /got your request/.test(e.subject)));
});

test("the quote form stops bots: robot check, hidden field and too-fast forms", async () => {
  assert.equal((await quote({ turnstile: "bot" })).status, 403);
  assert.equal((await quote({ company_website: "spam.example" })).status, 200, "bots get a quiet OK…");
  assert.equal((await quote({ started: Date.now() })).status, 200);
  assert.equal((await site.db.first("SELECT COUNT(*) AS n FROM leads")).n, 0, "…but nothing is saved");
  site.setVars({ TURNSTILE_SECRET: undefined });
  try {
    assert.equal((await quote({})).status, 503, "fails closed without the secret");
  } finally {
    site.setVars({ TURNSTILE_SECRET: "ts-secret" });
  }
  assert.equal((await quote({ email: "nope" })).status, 400);
});

test("AI suggestions are stored for the studio only and never sent to the client", async () => {
  site.setVars({ ANTHROPIC_API_KEY: "sk-ant-test" });
  try {
    await quote({ package: "starter" });
    const lead = await site.db.first("SELECT * FROM leads");
    const s = JSON.parse(lead.ai_summary);
    assert.equal(s.suggested_package, "starter");
    const req = site.outside.anthropic[0];
    assert.equal(req.model, "claude-opus-5-5");
    assert.match(JSON.stringify(req.messages), /Lee Plumbing/);
    assert.equal(lead.status, "new", "the AI changes nothing");
    assert.equal((await site.db.first("SELECT COUNT(*) AS n FROM projects")).n, 0);
    assert.ok(!site.outside.emails.some((e) => e.to[0] === "pat@example.com" && e.text.includes(s.summary)));
    assert.ok(await site.db.first("SELECT * FROM activity WHERE actor = 'ai'"));
    const leads = await site.call("GET", "/api/admin/leads", { as: "admin" });
    assert.equal(leads.data.leads[0].ai_summary.summary, s.summary);
  } finally {
    site.setVars({ ANTHROPIC_API_KEY: undefined });
  }
});

test("without an AI key, inquiries still work and nothing is sent to Anthropic", async () => {
  await quote({});
  assert.equal(site.outside.anthropic.length, 0);
  assert.equal((await site.db.first("SELECT ai_summary FROM leads")).ai_summary, null);
});

test("the portal and dashboard pages aren't indexed or cached", async () => {
  const r = await site.call("GET", "/portal/");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.headers.get("cache-control"), "no-store");
});
