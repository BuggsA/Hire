// Small helpers shared by every route.

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export async function readJson(request, max = 200_000) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > max) fail(413, "That's too much to send at once");
  const text = await request.text();
  if (text.length > max) fail(413, "That's too much to send at once");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) fail(400, "Expected a JSON object");
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    fail(400, "That wasn't valid JSON");
  }
}

/** Free text: trimmed, capped, null when empty. */
export const text = (v, max = 500) => {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
};
export const req = (v, label, max = 500) => text(v, max) ?? fail(400, `${label} is required`);

export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i;
export const email = (v) => {
  const e = String(v ?? "").trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 200 ? e : null;
};

/** Whole cents from "$1,250.50", 1250.5 or "1250". Null for empty. Throws for nonsense. */
export function cents(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) fail(400, "Amounts must be zero or more");
    return Math.round(v * 100);
  }
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) fail(400, `"${v}" isn't an amount`);
  return Math.round(parseFloat(s) * 100);
}
export const int = (v, { min = 0, max = 100000, fallback = null } = {}) => {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `Expected a whole number from ${min} to ${max}`);
  return n;
};

export const money = (c) => (c === null || c === undefined ? "Custom quote" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

export async function sha256Hex(s) {
  const h = await crypto.subtle.digest("SHA-256", typeof s === "string" ? new TextEncoder().encode(s) : s);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const randomToken = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const siteUrl = (env) => String(env.SITE_URL || "https://fiveday.studio").replace(/\/+$/, "");

/** Constant-time string comparison (for signatures). */
export function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** A real calendar date written YYYY-MM-DD. */
export const isDateStr = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
