# Fiveday Studio

**A professional website. One business week.** The public website for a small custom web studio, plus the system behind it: quote requests, agreements, payments, a client onboarding portal, project tracking and an admin dashboard.

“Fiveday Studio” is a working name. Change it in one place: Dashboard → Content → Business & homepage (and `SITE_URL` in `wrangler.toml`).

## Architecture (and why it's cheap)

One Cloudflare Worker serves everything. Same approach as Walks for Lucy, but **entirely separate**: its own Worker, D1 database, R2 bucket, Access applications and secrets. Nothing reads or writes Walks for Lucy data.

| Piece | What it does | Cost |
|---|---|---|
| Cloudflare Worker (`src/worker.js`) | Renders the public pages from the database (so prices, portfolio and FAQs are editable and visible to search engines), runs the API, protects `/admin` | Free plan (100k requests/day) |
| D1 database `fiveday-studio` (`schema.sql`) | Leads, clients, projects, onboarding, invoices, agreements, audit trail | Free tier |
| R2 bucket `fiveday-studio-files` | Private client uploads and studio files. Nothing in it is public | Free up to 10 GB |
| Cloudflare Access | Your admin login (one-time code to your email) | Free (50 users) |
| Client sign-in | Email link + session cookie, built in (no seat limits) | Free |
| Resend | Emails to clients and to you | Free up to 3,000/month |
| Stripe Checkout | Card payments, deposits, invoices, subscriptions | Stripe's per-payment fees only |
| Turnstile | Spam protection on the quote form | Free |
| ntfy (optional) | Phone push alerts | Free |
| Anthropic API (optional) | Summaries of new inquiries for you to read | Pennies per inquiry |

Plain HTML/CSS/JS, no build step. Reused from the Walks for Lucy codebase: the Access login check, Turnstile verification, Resend email layout, ntfy alerts with email fallback, the activity log, schema-on-startup, and the test harness that runs the real Worker against a throwaway database.

## What's where

| Path | What it is |
|---|---|
| `src/pages/public.js`, `src/pages/layout.js` | Public pages: home, pricing, work + case studies, process, about, FAQ, quote form, Northern Virginia page, privacy, sitemap |
| `src/lib/timeline.js` | **The delivery-clock rules** (business days, when the clock starts, holds and pauses). Pure functions, fully tested |
| `src/lib/workflow.js` | Project statuses, what each change does, whose turn it is, previews/approvals/revisions/launch |
| `src/lib/automation.js` | The daily run: reminders, follow-ups, overdue checks and your morning digest |
| `src/lib/stripe.js` | Checkout sessions, webhook verification, payment and subscription tracking |
| `src/lib/agreements.js` | Agreement templates → frozen per-client copies → recorded acceptance |
| `src/lib/files.js` | Private uploads in R2 |
| `src/lib/auth.js` | Admin (Cloudflare Access) and client (email link) sign-in |
| `src/lib/ai.js` | Optional AI inquiry summaries (suggestions only) |
| `src/lib/seed.js` | Starting prices, add-ons, care plans, portfolio, FAQs, agreement drafts and the onboarding checklist. Written to the database once; edit them in the dashboard afterwards |
| `src/api/` | `public.js` (quote form, sign-in, Stripe webhook), `portal.js` (clients), `admin.js` + `content.js` (you) |
| `public/portal/`, `public/js/portal.js` | Client portal |
| `public/admin/`, `public/js/admin.js` | Your dashboard |
| `public/img/work/` | Real screenshots of the portfolio sites |

## How a project flows

1. A visitor sends the quote form → a **lead** (you get an alert; optional AI summary).
2. You create a quote from the lead, adjust price/scope, **Send quote**. That creates the deposit (due before the build) and final payment (due at launch), freezes the agreement text for this client, and emails a sign-in link.
3. The client reads and **accepts the agreement** (consent box + typed name; version, text fingerprint, time, IP and browser are recorded) and **pays the deposit** through Stripe.
4. The project moves to **Awaiting onboarding** by itself. The client works through the checklist: forms, uploads, progress bar, statuses (Not started / Submitted / Needs changes / Approved / Exception approved). They can request an exception with a reason.
5. Only you approve items or grant exceptions. When the last required item is approved, **day 1 is set to the next business day** and the delivery target is calculated. Nobody can skip this by hand.
6. On day 1 the project moves to **In development**. Send a preview → **Awaiting client feedback**. The client has a reply window (default 2 business days); every business day beyond it moves the delivery date, and the client sees that.
7. The client approves or sends one list of changes (counted against included revision rounds; extra rounds are flagged to you).
8. Send the **final** preview; the client signs off (name + confirmation) → **Ready for launch**, final invoice becomes due.
9. Once it's paid, **Mark launched** → **Completed**. Optional care plan via Stripe subscription.

The dashboard's **Today** page shows everything waiting on you, and every project shows whose turn it is. Each morning you get one digest email if anything needs you.

### What runs automatically (daily, ~9am Eastern, business days)

