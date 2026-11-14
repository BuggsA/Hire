// Starting content, written to the database once. Everything here is editable in Admin → Content,
// and prices are examples, not commitments. Agreement texts are DRAFTS for attorney review.

const J = JSON.stringify;

export const DEFAULT_BUSINESS = {
  name: "Fiveday Studio",
  short: "Fiveday",
  tagline: "A professional website. One business week.",
  owner: "",
  email: "hello@fiveday.studio",
  phone: "",
  city: "Reston",
  region: "Virginia",
  area: "Northern Virginia",
  payment_note: "Card payments go through Stripe's secure checkout. Card numbers never touch this site.",
};

export const DEFAULT_HOME = {
  eyebrow: "Custom websites · Reston, VA · Working nationwide",
  headline: "A professional website.|One business week.",
  intro:
    "I design and build custom websites and web apps for small businesses: your brand, your words, real code. A standard site goes live five business days after your materials are in. No templates, no page builders, no agency overhead.",
  cta: "Get a quote",
  promise_title: "How a week is possible",
  promise:
    "I build with AI-assisted development and a toolkit I've refined across real products: booking systems, dashboards, payment flows and notifications. The repetitive parts are fast, so the time goes into design, writing and getting the details right. The week starts once your onboarding is approved, so nothing stalls waiting on photos.",
};

const packages = [
  {
    slug: "starter",
    name: "Starter Site",
    tagline: "A clean, custom home on the web for a small business.",
    price_cents: 15000,
    price_prefix: null,
    turnaround_days: 5,
    turnaround_text: "5 business days",
    support_days: 7,
    revision_rounds: 1,
    deposit_percent: 50,
    fast_track: 1,
    featured: 0,
    features: [
      "Custom design using your logo, colors and photos",
      "Up to 3 pages",
      "Looks right on phones, tablets and desktops",
      "Contact form that emails you",
      "Services, hours and business details",
      "Basic SEO: titles, descriptions, sitemap, Google-ready",
      "Fast loading and tidy, accessible code",
      "Subtle page transitions",
      "Help putting it live on your domain",
      "1 round of revisions",
      "7 days of support after launch",
    ],
  },
  {
    slug: "business",
    name: "Business Site",
    tagline: "More pages, more polish, and the features customers use.",
    price_cents: 45000,
    price_prefix: "from",
    turnaround_days: 5,
    turnaround_text: "5–10 business days, set in your quote",
    support_days: 14,
    revision_rounds: 2,
    deposit_percent: 50,
    fast_track: 0,
    featured: 1,
    features: [
      "Everything in Starter",
      "Up to 8 pages with richer layouts",
      "Scroll animations and interactive sections",
      "Service menus, product catalogs or photo galleries",
      "Booking or appointment-request form",
      "Fuller SEO: structured data, local search, social previews",
      "Stronger branding: type, color and graphic details",
      "2 rounds of revisions",
      "14 days of support after launch",
    ],
  },
  {
    slug: "custom-app",
    name: "Custom Web App",
    tagline: "When you need software, not just pages.",
    price_cents: 120000,
    price_prefix: "from",
    turnaround_days: null,
    turnaround_text: "Timeline set in your quote",
    support_days: 30,
    revision_rounds: 2,
    deposit_percent: 40,
    fast_track: 0,
    featured: 0,
    features: [
      "Customer accounts and logins",
      "Client dashboards and admin portals",
      "Databases and customer records",
      "Online payments, deposits and subscriptions",
      "Booking management",
      "Automated emails, reminders and notifications",
      "Reports and API integrations",
      "Workflows built around how you work",
      "30 days of support after launch",
    ],
  },
];

