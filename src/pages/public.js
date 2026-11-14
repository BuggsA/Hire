// The public website, rendered by the Worker from the database so every price, package, add-on,
// portfolio entry and FAQ edited in the dashboard shows up immediately (and is in the HTML for search engines).
import { all, first, getSetting } from "../lib/db.js";
import { esc, money, parse, siteUrl } from "../lib/http.js";
import { business } from "../lib/notify.js";
import { DEFAULT_HOME } from "../lib/seed.js";
import { page, icon, browserFrame } from "./layout.js";

async function context(env) {
  return { biz: await business(env), site: siteUrl(env), home: { ...DEFAULT_HOME, ...((await getSetting(env, "home", {})) || {}) } };
}

const priceHtml = (cents, prefix) => (cents === null || cents === undefined ? `<span>Custom</span>` : `${prefix ? `<small>${esc(prefix)}</small>` : ""}${money(cents)}`);
const addonPrice = (a) => (a.price_cents === null ? "Custom quote" : `${a.price_prefix === "from" ? "from " : "+"}${money(a.price_cents)}${a.unit ? ` ${a.unit}` : ""}`);
const paras = (s) => String(s || "").split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("");

const loadPackages = (env) => all(env, "SELECT * FROM packages WHERE active = 1 ORDER BY sort, id");
const loadWork = (env) => all(env, "SELECT * FROM portfolio WHERE published = 1 AND (permission = 1 OR status = 'live') ORDER BY featured DESC, sort, id");
const loadFaqs = (env, pages) => all(env, `SELECT * FROM faqs WHERE published = 1 AND page IN (${pages.map(() => "?").join(",")}) ORDER BY sort, id`, ...pages);

const orgLd = (ctx) => ({
  "@context": "https://schema.org",
  "@type": "ProfessionalService",
  "@id": ctx.site + "/#studio",
  name: ctx.biz.name,
  url: ctx.site + "/",
  email: ctx.biz.email,
  ...(ctx.biz.phone ? { telephone: ctx.biz.phone } : {}),
  description: "Custom small-business websites and web applications, with standard sites delivered in five business days.",
  address: { "@type": "PostalAddress", addressLocality: ctx.biz.city, addressRegion: "VA", addressCountry: "US" },
  areaServed: [
    { "@type": "City", name: "Reston, Virginia" },
    { "@type": "AdministrativeArea", name: "Fairfax County, Virginia" },
    { "@type": "AdministrativeArea", name: "Loudoun County, Virginia" },
    { "@type": "Country", name: "United States" },
  ],
  priceRange: "$$",
});

const crumbsLd = (ctx, items) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: ctx.site + path })),
});

const faqLd = (faqs) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
});

const faqHtml = (faqs) => `<div class="faq">${faqs.map((f) => `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`).join("")}</div>`;

const ctaBand = (title = "Tell me about your business.", text = "A short form, a real reply within one business day, and a written quote before anything is booked.") => `
<section><div class="wrap"><div class="cta-band reveal">
  <div><h2>${title}</h2><p>${text}</p></div>
  <a class="btn" href="/quote">Get a quote <span class="arrow">→</span></a>
  <div class="bars" aria-hidden="true"><i style="height:60px"></i><i style="height:90px"></i><i style="height:120px"></i><i style="height:150px"></i><i style="height:180px"></i></div>
</div></div></section>`;

function weekBoard() {
  const days = [
    ["MON", "Kickoff", "Direction, structure and your approved content"],
    ["TUE", "Design", "Homepage design in your brand"],
    ["WED", "Build", "Every page, on every screen size"],
    ["THU", "Review", "Your preview and one round of changes"],
    ["FRI", "Launch", "Live on your domain"],
  ];
  return `<div class="week" data-week aria-label="An example build week, Monday to Friday">
  <div class="week-top"><span>Your build week</span><span class="live">On schedule</span></div>
  <div class="before"><span class="chip ok">${icon("check")} Agreement signed</span><span class="chip ok">${icon("check")} Deposit paid</span><span class="chip ok">${icon("check")} Onboarding approved</span></div>
  <div class="days">${days
    .map(
      ([d, t, s], i) => `<div class="day${i === 4 ? " launch" : ""}" data-day="${i}"><div class="d"><span>${d}</span><span>${i + 1}/5</span></div><div class="task">${t}</div><div class="sub">${s}</div><div class="tick">${icon("check")}</div></div>`
    )
    .join("")}</div>
  <div class="week-foot"><span class="mono small" data-week-label>Day 5 of 5</span><div class="meter"><i data-week-meter style="width:100%"></i></div><span class="mono small">Launch</span></div>
</div>`;
}

const workCard = (w, big = false) => `<a class="work-card${big ? " big" : ""} reveal" href="/work/${esc(w.slug)}">
  ${browserFrame(w.image, w.url, `${w.title} website`)}
  <div class="kind">${esc(w.kind || "")}</div>
  <h3>${esc(w.title)}${w.status === "preview" ? ' <span class="chip wait">Preview</span>' : ""}</h3>
  <p>${esc(w.summary)}</p>
</a>`;

