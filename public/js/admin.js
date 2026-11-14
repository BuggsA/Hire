// The studio dashboard. Opens on "Today": everything waiting on you, so no project needs checking by hand.
import { $, h, api, money, fmtDate, fmtTime, kb, chip, itemChip, toast, act, upload, weekBar, modal, field } from "./ui.js";

const app = $("#app");
const side = $("#side");
const MARK = '<svg class="mark" viewBox="0 0 30 26" aria-hidden="true"><rect x="0" y="14" width="4.4" height="12" rx="1.2"/><rect x="6.4" y="10" width="4.4" height="16" rx="1.2"/><rect x="12.8" y="6" width="4.4" height="20" rx="1.2"/><rect x="19.2" y="3" width="4.4" height="23" rx="1.2"/><rect x="25.6" y="0" width="4.4" height="26" rx="1.2"/></svg>';
const NAV = [
  ["today", "Today"],
  ["leads", "Leads"],
  ["projects", "Projects"],
  ["clients", "Clients"],
  ["money", "Money"],
  ["content", "Content"],
  ["setup", "Setup"],
];
const STATUS_KIND = { quote: "", awaiting_onboarding: "accent", ready_to_start: "info", in_development: "info", awaiting_feedback: "wait", in_revision: "accent", ready_for_launch: "ok", completed: "ok", paused: "wait", cancelled: "" };
let statuses = {};
let counts = {};

function nav(current) {
  const brand = h("a.brand", { href: "/" });
  brand.innerHTML = `${MARK}<span>Fiveday</span>`;
  side.replaceChildren(
    ...[brand,
    NAV.map(([k, label]) => h("a.nav-i", { href: `#/${k}`, "aria-current": current === k ? "page" : null }, label, counts[k] ? h("span.count", String(counts[k])) : null)),
    h("div.foot", h("a", { href: "/", target: "_blank" }, "View site ↗"), h("br"), h("a", { href: "/cdn-cgi/access/logout" }, "Sign out"))].flat()
  );
}

const show = (...nodes) => app.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
const top = (title, ...right) => h("div.admin-top", h("h1", title), h("div.actions", right));
const statusChip = (s) => chip(statuses[s]?.label || s.replaceAll("_", " "), STATUS_KIND[s] || "");
const turnChip = (n) => (n ? chip(n.who === "client" ? "Client" : n.who === "studio" ? "You" : "—", n.who === "studio" ? "accent" : n.who === "client" ? "info" : "") : null);

async function route() {
  const [, view = "today", id, tab] = location.hash.split("/");
  const v = view.split("?")[0] || "today";
  nav(v === "project" ? "projects" : v === "lead" ? "leads" : v);
  try {
    if (v === "project" && id) return await projectView(Number(id), tab || "overview");
    const views = { today, leads, projects, clients, money: moneyView, content, setup };
    await (views[v] || today)(id);
  } catch (e) {
    show(h("div.form-msg.err", e.message));
  }
  app.focus({ preventScroll: true });
}
addEventListener("hashchange", route);
route();
const reload = () => route();

// ───────── Today ─────────
async function today() {
  const d = await api("GET", "/api/admin/overview");
  statuses = d.statuses;
  const a = d.attention;
  counts = { today: a.toReview.length + a.exceptions.length + a.changes.length + a.unread.length + a.launch.length, leads: a.newLeads.length };
  nav("today");
  const cards = [];
  const card = (k, t, href) => cards.push(h("a", { href }, h("span.k", k), h("span.t", t)));
  a.exceptions.forEach((x) => card("Exception requested", `${x.label} · ${x.title}`, `#/project/${x.project_id}/onboarding`));
  a.toReview.forEach((x) => card("Review submission", `${x.label} · ${x.title}`, `#/project/${x.project_id}/onboarding`));
  a.changes.forEach((x) => card("Revisions requested", x.title, `#/project/${x.id}/previews`));
  a.late.forEach((x) => card("Past delivery target", `${x.title} (was ${fmtDate(x.due_date)})`, `#/project/${x.id}`));
  a.dueSoon.forEach((x) => card("Due soon", `${x.title} · ${fmtDate(x.due_date)}`, `#/project/${x.id}`));
  a.launch.forEach((x) => card("Ready to launch", x.title, `#/project/${x.id}`));
  a.unread.forEach((x) => card("Unread messages", `${x.n} · ${x.title}`, `#/project/${x.project_id}/messages`));
  a.newLeads.forEach((x) => card("New inquiry", `${x.name}${x.business ? ` · ${x.business}` : ""}`, `#/leads`));
  a.overdueInvoices.forEach((x) => card("Overdue invoice", `${x.number} · ${money(x.amount_cents)} · ${x.client_name}`, x.project_id ? `#/project/${x.project_id}/billing` : "#/money"));
  a.feedbackOverdue.forEach((x) => card("Waiting on client (clock held)", `${x.title} since ${fmtDate(x.waiting_since)}`, `#/project/${x.id}`));
  const r = d.revenue;
  show(
    top("Today", h("a.btn.small", { href: "#/projects/new" }, "+ New quote")),
    h("div.kpis", kpi(String(d.projects.length), "active projects"), kpi(money(r.outstanding), `outstanding · ${r.openInvoices} open`), kpi(`${money(r.mrr)}/mo`, `${r.subscriptions} care plans`), kpi(money(r.this_year), "received this year")),
    h("div.panel", h("h2", cards.length ? `Needs you (${cards.length})` : "Nothing needs you right now"), cards.length ? h("div.need", cards) : h("p.muted", "Reminders, follow-ups and the morning digest run automatically.")),
    h("div.panel", h("h2", "Active projects"), projectTable(d.projects)),
    h("div.panel", h("h2", "Recent activity"), activityList(d.recent))
  );
}
const kpi = (b, s) => h("div.kpi", h("b", b), h("span", s));

function projectTable(list) {
  if (!list.length) return h("p.muted", "No active projects.");
  return h(
    "div.table-wrap",
    h(
      "table.t",
      h("thead", h("tr", h("th", "Project"), h("th", "Status"), h("th", "Whose turn"), h("th", "Next"), h("th", "Due"))),
      h(
        "tbody",
        list.map((p) =>
          h(
            "tr.click",
            { onclick: () => (location.hash = `#/project/${p.id}`) },
            h("td", h("a", { href: `#/project/${p.id}` }, h("b", p.title)), h("div.small.muted", p.client_name)),
            h("td", statusChip(p.status), p.progress && p.status === "awaiting_onboarding" ? h("div.small.muted", `${p.progress.done}/${p.progress.total} approved`) : null),
            h("td", turnChip(p.next)),
            h("td.small", p.next?.text),
            h("td.mono.small", p.schedule?.due ? fmtDate(p.schedule.due) : "—")
          )
        )
      )
    )
  );
}