// [category, name, description, price (dollars) | null, prefix, unit, extends timeline]
const addons = [
  ["Design & experience", "Extra page", "Another page in the same design.", 25, null, "per page", 0],
  ["Design & experience", "Advanced scroll animations", "Sections that reveal, layer and move as visitors scroll.", 75, null, null, 0],
  ["Design & experience", "Custom interactive animation", "A signature moment: an animated hero, product explorer or illustration that responds.", 120, "from", null, 1],
  ["Design & experience", "Animated illustrations or graphics", "Simple, light vector animation that fits your brand.", 90, "from", null, 0],
  ["Design & experience", "Interactive calculator or tool", "Quotes, estimates, ROI, sizing: answers visitors can work out themselves.", 150, "from", null, 1],
  ["Design & experience", "Enhanced branding", "A refreshed wordmark, color palette and type system to use everywhere.", 120, "from", null, 0],
  ["Design & experience", "Custom graphics", "Icons, badges and section art made for your site.", 60, "from", null, 0],
  ["Design & experience", "Blog or content editing", "Posts and pages you can update yourself.", 200, "from", null, 1],
  ["Business features", "Online appointment scheduling", "Customers pick a time from your availability.", 150, "from", null, 0],
  ["Business features", "Booking and reservation system", "Requests, approvals, calendars and clash checks.", 400, "from", null, 1],
  ["Business features", "Lead and contact dashboard", "Every inquiry in one private list with status and notes.", 250, "from", null, 1],
  ["Business features", "Client portal", "Customers sign in to see their bookings, files, bills and messages.", 500, "from", null, 1],
  ["Business features", "Admin dashboard", "Your private back office for managing the site's data.", 400, "from", null, 1],
  ["Business features", "Customer messaging", "Message threads between you and each customer.", 250, "from", null, 1],
  ["Business features", "Email notifications", "Branded emails for confirmations and updates.", 75, null, null, 0],
  ["Business features", "Automated reminders", "Reminder emails that send themselves on a schedule.", 100, "from", null, 0],
  ["Business features", "File and document uploads", "Private uploads from customers, stored securely.", 150, "from", null, 1],
  ["Payments & commerce", "Stripe payments", "Card and wallet payments through Stripe's hosted checkout.", 150, "from", null, 0],
  ["Payments & commerce", "One-time payments", "Pay-now buttons for services, classes or fees.", 100, null, null, 0],
  ["Payments & commerce", "Recurring subscriptions", "Memberships or plans billed monthly or yearly.", 200, "from", null, 1],
  ["Payments & commerce", "Deposits and payment plans", "Take a deposit now and the balance later.", 150, "from", null, 1],
  ["Payments & commerce", "Invoicing", "Send invoices customers pay online.", 200, "from", null, 1],
  ["Payments & commerce", "Online storefront", "A small shop with cart and checkout.", 600, "from", null, 1],
  ["Payments & commerce", "Product catalog", "Products with photos, options and prices.", 200, "from", null, 0],
  ["Payments & commerce", "Customer payment history", "Customers see what they've paid and what's due.", 150, "from", null, 1],
  ["Advanced development", "Database integration", "Store and manage your own records.", 250, "from", null, 1],
  ["Advanced development", "Third-party API integrations", "Connect your CRM, calendar, inventory or other tools.", null, null, null, 1],
  ["Advanced development", "Custom calculators and pricing engines", "Complex rules turned into instant answers.", 250, "from", null, 1],
  ["Advanced development", "Advanced reporting", "Charts and exports from your business data.", 300, "from", null, 1],
  ["Advanced development", "Custom business automations", "Hand off routine work: follow-ups, assignments, status updates.", null, null, null, 1],
  ["Advanced development", "AI-powered features", "Summaries, sorting or drafting, where it genuinely helps and stays under your review.", null, null, null, 1],
  ["Advanced development", "Other integrations and special functionality", "Tell me what you need.", null, null, null, 1],
];

const carePlans = [
  ["care-monthly", "Care · month to month", "care", 2500, 0, "Cancel any time with 30 days' notice."],
  ["care-3", "Care · 3 months", "care", 2200, 3, "A short commitment at a lower monthly rate."],
  ["care-6", "Care · 6 months", "care", 2000, 6, "Half a year of looked-after hosting and updates."],
  ["care-12", "Care · 12 months", "care", 1800, 12, "The best rate, for a year of care."],
  ["care-custom", "Custom care agreement", "care", null, null, "For larger sites, more hours or special requirements."],
  ["waas-12", "Website as a service", "waas", 4900, 12, "A Starter or Business build plus care for one monthly fee instead of paying up front. Ownership, buyout and cancellation terms are spelled out in the agreement before you accept."],
];
const careFeatures = [
  "Hosting set-up and coordination",
  "Small content changes each month",
  "Security and software updates",
  "Uptime monitoring",
  "Backups",
  "Email support",
];