// ───────── Home ─────────
export async function homePage(env) {
  const ctx = await context(env);
  const [packages, work, faqs] = await Promise.all([loadPackages(env), loadWork(env), loadFaqs(env, ["home"])]);
  const [l1, l2] = ctx.home.headline.split("|");
  const featured = [...work.filter((w) => w.featured), ...work.filter((w) => !w.featured)].slice(0, 5);
  const caps = ["Booking systems", "Client portals", "Stripe payments", "Admin dashboards", "Automated reminders", "Live data", "Calculators", "Interactive maps", "Browser games", "Email notifications"];
  const body = `
<section class="hero"><div class="wrap hero-grid">
  <div>
    <div class="eyebrow">${esc(ctx.home.eyebrow)}</div>
    <h1><span class="line">${esc(l1)}</span>${l2 ? `<span class="line">${esc(l2)}</span>` : ""}</h1>
    <p class="lede">${esc(ctx.home.intro)}</p>
    <div class="cta-row"><a class="btn accent" href="/quote">${esc(ctx.home.cta)} <span class="arrow">→</span></a><a class="btn ghost" href="/work">See the work</a></div>
    <div class="facts">
      <span>${icon("tag")} Sites from ${money(Math.min(...packages.filter((p) => p.price_cents).map((p) => p.price_cents)))}</span>
      <span>${icon("clock")} 5 business days for standard sites</span>
      <span>${icon("pin")} Reston, VA · working nationwide</span>
    </div>
  </div>
  ${weekBoard()}
</div></section>

<div class="marquee" aria-hidden="true"><div class="track"><span>${caps.join("</span><span>")}</span><span>${caps.join("</span><span>")}</span></div></div>

<section id="work"><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">Real work, live today</div><h2>Built for real businesses<br>and real people.</h2></div><a class="link-arrow" href="/work">All case studies →</a></div>
  <div class="work-grid">${featured.map((w, i) => workCard(w, i < 2)).join("")}</div>
</div></section>

<section class="dark"><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">${esc(ctx.home.promise_title)}</div><h2>A week of building.<br><span class="accent">Zero weeks of waiting.</span></h2></div></div>
  <div class="grid-2" style="gap:56px;align-items:start">
    <div>
      <p class="lede" style="color:#d9d3c4">${esc(ctx.home.promise)}</p>
      <div class="steps" style="margin-top:28px">
        <div class="step"><div><h3>Before the week</h3><p>You accept a written quote, pay the deposit and fill in a guided onboarding checklist: text, photos, logo and details. I review each item.</p></div></div>
        <div class="step"><div><h3>The week</h3><p>Day 1 is the business day after onboarding is approved. You watch the countdown, get a preview mid-week and send one list of changes.</p></div></div>
        <div class="step"><div><h3>After launch</h3><p>Support is included for the first days after launch. A care plan is there if you'd like ongoing updates, but you don't need one.</p></div></div>
      </div>
    </div>
    <div class="mock reveal" aria-label="Example of the client project dashboard">
      <div class="mock-head"><b>Harbor &amp; Pine Bakery</b><span class="chip info">Awaiting onboarding</span></div>
      <div class="mock-body">
        <div class="turn"><span class="who">Your turn</span>Upload 3 more photos and your team bios</div>
        <div><div class="label small" style="display:flex;justify-content:space-between"><span>Onboarding</span><span class="mono">9 of 13 approved</span></div><div class="meter" style="margin-top:8px"><i style="width:69%;background:var(--accent)"></i></div></div>
        <div>
          <div class="check-row"><span>Business name and contact details</span><span class="chip ok">Approved</span></div>
          <div class="check-row"><span>Logo files</span><span class="chip ok">Approved</span></div>
          <div class="check-row"><span>Photos and visual assets</span><span class="chip bad">Needs changes</span></div>
          <div class="check-row"><span>Staff names and biographies</span><span class="chip">Not started</span></div>
          <div class="check-row"><span>Certifications</span><span class="chip accent">Exception approved</span></div>
        </div>
      </div>
    </div>
  </div>
</div></section>

<section><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">Clear prices</div><h2>Pick a starting point.</h2></div><p class="muted" style="max-width:26em">Every quote is written down before you pay anything. Add-ons are priced up front too.</p></div>
  ${packagesHtml(packages)}
  <p class="muted small" style="margin-top:22px;text-align:center">Prices are for the work described. Third-party costs such as domains, hosting upgrades and payment processing fees are separate. <a href="/pricing">Full pricing and add-ons →</a></p>
</div></section>

<section style="padding-top:0"><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">More than a brochure</div><h2>When your website<br>needs to do the work.</h2></div></div>
  <div class="grid-3">
    ${tile("calendar", "Bookings and scheduling", "Requests, approvals, calendars, clash checks and reminder emails.", "walks-for-lucy", "Walks for Lucy")}
    ${tile("user", "Client accounts and portals", "Customers sign in to see their bookings, files, bills and messages.", "walks-for-lucy", "Walks for Lucy")}
    ${tile("card", "Payments", "Deposits, invoices and subscriptions through Stripe's secure checkout.", null, "This site's own client portal")}
    ${tile("chart", "Calculators and data", "Turn complicated tables into instant, personal answers.", "paybook", "Paybook")}
    ${tile("bell", "Live updates and alerts", "Status that changes on its own, with notifications when it matters.", "is-there-school", "Is There School?")}
    ${tile("layout", "Dashboards", "A private back office that shows what needs you today.", "walks-for-lucy", "Walks for Lucy")}
  </div>
</div></section>

<section style="padding-top:0"><div class="wrap grid-2" style="gap:56px">
  <div><div class="eyebrow">Questions</div><h2>The short answers.</h2><p class="muted">More on the <a href="/faq">FAQ page</a>.</p></div>
  ${faqHtml(faqs)}
</div></section>
${ctaBand()}`;
  return page(ctx, {
    title: `${ctx.biz.name} · Custom small-business websites in one business week`,
    description: `Custom, professionally designed small-business websites built in five business days, from ${money(Math.min(...packages.filter((p) => p.price_cents).map((p) => p.price_cents)))}. Booking systems, client portals and payments too. Reston, VA, working nationwide.`,
    path: "/",
    body,
    jsonld: [orgLd(ctx), faqLd(faqs)],
  });
}

