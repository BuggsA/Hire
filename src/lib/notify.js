// Outgoing messages.
//  • emailClient / emailStudio: branded emails through Resend (RESEND_API_KEY). Without the key nothing
//    is sent and everything else keeps working; each attempt is written to the event log.
//  • alertStudio: a short phone push through ntfy (NTFY_TOPIC), falling back to email. ntfy topics are
//    readable by anyone who knows the name, so alerts carry first names and counts only.
import { logEvent, getSetting } from "./db.js";
import { esc, siteUrl } from "./http.js";
import { DEFAULT_BUSINESS } from "./seed.js";

export const business = async (env) => ({ ...DEFAULT_BUSINESS, ...((await getSetting(env, "business", {})) || {}) });

function layout(env, biz, { heading, paragraphs, button, footer }) {
  const site = siteUrl(env);
  return `<!doctype html><html><body style="margin:0;background:#f3efe6;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#191813">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3efe6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-size:18px;font-weight:700;letter-spacing:-.02em">${esc(biz.name)}<span style="color:#e4532c">.</span></td></tr>
<tr><td style="background:#fffdf8;border:1px solid #ddd6c6;border-radius:14px;padding:28px">
<h1 style="font-size:22px;line-height:1.25;margin:0 0 14px;letter-spacing:-.01em">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${p}</p>`).join("")}
${button ? `<p style="margin:22px 0 4px"><a href="${esc(button.url)}" style="display:inline-block;background:#191813;color:#fffdf8;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">${esc(button.label)}</a></p>` : ""}
</td></tr>
<tr><td style="padding:16px 6px;font-size:12px;line-height:1.5;color:#6b665a">${footer || `Questions? Just reply to this email. · <a href="${site}" style="color:#6b665a">${esc(new URL(site).host)}</a>`}</td></tr>
</table></td></tr></table></body></html>`;
}

const plain = (heading, paragraphs, button) =>
  [heading, ...paragraphs.map((p) => p.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")), button ? `${button.label}: ${button.url}` : ""]
    .filter(Boolean)
    .join("\n\n");

/** Send one email. Returns true (sent), false (failed) or null (email isn't set up). paragraphs are HTML: escape user text with esc(). */
export async function sendEmail(env, { to, subject, heading, paragraphs = [], button, replyTo }) {
  if (!env.RESEND_API_KEY || !to) return null;
  const biz = await business(env);
  const from = env.EMAIL_FROM || `${biz.name} <${biz.email}>`;
  try {
    const r = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        ...(replyTo || env.EMAIL_REPLY_TO ? { reply_to: replyTo || env.EMAIL_REPLY_TO } : {}),
        subject,
        html: layout(env, biz, { heading, paragraphs, button }),
        text: plain(heading, paragraphs, button),
      }),
    });
    await logEvent(env, "email", r.ok, `“${subject}” → ${to}${r.ok ? "" : ` (HTTP ${r.status}: ${(await r.text()).slice(0, 120)})`}`);
    return r.ok;
  } catch (e) {
    await logEvent(env, "email", false, `“${subject}” → ${to}: ${String(e).slice(0, 120)}`);
    return false;
  }
}

export const emailClient = (env, client, msg) => sendEmail(env, { ...msg, to: client.email });

export const studioEmails = (env) => String(env.ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);

export async function emailStudio(env, msg) {
  const to = env.STUDIO_NOTIFY_EMAIL || studioEmails(env)[0];
  return sendEmail(env, { ...msg, to });
}

/**
 * Tell the studio something needs attention. short: safe for ntfy (no contact details or client text).
 * email: optional { subject, heading, paragraphs } for the full version.
 */
export async function alertStudio(env, short, { title = "Fiveday", email, path = "/admin/" } = {}) {
  let pushed = false;
  if (env.NTFY_TOPIC) {
    try {
      const r = await fetch(`${env.NTFY_URL || "https://ntfy.sh"}/${encodeURIComponent(env.NTFY_TOPIC)}`, {
        method: "POST",
        headers: { Title: title, Click: siteUrl(env) + path, ...(env.NTFY_TOKEN ? { Authorization: `Bearer ${env.NTFY_TOKEN}` } : {}) },
        body: short,
      });
      pushed = r.ok;
      await logEvent(env, "alert", r.ok, `${title}: ${short}${r.ok ? "" : ` (HTTP ${r.status})`}`);
    } catch (e) {
      await logEvent(env, "alert", false, `${title}: ${short} (${String(e).slice(0, 80)})`);
    }
  }
  if (email || !pushed) {
    const msg = email || { subject: `${title}: ${short}`, heading: short, paragraphs: [] };
    await emailStudio(env, { ...msg, button: { label: "Open the dashboard", url: siteUrl(env) + path } });
  }
}
