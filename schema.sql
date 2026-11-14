-- Fiveday Studio database (Cloudflare D1). The Worker runs this on start-up (CREATE ... IF NOT EXISTS),
-- so a schema change never needs a manual step. Money is stored in whole cents. Dates are YYYY-MM-DD
-- (business dates, America/New_York); timestamps are UTC "YYYY-MM-DD HH:MM:SS".

-- Key/value settings: business details, homepage text, closed dates, secrets made by the Worker
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Catalog (all editable in Admin → Content) ─────────
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tagline TEXT,
  price_cents INTEGER,                 -- null = custom quote
  price_prefix TEXT,                   -- e.g. "from"
  turnaround_days INTEGER,             -- business days; null = set per quote
  turnaround_text TEXT,
  support_days INTEGER NOT NULL DEFAULT 7,
  revision_rounds INTEGER NOT NULL DEFAULT 1,
  deposit_percent INTEGER NOT NULL DEFAULT 50,
  fast_track INTEGER NOT NULL DEFAULT 0, -- qualifies for the one-business-week promise
  features TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  featured INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER,                 -- null = custom quote
  price_prefix TEXT,                   -- "from", "+", …
  unit TEXT,                           -- "per page", "/mo", …
  extends_timeline INTEGER NOT NULL DEFAULT 0, -- 1 = usually adds days beyond the standard week
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS care_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'care',   -- care | waas (website as a service)
  monthly_cents INTEGER,               -- null = custom
  term_months INTEGER,                 -- 0 = month to month, null = custom agreement
  description TEXT,
  features TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  url TEXT,
  kind TEXT,                           -- "Small business · booking", …
  summary TEXT,
  story TEXT,                          -- longer write-up (paragraphs separated by blank lines)
  built TEXT NOT NULL DEFAULT '[]',     -- JSON array: what was built
  stack TEXT NOT NULL DEFAULT '[]',
  image TEXT,                          -- desktop screenshot path
  image_mobile TEXT,
  extra_images TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'live', -- live | preview
  permission INTEGER NOT NULL DEFAULT 0, -- owner said it may be shown (client work needs this)
  published INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  page TEXT NOT NULL DEFAULT 'faq',    -- faq | pricing | home (home shows on both)
  sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1
);

-- ───────── Agreements ─────────
-- A template version is never edited after a client accepts it: edits make a new version.
CREATE TABLE IF NOT EXISTS agreement_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,                  -- project | care | waas
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,                  -- Markdown-ish text with {{placeholders}}
  attorney_approved INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (slug, version)
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  client_id INTEGER NOT NULL,
  subscription_id INTEGER,
  template_id INTEGER NOT NULL,
  template_slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,                  -- the exact text shown to the client (filled in)
  body_hash TEXT NOT NULL,             -- SHA-256 of body, recorded with the acceptance
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | void
  accepted_at TEXT,
  accepted_name TEXT,
  accepted_email TEXT,
  accepted_ip TEXT,
  accepted_ua TEXT,
  consent_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── People ─────────
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  business TEXT,
  website TEXT,
  package_slug TEXT,
  addons TEXT NOT NULL DEFAULT '[]',    -- JSON array of addon ids
  care_plan TEXT,
  budget TEXT,
  timeline TEXT,
  location TEXT,
  message TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'new',  -- new | contacted | quoted | won | lost
  ai_summary TEXT,                     -- JSON suggestion from AI triage (never acted on automatically)
  notes TEXT,
  project_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  business TEXT,
  phone TEXT,
  notes TEXT,
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Client sign-in: one-time links (hashed) and sessions (hashed). Raw tokens are never stored.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Projects ─────────
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  title TEXT NOT NULL,
  package_slug TEXT,
  scope TEXT NOT NULL DEFAULT '[]',     -- JSON array of agreed deliverables
  addons TEXT NOT NULL DEFAULT '[]',    -- JSON array of {name, price_cents}
  price_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'quote',
  -- quote | awaiting_onboarding | ready_to_start | in_development | awaiting_feedback | in_revision
  -- | ready_for_launch | completed | paused | cancelled
  status_before_pause TEXT,
  pause_reason TEXT,
  pause_owner TEXT,                    -- client | studio
  turnaround_days INTEGER,             -- agreed business days of build time
  fast_track INTEGER NOT NULL DEFAULT 0,
  feedback_days INTEGER NOT NULL DEFAULT 2, -- business days the client has to answer before the clock pauses
  revision_rounds INTEGER NOT NULL DEFAULT 1,
  revisions_used INTEGER NOT NULL DEFAULT 0,
  support_days INTEGER NOT NULL DEFAULT 7,
  ready_at TEXT,                       -- when onboarding + payment + agreement were all satisfied
  start_date TEXT,                     -- first business day of the build
  due_date TEXT,                       -- current delivery target (recomputed from holds)
  preview_url TEXT,
  live_url TEXT,
  launched_at TEXT,
  completed_at TEXT,
  quote_sent_at TEXT,
  quote_expires TEXT,
  notes TEXT,                          -- private studio notes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Periods the delivery clock is held: waiting on client feedback (after the grace days) or paused