function tile(ic, title, text, slug, proofName) {
  return `<div class="tile reveal"><div class="ic">${icon(ic)}</div><h3>${title}</h3><p>${text}</p><div class="proof muted">Built for: ${slug ? `<a href="/work/${slug}">${proofName}</a>` : proofName}</div></div>`;
}

function packagesHtml(packages) {
  return `<div class="packages">${packages
    .map(
      (p) => `<div class="pkg${p.featured ? " featured" : ""} reveal">
  ${p.featured ? '<span class="tag chip accent">Most chosen</span>' : ""}
  <h3>${esc(p.name)}</h3>
  <p class="muted" style="margin:0">${esc(p.tagline || "")}</p>
  <div class="price">${priceHtml(p.price_cents, p.price_prefix)}</div>
  <div class="pkg-meta">${esc(p.turnaround_text || "")}${p.support_days ? ` · ${p.support_days} days of support` : ""}</div>
  <ul>${parse(p.features, []).map((f) => `<li><span>${esc(f)}</span></li>`).join("")}</ul>
  <a class="btn${p.featured ? "" : " ghost"}" href="/quote?package=${esc(p.slug)}">Start with ${esc(p.name)} <span class="arrow">→</span></a>
</div>`
    )
    .join("")}</div>`;
}

// ───────── Pricing ─────────
export async function pricingPage(env) {
  const ctx = await context(env);
  const [packages, addons, plans, faqs] = await Promise.all([
    loadPackages(env),
    all(env, "SELECT * FROM addons WHERE active = 1 ORDER BY sort, id"),
    all(env, "SELECT * FROM care_plans WHERE active = 1 ORDER BY sort, id"),
    loadFaqs(env, ["pricing", "home"]),
  ]);
  const cats = [...new Set(addons.map((a) => a.category))];
  const care = plans.filter((p) => p.kind === "care");
  const waas = plans.filter((p) => p.kind === "waas");
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>Pricing</span></nav>
  <div class="eyebrow">Transparent pricing</div>
  <h1>Clear prices. No surprise invoices.</h1>
  <p class="lede">Choose a package, add what you need, and get a written quote with the timeline and payment schedule before anything is booked. Usually half up front, half at launch.</p>
</div></section>
<section style="padding-top:0"><div class="wrap">${packagesHtml(packages)}
  <div class="notice accent" style="margin-top:28px"><b>The one-week promise</b> covers the Starter Site and other projects quoted as standard: a clearly defined scope, approved onboarding and the deposit paid. The five business days start the business day after all three. If a preview waits on you beyond the agreed reply window, the date moves by the same number of days. Larger projects get their own written timeline.</div>
</div></section>

<section id="addons" style="padding-top:20px"><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">Add-ons</div><h2>Add what your business needs.</h2></div><p class="muted" style="max-width:28em">Pick these on the quote form. <span class="mono" style="color:var(--wait)">+ time</span> marks features that usually add days beyond a standard week.</p></div>
  ${cats
    .map(
      (c) => `<div class="addon-cat reveal"><div><h3>${esc(c)}</h3></div><div class="addon-list">${addons
        .filter((a) => a.category === c)
        .map((a) => `<div class="addon"><b>${esc(a.name)}${a.extends_timeline ? '<span class="slow">+ time</span>' : ""}</b><span class="p">${esc(addonPrice(a))}</span><span class="d">${esc(a.description || "")}</span></div>`)
        .join("")}</div></div>`
    )
    .join("")}
  <p class="muted small">Third-party transaction, subscription and service fees (for example Stripe's card fees, domain registration, email hosting, paid plug-ins or APIs) are charged by those providers and aren't included in these prices.</p>
</div></section>

<section class="dark" id="care"><div class="wrap">
  <div class="section-head"><div><div class="eyebrow">After launch</div><h2>Care plans, if you want them.</h2></div><p class="muted" style="max-width:30em">Buying a website doesn't sign you up for anything. These are optional, and you see the full agreement before you accept.</p></div>
  <div class="grid-3">${care
    .map(
      (p) => `<div class="card" style="background:#24221c;border-color:#35322a"><h3>${esc(p.name)}</h3><div class="price" style="font-size:2.4rem">${p.monthly_cents === null ? "Custom" : `${money(p.monthly_cents)}<small>/month</small>`}</div><p class="muted small">${p.term_months === 0 ? "No minimum term" : p.term_months ? `${p.term_months}-month minimum` : "Terms agreed together"}</p><p style="color:#d9d3c4;font-size:15px">${esc(p.description || "")}</p></div>`
    )
    .join("")}</div>
  <div class="grid-2" style="margin-top:28px;align-items:start">
    <div><h3>Every care plan includes</h3><ul class="built" style="color:#d9d3c4">${parse(care[0]?.features, []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>
    ${waas.map((p) => `<div class="card" style="background:var(--accent);border-color:var(--accent);color:#fff"><div class="eyebrow" style="color:#fff">Spread the cost</div><h3>${esc(p.name)}: ${p.monthly_cents === null ? "custom" : `${money(p.monthly_cents)}/month`}</h3><p>${esc(p.description || "")}</p><p class="small">${p.term_months ? `${p.term_months}-month minimum term.` : ""}</p></div>`).join("")}
  </div>
</div></section>

<section><div class="wrap grid-2" style="gap:56px"><div><div class="eyebrow">Pricing questions</div><h2>Good to know.</h2></div>${faqHtml(faqs)}</div></section>
${ctaBand("Not sure which fits?", "Describe your business and what you want the site to do. I'll recommend the smallest package that does the job.")}`;
  const offers = {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: `${ctx.biz.name} website packages`,
    itemListElement: packages.filter((p) => p.price_cents).map((p) => ({ "@type": "Offer", name: p.name, description: p.tagline, price: (p.price_cents / 100).toFixed(2), priceCurrency: "USD", ...(p.price_prefix ? { priceSpecification: { "@type": "PriceSpecification", minPrice: (p.price_cents / 100).toFixed(2), priceCurrency: "USD" } } : {}) })),
  };
  return page(ctx, {
    title: "Website pricing: packages, add-ons and care plans",
    description: `Small-business websites from ${money(packages[0]?.price_cents)} with 7 days of support, business sites with booking and galleries, and custom web apps. Add-on prices and optional care plans, all upfront.`,
    path: "/pricing",
    body,
    jsonld: [offers, crumbsLd(ctx, [["Home", "/"], ["Pricing", "/pricing"]]), faqLd(faqs)],
  });
}

// ───────── Work ─────────
export async function workPage(env) {
  const ctx = await context(env);
  const work = await loadWork(env);
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>Work</span></nav>
  <div class="eyebrow">Case studies</div>
  <h1>Work that's live and in use.</h1>
  <p class="lede">Real screenshots of real sites: a small business run from its own website, a data platform with thousands of pages, a live school-closings service, browser games and a few experiments. Each one shows something I can build for you.</p>
</div></section>
<section style="padding-top:0"><div class="wrap"><div class="work-grid">${work.map((w, i) => workCard(w, i < 2)).join("")}</div></div></section>
${ctaBand("Want something like these?")}`;
  return page(ctx, {
    title: "Website and web app case studies",
    description: "Custom websites and web applications built for real use: a pet-care business with bookings and client accounts, a federal pay calculator, a live school-closings service, browser games and more.",
    path: "/work",
    body,
    jsonld: [crumbsLd(ctx, [["Home", "/"], ["Work", "/work"]])],
  });
}

export async function casePage(env, slug) {
  const w = await first(env, "SELECT * FROM portfolio WHERE slug = ? AND published = 1 AND (permission = 1 OR status = 'live')", slug);
  if (!w) return null;
  const ctx = await context(env);
  const others = (await loadWork(env)).filter((o) => o.slug !== slug).slice(0, 3);
  const built = parse(w.built, []);
  const stack = parse(w.stack, []);
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><a href="/work">Work</a><span>/</span><span>${esc(w.title)}</span></nav>
  <div class="eyebrow">${esc(w.kind || "Case study")}</div>
  <h1>${esc(w.title)}${w.status === "preview" ? ' <span class="chip wait" style="vertical-align:middle;font-size:1rem">Preview</span>' : ""}</h1>
  <p class="lede">${esc(w.summary)}</p>
  ${w.url ? `<p style="margin-top:22px"><a class="btn ghost" href="${esc(w.url)}" rel="noopener" target="_blank">${w.status === "preview" ? "Open the preview" : "Visit the live site"} ${icon("external")}</a></p>` : ""}
</div></section>
<section style="padding-top:0"><div class="wrap case-hero">
  ${browserFrame(w.image, w.url, `${w.title} on a desktop screen`, { eager: true })}
  ${w.image_mobile ? `<div class="phone"><img src="${esc(w.image_mobile)}" alt="${esc(w.title)} on a phone" width="640" height="1385" loading="lazy"></div>` : ""}
</div></section>
<section style="padding-top:0"><div class="wrap case-body">
  <div class="prose">
    ${w.status === "preview" ? '<div class="notice" style="margin-bottom:24px">This is a preview of work in progress. Some content is placeholder until the client supplies it.</div>' : ""}
    <h2 style="margin-top:0">The project</h2>${paras(w.story)}
  </div>
  <aside>
    <h3>What was built</h3><ul class="built">${built.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    ${stack.length ? `<h3 style="margin-top:28px">Under the hood</h3><div class="stack">${stack.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div>` : ""}
  </aside>
</div></section>
<section style="padding-top:0"><div class="wrap"><div class="section-head"><h2>More work</h2><a class="link-arrow" href="/work">All case studies →</a></div><div class="work-grid">${others.map((o) => workCard(o)).join("")}</div></div></section>
${ctaBand()}`;
  return page(ctx, {
    title: `${w.title}: ${w.kind || "case study"}`,
    description: w.summary,
    path: `/work/${w.slug}`,
    body,
    image: w.image,
    jsonld: [
      { "@context": "https://schema.org", "@type": "CreativeWork", name: w.title, url: w.url || undefined, description: w.summary, image: ctx.site + w.image, creator: { "@id": ctx.site + "/#studio" } },
      crumbsLd(ctx, [["Home", "/"], ["Work", "/work"], [w.title, `/work/${w.slug}`]]),
    ],
  });
}

// ───────── Process ─────────
export async function processPage(env) {
  const ctx = await context(env);
  const step = (t, d) => `<div class="step reveal"><div><h3>${t}</h3><p>${d}</p></div></div>`;
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>How it works</span></nav>
  <div class="eyebrow">The process</div>
  <h1>How a website gets built in a week.</h1>
  <p class="lede">The week is fast because everything that usually slows a project down happens first, out in the open, with a checklist you can see.</p>
</div></section>
<section style="padding-top:0"><div class="wrap grid-2" style="gap:64px;align-items:start">
  <div class="steps">
    <div class="phase">Before the week</div>
    ${step("Explore and ask", "Look through the work and pricing, then send a quote request. It takes about three minutes.")}
    ${step("Get a written quote", "I reply within one business day with questions or a quote: scope, price, timeline and payment schedule.")}
    ${step("Accept and pay the deposit", "You read the full agreement in your project portal, accept it, and pay the deposit by card through Stripe.")}
    ${step("Complete onboarding", "A guided checklist collects your text, photos, logo, services, team bios and details. Each item shows its status, so you always know what's left.")}
    ${step("I approve each item", "I review everything you send. If something needs changing I'll say exactly what. If something truly isn't available, you can ask for an exception.")}
    <div class="phase">The week</div>
    ${step("Day 1 begins", "The business day after everything is approved. Your dashboard shows the countdown and the delivery date.")}
    ${step("You get a preview", "A real, clickable preview of your site, not a picture of one.")}
    ${step("One list of changes", "Send your revisions in one list. Your package includes a set number of rounds.")}
    <div class="phase">Launch and after</div>
    ${step("Approve and pay the balance", "You sign off the final site in your portal, then pay the final payment.")}
    ${step("Go live", "I help put it live on your domain and check everything works.")}
    ${step("Support, then optional care", "Included support covers the first days after launch. After that, a care plan is optional.")}
  </div>
  <div style="position:sticky;top:100px">
    ${weekBoard()}
    <div class="card" style="margin-top:20px">
      <h3>The fine print, in plain words</h3>
      <ul class="built">
        <li>The five business days apply to standard projects with a clear scope.</li>
        <li>The clock starts after the agreement, deposit and onboarding approval.</li>
        <li>You have an agreed number of business days to reply to each preview. Past that, the date moves with you, and the dashboard shows it.</li>
        <li>Pauses you ask for extend the date by the days paused.</li>
        <li>Bigger features (booking systems, portals, stores) get their own timeline in the quote.</li>
      </ul>
    </div>
  </div>
</div></section>
${ctaBand("Ready when you are.")}`;
  return page(ctx, {
    title: "How it works: a professional website in five business days",
    description: "The process behind a one-business-week website: written quote, agreement and deposit, guided onboarding, a five-day build with a preview, revisions, approval and launch.",
    path: "/process",
    body,
    jsonld: [crumbsLd(ctx, [["Home", "/"], ["How it works", "/process"]])],
  });
}

// ───────── About ─────────
export async function aboutPage(env) {
  const ctx = await context(env);
  const who = ctx.biz.owner ? `I'm ${esc(ctx.biz.owner)}, and ` : "";
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>About</span></nav>
  <div class="eyebrow">About the studio</div>
  <h1>A small studio that ships.</h1>
  <p class="lede">${who}${esc(ctx.biz.name)} is a one-person web studio in ${esc(ctx.biz.city)}, Virginia. You work directly with the person designing and building your site, from the first message to launch.</p>
</div></section>
<section style="padding-top:0"><div class="wrap grid-2" style="gap:64px;align-items:start">
  <div class="prose">
    <h2 style="margin-top:0">Why one week works</h2>
    <p>Most website projects aren't slow because building is slow. They're slow because of waiting: for photos, for a logo file, for someone to approve the about page. So the waiting happens first, in a guided checklist, and the build week starts only when everything's ready.</p>
    <p>The build itself is fast because I use AI-assisted development and a toolkit refined across real products: booking systems, dashboards, payment flows, notification systems and games. Repetitive code gets written quickly, so my time goes into the parts that matter: design, writing, details and testing.</p>
    <h2>What AI does and doesn't do here</h2>
    <p>AI helps me write code faster and sort incoming information. It doesn't design your brand, publish anything without review, approve contracts or make promises on your behalf. Every line that ships is checked by me, and nothing goes live without your approval.</p>
    <h2>What you can expect</h2>
    <ul>
      <li>Replies within one business day.</li>
      <li>Written quotes and agreements before any payment.</li>
      <li>A project dashboard that always shows whose turn it is.</li>
      <li>Fast, accessible sites built with real code, not a page-builder subscription.</li>
      <li>Honest answers, including “that won't fit in a week”.</li>
    </ul>
  </div>
  <div>
    <div class="stats">
      <div><b>5</b><span>business days for a standard site</span></div>
      <div><b>390</b><span>school pages on Is There School?</span></div>
      <div><b>5</b><span>browser games on Tycoon Universe</span></div>
      <div><b>1</b><span>person you deal with</span></div>
    </div>
    <div class="card" style="margin-top:20px"><h3>Local and nationwide</h3><p class="muted">Based in Reston and glad to meet in person around Fairfax and Loudoun County. Most projects run fully online, so clients anywhere in the US are welcome.</p><a class="link-arrow" href="/web-design-northern-virginia">Northern Virginia web design →</a></div>
  </div>
</div></section>
${ctaBand()}`;
  return page(ctx, {
    title: "About: a one-person web studio in Reston, VA",
    description: "A small web design and development studio in Reston, Virginia. AI-assisted development, real code, honest timelines, and one person from first message to launch.",
    path: "/about",
    body,
    jsonld: [orgLd(ctx), crumbsLd(ctx, [["Home", "/"], ["About", "/about"]])],
  });
}

// ───────── FAQ ─────────
export async function faqPage(env) {
  const ctx = await context(env);
  const faqs = await all(env, "SELECT * FROM faqs WHERE published = 1 ORDER BY CASE page WHEN 'home' THEN 0 WHEN 'pricing' THEN 1 ELSE 2 END, sort, id");
  const body = `
<section class="page-hero"><div class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>FAQ</span></nav><div class="eyebrow">FAQ</div><h1>Questions, answered.</h1></div></section>
<section style="padding-top:0"><div class="narrow">${faqHtml(faqs)}</div></section>
${ctaBand("Still wondering about something?", "Ask in the quote form. There's no obligation, and you'll get a real answer.")}`;
  return page(ctx, { title: "Frequently asked questions", description: "How the five-business-day website works, payments, ownership, hosting, revisions, add-ons and SEO, answered plainly.", path: "/faq", body, jsonld: [faqLd(faqs), crumbsLd(ctx, [["Home", "/"], ["FAQ", "/faq"]])] });
}

// ───────── Quote form ─────────
export async function quotePage(env) {
  const ctx = await context(env);
  const [packages, addons, plans] = await Promise.all([loadPackages(env), all(env, "SELECT * FROM addons WHERE active = 1 ORDER BY sort, id"), all(env, "SELECT * FROM care_plans WHERE active = 1 ORDER BY sort")]);
  const cats = [...new Set(addons.map((a) => a.category))];
  const siteKey = env.TURNSTILE_SITE_KEY || "";
  const body = `
<section class="page-hero" style="padding-bottom:24px"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>Get a quote</span></nav>
  <div class="eyebrow">Get a quote</div>
  <h1>Tell me about your business.</h1>
  <p class="lede">A few minutes now saves days later. I reply within one business day with questions or a written quote. Nothing is booked or charged until you accept one.</p>
</div></section>
<section style="padding-top:0"><div class="wrap quote-grid">
  <form class="form" id="quote-form" novalidate data-sitekey="${esc(siteKey)}">
    <div class="row-2">
      <div class="field"><label for="q-name">Your name</label><input id="q-name" name="name" type="text" autocomplete="name" required></div>
      <div class="field"><label for="q-email">Email</label><input id="q-email" name="email" type="email" autocomplete="email" required></div>
    </div>
    <div class="row-2">
      <div class="field"><label for="q-business">Business name</label><input id="q-business" name="business" type="text" autocomplete="organization"></div>
      <div class="field"><label for="q-phone">Phone <span class="muted">(optional)</span></label><input id="q-phone" name="phone" type="tel" autocomplete="tel"></div>
    </div>
    <div class="row-2">
      <div class="field"><label for="q-website">Current website <span class="muted">(if any)</span></label><input id="q-website" name="website" type="url" placeholder="https://"></div>
      <div class="field"><label for="q-location">Where you're based</label><input id="q-location" name="location" type="text" placeholder="e.g. Reston, VA"></div>
    </div>
    <fieldset><legend>Which package sounds closest?</legend><div class="choice-grid">
      ${packages.map((p) => `<label class="choice"><input type="radio" name="package" value="${esc(p.slug)}"><span><b>${esc(p.name)}</b><small>${p.price_cents === null ? "Custom quote" : `${p.price_prefix ? p.price_prefix + " " : ""}${money(p.price_cents)}`} · ${esc(p.turnaround_text || "")}</small></span></label>`).join("")}
      <label class="choice"><input type="radio" name="package" value=""><span><b>Not sure yet</b><small>I'll recommend one</small></span></label>
    </div></fieldset>
    <fieldset><legend>Anything extra? <span class="muted" style="font-weight:400">(optional)</span></legend>
      ${cats.map((c, i) => `<details class="more"${i === 0 ? "" : ""}><summary>${esc(c)}</summary><div class="checks">${addons.filter((a) => a.category === c).map((a) => `<label class="check"><input type="checkbox" name="addons" value="${a.id}"><span>${esc(a.name)} <small>${esc(addonPrice(a))}</small></span></label>`).join("")}</div></details>`).join("")}
    </fieldset>
    <div class="row-2">
      <div class="field"><label for="q-timeline">When do you need it?</label><select id="q-timeline" name="timeline"><option value="">No rush</option><option>As soon as possible</option><option>Within a month</option><option>In 1–3 months</option><option>Just exploring</option></select></div>
      <div class="field"><label for="q-care">Interested in ongoing care?</label><select id="q-care" name="care_plan"><option value="">Not sure</option><option value="none">No, just the website</option>${plans.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join("")}</select></div>
    </div>
    <div class="field"><label for="q-message">What should the website do for your business?</label><div class="hint">Who your customers are, what you want them to do on the site, sites you like, anything you already have.</div><textarea id="q-message" name="message" rows="6"></textarea></div>
    <div class="hp" aria-hidden="true"><label>Company website <input name="company_website" tabindex="-1" autocomplete="off"></label></div>
    <div id="turnstile"></div>
    <div class="form-msg" role="status" aria-live="polite" hidden></div>
    <div><button class="btn accent" type="submit">Send my request <span class="arrow">→</span></button></div>
    <p class="muted small">I'll only use your details to reply about your project. See the <a href="/privacy">privacy notice</a>.</p>
  </form>
  <aside style="position:sticky;top:100px">
    <div class="card"><h3>What happens next</h3><div class="steps">
      <div class="step"><div><h3 style="font-size:1rem">I read it properly</h3><p class="small">And reply within one business day, often sooner.</p></div></div>
      <div class="step"><div><h3 style="font-size:1rem">You get a written quote</h3><p class="small">Scope, price, timeline and payment schedule, in your own project portal.</p></div></div>
      <div class="step"><div><h3 style="font-size:1rem">You decide</h3><p class="small">No obligation. Accept and pay the deposit only if it's right.</p></div></div>
    </div></div>
    <p class="muted small" style="margin-top:16px">Prefer email? <a href="mailto:${esc(ctx.biz.email)}">${esc(ctx.biz.email)}</a></p>
  </aside>
</div></section>`;
  return page(ctx, {
    title: "Get a quote for your website",
    description: "Request a written quote for a custom small-business website or web app. Reply within one business day, no obligation.",
    path: "/quote",
    body,
    scripts: ["/js/quote.js"],
    head: siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" async defer></script>' : "",
  });
}

// ───────── Northern Virginia (a single, substantive local page) ─────────
export async function localPage(env) {
  const ctx = await context(env);
  const packages = await loadPackages(env);
  const body = `
<section class="page-hero"><div class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>Northern Virginia</span></nav>
  <div class="eyebrow">Reston · Fairfax County · Loudoun County</div>
  <h1>Web design for Northern Virginia small businesses.</h1>
  <p class="lede">Custom websites and web apps built in Reston for businesses across Fairfax and Loudoun County, with standard sites live in one business week. Happy to meet in person; just as happy to do it all online.</p>
  <p style="margin-top:22px"><a class="btn accent" href="/quote">Get a quote <span class="arrow">→</span></a></p>
</div></section>
<section style="padding-top:0"><div class="wrap case-body">
  <div class="prose">
    <h2 id="reston" style="margin-top:0">Built in Reston, for local customers</h2>
    <p><a href="/work/walks-for-lucy">Walks for Lucy</a> is a Reston dog walking and pet sitting business whose whole operation runs on a site I built: online booking requests, a drive-time service-area map covering Reston, Herndon, Sterling and Ashburn, client accounts with visit reports and photos, bills and automatic reminders. It shows what a local service business can do with a website that's more than a brochure.</p>
    <h2 id="fairfax">Fairfax County</h2>
    <p><a href="/work/is-there-school">Is There School?</a> answers one question for parents across Fairfax, Loudoun and Prince William counties every school morning: open, delayed or closed, for every one of 390 public schools, with bell times, lunch menus and calendars. Local knowledge matters in web design too: the right town names, the right service areas, the details people actually search for.</p>
    <h2 id="loudoun">Loudoun County and beyond</h2>
    <p>From Ashburn and Leesburg to Sterling and South Riding, the same process applies: a written quote, a guided onboarding checklist, and a five-business-day build once everything's approved. Projects outside Virginia work exactly the same way, entirely online.</p>
    <h2>What local businesses usually need</h2>
    <ul>
      <li>A fast, mobile-first site with your services, prices and service area.</li>
      <li>Google-friendly basics: titles, descriptions, structured data, a sitemap and your business details.</li>
      <li>Booking or appointment requests, and email notifications so you never miss one.</li>
      <li>Photos of your real work, not stock photography.</li>
      <li>A way for customers to pay deposits or invoices online, if you want it.</li>
    </ul>
    <p>I don't promise rankings. Nobody honestly can. I build sites the way search engines reward: fast, clear, well-structured and specific to where you work.</p>
  </div>
  <aside>
    <div class="card"><h3>Starting prices</h3>${packages.map((p) => `<div class="check-row"><span>${esc(p.name)}</span><b class="mono">${p.price_cents === null ? "Quote" : `${p.price_prefix ? p.price_prefix + " " : ""}${money(p.price_cents)}`}</b></div>`).join("")}<p class="small muted" style="margin:12px 0 0"><a href="/pricing">Full pricing and add-ons →</a></p></div>
    <div class="card" style="margin-top:18px"><h3>Areas served in person</h3><p class="muted small">Reston, Herndon, Sterling, Ashburn, Chantilly, Centreville, Fairfax, Vienna, McLean, Leesburg and nearby. Everywhere else in the US: online.</p></div>
  </aside>
</div></section>
${ctaBand("Local business? Let's talk.")}`;
  return page(ctx, {
    title: "Web design in Reston & Northern Virginia",
    description: "Custom small-business websites and web apps for Reston, Fairfax County and Loudoun County, built in one business week. Booking systems, client portals and online payments.",
    path: "/web-design-northern-virginia",
    body,
    jsonld: [orgLd(ctx), crumbsLd(ctx, [["Home", "/"], ["Northern Virginia web design", "/web-design-northern-virginia"]])],
  });
}

// ───────── Privacy ─────────
export async function privacyPage(env) {
  const ctx = await context(env);
  const body = `
<section class="page-hero"><div class="wrap"><div class="eyebrow">Privacy</div><h1>Privacy notice</h1><p class="lede">Plain words about what this site collects and why.</p></div></section>
<section style="padding-top:0"><div class="narrow prose">
  <div class="notice">This notice is a draft pending review. Questions: <a href="mailto:${esc(ctx.biz.email)}">${esc(ctx.biz.email)}</a>.</div>
  <h2>What's collected</h2>
  <p>When you request a quote: your name, email, optional phone, business details and what you write. If you become a client: the materials you upload during onboarding, messages, agreements you accept (with the time, IP address and browser recorded as evidence of acceptance) and payment records.</p>
  <h2>How it's used</h2>
  <p>Only to reply to you, run your project and keep proper business records. It's never sold. Optional AI tools may help summarize inquiries for me to read; they never contact you or make decisions.</p>
  <h2>Payments</h2>
  <p>Card payments are handled by Stripe on its own secure pages. Card numbers never reach this site.</p>
  <h2>Where it's stored</h2>
  <p>On Cloudflare (database and private file storage), with email sent through Resend. Uploaded files are private and only reachable by you and the studio after signing in.</p>
  <h2>Cookies</h2>
  <p>A single sign-in cookie for the client portal. No advertising or tracking cookies.</p>
  <h2>Your choices</h2>
  <p>Ask for a copy of your information, or for it to be deleted (except records the law requires keeping), by emailing <a href="mailto:${esc(ctx.biz.email)}">${esc(ctx.biz.email)}</a>.</p>
</div></section>`;
  return page(ctx, { title: "Privacy notice", description: "What this site collects, why, and how it's protected.", path: "/privacy", body });
}

export async function notFoundPage(env) {
  const ctx = await context(env);
  return page(ctx, {
    title: "Page not found",
    description: "That page doesn't exist.",
    path: "/404",
    noindex: true,
    body: `<section class="page-hero"><div class="wrap"><div class="eyebrow">404</div><h1>That page took the week off.</h1><p class="lede">The link may be old or mistyped.</p><p style="margin-top:24px"><a class="btn" href="/">Go home</a> <a class="btn ghost" href="/work">See the work</a></p></div></section>`,
  });
}

export async function sitemap(env) {
  const site = siteUrl(env);
  const work = await loadWork(env);
  const paths = ["/", "/work", "/pricing", "/process", "/about", "/faq", "/quote", "/web-design-northern-virginia", "/privacy", ...work.map((w) => `/work/${w.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${site}${p}</loc></url>`).join("\n")}\n</urlset>\n`;
}

export const robots = (env) => `User-agent: *\nDisallow: /admin/\nDisallow: /portal/\nDisallow: /api/\n\nSitemap: ${siteUrl(env)}/sitemap.xml\n`;
