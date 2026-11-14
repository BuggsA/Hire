// Database set-up: tables are created on first use, and the catalog is filled with starting content
// the first time (prices, add-ons, portfolio, FAQs, agreement drafts). After that the studio edits
// everything in Admin → Content; the seed never overwrites anything.
import SCHEMA from "../../schema.sql";
import { seedStatements } from "./seed.js";

// Columns added after a table first shipped ("CREATE TABLE IF NOT EXISTS" can't add them)
const ADDED_COLUMNS = {};

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    const statements = SCHEMA.replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.DB.prepare(s));
    ready = env.DB.batch(statements)
      .then(async () => {
        for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
          const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
          const have = new Set(results.map((c) => c.name));
          for (const [col, type] of Object.entries(cols)) {
            if (have.has(col)) continue;
            await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run().catch((e) => {
              if (!/duplicate column/i.test(String(e))) throw e;
            });
          }
        }
        // Seed once (the 'seeded' setting is written in the same batch)
        const seeded = await env.DB.prepare("SELECT value FROM settings WHERE key = 'seeded'").first();
        if (!seeded) await env.DB.batch(seedStatements(env.DB));
      })
      .catch((e) => {
        ready = null;
        throw e;
      });
  }
  return ready;
}

/** For tests: forget that the schema was set up (after tables are emptied). */
export const resetSchemaCache = () => {
  ready = null;
};

export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const first = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

// ───────── Settings ─────────
export async function getSetting(env, key, fallback = null) {
  const row = await first(env, "SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}
export const setSetting = (env, key, value) =>
  run(env, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')", key, JSON.stringify(value));

/** The studio's closed dates (holidays, vacation) — business-day math skips them. */
export const closedDates = async (env) => new Set((await getSetting(env, "closed_dates", [])) || []);

/** Record who did what (the audit trail). Never throws. */
export async function activity(env, projectId, actor, action, detail = null) {
  try {
    await run(env, "INSERT INTO activity (project_id, actor, action, detail) VALUES (?, ?, ?, ?)", projectId ?? null, actor, action, detail ? String(detail).slice(0, 1000) : null);
  } catch (e) {
    console.error("activity failed", e);
  }
}

export async function logEvent(env, kind, ok, detail) {
  try {
    await run(env, "INSERT INTO event_log (kind, ok, detail) VALUES (?, ?, ?)", kind, ok ? 1 : 0, String(detail).slice(0, 400));
  } catch (e) {
    console.error("logEvent failed", e);
  }
}

/** Mark a one-time automatic email as sent. Returns false if it was already sent (so: don't send). */
export async function claimOnce(env, key) {
  const r = await run(env, "INSERT INTO sent_log (key) VALUES (?) ON CONFLICT(key) DO NOTHING", key);
  return (r.meta?.changes ?? 0) > 0;
}
export const releaseOnce = (env, key) => run(env, "DELETE FROM sent_log WHERE key = ?", key);