CREATE TABLE IF NOT EXISTS project_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- feedback | pause
  owner TEXT NOT NULL DEFAULT 'client',
  reason TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,                       -- null while still on hold
  grace_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_date TEXT,
  done_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Onboarding checklist: one row per requirement for a project
CREATE TABLE IF NOT EXISTS onboarding_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  section TEXT NOT NULL,
  label TEXT NOT NULL,
  help TEXT,
  fields TEXT NOT NULL DEFAULT '[]',    -- JSON form definition
  allow_files INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,
  value TEXT NOT NULL DEFAULT '{}',     -- JSON answers
  status TEXT NOT NULL DEFAULT 'not_started',
  -- not_started | submitted | needs_changes | approved | exception_approved
  admin_note TEXT,
  exception_requested INTEGER NOT NULL DEFAULT 0,
  exception_reason TEXT,
  submitted_at TEXT,
  reviewed_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,                  -- null for studio-wide files (portfolio images)
  item_id INTEGER,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'onboarding', -- onboarding | preview | deliverable | message | agreement | public
  uploaded_by TEXT NOT NULL,           -- client | studio
  visible_to_client INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  sender TEXT NOT NULL,                -- client | studio | system
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Previews sent for review, and the client's answer (approve or request changes)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'design', -- design | final
  title TEXT NOT NULL,
  url TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | approved | changes_requested
  response TEXT,
  responded_at TEXT,
  responded_name TEXT,
  counts_as_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Money ─────────
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  project_id INTEGER,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom', -- deposit | milestone | final | installment | custom
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date TEXT,
  due_trigger TEXT,                    -- start | launch | date (when it becomes due)
  required_for_start INTEGER NOT NULL DEFAULT 0,
  required_for_launch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | open | paid | void
  sent_at TEXT,
  paid_at TEXT,
  stripe_session_id TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  invoice_id INTEGER,
  subscription_id INTEGER,
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL,                -- stripe | manual
  reference TEXT,                      -- Stripe payment / invoice id, or a note for manual payments
  note TEXT,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (method, reference)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER,
  plan_slug TEXT,
  name TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL,
  term_months INTEGER NOT NULL DEFAULT 0, -- minimum commitment; 0 = month to month
  status TEXT NOT NULL DEFAULT 'offered', -- offered | active | past_due | canceled | ended
  stripe_subscription_id TEXT UNIQUE,
  stripe_session_id TEXT,
  started_at TEXT,
  commitment_ends TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every Stripe webhook event handled (so a repeat delivery does nothing)
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────── Audit trail and automation ─────────
-- Who did what, to which project. actor: studio | client:<id> | system | stripe | ai
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_project ON activity (project_id, id);

-- Automatic emails already sent (the key makes each reminder go out once)
CREATE TABLE IF NOT EXISTS sent_log (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Delivery log of alerts and emails, with failures (Admin → Setup)
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS items_project ON onboarding_items (project_id, sort);
CREATE INDEX IF NOT EXISTS files_project ON files (project_id);
CREATE INDEX IF NOT EXISTS messages_project ON messages (project_id, id);
CREATE INDEX IF NOT EXISTS invoices_project ON invoices (project_id);
CREATE INDEX IF NOT EXISTS projects_client ON projects (client_id);
