// Small shared helpers for the portal and dashboard apps (no framework).
export const $ = (sel, root = document) => root.querySelector(sel);

/** h("div.card#x", {onclick}, child, …) → element. Strings become text (never HTML). */
export function h(tag, attrs, ...kids) {
  const [, name = "div", rest = ""] = tag.match(/^(\w+)?(.*)$/);
  const el = document.createElement(name || "div");
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === "." ? el.classList.add(m[2]) : (el.id = m[2]);
  if (attrs !== null && attrs !== undefined && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (["value", "checked", "disabled", "selected", "required", "multiple"].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  const add = (c) => (Array.isArray(c) ? c.forEach(add) : c === null || c === undefined || c === false ? null : el.append(c instanceof Node ? c : String(c)));
  kids.forEach(add);
  return el;
}

export async function api(method, path, body, { raw } = {}) {
  const opts = { method, headers: {} };
  if (raw) {
    opts.body = raw.body;
    Object.assign(opts.headers, raw.headers);
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["content-type"] = "application/json";
  }
  const r = await fetch(path, opts);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(out.error || `Something went wrong (${r.status})`), { status: r.status });
  return out;
}

export const money = (c) => (c === null || c === undefined ? "Custom" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
export const fmtDate = (d) =>
  d ? new Date(d.length === 10 ? d + "T12:00:00Z" : d.replace(" ", "T") + "Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(d.length === 10 ? { timeZone: "UTC" } : {}) }) : "";
export const fmtTime = (ts) => (ts ? new Date(ts.replace(" ", "T") + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
export const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const ITEM_STATUS = {
  not_started: ["Not started", ""],
  submitted: ["Submitted", "info"],
  needs_changes: ["Needs changes", "bad"],
  approved: ["Approved", "ok"],
  exception_approved: ["Exception approved", "ok"],
};
export const chip = (text, kind = "") => h(`span.chip${kind ? "." + kind : ""}`, text);
export const itemChip = (i) =>
  i.exception_requested && !["approved", "exception_approved", "needs_changes"].includes(i.status) ? chip("Exception requested", "wait") : chip(...ITEM_STATUS[i.status]);

let toastTimer;
export function toast(text, bad = false) {
  let t = $("#toast");
  if (!t) document.body.append((t = h("div#toast", { role: "status", "aria-live": "polite" })));
  t.textContent = text;
  t.className = bad ? "show bad" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 4000);
}

/** Run an async action from a button: busy state, toast on error. */
export async function act(btn, fn, okText) {
  btn?.classList.add("is-busy");
  try {
    const out = await fn();
    if (okText) toast(okText);
    return out;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    btn?.classList.remove("is-busy");
  }
}

/** Upload one file as the raw request body. */
export const upload = (path, file) =>
  api("POST", path, undefined, { raw: { body: file, headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } } });

/** The day-by-day bar for a project's schedule (the same motif as the homepage week board). */
export function weekBar(s) {
  if (!s || !s.daysTotal) return null;
  const n = Math.min(s.daysTotal, 20);
  return h(
    "div.weekbar",
    { role: "img", "aria-label": `Build day ${Math.min(s.daysUsed + (s.start ? 1 : 0), n)} of ${s.daysTotal}` },
    Array.from({ length: n }, (_, i) => h(`div.wb-cell${i < s.daysUsed ? ".done" : ""}${i === s.daysUsed && s.start && !s.held ? ".now" : ""}`, h("span", String(i + 1))))
  );
}

/** A dialog with a form. onSubmit(formData) → truthy to close. */
export function modal(title, body, { submit = "Save", onSubmit, danger = false } = {}) {
  const form = h("form.form", h("h3", title), body, h("div.modal-actions", h("button.btn.quiet.small", { type: "button", onclick: () => dlg.close() }, "Cancel"), onSubmit ? h(`button.btn.small${danger ? ".danger" : ""}`, { type: "submit" }, submit) : null));
  const dlg = h("dialog.modal", { onclose: () => dlg.remove() }, form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const ok = await act(btn, () => onSubmit(new FormData(form), form));
    if (ok !== undefined && ok !== false) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

let uid = 0;
export function field(label, input, hint) {
  if (!input.id) input.id = `f${++uid}`;
  return h("div.field", h("label", { for: input.id }, label), hint ? h("div.hint", hint) : null, input);
}