const portfolio = [
  {
    slug: "walks-for-lucy",
    title: "Walks for Lucy",
    url: "https://walksforlucy.com",
    kind: "Small business · bookings, client accounts, dashboard",
    summary: "A dog walking and pet sitting business in Reston, run entirely from its own website: booking requests, client accounts, visit reports with photos, bills and reminders.",
    story:
      "Walks for Lucy needed more than a brochure. Anissa runs the business from her phone between visits, so the site became the business's operating system.\n\nVisitors get a warm, fast public site with prices, a drive-time service-area map and a booking form. Clients sign in to see bookings, pet profiles, visit reports with photos, bills and messages. Behind it, a private dashboard follows each day's visits, works with no phone signal, and sends reminders and backups on its own.",
    built: [
      "Booking requests with clash warnings and approvals",
      "Client accounts with pet profiles, files and messages",
      "Mobile admin dashboard that works offline",
      "Visit reports with photos, private storage",
      "Bills, reminders and email notifications",
      "Daily automatic backups and an audit log",
      "Town landing pages and an SEO content section",
      "Automated tests for logins, bookings, bills and uploads",
    ],
    stack: ["Cloudflare Workers", "D1", "R2", "Cloudflare Access", "Turnstile", "Resend"],
    image: "/img/work/walks-for-lucy-desktop.webp",
    image_mobile: "/img/work/walks-for-lucy-mobile.webp",
    status: "live",
    permission: 1,
    featured: 1,
  },
  {
    slug: "paybook",
    title: "Paybook",
    url: "https://paybook.loopi.sh",
    kind: "Interactive data platform · calculators and charts",
    summary: "Federal and military pay, read like a pay statement: take-home pay, raises and pay tables for every locality, job series and base.",
    story:
      "Paybook turns official pay orders and government tables into pages anyone can read at a glance. Pick a grade, step and location and it works out the salary, each paycheck and the take-home after taxes, retirement and TSP.\n\nIt covers 58 locality areas, 442 job series, 175 wage areas, 338 housing areas and 295 per diem areas, with data stories that map pay across the country.",
    built: [
      "Pay and take-home calculators",
      "Thousands of generated, searchable pay pages",
      "Data visualizations and pay maps",
      "Military-to-civilian comparisons",
      "Written data stories",
    ],
    stack: ["Static generation", "Data pipelines", "Charts"],
    image: "/img/work/paybook-desktop.webp",
    image_mobile: "/img/work/paybook-mobile.webp",
    status: "live",
    permission: 1,
    featured: 1,
  },
  {
    slug: "is-there-school",
    title: "Is There School?",
    url: "https://isthereschool.com",
    kind: "Live information service · local",
    summary: "Open, delayed or closed? Every public school in Fairfax, Loudoun and Prince William counties, with bell times, calendars and lunch menus.",
    story:
      "Parents want one answer on a snowy morning. Is There School? remembers your school and opens straight to it: open, delayed or closed, with the right times.\n\nIt covers 390 schools across three districts, with live closing and delay status, school calendars, bell schedules, holidays and lunch menus.",
    built: [
      "Live closings and delay status",
      "390 school pages with bell times",
      "District calendars and holiday answers",
      "Lunch menus",
      "Saved schools and location search",
    ],
    stack: ["Live data feeds", "Calendars", "Local SEO"],
    image: "/img/work/is-there-school-desktop.webp",
    image_mobile: "/img/work/is-there-school-mobile.webp",
    status: "live",
    permission: 1,
    featured: 1,
  },
  {
    slug: "right-2-arms",
    title: "Right 2 Arms",
    url: "https://2.right2armsllc.com",
    kind: "Brand and website concept · training business",
    summary: "A bold, custom-branded design concept for a firearms training and carry-permit business: class menu, pricing, VIP services and booking.",
    story:
      "A design concept showing how a small training business can look established from day one: a hand-lettered identity, a photo-led hero, a scrolling class ticker and a clear menu of classes with prices.\n\nThis is a preview. The instructor names, photos and bios are still placeholders waiting on the client.",
    built: ["Custom brand styling", "Class menu with prices", "VIP and group sections", "Booking calls to action"],
    stack: ["Custom design", "Responsive layout"],
    image: "/img/work/right-2-arms-desktop.webp",
    image_mobile: "/img/work/right-2-arms-mobile.webp",
    status: "preview",
    permission: 0,
    published: 0,
    featured: 0,
  },
  {
    slug: "tycoon-universe",
    title: "Tycoon Universe",
    url: "https://tycoon-universe.com",
    kind: "Browser games · interactive applications",
    summary: "Five original tycoon and strategy games that run in the browser: no logins, no downloads, play with friends by link.",
    story:
      "Tycoon Universe is a hub for five original games, from a spooky idle story to a real-time strategy game that runs from the first fire to the age of steam.\n\nThey run in the browser on phones and laptops, with multiplayer rooms you join by link. It's the most demanding interactive work in this portfolio.",
    built: ["Five browser games", "Online multiplayer by link", "Mobile-first controls", "Game hub with filters"],
    stack: ["WebGL", "Realtime multiplayer"],
    image: "/img/work/tycoon-universe-desktop.webp",
    image_mobile: "/img/work/tycoon-universe-mobile.webp",
    status: "live",
    permission: 1,
    featured: 0,
  },
  {
    slug: "tidehere",
    title: "tidehere",
    url: "https://tidehere.app",
    kind: "Experiment · data visualization",
    summary: "Tide times for any coast, on a 3D globe of the moon pulling the ocean. NOAA predictions where there's a station, a global model everywhere else.",
    story: "A small tool with a big first impression: search a beach or harbor and see the next high and low tide, today's tide chart and the week ahead. No ads, no tracking.",
    built: ["3D globe", "Tide predictions and charts", "Location search"],
    stack: ["WebGL", "Open data"],
    image: "/img/work/tidehere-desktop.webp",
    image_mobile: "/img/work/tidehere-mobile.webp",
    status: "live",
    permission: 1,
    featured: 0,
  },
  {
    slug: "iphere",
    title: "iphere",
    url: "https://iphere.app",
    kind: "Experiment · interactive explainer",
    summary: "Your public IP address, location and provider, then a zoomable journey through the internet around it.",
    story: "A utility people search for every day, turned into something worth remembering: instant answers, then an explorable map of who runs the network you're on.",
    built: ["Edge-computed answers", "Interactive zoomable map", "Sound and guided mode"],
    stack: ["Cloudflare Workers", "Canvas"],
    image: "/img/work/iphere-desktop.webp",
    image_mobile: "/img/work/iphere-mobile.webp",
    status: "live",
    permission: 1,
    featured: 0,
  },
];

