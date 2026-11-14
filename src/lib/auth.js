// Who is asking?
//  • The studio (admin): a verified Cloudflare Access login whose email is in ADMIN_EMAILS (same approach
//    as Walks for Lucy, but a separate Access application, AUD tag and email list).
//  • Clients: a one-time sign-in link sent by email, then an HttpOnly session cookie. Only hashes of the
//    link and session tokens are stored, so a database leak can't be used to sign in.
import { first, run } from "./db.js";
import { sha256Hex, randomToken } from "./http.js";

// ───────── Studio (Cloudflare Access) ─────────
let certCache = { at: 0, team: "", keys: [] };
const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};

async function accessKeys(team) {
  if (certCache.team === team && Date.now() - certCache.at < 10 * 60 * 1000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  const { keys } = await r.json();
  certCache = { at: Date.now(), team, keys };
  return keys;
}

async function accessEmail(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  try {
    const [h, p, sig] = token.split(".");
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    if (header.alg !== "RS256") return null;
    const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`)))) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return String(payload.email || "").trim().toLowerCase() || null;
  } catch (e) {
    console.error("access verify failed", e);
    return null;
  }
}

const isLocal = (request) => ["localhost", "127.0.0.1"].includes(new URL(request.url).hostname);

/** The studio's email if this request is from a signed-in admin, else null. */
export async function adminEmail(request, env) {
  if (env.DEV_ADMIN_BYPASS === "1" && isLocal(request)) return "dev@localhost";
  const email = await accessEmail(request, env);
  if (!email) return null;
  const allowed = String(env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(email) ? email : null;
}

// ───────── Clients (email link + session cookie) ─────────
export const SESSION_COOKIE = "fd_session";
const SESSION_DAYS = 30;
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/** Make a one-time sign-in link token for a client. minutes: how long it works. */
export async function createLoginToken(env, clientId, minutes = 30) {
  const token = randomToken(32);
  await run(env, "INSERT INTO login_tokens (token_hash, client_id, expires_at) VALUES (?, ?, ?)", await sha256Hex(token), clientId, sqlTime(Date.now() + minutes * 60_000));
  return token;
}

/** How many sign-in links this client was sent in the last hour (to stop someone flooding an inbox). */
export const recentLoginTokens = async (env, clientId) =>
  (await first(env, "SELECT COUNT(*) AS n FROM login_tokens WHERE client_id = ? AND created_at > datetime('now', '-1 hour')", clientId)).n;

/** Use a sign-in link: returns a new session token (for the cookie), or null if the link is bad, used or expired. */
export async function redeemLoginToken(env, token) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  // Mark used in the same statement that checks it, so a link works exactly once even if clicked twice at once
  const row = await first(
    env,
    "UPDATE login_tokens SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now') RETURNING client_id",
    hash
  );
  if (!row) return null;
  const session = randomToken(32);
  await run(env, "INSERT INTO sessions (token_hash, client_id, expires_at) VALUES (?, ?, ?)", await sha256Hex(session), row.client_id, sqlTime(Date.now() + SESSION_DAYS * 86400_000));
  return { session, clientId: row.client_id };
}

const readCookie = (request, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("cookie") || "");
  return m ? m[1] : null;
};

/** The signed-in client row, or null. */
export async function currentClient(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return first(
    env,
    "SELECT c.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.token_hash = ? AND s.expires_at > datetime('now')",
    await sha256Hex(token)
  );
}

export async function endSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await run(env, "DELETE FROM sessions WHERE token_hash = ?", await sha256Hex(token));
}

export const sessionCookie = (token, request) => {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
};
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