function activityList(list) {
  return h(
    "ul.list.log",
    list.map((x) => h("li", h("time", fmtTime(x.created_at)), h("span", h("b", x.actor.startsWith("client") ? "Client" : x.actor === "studio" ? "You" : x.actor), " · ", x.detail || x.action, x.title ? h("span.muted", ` · ${x.title}`) : null)))
  );
}

// ───────── Leads ─────────
async function leads() {
  const d = await api("GET", "/api/admin/leads");
  show(
    top("Leads"),
    d.leads.length
      ? d.leads.map((l) => {
          const status = h("select", { onchange: () => act(null, () => api("PATCH", `/api/admin/leads/${l.id}`, { status: status.value }), "Saved") }, ["new", "contacted", "quoted", "won", "lost"].map((s) => h("option", { value: s, selected: l.status === s }, s)));
          const triage = h("button.btn.tiny.quiet", { type: "button" }, "AI summary");
          triage.onclick = async () => (await act(triage, () => api("POST", `/api/admin/leads/${l.id}/triage`), "Suggestion ready")) && reload();
          const s = l.ai_summary;
          return h(
            "div.panel",
            h("div.panel-head", h("div", h("h3", l.name, l.business ? h("span.muted", ` · ${l.business}`) : null), h("div.small.muted", `${fmtTime(l.created_at)} · `, h("a", { href: `mailto:${l.email}` }, l.email), l.phone ? ` · ${l.phone}` : "", l.location ? ` · ${l.location}` : "")), h("div.actions", status, l.project_id ? h("a.btn.tiny", { href: `#/project/${l.project_id}` }, "Open project") : h("button.btn.tiny", { type: "button", onclick: () => newProject({ lead: l }) }, "Create quote"))),
            h("dl.kv", h("dt", "Package"), h("dd", l.package_slug || "Not chosen"), l.addons.length ? [h("dt", "Add-ons"), h("dd", l.addons.join(", "))] : null, l.timeline ? [h("dt", "Timeline"), h("dd", l.timeline)] : null, l.care_plan ? [h("dt", "Care"), h("dd", l.care_plan)] : null, l.website ? [h("dt", "Website"), h("dd", l.website)] : null),
            l.message ? h("p", { style: { whiteSpace: "pre-wrap", marginTop: "12px" } }, l.message) : null,
            s
              ? h("div.ai", h("span.k", "AI suggestion · for you only, never sent"), h("p", s.summary), h("p.small", `Fits: ${s.suggested_package} · ${s.complexity}${s.fits_one_week ? " · could be a one-week build" : ""}`), s.missing_information?.length ? h("p.small", `Missing: ${s.missing_information.join("; ")}`) : null, s.questions_to_ask?.length ? h("p.small", `Ask: ${s.questions_to_ask.join(" · ")}`) : null, s.flags?.length ? h("p.small", `Careful: ${s.flags.join("; ")}`) : null)
              : d.aiReady
                ? triage
                : null
          );
        })
      : h("div.empty", "No inquiries yet. They arrive from the quote form.")
  );
}

// ───────── New project (quote) ─────────
async function newProject({ lead } = {}) {
  const pk = await api("GET", "/api/admin/content/packages");
  const pkg = h("select", { name: "package_slug" }, pk.rows.map((p) => h("option", { value: p.slug, selected: (lead?.package_slug || "starter") === p.slug }, `${p.name} (${money(p.price_cents)})`)));
  modal(
    lead ? `Quote for ${lead.name}` : "New quote",
    [
      lead ? null : [field("Client name", h("input", { name: "client_name", required: true })), field("Client email", h("input", { name: "client_email", type: "email", required: true })), field("Business", h("input", { name: "client_business" }))],
      field("Package", pkg),
      field("Title", h("input", { name: "title", placeholder: "Defaults to “<Package> for <business>”" })),
      field("Price", h("input", { name: "price", placeholder: "Defaults to package + chosen add-ons" })),
    ],
    {
      submit: "Create draft",
      onSubmit: async (fd) => {
        const out = await api("POST", "/api/admin/projects", { ...Object.fromEntries(fd), lead_id: lead?.id });
        location.hash = `#/project/${out.project.id}`;
        return true;
      },
    }
  );
}

// ───────── Projects ─────────
async function projects(id) {
  if (id === "new") {
    history.replaceState(null, "", "#/projects");
    newProject();
  }
  const d = await api("GET", "/api/admin/projects");
  statuses = d.statuses;
  show(
    top("Projects", h("button.btn.small", { type: "button", onclick: () => newProject() }, "+ New quote")),
    h(
      "div.panel",
      h(
        "div.table-wrap",
        h(
          "table.t",
          h("thead", h("tr", h("th", "#"), h("th", "Project"), h("th", "Client"), h("th", "Status"), h("th", "Price"), h("th", "Start"), h("th", "Due"))),
          h("tbody", d.projects.map((p) => h("tr.click", { onclick: () => (location.hash = `#/project/${p.id}`) }, h("td.mono", p.id), h("td", h("b", p.title)), h("td", p.client_name), h("td", statusChip(p.status)), h("td.mono", money(p.price_cents)), h("td.mono.small", fmtDate(p.start_date)), h("td.mono.small", fmtDate(p.due_date)))))
        )
      )
    )
  );
}

const PTABS = [
  ["overview", "Overview"],
  ["onboarding", "Onboarding"],
  ["previews", "Previews"],
  ["messages", "Messages"],
  ["files", "Files"],
  ["billing", "Billing"],
  ["agreements", "Agreements"],
  ["activity", "Activity"],
];

