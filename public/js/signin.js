// The email link lands here with the one-time token after "#". Browsers never send the part after "#"
// to servers, so the token stays out of logs and referrers; it's used once, here, then removed from the address bar.
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
const next = new URLSearchParams(location.search).get("next") || "";
const status = document.getElementById("status");
const go = document.getElementById("go");

function offerNewLink(text) {
  status.textContent = text;
  go.hidden = false;
  go.textContent = "Request a new link";
  go.onclick = () => location.replace("/portal/");
}

async function signIn() {
  const r = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (r.ok) return location.replace("/portal/" + (next.startsWith("#/") ? next : ""));
  const out = await r.json().catch(() => ({}));
  offerNewLink(out.error || "That link didn't work.");
}

if (!/^[0-9a-f]{64}$/.test(token)) offerNewLink("This sign-in link is incomplete. Request a new one.");
else signIn();
