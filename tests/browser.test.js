// The real pages in Chromium: no script errors, the quote form, the client portal and the dashboard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startSite, accessToken, ADMIN } from "./support/site.mjs";
import { quoteSent, acceptAgreement, payDeposit } from "./support/flow.mjs";

let site, server, browser;
before(async () => {
  site = await startSite({ TURNSTILE_SITE_KEY: "" }); // no external widget in the browser tests
  await site.reset();
  server = await site.serve();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
  await site?.stop();
});

async function open(path, { cookies = [], viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 860 } });
  // Fonts come from Google; the tests don't need them
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (cookies.length) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/fonts\.|ERR_FAILED|status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  await page.goto(server.url + path);
  return { page, errors, ctx };
}

test("public pages load without script errors and fit a phone screen", async () => {
  for (const path of ["/", "/pricing", "/work", "/work/paybook", "/process", "/about", "/faq", "/quote", "/web-design-northern-virginia"]) {
    const { page, errors, ctx } = await open(path, { viewport: { width: 390, height: 844 } });
    await page.waitForLoadState("networkidle");
    assert.deepEqual(errors, [], path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `${path} scrolls sideways by ${overflow}px`);
    await ctx.close();
  }
});

test("the mobile menu opens and closes", async () => {
  const { page, ctx } = await open("/", { viewport: { width: 390, height: 844 } });
  await page.click(".menu-btn");
  assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "true");
  await page.keyboard.press("Escape");
  assert.equal(await page.getAttribute(".menu-btn", "aria-expanded"), "false");
  await ctx.close();
});

test("the quote form validates and sends", async () => {
  // Without a Turnstile site key in the page, the server's robot check refuses: the form must say so clearly
  const { page, ctx } = await open("/quote?package=business");
  assert.equal(await page.isChecked('input[name="package"][value="business"]'), true);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".form-msg.err");
  assert.match(await page.textContent(".form-msg"), /name/);
  await page.fill("#q-name", "Pat Lee");
  await page.fill("#q-email", "pat@example.com");
  await page.fill("#q-message", "A site for my plumbing company");
  await page.waitForTimeout(3100); // forms sent faster than 3 seconds are treated as bots
  await page.click('button[type="submit"]');
  await page.waitForSelector(".form-msg.err");
  assert.match(await page.textContent(".form-msg"), /robot/);
  await ctx.close();
});

test("a client signs in from the email, accepts, and works through onboarding", async () => {
  const { id, cookie } = await quoteSent(site, { email: "jo@example.com" });
  void cookie;
  // Sign in through the real email link
  await site.call("POST", "/api/auth/login", { body: { email: "jo@example.com" } });
  const link = site.outside.emails.filter((e) => /sign-in/i.test(e.subject)).pop().text.match(/https?:\/\/\S+#[0-9a-f]{64}/)[0];
  const { page, errors, ctx } = await open(link.replace("https://fiveday.studio", ""));
  await page.waitForSelector(".proj-head h1");
  assert.match(await page.textContent(".turn"), /accept the agreement/i);
  // Accept the agreement in the browser
  await page.check('form .check input[type="checkbox"]');
  await page.fill('form input[autocomplete="name"]', "Jo Baker");
  await page.click("text=Accept agreement");
  await page.waitForSelector("text=Pay $75");
  // The deposit is paid (webhook), then onboarding opens
  await payDeposit(site, id);
  await page.goto(`${server.url}/portal/#/project/${id}/onboarding`);
  await page.waitForSelector(".item");
  const first = page.locator("details.item").first();
  await first.locator('input[name="business_name"]').fill("Harbor Bakery");
  await first.locator('input[name="public_email"]').fill("hello@harbor.example");
  await first.locator("text=Submit for review").click();
  await page.waitForSelector("details.item.submitted");
  // Upload a logo
  const logo = page.locator("details.item", { hasText: "Logo files" });
  await logo.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 1, 2, 3]) });
  await logo.locator(".file a", { hasText: "logo.png" }).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
  void acceptAgreement;
});

test("the studio reviews submissions in the dashboard", async () => {
  const token = await accessToken(ADMIN);
  const { page, errors, ctx } = await open("/admin/", { cookies: [{ name: "CF_Authorization", value: token, url: server.url }] });
  await page.waitForSelector("h1:text('Today')");
  await page.waitForSelector(".need a");
  await page.click(".need a >> text=Review submission");
  await page.waitForSelector("details.item.submitted");
  await page.locator("details.item.submitted").first().locator("button:text('Approve')").click();
  await page.waitForSelector("#toast.show");
  const item = await site.db.first("SELECT status FROM onboarding_items WHERE key = 'contact'");
  assert.equal(item.status, "approved");
  for (const view of ["leads", "projects", "clients", "money", "content", "content/portfolio", "content/agreements", "content/settings", "setup"]) {
    await page.goto(`${server.url}/admin/#/${view}`);
    await page.waitForSelector(".admin-top h1");
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});