const faqs = [
  ["What does “one business week” really mean?", "For a Starter Site, five business days of build time. The clock starts the business day after three things are done: you've accepted the agreement, paid the deposit, and your onboarding materials are approved. You'll see the countdown in your project dashboard.", "home"],
  ["What if I'm still gathering photos or text?", "That's normal. Your onboarding checklist shows exactly what's needed. If something truly isn't available, you can ask for an exception and explain why. The week starts once everything is approved, so no one is stuck waiting halfway through a build.", "home"],
  ["Is this a template or a page builder?", "No. Every site is designed for the business and written in real code. You get a site that loads fast, ranks on its own merits and isn't locked into a monthly builder subscription.", "home"],
  ["How do payments work?", "Usually half up front and the balance at launch, paid by card through Stripe's secure checkout. Larger projects can be split into milestones or installments. Card details never touch this site.", "pricing"],
  ["What about hosting and my domain?", "I'll help you put the site live on your own domain. Many small sites can be hosted for little or nothing. Third-party costs like domains, email, hosting upgrades and payment fees are separate and paid to those providers.", "pricing"],
  ["What happens after launch?", "Every package includes a support period for fixes and questions. After that, care plans cover updates and small changes, or you can just get in touch when you need something.", "pricing"],
  ["Can every add-on be done in five days?", "No, and I won't pretend otherwise. Features like booking systems, client portals or stores add time. Your quote gives a specific timeline before you commit.", "pricing"],
  ["Do you only work in Northern Virginia?", "I'm in Reston and happy to meet locally in Fairfax and Loudoun County, but most projects run online, so I take work from anywhere in the US.", "faq"],
  ["Who owns the website?", "For a one-time purchase, you own the finished site once it's paid for in full. Website-as-a-service arrangements work differently, and the agreement spells out ownership and buyout before you accept anything.", "faq"],
  ["Can you guarantee I'll rank first on Google?", "No one honestly can. I build sites the way search engines reward: fast, well-structured, clearly written, with proper metadata and local details. Rankings then depend on your content, competition and reputation.", "faq"],
  ["Do you use AI?", "Yes, as a development tool. It speeds up the repetitive parts of building. Every design decision, line of copy and line of code is reviewed by me, and nothing goes live without your approval.", "faq"],
];