async function projectView(id, tab) {
  const d = await api("GET", `/api/admin/projects/${id}`);
  statuses = d.statuses;
  const p = d.project;
  const c = {
    onboarding: d.items.filter((i) => i.status === "submitted" || (i.exception_requested && !["approved", "exception_approved", "needs_changes"].includes(i.status))).length,
    messages: d.messages.filter((m) => m.sender === "client" && !m.read_at).length,
  };
  const n = d.state.next;
  const views = { overview: pOverview, onboarding: pOnboarding, previews: pPreviews, messages: pMessages, files: pFiles, billing: pBilling, agreements: pAgreements, activity: (d) => h("div.panel", activityList(d.log)) };
  show(
    h("p.small", h("a", { href: "#/projects" }, "← Projects")),
    h("div.proj-head", h("div", statusChip(p.status), h("h1", p.title), h("div.muted", `${d.client.name}${d.client.business ? ` · ${d.client.business}` : ""} · `, h("a", { href: `mailto:${d.client.email}` }, d.client.email))), h("div.actions", statusActions(d))),
    h(`div.turn.${n.who}`, h("span.who", n.who === "client" ? "Client's turn" : n.who === "studio" ? "Your turn" : "Done"), h("span", n.text)),
    h("nav.tabs", PTABS.map(([k, l]) => h("a", { href: `#/project/${id}/${k}`, "aria-current": tab === k ? "page" : null }, l, c[k] ? h("span.count", String(c[k])) : null))),
    (views[tab] || pOverview)(d, id)
  );
}

function statusActions(d) {
  const p = d.project;
  const id = p.id;
  const btns = [];
  const post = (path, body, ok) => async (e) => (await act(e.currentTarget, () => api("POST", path, body), ok)) && reload();
  if (p.status === "quote") btns.push(h("button.btn.small.accent", { type: "button", onclick: post(`/api/admin/projects/${id}/send-quote`, {}, "Quote sent") }, p.quote_sent_at ? "Re-send quote" : "Send quote"));
  if (["in_development", "in_revision", "awaiting_feedback"].includes(p.status)) btns.push(h("button.btn.small", { type: "button", onclick: () => previewModal(d) }, "Send preview"));
  if (p.status === "ready_for_launch")
    btns.push(h("button.btn.small.accent", { type: "button", onclick: () => modal("Mark launched", field("Live URL", h("input", { name: "live_url", type: "url", value: p.live_url || "" })), { submit: "Complete project", onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${id}/complete`, Object.fromEntries(fd)), reload(), true) }) }, "Mark launched"));
  if (p.status === "paused") btns.push(h("button.btn.small", { type: "button", onclick: post(`/api/admin/projects/${id}/status`, { action: "resume" }, "Resumed") }, "Resume"));
  else if (!["completed", "cancelled", "quote"].includes(p.status))
    btns.push(
      h("button.btn.small.quiet", {
        type: "button",
        onclick: () =>
          modal("Pause the project", [field("Reason (the client sees this)", h("input", { name: "reason", required: true })), field("Waiting on", h("select", { name: "owner" }, h("option", { value: "client" }, "The client"), h("option", { value: "studio" }, "The studio")))], {
            submit: "Pause",
            onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${id}/status`, { to: "paused", ...Object.fromEntries(fd) }), reload(), true),
          }),
      }, "Pause")
    );
  if (p.status === "in_revision") btns.push(h("button.btn.small.quiet", { type: "button", onclick: post(`/api/admin/projects/${id}/status`, { to: "in_development" }, "Back in development") }, "Revisions done"));
  if (!["completed", "cancelled"].includes(p.status))
    btns.push(h("button.btn.small.quiet", { type: "button", onclick: () => modal("Cancel this project?", [h("p.muted", "Unpaid invoices and unsigned agreements are voided. Paid invoices stay as they are."), field("Reason", h("input", { name: "reason" }))], { submit: "Cancel project", danger: true, onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${id}/cancel`, Object.fromEntries(fd)), reload(), true) }) }, "Cancel"));
  return btns;
}

function previewModal(d) {
  modal(
    "Send a preview for review",
    [
      field("Title", h("input", { name: "title", required: true, value: d.project.status === "in_revision" ? "Revised preview" : "Homepage design" })),
      field("Preview link", h("input", { name: "url", type: "url", value: d.project.preview_url || "" })),
      field("Note to the client", h("textarea", { name: "note", rows: 3 })),
      field("Kind", h("select", { name: "kind" }, h("option", { value: "design" }, "Preview (approve or request changes)"), h("option", { value: "final" }, "Final website (sign-off before launch)"))),
      h("p.small.muted", `The clock holds for the client after ${d.project.feedback_days} business days without a reply.`),
    ],
    { submit: "Send to client", onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${d.project.id}/preview`, Object.fromEntries(fd)), toast("Preview sent"), reload(), true) }
  );
}