- Onboarding reminders every 3 days, listing exactly which items are missing or need changes
- A nudge when a preview passes the client's reply window (then every 3 days)
- Up to 3 weekly reminders for overdue invoices; one follow-up on unanswered quotes
- Projects start on day 1; delivery targets recalculate around holds, pauses and closed dates
- Alerts to you when onboarding is complete, items or exceptions need review, payments arrive, clients message or request changes

Each email is recorded once per key, so the job can run twice without double-sending.

### AI, and its limits

With `ANTHROPIC_API_KEY` set, new inquiries get a short summary, a suggested package, missing information and questions to ask, shown only in your Leads tab and labelled as a suggestion. The AI never emails clients, approves anything, changes prices or publishes anything. Every run is in the audit trail as `ai`.

### Agreements: please read

The three agreement templates (project, care, website-as-a-service) are **drafts for attorney review**, clearly marked as such in their text. Have an attorney review them, edit them in Dashboard → Content → Agreements (saving creates a new version; accepted agreements keep the exact text their client saw), and tick “attorney approved”.

## Prices

Starting prices (all editable in Dashboard → Content):

- **Starter Site: $150**, up to 3 pages, 5 business days, 1 revision round, 7 days of support
- **Business Site: from $450**, up to 8 pages, 2 rounds, 14 days of support
- **Custom Web App: from $1,200**, quoted individually, 30 days of support
- Add-ons from $25 (extra page) to custom quotes; care plans $18–25/month; website-as-a-service $49/month (12-month minimum)

## Run it on your computer

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev            # http://localhost:8787 (admin: /admin/ with DEV_ADMIN_BYPASS=1)
npm test               # about a minute
```

The tests run the real Worker in Node against a throwaway database and file store. Emails, alerts, Turnstile, Stripe and Anthropic are faked and recorded, so nothing real is contacted.

| Test file | What it checks |
|---|---|
| `tests/timeline.test.js` | Business days, closed dates, the start rule, reply windows, holds and pauses |
| `tests/access.test.js` | Admin logins (forged, expired, wrong app, wrong email), email-link sign-in (single use, expiry, rate limit, no account fishing), each client seeing only their own things |
| `tests/uploads.test.js` | Private files: who can upload/download/delete, file types and sizes, SVGs never open inline |
| `tests/payments.test.js` | Amounts from the database, signed webhooks only, replay and duplicate protection, amount mismatches, manual payments, installments, care-plan subscriptions |
| `tests/workflow.test.js` | Agreements, approvals and exceptions (studio only), the start rule, previews, revisions, holds, pauses, final sign-off, launch, reminders, audit trail |
| `tests/public.test.js` | Pages, SEO tags and structured data, editable prices, portfolio permission, quote form spam protection, AI suggestions |
| `tests/browser.test.js` | Real Chromium: pages without script errors or sideways scrolling, mobile menu, quote form, client portal sign-in → agreement → onboarding → upload, dashboard review |

## Put it live (one-time setup)

1. **Create the resources** (Cloudflare dashboard or CLI):
   ```bash
   npx wrangler d1 create fiveday-studio          # paste the id into wrangler.toml
   npx wrangler r2 bucket create fiveday-studio-files
   ```
   Tables and starting content are created automatically on first request.
2. **Worker:** connect this repo in Workers & Pages (deploy command `npx wrangler deploy`), or run `npm run deploy`. Add your domain under Settings → Domains & Routes and set `SITE_URL` / `TURNSTILE_HOSTNAMES` in `wrangler.toml` to match.
3. **Admin login (Cloudflare Access):** Zero Trust → Access → Applications → Self-hosted, paths `admin/*` and `api/admin/*` on your domain, policy *Allow* your email. Then add Worker variables `ACCESS_TEAM_DOMAIN` (e.g. `yourteam.cloudflareaccess.com`), `ACCESS_AUD` (the app's AUD tag) and `ADMIN_EMAILS` (your email). Use a new Access application, not the Walks for Lucy one.
4. **Email (Resend):** verify your domain, then add the secret `RESEND_API_KEY` and variable `EMAIL_FROM` (e.g. `Fiveday Studio <hello@yourdomain>`). Optional: `EMAIL_REPLY_TO`, `STUDIO_NOTIFY_EMAIL`.
5. **Stripe:** add secret `STRIPE_SECRET_KEY`. Create a webhook endpoint `https://<your domain>/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, and add its signing secret as `STRIPE_WEBHOOK_SECRET`. Test with test-mode keys first.
6. **Turnstile:** create a widget for your domain (action `quote`), add `TURNSTILE_SITE_KEY` (variable) and `TURNSTILE_SECRET` (secret). The form refuses submissions until this is set.
7. **Optional:** `NTFY_TOPIC` (long random name) for phone alerts; `ANTHROPIC_API_KEY` for inquiry summaries.
8. Open Dashboard → **Setup** to check every connection and send a test email/alert.

Then in the dashboard: set your business details, check prices, confirm portfolio permissions (Right 2 Arms is hidden until you tick “client gave permission”), and have the agreements reviewed.
