// Spam protection for the public quote form (Cloudflare Turnstile). Fails closed: without the secret,
// or if Cloudflare can't be reached, the form asks people to email instead.
// Secret: Worker secret TURNSTILE_SECRET. Allowed hostnames: TURNSTILE_HOSTNAMES. Site key: TURNSTILE_SITE_KEY.
export const TURNSTILE_ACTION = "quote";

export async function verifyTurnstile(env, request, token) {
  if (!env.TURNSTILE_SECRET) return { ok: false, status: 503, error: "The quote form is paused for a moment. Please email instead." };
  const hosts = new Set(String(env.TURNSTILE_HOSTNAMES || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  const no = { ok: false, status: 403, error: "We couldn't confirm you're not a robot. Please try again." };
  if (typeof token !== "string" || !token || token.length > 2048 || !hosts.size) return no;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: request.headers.get("cf-connecting-ip") || "" }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await r.json();
    if (result.success === true && result.action === TURNSTILE_ACTION && hosts.has(String(result.hostname || "").toLowerCase())) return { ok: true };
    return no;
  } catch (e) {
    console.error("turnstile", e);
    return no;
  }
}
