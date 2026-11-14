// Shared page shell for the public site: <head> with SEO tags, header, footer.
import { esc } from "../lib/http.js";

export const ICONS = {
  check: '<path d="M4 12.5 9.5 18 20 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8L3 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16l-1 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4m8-4v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  user: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2.5 10h19M6 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  chart: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  layout: '<rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 9h18M9 9v11" stroke="currentColor" stroke-width="1.8"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  external: '<path d="M14 4h6v6m0-6L11 13M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
};
export const icon = (name, cls = "") => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ""}>${ICONS[name] || ""}</svg>`;

export const MARK = `<svg class="mark" viewBox="0 0 30 26" aria-hidden="true"><rect x="0" y="14" width="4.4" height="12" rx="1.2"/><rect x="6.4" y="10" width="4.4" height="16" rx="1.2"/><rect x="12.8" y="6" width="4.4" height="20" rx="1.2"/><rect x="19.2" y="3" width="4.4" height="23" rx="1.2"/><rect x="25.6" y="0" width="4.4" height="26" rx="1.2"/></svg>`;

const NAV = [
  ["/work", "Work"],
  ["/pricing", "Pricing"],
  ["/process", "How it works"],
  ["/about", "About"],
];

export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=JetBrains+Mono:wght@500;600&display=swap">`;

/**
 * A full public page. opts: { title, description, path, body, jsonld: [], noindex, scripts: [], image }
 */
export function page(ctx, { title, description, path, body, jsonld = [], noindex = false, scripts = [], image = "/img/og.png", head = "" }) {
  const { biz, site } = ctx;
  const url = site + (path === "/" ? "/" : path);
  const fullTitle = path === "/" ? title : `${title} · ${biz.name}`;
  const nav = NAV.map(([href, label]) => `<a href="${href}"${path === href || path.startsWith(href + "/") ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(biz.name)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image.startsWith("http") ? image : site + image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f3efe6">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/img/favicon.png" type="image/png" sizes="64x64">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
${FONTS}
<link rel="stylesheet" href="/css/site.css">
<script>document.documentElement.classList.add("js")</script>
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n")}
${head}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/" aria-label="${esc(biz.name)} home">${MARK}<span>${esc(biz.short || biz.name)}</span><small>studio</small></a>
    <button class="menu-btn" aria-expanded="false" aria-controls="nav" aria-label="Menu">${icon("menu")}</button>
    <nav class="nav" id="nav" aria-label="Main">${nav}<a class="login" href="/portal/">Client login</a><a class="btn accent" href="/quote">Get a quote <span class="arrow">→</span></a></nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/">${MARK}<span>${esc(biz.short || biz.name)}</span></a>
        <p class="muted" style="margin-top:14px;max-width:26em">${esc(biz.tagline)} Custom websites and web apps for small businesses, from ${esc(biz.city)}, ${esc(biz.region)}, for clients anywhere in the US.</p>
        <p><a href="mailto:${esc(biz.email)}">${esc(biz.email)}</a>${biz.phone ? `<br><a href="tel:${esc(biz.phone.replace(/[^\d+]/g, ""))}">${esc(biz.phone)}</a>` : ""}</p>
      </div>
      <div><h4>Studio</h4><ul><li><a href="/work">Work</a></li><li><a href="/pricing">Pricing</a></li><li><a href="/process">How it works</a></li><li><a href="/about">About</a></li></ul></div>
      <div><h4>Help</h4><ul><li><a href="/faq">FAQ</a></li><li><a href="/quote">Get a quote</a></li><li><a href="/portal/">Client login</a></li><li><a href="/privacy">Privacy</a></li></ul></div>
      <div><h4>Local</h4><ul><li><a href="/web-design-northern-virginia">Northern Virginia web design</a></li><li><a href="/web-design-northern-virginia#reston">Reston</a></li><li><a href="/web-design-northern-virginia#fairfax">Fairfax County</a></li><li><a href="/web-design-northern-virginia#loudoun">Loudoun County</a></li></ul></div>
    </div>
    <div class="legal"><span>© ${new Date().getFullYear()} ${esc(biz.name)}</span><span>Payments by Stripe · Card details never touch this site</span></div>
  </div>
</footer>
<script src="/js/site.js" defer></script>
${scripts.map((s) => `<script src="${s}" defer></script>`).join("\n")}
</body>
</html>`;
}

export const browserFrame = (img, url, alt, { eager = false } = {}) =>
  `<div class="frame"><div class="bar"><i></i><i></i><i></i><span>${esc(url ? url.replace(/^https?:\/\//, "") : "")}</span></div><img src="${esc(img)}" alt="${esc(alt)}" width="1440" height="900" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></div>`;