const AGREEMENT_PROJECT = `DRAFT FOR ATTORNEY REVIEW. This template has not yet been approved by an attorney. Do not rely on it as legal advice.

# Website Project Agreement

This agreement is between {{studio_name}} ("the Studio") and {{client_name}}{{client_business}} ("the Client"), dated {{date}}.

## 1. The project
{{project_title}}. The agreed scope is:
{{scope}}

Anything not listed above is outside this agreement and may be quoted separately.

## 2. Price and payments
The project price is {{price}}. Payments are due as follows:
{{payment_schedule}}

Payments are made by card through Stripe's hosted checkout or another method the Studio accepts. Third-party costs (domain names, hosting upgrades, email, plug-ins, payment processing and other service fees) are not included and are paid by the Client to those providers.

## 3. Onboarding and the delivery timeline
The Client will supply the materials listed in the onboarding portal (text, photos, logos, business details, approvals). The agreed build time is {{turnaround}}. The build begins on the first business day after (a) this agreement is accepted, (b) any payment required to start is received, and (c) the required onboarding items are approved by the Studio or excused by an exception the Studio approves in writing in the portal.

When the Studio sends a preview or asks a question, the Client has {{feedback_days}} business days to respond. Business days beyond that are added to the delivery target. Business days on which the project is paused at the Client's request, or for the Client's delay, are also added.

## 4. Revisions
This project includes {{revision_rounds}} round(s) of revisions. A round is one consolidated list of changes to the current preview. Additional rounds or new features may be quoted separately.

## 5. Approval and launch
The Client approves the final website in the portal. The Studio will help put the site live after final payment, as set out in section 2.

## 6. Support
The Studio will fix defects in the delivered work reported within {{support_days}} days of launch at no charge. Ongoing maintenance is optional and covered by a separate care agreement.

## 7. Content and ownership
The Client confirms it has the right to use everything it supplies and that claims made about its business (credentials, certifications, reviews) are accurate. On payment in full, the Client owns the final website design and content created for it. The Studio may reuse general techniques, code libraries and tools, and may show the work in its portfolio only with the Client's permission.

## 8. Ending the project
Either party may end the project in writing. Payments already made for work performed are not refundable except as required by law; terms for any refund are to be confirmed by attorney review.

## 9. Other terms
[Limitation of liability, warranties, governing law and dispute terms to be supplied by the Studio's attorney.]
`;

const AGREEMENT_CARE = `DRAFT FOR ATTORNEY REVIEW. This template has not yet been approved by an attorney. Do not rely on it as legal advice.

# Website Care Agreement

Between {{studio_name}} ("the Studio") and {{client_name}}{{client_business}} ("the Client"), dated {{date}}.

## 1. The plan
{{plan_name}}: {{monthly}} per month, billed monthly by card through Stripe. Minimum term: {{term}}.

## 2. What's included
{{plan_features}}

Work beyond the plan is quoted separately. Third-party costs (hosting upgrades, domains, email, paid plug-ins) are not included.

## 3. Cancelling
After the minimum term, either party may cancel with 30 days' written notice. [Early-termination terms, if any, to be supplied by the Studio's attorney.]

## 4. Other terms
[Limitation of liability, data handling, governing law and dispute terms to be supplied by the Studio's attorney.]
`;