function pOverview(d, id) {
  const p = d.project;
  const s = d.state.schedule;
  const quote = p.status === "quote";
  const form = h(
    "form.form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        fd.fast_track = !!e.target.fast_track?.checked;
        if (!quote) for (const k of ["price", "scope", "turnaround_days", "revision_rounds", "support_days", "feedback_days"]) delete fd[k];
        else fd.scope = fd.scope.split("\n");
        if (await act(e.submitter, () => api("PATCH", `/api/admin/projects/${id}`, fd), "Saved")) reload();
      },
    },
    field("Title", h("input", { name: "title", value: p.title })),
    h("div.row-2", field("Price", h("input", { name: "price", value: (p.price_cents / 100).toFixed(2), disabled: !quote })), field("Build time (business days)", h("input", { name: "turnaround_days", type: "number", value: p.turnaround_days ?? "", disabled: !quote }))),
    h("div.row-2", field("Revision rounds", h("input", { name: "revision_rounds", type: "number", value: p.revision_rounds, disabled: !quote })), field("Client reply window (business days)", h("input", { name: "feedback_days", type: "number", value: p.feedback_days, disabled: !quote }))),
    h("div.row-2", field("Support days after launch", h("input", { name: "support_days", type: "number", value: p.support_days, disabled: !quote })), field("Quote valid until", h("input", { name: "quote_expires", type: "date", value: p.quote_expires || "" }))),
    field("Scope (one deliverable per line)", h("textarea", { name: "scope", rows: 7, disabled: !quote }, p.scope.join("\n"))),
    p.addons.length ? h("p.small", "Add-ons: ", p.addons.map((a) => `${a.name}${a.price_cents != null ? ` (${money(a.price_cents)})` : ""}`).join(", ")) : null,
    h("label.check", h("input", { type: "checkbox", name: "fast_track", checked: !!p.fast_track }), h("span", "Qualifies for the one-business-week promise")),
    h("div.row-2", field("Preview URL", h("input", { name: "preview_url", value: p.preview_url || "" })), field("Live URL", h("input", { name: "live_url", value: p.live_url || "" }))),
    field("Private notes (never shown to the client)", h("textarea", { name: "notes", rows: 3 }, p.notes || "")),
    quote ? null : h("p.note", "Price, scope and terms are part of the accepted agreement. To change them, use “Revise quote” so the client accepts the new terms."),
    h("div.actions", h("button.btn.small", { type: "submit" }, "Save"), quote ? null : h("button.btn.small.quiet", { type: "button", onclick: () => reviseQuote(d) }, "Revise quote…"))
  );
  return h(
    "div.cols",
    h("div", h("div.panel", h("h3", "Project details"), form)),
    h(
      "div",
      h(
        "div.panel",
        h("h3", "Clock"),
        s.start
          ? [h("dl.kv", h("dt", "Day 1"), h("dd", fmtDate(s.start)), h("dt", "Original target"), h("dd", fmtDate(s.baseDue)), h("dt", "Held days"), h("dd", String(s.delay)), h("dt", "Target now"), h("dd", h("b", fmtDate(s.due)))), h("div", { style: { marginTop: "12px" } }, weekBar(s))]
          : h("div", h("p.muted", "Not started. Waiting on:"), d.state.blockers.length ? h("ul.list", d.state.blockers.map((b) => h("li", h("span", b.what), turnChip({ who: b.who })))) : h("p", "Nothing; it starts on the next run.")),
        d.holds.length ? h("ul.list.small", d.holds.map((x) => h("li", `${x.kind === "feedback" ? "Waiting on feedback" : "Paused"} from ${fmtDate(x.start_date)}${x.end_date ? ` to ${fmtDate(x.end_date)}` : " (open)"}${x.grace_days ? ` · ${x.grace_days}-day reply window` : ""}`))) : null
      ),
      h(
        "div.panel",
        h("div.panel-head", h("h3", "Milestones"), h("button.btn.tiny.quiet", { type: "button", onclick: () => modal("Add milestone", [field("Title", h("input", { name: "title", required: true })), field("Target date", h("input", { name: "target_date", type: "date" }))], { onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${id}/milestones`, Object.fromEntries(fd)), reload(), true) }) }, "+ Add")),
        d.milestones.length
          ? h("ul.list", d.milestones.map((m) => h("li", h("label.check", h("input", { type: "checkbox", checked: !!m.done_at, onchange: (e) => act(null, () => api("PATCH", `/api/admin/milestones/${m.id}`, { done: e.target.checked }), e.target.checked ? "Milestone reached; client emailed" : "Saved") }), h("span", m.title, m.target_date ? h("span.muted", ` · ${fmtDate(m.target_date)}`) : null)))))
          : h("p.muted.small", "Optional. Reaching one emails the client.")
      )
    )
  );
}

function reviseQuote(d) {
  modal(
    "Revise the quote",
    [
      h("p.muted", "Use this when the scope or price changes after the client accepted. They get a new agreement to accept; paid invoices stay, unpaid ones are replaced by one balance due at launch."),
      field("New total price", h("input", { name: "price", value: (d.project.price_cents / 100).toFixed(2) })),
      field("Scope (one per line)", h("textarea", { name: "scope", rows: 6 }, d.project.scope.join("\n"))),
    ],
    { submit: "Send revised quote", onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${d.project.id}/send-quote`, { revise: true, price: fd.get("price"), scope: fd.get("scope") }), toast("Revised quote sent"), reload(), true) }
  );
}

function pOnboarding(d, id) {
  const pr = d.state.progress;
  const addItem = () =>
    modal("Add a checklist item", [field("What you need", h("input", { name: "label", required: true })), field("Instructions for the client", h("textarea", { name: "help", rows: 3 })), h("label.check", h("input", { type: "checkbox", name: "allow_files", value: "1" }), h("span", "Takes file uploads")), h("label.check", h("input", { type: "checkbox", name: "required", value: "1", checked: true }), h("span", "Required before the build starts"))], {
      onSubmit: async (fd) => (await api("POST", `/api/admin/projects/${id}/items`, { label: fd.get("label"), help: fd.get("help"), allow_files: !!fd.get("allow_files"), required: !!fd.get("required") }), reload(), true),
    });
  const sections = [...new Set(d.items.map((i) => i.section))];
  return [
    h("div.panel", h("div.panel-head", h("h3", `${pr.done} of ${pr.total} required items approved`), h("button.btn.tiny.quiet", { type: "button", onclick: addItem }, "+ Add item")), h("div.meter", h("i", { style: { width: `${pr.percent}%`, background: "var(--accent)" } })), h("p.small.muted", { style: { marginTop: "10px" } }, "Only you can approve items or grant exceptions. The build starts by itself the business day after the last required item is approved, if the agreement is accepted and the deposit is paid.")),
    sections.map((s) => [h("div.ob-section", s), d.items.filter((i) => i.section === s).map((i) => adminItem(i, d.files))]),
  ];
}

function adminItem(item, files) {
  const review = (action, needNote) => async (e) => {
    let note = null;
    if (needNote) {
      note = prompt(action === "approve_exception" ? "Note for the client about the exception (optional if they requested it):" : "What should the client change?") ?? undefined;
      if (note === undefined) return;
    }
    if (await act(e.currentTarget, () => api("POST", `/api/admin/items/${item.id}/review`, { action, note, force: action === "approve" }), "Saved")) reload();
  };
  const answers = item.fields.map((f) => (item.value[f.name] ? h("div", h("div.small.muted", f.label), h("div", { style: { whiteSpace: "pre-wrap" } }, item.value[f.name])) : null));
  const theirFiles = files.filter((f) => f.item_id === item.id);
  const done = ["approved", "exception_approved"].includes(item.status);
  return h(
    `details.item.${item.status}`,
    { open: item.status === "submitted" || item.exception_requested ? true : null },
    h("summary", h("span.dot"), h("span.t", item.label, item.required ? null : h("span.opt", " · optional")), itemChip(item)),
    h(
      "div.item-body",
      item.exception_requested ? h("p.note.wait", `Exception requested: “${item.exception_reason}”`) : null,
      item.admin_note ? h("p.note", `Your note: ${item.admin_note}`) : null,
      answers.some(Boolean) ? answers : h("p.muted", "No answers yet."),
      theirFiles.length ? h("div.files", theirFiles.map((f) => h("div.file", h("a", { href: `/api/admin/files/${f.id}`, target: "_blank" }, f.name), h("span.small.muted", kb(f.size))))) : null,
      h(
        "div.actions",
        done ? h("button.btn.tiny.quiet", { type: "button", onclick: review("reopen") }, "Reopen") : [h("button.btn.tiny", { type: "button", onclick: review("approve") }, "Approve"), h("button.btn.tiny.quiet", { type: "button", onclick: review("needs_changes", true) }, "Needs changes…"), item.exception_requested ? [h("button.btn.tiny.quiet", { type: "button", onclick: review("approve_exception", true) }, "Approve exception"), h("button.btn.tiny.quiet", { type: "button", onclick: review("decline_exception", true) }, "Decline exception")] : h("button.btn.tiny.quiet", { type: "button", onclick: review("approve_exception", true) }, "Grant exception…")],
        h("button.btn.tiny.quiet", { type: "button", onclick: async (e) => (await act(e.currentTarget, () => api("PATCH", `/api/admin/items/${item.id}`, { required: !item.required }), "Saved")) && reload() }, item.required ? "Make optional" : "Make required")
      )
    )
  );
}

function pPreviews(d) {
  return [
    ["in_development", "in_revision", "awaiting_feedback"].includes(d.project.status) ? h("p", h("button.btn.small", { type: "button", onclick: () => previewModal(d) }, "Send preview")) : null,
    d.reviews.length
      ? h("div.panel", h("ul.list", d.reviews.map((r) => h("li", h("div", h("b", r.title), " ", chip(r.kind === "final" ? "Final" : "Preview"), r.url ? h("div.small", h("a", { href: r.url, target: "_blank" }, r.url)) : null, r.response ? h("div.small", { style: { whiteSpace: "pre-wrap", marginTop: "6px" } }, `${r.responded_name ? r.responded_name + ": " : ""}${r.response}`) : null), chip(r.status.replace("_", " "), r.status === "approved" ? "ok" : r.status === "open" ? "info" : "wait")))))
      : h("div.empty", "No previews sent yet."),
    h("p.small.muted", `Revision rounds used: ${d.project.revisions_used} of ${d.project.revision_rounds}.`),
  ];
}

function pMessages(d, id) {
  const body = h("textarea", { rows: 3 });
  const send = h("button.btn.small", { type: "submit" }, "Send (emails the client)");
  const thread = h("div.thread", d.messages.length ? d.messages.map((m) => h(`div.msg.${m.sender}`, m.body, h("time", fmtTime(m.created_at)))) : h("div.empty", "No messages yet."));
  setTimeout(() => (thread.scrollTop = thread.scrollHeight));
  return h("div.panel", thread, h("form.form", { style: { marginTop: "14px" }, onsubmit: async (e) => (e.preventDefault(), (await act(send, () => api("POST", `/api/admin/projects/${id}/messages`, { body: body.value }), "Sent")) && reload()) }, field("Message", body), h("div.actions", send)));
}

function pFiles(d, id) {
  const picker = h("input", { type: "file", multiple: true });
  const kind = h("select", h("option", { value: "deliverable" }, "Deliverable (client sees it)"), h("option", { value: "preview" }, "Preview asset (client sees it)"), h("option", { value: "private" }, "Private to the studio"));
  picker.onchange = async () => {
    for (const f of picker.files) await act(null, () => upload(`/api/admin/projects/${id}/files?${kind.value === "private" ? "kind=deliverable&private=1" : `kind=${kind.value}`}`, f), `Uploaded ${f.name}`);
    reload();
  };
  return [
    h("div.panel", h("div.actions", kind, h("label.drop", { style: { flex: 1 } }, picker, "Upload files"))),
    h(
      "div.panel",
      d.files.length
        ? h("div.files", d.files.map((f) => h("div.file", h("a", { href: `/api/admin/files/${f.id}`, target: "_blank" }, f.name), h("span.small.muted", `${f.uploaded_by} · ${f.kind}${f.visible_to_client ? "" : " · private"} · ${kb(f.size)}`), h("button.x", { type: "button", "aria-label": `Delete ${f.name}`, onclick: async () => confirm(`Delete ${f.name}?`) && (await act(null, () => api("DELETE", `/api/admin/files/${f.id}`), "Deleted")) && reload() }, "×"))))
        : h("p.muted", "No files yet.")
    ),
  ];
}

function invoiceRow(i) {
  const b = (label, fn) => h("button.btn.tiny.quiet", { type: "button", onclick: fn }, label);
  const post = (path, body, ok) => async (e) => (await act(e.currentTarget, () => api("POST", path, body), ok)) && reload();
  return h(
    "tr",
    h("td.mono", i.number),
    h("td", i.label, i.required_for_start ? h("div.small.muted", "Required before the build") : null, i.required_for_launch ? h("div.small.muted", "Required before launch") : null),
    h("td.mono", money(i.amount_cents)),
    h("td", chip(i.status, i.status === "paid" ? "ok" : i.status === "open" ? "wait" : ""), i.due_date ? h("div.small.muted", `Due ${fmtDate(i.due_date)}`) : i.due_trigger !== "date" ? h("div.small.muted", `Due at ${i.due_trigger}`) : null),
    h(
      "td.actions",
      i.status === "draft" ? b("Send", post(`/api/admin/invoices/${i.id}/send`, {}, "Sent")) : null,
      ["draft", "open"].includes(i.status)
        ? [
            b("Edit", () => modal(`Edit ${i.number}`, [field("Label", h("input", { name: "label", value: i.label })), field("Amount", h("input", { name: "amount", value: (i.amount_cents / 100).toFixed(2) })), field("Due date", h("input", { name: "due_date", type: "date", value: i.due_date || "" }))], { onSubmit: async (fd) => (await api("PATCH", `/api/admin/invoices/${i.id}`, Object.fromEntries(fd)), reload(), true) })),
            b("Split", () => modal(`Split ${i.number} into installments`, [field("How many", h("input", { name: "count", type: "number", value: 3, min: 2 })), field("First due", h("input", { name: "first_due", type: "date" })), field("Days between", h("input", { name: "every_days", type: "number", value: 30 }))], { onSubmit: async (fd) => (await api("POST", `/api/admin/invoices/${i.id}/split`, Object.fromEntries(fd)), reload(), true) })),
            b("Mark paid", () => modal(`Record a payment for ${i.number}`, [h("p.muted", "For payments outside Stripe (check, cash, bank transfer)."), field("How it was paid", h("input", { name: "note", required: true, placeholder: "Check #1042" }))], { onSubmit: async (fd) => (await api("POST", `/api/admin/invoices/${i.id}/mark-paid`, Object.fromEntries(fd)), reload(), true) })),
            b("Void", async (e) => confirm(`Void ${i.number}?`) && post(`/api/admin/invoices/${i.id}/void`, {}, "Voided")(e)),
          ]
        : null
    )
  );
}

function newInvoiceModal({ projectId, clientId }) {
  modal(
    "New invoice",
    [
      field("Label", h("input", { name: "label", required: true, placeholder: "Extra page: Gallery" })),
      h("div.row-2", field("Amount", h("input", { name: "amount", required: true })), field("Due date", h("input", { name: "due_date", type: "date" }))),
      field("Kind", h("select", { name: "kind" }, ["custom", "milestone", "installment", "deposit", "final"].map((k) => h("option", { value: k }, k)))),
      h("label.check", h("input", { type: "checkbox", name: "required_for_start", value: "1" }), h("span", "Must be paid before the build starts")),
      h("label.check", h("input", { type: "checkbox", name: "required_for_launch", value: "1" }), h("span", "Must be paid before launch")),
      h("label.check", h("input", { type: "checkbox", name: "send", value: "1", checked: true }), h("span", "Send to the client now")),
    ],
    {
      submit: "Create invoice",
      onSubmit: async (fd) => {
        const o = Object.fromEntries(fd);
        await api("POST", "/api/admin/invoices", { ...o, project_id: projectId, client_id: clientId, required_for_start: !!o.required_for_start, required_for_launch: !!o.required_for_launch, send: !!o.send });
        reload();
        return true;
      },
    }
  );
}

async function offerPlanModal({ clientId, projectId }) {
  const m = await api("GET", "/api/admin/money");
  modal(
    "Offer a care plan",
    [
      field("Plan", h("select", { name: "plan_slug" }, m.plans.map((p) => h("option", { value: p.slug }, `${p.name}${p.monthly_cents != null ? ` · ${money(p.monthly_cents)}/mo` : ""}`)))),
      h("div.row-2", field("Monthly price (override)", h("input", { name: "monthly", placeholder: "Plan price" })), field("Minimum months (override)", h("input", { name: "term_months", type: "number" }))),
      h("p.small.muted", "The client reviews and accepts the care agreement, then subscribes through Stripe."),
    ],
    { submit: "Offer plan", onSubmit: async (fd) => (await api("POST", "/api/admin/subscriptions", { ...Object.fromEntries(fd), client_id: clientId, project_id: projectId }), reload(), true) }
  );
}

function pBilling(d, id) {
  const live = d.invoices.filter((i) => i.status !== "void");
  const paid = live.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount_cents, 0);
  return [
    h(
      "div.panel",
      h("div.panel-head", h("h3", `Invoices · ${money(paid)} of ${money(d.project.price_cents)} paid`), h("div.actions", h("button.btn.tiny", { type: "button", onclick: () => newInvoiceModal({ projectId: id }) }, "+ Invoice"))),
      live.length ? h("div.table-wrap", h("table.t", h("tbody", live.map(invoiceRow)))) : h("p.muted", "No invoices yet. Sending the quote creates the deposit and final payment."),
      d.stripe ? null : h("p.note.wait", "Stripe isn't connected (STRIPE_SECRET_KEY), so clients can't pay online yet. You can still record payments by hand.")
    ),
    h("div.panel", h("div.panel-head", h("h3", "Care plans"), h("button.btn.tiny", { type: "button", onclick: () => offerPlanModal({ clientId: d.project.client_id, projectId: id }) }, "+ Offer plan")), d.subscriptions.length ? h("ul.list", d.subscriptions.map((s) => h("li", h("span", `${s.name} · ${money(s.monthly_cents)}/mo`), h("span.actions", chip(s.status), ["offered", "active", "past_due"].includes(s.status) ? h("button.btn.tiny.quiet", { type: "button", onclick: async (e) => confirm("Cancel this plan? Active plans stop at the end of the current period.") && (await act(e.currentTarget, () => api("POST", `/api/admin/subscriptions/${s.id}/cancel`), "Done")) && reload() }, "Cancel") : null)))) : h("p.muted", "None.")),
    d.payments.length ? h("div.panel", h("h3", "Payments"), h("ul.list", d.payments.map((p) => h("li", h("span", `${fmtDate(p.paid_at)} · ${p.method}${p.note ? ` · ${p.note}` : ""}`), h("b.mono", money(p.amount_cents)))))) : null,
  ];
}

function pAgreements(d) {
  return d.agreements.length
    ? h("div.panel", h("ul.list", d.agreements.map((a) => h("li", h("div", h("b", `${a.title} v${a.version}`), h("div.small.muted", a.status === "accepted" ? `Accepted by ${a.accepted_name} (${a.accepted_email}) ${fmtTime(a.accepted_at)} · IP ${a.accepted_ip || "?"} · text ${a.body_hash.slice(0, 12)}…` : `Issued ${fmtTime(a.created_at)}`)), h("span.actions", chip(a.status, a.status === "accepted" ? "ok" : a.status === "pending" ? "wait" : ""), h("a.btn.tiny.quiet", { href: `/api/admin/agreements/${a.id}/document`, target: "_blank" }, "View"))))))
    : h("div.empty", "No agreements yet. Sending the quote issues one.");
}

// ───────── Clients ─────────
async function clients() {
  const d = await api("GET", "/api/admin/clients");
  show(
    top("Clients", h("button.btn.small", { type: "button", onclick: () => modal("Add client", [field("Name", h("input", { name: "name", required: true })), field("Email", h("input", { name: "email", type: "email", required: true })), field("Business", h("input", { name: "business" })), field("Phone", h("input", { name: "phone" }))], { onSubmit: async (fd) => (await api("POST", "/api/admin/clients", Object.fromEntries(fd)), reload(), true) }) }, "+ Client")),
    h(
      "div.panel",
      d.clients.length
        ? h("div.table-wrap", h("table.t", h("thead", h("tr", h("th", "Name"), h("th", "Email"), h("th", "Business"), h("th", "Projects"), h("th", "Paid"), h("th", ""))), h("tbody", d.clients.map((c) => h("tr", h("td", h("b", c.name)), h("td", c.email), h("td", c.business || ""), h("td.mono", c.projects), h("td.mono", money(c.paid_cents)), h("td.actions", h("button.btn.tiny.quiet", { type: "button", onclick: async (e) => act(e.currentTarget, () => api("POST", `/api/admin/clients/${c.id}/invite`), "Portal link sent") }, "Send portal link"), h("button.btn.tiny.quiet", { type: "button", onclick: () => newInvoiceModal({ clientId: c.id }) }, "Invoice"), h("button.btn.tiny.quiet", { type: "button", onclick: () => offerPlanModal({ clientId: c.id }) }, "Care plan")))))))
        : h("p.muted", "No clients yet.")
    )
  );
}

// ───────── Money ─────────
async function moneyView() {
  const d = await api("GET", "/api/admin/money");
  const r = d.revenue;
  show(
    top("Money"),
    h("div.kpis", kpi(money(r.this_year), "received this year"), kpi(money(r.all_time), "all time"), kpi(money(r.outstanding), `${r.openInvoices} open invoices`), kpi(`${money(r.mrr)}/mo`, `${r.subscriptions} active care plans`)),
    d.stripe ? null : h("p.note.wait", "Stripe isn't connected yet. Add STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (see Setup)."),
    h("div.panel", h("h3", "By month"), r.byMonth.length ? h("ul.list", r.byMonth.map((m) => h("li", h("span", m.month), h("b.mono", `${money(m.cents)} · ${m.n} payment${m.n === 1 ? "" : "s"}`)))) : h("p.muted", "No payments yet.")),
    h("div.panel", h("h3", "Invoices"), d.invoices.length ? h("div.table-wrap", h("table.t", h("tbody", d.invoices.map((i) => { const row = invoiceRow(i); row.children[1].append(h("div.small.muted", `${i.client_name}${i.project_title ? ` · ${i.project_title}` : ""}`)); return row; })))) : h("p.muted", "None.")),
    h("div.panel", h("h3", "Care plans"), d.subscriptions.length ? h("ul.list", d.subscriptions.map((s) => h("li", h("span", `${s.client_name} · ${s.name} · ${money(s.monthly_cents)}/mo${s.commitment_ends ? ` · term ends ${fmtDate(s.commitment_ends)}` : ""}`), chip(s.status, s.status === "active" ? "ok" : s.status === "past_due" ? "bad" : "")))) : h("p.muted", "None.")),
    h("div.panel", h("h3", "Recent payments"), d.payments.length ? h("ul.list", d.payments.map((p) => h("li", h("span", `${fmtDate(p.paid_at)} · ${p.client_name} · ${p.method}`), h("b.mono", money(p.amount_cents))))) : h("p.muted", "None."))
  );
}

// ───────── Content ─────────
const SCHEMAS = {
  packages: { title: "Packages", label: (r) => `${r.name} · ${money(r.price_cents)}`, fields: [["name", "Name"], ["slug", "Slug (in URLs)"], ["tagline", "Tagline"], ["price_cents", "Price ($, blank = custom)", "money"], ["price_prefix", "Price prefix (e.g. from)"], ["turnaround_days", "Build time (business days)", "number"], ["turnaround_text", "Timeline text"], ["support_days", "Support days", "number"], ["revision_rounds", "Revision rounds", "number"], ["deposit_percent", "Deposit %", "number"], ["features", "Features (one per line)", "list"], ["fast_track", "One-week promise", "bool"], ["featured", "Highlight", "bool"], ["sort", "Order", "number"], ["active", "Shown", "bool"]] },
  addons: { title: "Add-ons", label: (r) => `${r.category} · ${r.name} · ${r.price_cents == null ? "Custom quote" : money(r.price_cents)}`, fields: [["category", "Category"], ["name", "Name"], ["description", "Description", "text"], ["price_cents", "Price ($, blank = custom quote)", "money"], ["price_prefix", "Prefix (from)"], ["unit", "Unit (per page)"], ["extends_timeline", "Usually adds days", "bool"], ["sort", "Order", "number"], ["active", "Shown", "bool"]] },
  care_plans: { title: "Care plans", label: (r) => `${r.name} · ${r.monthly_cents == null ? "Custom" : money(r.monthly_cents) + "/mo"}`, fields: [["name", "Name"], ["slug", "Slug"], ["kind", "Kind (care or waas)"], ["monthly_cents", "Monthly price ($)", "money"], ["term_months", "Minimum months (0 = month to month)", "number"], ["description", "Description", "text"], ["features", "Includes (one per line)", "list"], ["sort", "Order", "number"], ["active", "Shown", "bool"]] },
  portfolio: { title: "Portfolio", label: (r) => `${r.title}${r.status === "preview" ? " · preview" : ""}${r.published ? "" : " · hidden"}${r.permission ? "" : " · no permission"}`, fields: [["title", "Title"], ["slug", "Slug"], ["url", "Website URL"], ["kind", "Kind"], ["summary", "Summary", "text"], ["story", "Story (blank line between paragraphs)", "text"], ["built", "What was built (one per line)", "list"], ["stack", "Stack (one per line)", "list"], ["image", "Desktop screenshot path", "image"], ["image_mobile", "Mobile screenshot path", "image"], ["status", "Status (live or preview)"], ["permission", "Client gave permission to show it", "bool"], ["published", "Published", "bool"], ["featured", "Featured", "bool"], ["sort", "Order", "number"]] },
  testimonials: { title: "Testimonials", label: (r) => `${r.name}${r.published ? "" : " · hidden"}`, fields: [["quote", "Quote", "text"], ["name", "Name"], ["role", "Role / business"], ["published", "Published (only real, permitted quotes)", "bool"], ["sort", "Order", "number"]] },
  faqs: { title: "FAQs", label: (r) => `${r.question} · ${r.page}`, fields: [["question", "Question"], ["answer", "Answer", "text"], ["page", "Page (home, pricing or faq)"], ["sort", "Order", "number"], ["published", "Published", "bool"]] },
};

async function content(sub = "packages") {
  const subs = [...Object.entries(SCHEMAS).map(([k, s]) => [k, s.title]), ["agreements", "Agreements"], ["settings", "Business & homepage"]];
  const tabs = h("nav.tabs", subs.map(([k, l]) => h("a", { href: `#/content/${k}`, "aria-current": sub === k ? "page" : null }, l)));
  if (sub === "agreements") return show(top("Content"), tabs, await agreementTemplates());
  if (sub === "settings") return show(top("Content"), tabs, await settingsView());
  const schema = SCHEMAS[sub] || SCHEMAS.packages;
  const table = SCHEMAS[sub] ? sub : "packages";
  const d = await api("GET", `/api/admin/content/${table}`);
  show(top("Content", h("button.btn.small", { type: "button", onclick: () => editRow(table, schema, null) }, "+ Add")), tabs, h("p.small.muted", "Changes show on the public site immediately."), h("div.panel", h("ul.list", d.rows.map((r) => h("li", h("span", { style: { opacity: r.active === 0 || r.published === 0 ? 0.55 : 1 } }, schema.label(r)), h("span.actions", h("button.btn.tiny.quiet", { type: "button", onclick: () => editRow(table, schema, r) }, "Edit"), h("button.btn.tiny.quiet", { type: "button", onclick: async (e) => confirm("Delete this?") && (await act(e.currentTarget, () => api("DELETE", `/api/admin/content/${table}/${r.id}`), "Deleted")) && reload() }, "Delete")))))));
}

function editRow(table, schema, row) {
  const inputs = schema.fields.map(([name, label, type]) => {
    const v = row?.[name];
    if (type === "bool") return h("label.check", h("input", { type: "checkbox", name, value: "1", checked: row ? !!v : name === "active" || name === "published" }), h("span", label));
    if (type === "list") return field(label, h("textarea", { name, rows: 5 }, (v || []).join("\n")));
    if (type === "text") return field(label, h("textarea", { name, rows: name === "story" ? 8 : 3 }, v ?? ""));
    if (type === "money") return field(label, h("input", { name, value: v == null ? "" : (v / 100).toFixed(2) }));
    if (type === "image") {
      const input = h("input", { name, value: v ?? "" });
      const picker = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
      picker.onchange = async () => {
        const out = await act(null, () => upload("/api/admin/media", picker.files[0]), "Image uploaded");
        if (out) input.value = out.url;
      };
      return field(label, h("div.actions", input, h("label.btn.tiny.quiet", picker, "Upload")));
    }
    return field(label, h("input", { name, type: type === "number" ? "number" : "text", value: v ?? "" }));
  });
  modal(row ? "Edit" : "Add", inputs, {
    onSubmit: async (fd, form) => {
      const body = {};
      for (const [name, , type] of schema.fields) body[name] = type === "bool" ? !!form.elements[name]?.checked : fd.get(name);
      await api(row ? "PATCH" : "POST", `/api/admin/content/${table}${row ? `/${row.id}` : ""}`, body);
      reload();
      return true;
    },
  });
}

async function agreementTemplates() {
  const d = await api("GET", "/api/admin/agreement-templates");
  const latest = {};
  for (const t of d.templates) if (!latest[t.slug]) latest[t.slug] = t;
  return [
    h("p.note.wait", "These are drafts for attorney review. Saving creates a new version: agreements clients already accepted keep the exact text they saw. Placeholders like {{price}} are filled in per client."),
    Object.values(latest).map((t) => {
      const body = h("textarea.code", { name: "body" }, t.body);
      const title = h("input", { name: "title", value: t.title });
      const approved = h("input", { type: "checkbox", checked: !!t.attorney_approved });
      const save = h("button.btn.small", { type: "button" }, "Save as new version");
      save.onclick = async () => (await act(save, () => api("POST", "/api/admin/agreement-templates", { slug: t.slug, title: title.value, body: body.value, attorney_approved: approved.checked }), "Saved")) && reload();
      return h("div.panel", h("div.panel-head", h("h3", `${t.title} · v${t.version}`), chip(t.attorney_approved ? "Attorney approved" : "Draft", t.attorney_approved ? "ok" : "wait"), chip(`${t.accepted_count} accepted`)), h("div.form", field("Title", title), field("Text", body), h("label.check", approved, h("span", "An attorney has reviewed and approved this version")), h("div.actions", save)));
    }),
  ];
}

async function settingsView() {
  const d = await api("GET", "/api/admin/settings");
  const form = (key, fields) => {
    const f = h("form.form", { onsubmit: async (e) => (e.preventDefault(), act(e.submitter, () => api("PUT", `/api/admin/settings/${key}`, { value: Object.fromEntries(new FormData(f)) }), "Saved")) }, fields.map(([k, label, ta]) => field(label, ta ? h("textarea", { name: k, rows: 3 }, d[key][k] || "") : h("input", { name: k, value: d[key][k] || "" }))), h("div.actions", h("button.btn.small", { type: "submit" }, "Save")));
    return f;
  };
  const closed = h("textarea", { rows: 4 }, d.closed_dates.join("\n"));
  const saveClosed = h("button.btn.small", { type: "button" }, "Save closed dates");
  saveClosed.onclick = () => act(saveClosed, () => api("PUT", "/api/admin/settings/closed_dates", { value: closed.value.split(/\s+/).filter(Boolean) }), "Saved; delivery dates recalculated");
  return [
    h("div.panel", h("h3", "Business details"), form("business", [["name", "Business name"], ["short", "Short name (logo)"], ["tagline", "Tagline"], ["owner", "Your name (shown on About; blank to leave out)"], ["email", "Public email"], ["phone", "Public phone"], ["city", "City"], ["region", "State"]])),
    h("div.panel", h("h3", "Homepage"), form("home", [["eyebrow", "Small line above the headline"], ["headline", "Headline (| splits the two lines)"], ["intro", "Intro", true], ["cta", "Button text"], ["promise_title", "Promise section label"], ["promise", "Promise section text", true]])),
    h("div.panel", h("h3", "Closed dates"), h("p.small.muted", "Holidays and time off, one YYYY-MM-DD per line. They don't count as business days, so delivery dates move past them."), closed, h("div.actions", { style: { marginTop: "10px" } }, saveClosed)),
  ];
}

// ───────── Setup ─────────
async function setup() {
  const [s, a] = await Promise.all([api("GET", "/api/admin/setup"), api("GET", "/api/admin/activity")]);
  const b = (label, path, ok) => {
    const btn = h("button.btn.small.quiet", { type: "button" }, label);
    btn.onclick = async () => {
      const out = await act(btn, () => api("POST", path), ok);
      if (out?.report) toast(`Done: ${Object.entries(out.report).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    };
    return btn;
  };
  show(
    top("Setup"),
    h("div.panel", h("h3", "Connections"), h("ul.list", s.checks.map((c) => h("li", h("div", h("b", c.name), h("div.small.muted", c.how)), chip(c.ok ? "Connected" : "Not set", c.ok ? "ok" : "wait"))))),
    h("div.panel", h("h3", "Tests and automation"), h("div.actions", b("Send me a test email", "/api/admin/setup/test-email", "Test email sent"), b("Send a test phone alert", "/api/admin/setup/test-alert", "Alert sent"), b("Run today's reminders now", "/api/admin/run-daily", null)), h("p.small.muted", "Reminders and the morning digest also run automatically every day at about 9am Eastern. Each email goes out once.")),
    h("div.panel", h("h3", "Delivery log"), a.events.length ? h("ul.list.log", a.events.map((e) => h("li", h("time", fmtTime(e.created_at)), h("span", chip(e.ok ? e.kind : `${e.kind} failed`, e.ok ? "" : "bad"), " ", e.detail)))) : h("p.muted", "Nothing sent yet.")),
    h("div.panel", h("h3", "Audit trail"), activityList(a.activity))
  );
}