const AGREEMENT_WAAS = `DRAFT FOR ATTORNEY REVIEW. This template has not yet been approved by an attorney. Do not rely on it as legal advice.

# Website-as-a-Service Agreement

Between {{studio_name}} ("the Studio") and {{client_name}}{{client_business}} ("the Client"), dated {{date}}.

## 1. The service
The Studio builds and maintains a website for the Client for {{monthly}} per month, billed monthly by card through Stripe, with a minimum term of {{term}}. Included: {{plan_features}}

## 2. Ownership
While this agreement is active, the Studio owns the website's design and code and licenses their use to the Client. The Client always owns its own content, logo, domain name and data. [Buyout price and process to be set by the Studio and reviewed by its attorney.]

## 3. Cancelling
After the minimum term, either party may cancel with 30 days' written notice. On cancellation the Studio will return the Client's content and help move the domain. [Terms for cancelling during the minimum term to be supplied by the Studio's attorney.]

## 4. Other terms
[Limitation of liability, governing law and dispute terms to be supplied by the Studio's attorney.]
`;

/** The statements that fill an empty database. */
export function seedStatements(db) {
  const s = [];
  const p = (sql, ...args) => s.push(db.prepare(sql).bind(...args));
  p("INSERT OR IGNORE INTO settings (key, value) VALUES ('business', ?)", J(DEFAULT_BUSINESS));
  p("INSERT OR IGNORE INTO settings (key, value) VALUES ('home', ?)", J(DEFAULT_HOME));
  p("INSERT OR IGNORE INTO settings (key, value) VALUES ('closed_dates', ?)", J([]));
  packages.forEach((k, i) =>
    p(
      `INSERT OR IGNORE INTO packages (slug, name, tagline, price_cents, price_prefix, turnaround_days, turnaround_text, support_days, revision_rounds, deposit_percent, fast_track, features, featured, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      k.slug, k.name, k.tagline, k.price_cents, k.price_prefix, k.turnaround_days, k.turnaround_text, k.support_days, k.revision_rounds, k.deposit_percent, k.fast_track, J(k.features), k.featured, i
    )
  );
  addons.forEach(([category, name, description, dollars, prefix, unit, ext], i) =>
    p("INSERT INTO addons (category, name, description, price_cents, price_prefix, unit, extends_timeline, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", category, name, description, dollars === null ? null : dollars * 100, prefix, unit, ext, i)
  );
  carePlans.forEach(([slug, name, kind, monthly, term, description], i) =>
    p("INSERT OR IGNORE INTO care_plans (slug, name, kind, monthly_cents, term_months, description, features, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", slug, name, kind, monthly, term, description, J(careFeatures), i)
  );
  portfolio.forEach((w, i) =>
    p(
      `INSERT OR IGNORE INTO portfolio (slug, title, url, kind, summary, story, built, stack, image, image_mobile, status, permission, published, featured, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      w.slug, w.title, w.url, w.kind, w.summary, w.story, J(w.built), J(w.stack), w.image, w.image_mobile, w.status, w.permission, w.published ?? 1, w.featured, i
    )
  );
  faqs.forEach(([q, a, page], i) => p("INSERT INTO faqs (question, answer, page, sort) VALUES (?, ?, ?, ?)", q, a, page, i));
  for (const [slug, title, body] of [
    ["project", "Website Project Agreement", AGREEMENT_PROJECT],
    ["care", "Website Care Agreement", AGREEMENT_CARE],
    ["waas", "Website-as-a-Service Agreement", AGREEMENT_WAAS],
  ])
    p("INSERT OR IGNORE INTO agreement_templates (slug, version, title, body) VALUES (?, 1, ?, ?)", slug, title, body);
  p("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', ?)", J(new Date().toISOString()));
  return s;
}

// ───────── The onboarding checklist every new project starts with ─────────
// fields: [{ name, label, type: text|textarea|email|tel|url|color|list, required?, placeholder? }]
export const ONBOARDING_TEMPLATE = [
  { key: "contact", section: "Your business", label: "Business name and contact details", help: "Exactly as you want them shown on the site.", fields: [
    { name: "business_name", label: "Business name", type: "text", required: true },
    { name: "public_email", label: "Email shown on the site", type: "email", required: true },
    { name: "public_phone", label: "Phone shown on the site", type: "tel" },
    { name: "address", label: "Street address (leave blank if you don't want it public)", type: "text" },
    { name: "hours", label: "Hours", type: "textarea" },
  ] },
  { key: "description", section: "Your business", label: "What your business does", help: "A few honest paragraphs: who you serve, what makes you different, how you started. I'll edit it into web copy; you approve the final words.", fields: [
    { name: "about", label: "About the business", type: "textarea", required: true },
    { name: "audience", label: "Who your best customers are", type: "textarea" },
  ] },
  { key: "services", section: "Your business", label: "Services and pricing", help: "Each service with a short description, and prices if you want them shown.", fields: [
    { name: "services", label: "Services (one per line: name, description, price)", type: "textarea", required: true },
  ] },
  { key: "location", section: "Your business", label: "Location and service area", fields: [
    { name: "based", label: "Where you're based", type: "text", required: true },
    { name: "areas", label: "Towns, counties or regions you serve", type: "textarea" },
  ] },
  { key: "logo", section: "Brand", label: "Logo files", help: "The best versions you have: SVG, PDF or a large PNG. Phone photos of signs are fine as a start.", allow_files: 1, fields: [
    { name: "notes", label: "Anything about the logo I should know", type: "textarea" },
  ] },
  { key: "brand", section: "Brand", label: "Brand colors and design preferences", help: "Colors you use, websites you like (and why), and anything you don't want.", fields: [
    { name: "colors", label: "Brand colors (hex codes or descriptions)", type: "text" },
    { name: "likes", label: "Websites or styles you like", type: "textarea", required: true },
    { name: "avoid", label: "Anything to avoid", type: "textarea" },
  ] },
  { key: "photos", section: "Photos", label: "Photos and visual assets", help: "You, your team, your work, your space. Originals from your phone are better than screenshots. I'll crop and optimize them.", allow_files: 1, fields: [
    { name: "notes", label: "Notes about the photos (who's who, what's what)", type: "textarea" },
  ] },
  { key: "team", section: "People & credentials", label: "Staff names and biographies", help: "Name, role, a short bio and a photo for each person you want shown.", allow_files: 1, fields: [
    { name: "people", label: "People (name, role, bio)", type: "textarea", required: true },
  ] },
  { key: "credentials", section: "People & credentials", label: "Certifications and verification links", help: "Licenses, certifications, insurance or memberships you want mentioned, with a link or document I can check. I only publish claims you can back up.", allow_files: 1, fields: [
    { name: "credentials", label: "Credentials and where to verify them", type: "textarea" },
  ] },
  { key: "social", section: "Online presence", label: "Social media accounts", fields: [
    { name: "links", label: "Profile links (one per line)", type: "textarea" },
  ], required: 0 },
  { key: "pages", section: "The website", label: "Pages you need", help: "Your package includes a set number of pages. List what you'd like and I'll confirm.", fields: [
    { name: "pages", label: "Pages (one per line)", type: "textarea", required: true },
  ] },
  { key: "features", section: "The website", label: "Features and add-ons", help: "Anything beyond your package? Booking, payments, galleries… I'll confirm what's included and quote anything extra before doing it.", fields: [
    { name: "features", label: "Features you'd like", type: "textarea" },
  ], required: 0 },
  { key: "domain", section: "The website", label: "Domain and hosting", help: "Who your domain is registered with, and any current website or hosting. Please don't send passwords here; I'll ask for access safely when it's time.", fields: [
    { name: "domain", label: "Domain name", type: "text" },
    { name: "registrar", label: "Where it's registered (GoDaddy, Namecheap, Squarespace…)", type: "text" },
    { name: "current_site", label: "Current website or hosting, if any", type: "text" },
  ] },
  { key: "legal", section: "The website", label: "Legal policies", help: "Privacy policy, terms, refund or cancellation policies you want on the site. You're responsible for their content; I'll format and publish them.", allow_files: 1, fields: [
    { name: "policies", label: "Policies (paste them, upload them, or tell me what's needed)", type: "textarea" },
  ] },
  { key: "special", section: "Anything else", label: "Special requests", fields: [
    { name: "requests", label: "Anything else I should know", type: "textarea" },
  ], required: 0 },
];
