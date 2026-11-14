// Client portal: sign in, see the project, finish onboarding, review previews, message, pay, sign agreements.
import { $, h, api, money, fmtDate, fmtTime, kb, chip, itemChip, toast, act, upload, weekBar, field } from "./ui.js";

const app = $("#app");
let me = null;

const CHECK = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.innerHTML = '<path d="M4 12.5 9.5 18 20 6.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
  return s;
};

function render(...nodes) {
  app.replaceChildren(h("div.wrap", nodes));
}

// ───────── Router ─────────
async function route() {
  const [, kind, id, tab = "overview"] = location.hash.split("/");
  try {
    if (!me) me = await api("GET", "/api/portal/me");
  } catch (e) {
    if (e.status === 401) return signInView();
    return render(h("p.form-msg.err", e.message));
  }
  $("#who").replaceChildren(h("span", me.client.name), h("button.btn.tiny.quiet", { onclick: signOut }, "Sign out"));
  if (kind === "project" && id) return projectView(Number(id), tab);
  if (me.projects.length === 1) return (location.hash = `#/project/${me.projects[0].id}`);
  homeView();
}
addEventListener("hashchange", route);
route();

async function signOut() {
  await api("POST", "/api/auth/logout").catch(() => {});
  me = null;
  location.hash = "";
  route();
}

// ───────── Sign in ─────────
function signInView() {
  $("#who").replaceChildren();
  const email = h("input", { type: "email", name: "email", autocomplete: "email", required: true });
  const msg = h("div.form-msg", { hidden: true, role: "status" });
  const btn = h("button.btn.accent", { type: "submit" }, "Email me a sign-in link");
  const form = h(
    "form.form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const out = await act(btn, () => api("POST", "/api/auth/login", { email: email.value }));
        if (!out) return;
        msg.hidden = false;
        msg.className = "form-msg ok";
        msg.textContent = out.message;
      },
    },
    field("Your email", email),
    btn,
    msg
  );
  render(h("div.signin", h("div.panel", h("div.eyebrow", "Client portal"), h("h1", { style: { fontSize: "2.1rem" } }, "Sign in to your project"), h("p.muted", "No password needed. I'll email you a link that signs you in."), form)));
}

function homeView() {
  render(
    h("h1", { style: { fontSize: "2.2rem" } }, `Hi, ${me.client.name.split(/\s+/)[0]}`),
    me.projects.length
      ? h("ul.list.panel", me.projects.map((p) => h("li", h("a", { href: `#/project/${p.id}`, style: { fontWeight: 600 } }, p.title), chip(p.statusLabel || p.status))))
      : h("div.empty", "There's nothing here yet. When your quote is ready, it'll appear here.")
  );
}

// ───────── Project ─────────
const TABS = [
  ["overview", "Overview"],
  ["onboarding", "Onboarding"],
  ["previews", "Previews"],
  ["messages", "Messages"],
  ["files", "Files"],
  ["billing", "Billing"],
  ["agreements", "Agreements"],
];

async function projectView(id, tab) {
  let d;
  try {
    d = await api("GET", `/api/portal/projects/${id}`);
  } catch (e) {
    return render(h("div.empty", e.message), h("p", h("a", { href: "#/" }, "← Your projects")));
  }
  const p = d.project;
  const paid = new URLSearchParams(location.search);
  if (paid.has("paid") || paid.has("subscribed")) {
    toast(paid.has("paid") ? "Thank you! Your payment is being confirmed." : "Thanks! Your care plan is being set up.");
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const counts = {
    onboarding: d.items.filter((i) => i.required && ["not_started", "needs_changes"].includes(i.status) && !i.exception_requested).length,
    previews: d.reviews.filter((r) => r.status === "open").length,
    billing: d.invoices.filter((i) => i.status === "open").length,
    agreements: d.agreements.filter((a) => a.status === "pending").length,
  };
  const tabs = h(
    "nav.tabs",
    { "aria-label": "Project sections" },
    TABS.filter(([k]) => !(k === "onboarding" && p.status === "quote")).map(([k, label]) => h("a", { href: `#/project/${id}/${k}`, "aria-current": tab === k ? "page" : null }, label, counts[k] ? h("span.count", String(counts[k])) : null))
  );
  const next = d.state.next;
  const turn = h(
    `div.turn.${next.who}`,
    h("span.who", next.who === "client" ? "Your turn" : next.who === "studio" ? "Studio's turn" : "All set"),
    h("span", next.text)
  );
  const views = { overview, onboarding, previews, messages, files, billing, agreements };
  render(
    me.projects.length > 1 ? h("p.small", h("a", { href: "#/" }, "← All projects")) : null,
    h("div.proj-head", h("div", h("span.status-pill", d.state.clientStatusLabel), h("h1", p.title)), p.live_url ? h("a.btn.ghost.small", { href: p.live_url, target: "_blank", rel: "noopener" }, "View live site") : null),
    turn,
    tabs,
    (views[tab] || overview)(d, id)
  );
}

const reload = () => route();

// ───────── Overview ─────────
function overview(d, id) {
  const p = d.project;
  const s = d.state.schedule;
  const out = [];
  if (p.status === "quote") out.push(quotePanel(d, id));
  if (s.start) {
    out.push(
      h(
        "div.countdown",
        h("div", h("div.lbl", s.held ? "Delivery target (clock held)" : "Delivery target"), h("div.big", fmtDate(s.due))),
        h("div", h("div.lbl", { style: { marginBottom: "8px" } }, `Build day ${Math.min(s.daysUsed + (s.daysUsed < s.daysTotal ? 1 : 0), s.daysTotal)} of ${s.daysTotal}${s.delay ? ` · moved ${s.delay} business day${s.delay === 1 ? "" : "s"} while waiting on feedback or paused` : ""}`), weekBar(s))
      )
    );
  } else if (p.status !== "quote" && p.status !== "completed") {
    out.push(
      h(
        "div.panel",
        h("h3", "Before your build week starts"),
        h("p.muted", `Your ${p.turnaround_days ? `${p.turnaround_days}-business-day ` : ""}build begins the business day after everything below is done.`),
        d.state.blockers.length
          ? h("ul.list", d.state.blockers.map((b) => h("li", h("span", b.what), chip(b.who === "client" ? "You" : "Studio", b.who === "client" ? "accent" : "info"))))
          : h("p.note.ok", "Everything's in. The studio will confirm your start date.")
      )
    );
  }
  const stages = [
    ["quote", "Quote accepted"],
    ["awaiting_onboarding", "Onboarding"],
    ["ready_to_start", "Ready to start"],
    ["in_development", "In development"],
    ["awaiting_feedback", "Your review"],
    ["ready_for_launch", "Ready for launch"],
    ["completed", "Live"],
  ];
  const order = ["quote", "awaiting_onboarding", "ready_to_start", "in_development", "awaiting_feedback", "in_revision", "ready_for_launch", "completed"];
  const at = order.indexOf(p.status === "in_revision" ? "awaiting_feedback" : p.status);
  out.push(
    h(
      "div.cols",
      h(
        "div",
        h(
          "div.panel",
          h("h3", "Progress"),
          h(
            "ul.list",
            stages.map(([k, label]) => {
              const i = order.indexOf(k);
              const state = p.status === "paused" ? "" : i < at ? "done" : i === at ? "now" : "";
              return h("li", h("span", { style: { fontWeight: state === "now" ? 700 : 500, color: state ? "var(--ink)" : "var(--muted)" } }, label), state === "done" ? chip("Done", "ok") : state === "now" ? chip("Now", "accent") : null);
            })
          ),
          p.status === "paused" ? h("p.note.wait", `Paused${p.pause_reason ? `: ${p.pause_reason}` : ""}`) : null
        ),
        d.milestones.length ? h("div.panel", h("h3", "Milestones"), h("ul.list", d.milestones.map((m) => h("li", h("span", m.title), m.done_at ? chip("Reached", "ok") : chip(m.target_date ? `Target ${fmtDate(m.target_date)}` : "Upcoming"))))) : null
      ),
      h(
        "div",
        h(
          "div.panel",
          h("h3", "Your project"),
          h(
            "dl.kv",
            h("dt", "Price"), h("dd", money(p.price_cents)),
            h("dt", "Build time"), h("dd", p.turnaround_days ? `${p.turnaround_days} business days` : "As quoted"),
            h("dt", "Revisions"), h("dd", `${p.revisions_used} of ${p.revision_rounds} used`),
            h("dt", "Reply window"), h("dd", `${p.feedback_days} business days per preview`),
            h("dt", "Support"), h("dd", `${p.support_days} days after launch${p.launched_at ? ` (from ${fmtDate(p.launched_at)})` : ""}`),
            d.subscriptions.filter((s) => s.status === "active").length ? [h("dt", "Care plan"), h("dd", d.subscriptions.find((s) => s.status === "active").name)] : null
          ),
          h("h3", { style: { marginTop: "18px", fontSize: "1.05rem" } }, "Agreed scope"),
          h("ul.built", [...p.scope, ...p.addons.map((a) => a.name)].map((s) => h("li", s)))
        )
      )
    )
  );
  return out;
}

function agreementBox(a, consentText, onDone) {
  const box = h("div.agreement", { tabindex: "0", "aria-label": a.title }, a.body);
  if (a.status === "accepted") return h("div", box, h("p.note.ok", { style: { marginTop: "10px" } }, `Accepted by ${a.accepted_name} on ${fmtTime(a.accepted_at)}.`), h("p", h("a", { href: `/api/portal/agreements/${a.id}/document`, target: "_blank" }, "Download / print a copy")));
  const name = h("input", { type: "text", autocomplete: "name", required: true });
  const consent = h("input", { type: "checkbox" });
  const btn = h("button.btn.accent", { type: "submit" }, "Accept agreement");
  return h(
    "form.form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!consent.checked) return toast("Please tick the box to confirm.", true);
        const ok = await act(btn, () => api("POST", `/api/portal/agreements/${a.id}/accept`, { name: name.value, consent: true, hash: a.body_hash }), "Agreement accepted. Thank you!");
        if (ok) onDone();
      },
    },
    box,
    h("p.small.muted", h("a", { href: `/api/portal/agreements/${a.id}/document`, target: "_blank" }, "Open a printable copy"), ` · Version ${a.version}`),
    h("label.check", consent, h("span", consentText)),
    field("Type your full name to sign", name),
    btn
  );
}

function payButton(inv) {
  const btn = h("button.btn.accent.small", { type: "button" }, `Pay ${money(inv.amount_cents)}`);
  btn.onclick = async () => {
    const out = await act(btn, () => api("POST", `/api/portal/invoices/${inv.id}/checkout`));
    if (out?.url) location.href = out.url;
  };
  return btn;
}

function quotePanel(d, id) {
  const p = d.project;
  const a = d.agreements.find((x) => !x.subscription_id && x.template_slug === "project");
  const deposit = d.invoices.find((i) => i.required_for_start && i.status === "open");
  return h(
    "div.panel",
    h("div.panel-head", h("h2", "Your quote"), p.quote_expires ? chip(`Valid until ${fmtDate(p.quote_expires)}`) : null),
    h("div.money-big", money(p.price_cents)),
    h("p.muted", p.turnaround_days ? `${p.turnaround_days} business days of build time, starting the business day after onboarding is approved.` : "Timeline as described in the agreement."),
    h("h3", { style: { fontSize: "1.05rem" } }, "Payment schedule"),
    h(
      "ul.list",
      [...d.invoices, ...d.upcoming].map((i) => h("li", h("span", i.label), h("span", h("b.mono", money(i.amount_cents)), " ", chip(i.status === "paid" ? "Paid" : i.due_trigger === "start" ? "Before the build" : i.due_trigger === "launch" ? "At launch" : i.due_date ? `Due ${fmtDate(i.due_date)}` : "Due", i.status === "paid" ? "ok" : ""))))
    ),
    h("h3", { style: { fontSize: "1.05rem", marginTop: "18px" } }, "1. Read and accept the agreement"),
    a ? agreementBox(a, d.consentText, reload) : h("p.muted", "The agreement will appear here."),
    h("h3", { style: { fontSize: "1.05rem", marginTop: "18px" } }, "2. Pay the deposit"),
    deposit
      ? a?.status === "accepted"
        ? d.payOnline
          ? h("div.actions", payButton(deposit), h("span.small.muted", "Secure checkout by Stripe. Card details never touch this site."))
          : h("p.note.wait", "Online payment isn't switched on yet. I'll send payment instructions by email.")
        : h("p.muted", "Accept the agreement first.")
      : h("p.note.ok", "No deposit needed, or it's already paid.")
  );
}

// ───────── Onboarding ─────────
function onboarding(d, id) {
  const pr = d.state.progress;
  const sections = [...new Set(d.items.map((i) => i.section))];
  return [
    h(
      "div.panel",
      h("div.ob-progress", h("div", { style: { flex: 1 } }, h("div.label", `${pr.done} of ${pr.total} required items approved`), h("div.meter", { style: { marginTop: "8px" } }, h("i", { style: { width: `${pr.percent}%`, background: "var(--accent)" } })))),
      h("p.muted.small", { style: { margin: 0 } }, "Save as you go and submit each item when it's ready. I'll review it and mark it approved, or tell you exactly what to change. If something isn't available, request an exception and explain why.")
    ),
    sections.map((s) => [h("div.ob-section", s), d.items.filter((i) => i.section === s).map((i) => itemCard(i, id))]),
  ];
}

function itemCard(item, projectId) {
  const locked = ["approved", "exception_approved"].includes(item.status);
  const inputs = {};
  const fields = item.fields.map((f) => {
    const el =
      f.type === "textarea"
        ? h("textarea", { name: f.name, rows: 5, disabled: locked }, item.value[f.name] || "")
        : h("input", { type: ["email", "tel", "url"].includes(f.type) ? f.type : "text", name: f.name, value: item.value[f.name] || "", disabled: locked, placeholder: f.placeholder || "" });
    inputs[f.name] = el;
    return field(`${f.label}${f.required ? "" : " (optional)"}`, el);
  });
  const values = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
  const fileList = h("div.files", item.files.map((f) => fileRow(f, !locked && f.uploaded_by === "client")));
  const picker = h("input", { type: "file", multiple: true, accept: "image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.svg,.ai,.eps,.psd" });
  const drop = item.allow_files && !locked ? h("label.drop", picker, "Drop files here or tap to choose (up to 25 MB each)") : null;
  const sendFiles = async (files) => {
    for (const f of files) {
      drop.textContent = `Uploading ${f.name}…`;
      try {
        const out = await upload(`/api/portal/projects/${projectId}/items/${item.id}/files`, f);
        fileList.append(fileRow(out.file, true));
      } catch (e) {
        toast(`${f.name}: ${e.message}`, true);
      }
    }
    drop.replaceChildren(picker, "Drop files here or tap to choose (up to 25 MB each)");
  };
  if (drop) {
    picker.onchange = () => sendFiles([...picker.files]);
    drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => (e.preventDefault(), drop.classList.remove("over"), sendFiles([...e.dataTransfer.files]));
  }
  const save = h("button.btn.quiet.small", { type: "button" }, "Save draft");
  save.onclick = () => act(save, () => api("PUT", `/api/portal/projects/${projectId}/items/${item.id}`, { value: values() }), "Saved");
  const submit = h("button.btn.small", { type: "button" }, item.status === "needs_changes" ? "Resubmit for review" : "Submit for review");
  submit.onclick = async () => {
    if (await act(submit, () => api("PUT", `/api/portal/projects/${projectId}/items/${item.id}`, { value: values(), submit: true }), "Submitted for review")) reload();
  };
  const exc = h("button.btn.ghost.small", { type: "button" }, "This isn't available…");
  exc.onclick = () => {
    const reason = h("textarea", { rows: 3, required: true });
    const send = h("button.btn.small", { type: "button" }, "Request exception");
    send.onclick = async () => {
      if (await act(send, () => api("POST", `/api/portal/projects/${projectId}/items/${item.id}/exception`, { reason: reason.value }), "Exception requested")) reload();
    };
    exc.replaceWith(h("div.form", { style: { width: "100%" } }, field("Why isn't it available? I'll decide whether we can go ahead without it.", reason), h("div.actions", send)));
  };
  const notes = [
    item.status === "needs_changes" && item.admin_note ? h("p.note.bad", `Changes needed: ${item.admin_note}`) : null,
    item.status === "exception_approved" ? h("p.note.ok", `Exception approved${item.admin_note ? `: ${item.admin_note}` : ""}`) : null,
    item.status === "approved" && item.admin_note ? h("p.note.ok", item.admin_note) : null,
    item.exception_requested && !locked && item.status !== "needs_changes" ? h("p.note.wait", `Exception requested: “${item.exception_reason}”. Waiting for the studio.`) : null,
    item.status === "submitted" ? h("p.note", "Submitted. Waiting for review. You can still edit and resubmit.") : null,
  ];
  const open = ["not_started", "needs_changes"].includes(item.status) && !item.exception_requested;
  return h(
    `details.item.${item.status}`,
    { open: open && item.required ? true : null },
    h("summary", h("span.dot", locked ? CHECK() : null), h("span.t", item.label, item.required ? null : h("span.opt", " · optional")), itemChip(item)),
    h("div.item-body", item.help ? h("p.muted", { style: { margin: 0 } }, item.help) : null, notes, fields, item.allow_files ? [fileList, drop] : null, locked ? null : h("div.actions", submit, save, item.required && !item.exception_requested ? exc : null))
  );
}

function fileRow(f, removable) {
  const row = h(
    "div.file",
    h("a", { href: `/api/portal/files/${f.id}`, target: "_blank" }, f.name),
    h("span.small.muted", kb(f.size)),
    removable
      ? h("button.x", {
          type: "button",
          "aria-label": `Remove ${f.name}`,
          onclick: async () => {
            if (!confirm(`Remove ${f.name}?`)) return;
            if (await act(null, () => api("DELETE", `/api/portal/files/${f.id}`), "Removed")) row.remove();
          },
        }, "×")
      : null
  );
  return row;
}

// ───────── Previews ─────────
function previews(d, id) {
  const open = d.reviews.find((r) => r.status === "open");
  const past = d.reviews.filter((r) => r.status !== "open");
  const out = [];
  if (open) {
    const response = h("textarea", { rows: 6 });
    const name = h("input", { type: "text", autocomplete: "name" });
    const confirmBox = h("input", { type: "checkbox" });
    const approve = h("button.btn.accent", { type: "button" }, open.kind === "final" ? "Approve the final website" : "Approve this preview");
    const changes = h("button.btn.ghost", { type: "button" }, "Request these changes");
    approve.onclick = async () => {
      if (open.kind === "final" && (!confirmBox.checked || !name.value.trim())) return toast("Type your name and tick the box to sign off.", true);
      if (await act(approve, () => api("POST", `/api/portal/projects/${id}/review`, { decision: "approve", response: response.value, name: name.value, confirm: confirmBox.checked }), "Approved. Thank you!")) reload();
    };
    changes.onclick = async () => {
      if (!response.value.trim()) return toast("List the changes you'd like first.", true);
      const out = await act(changes, () => api("POST", `/api/portal/projects/${id}/review`, { decision: "changes", response: response.value, name: name.value }), "Changes sent");
      if (out?.extra) toast("That's beyond the included revision rounds; I'll confirm any cost before starting.");
      if (out) reload();
    };
    const p = d.project;
    out.push(
      h(
        "div.panel",
        h("div.panel-head", h("h2", open.title), chip(open.kind === "final" ? "Final approval" : "Preview", "accent")),
        open.note ? h("p", open.note) : null,
        open.url ? h("p", h("a.btn", { href: open.url, target: "_blank", rel: "noopener" }, "Open the preview ↗")) : null,
        h("p.muted.small", `Revision rounds used: ${p.revisions_used} of ${p.revision_rounds}. Please send all changes in one list. Your reply window is ${p.feedback_days} business days; after that, the delivery date moves with each business day of waiting.`),
        h("div.form", field("Your changes or comments", response, "One list, as specific as you can (page, section, what to change)."), field(open.kind === "final" ? "Your full name (signature)" : "Your name (optional)", name), open.kind === "final" ? h("label.check", confirmBox, h("span", "I approve the final website as complete and ready to launch, under the project agreement.")) : null, h("div.actions", approve, changes))
      )
    );
  } else out.push(h("div.empty", "Nothing to review right now. You'll get an email when a preview is ready."));
  if (d.project.preview_url && !open) out.push(h("p", h("a", { href: d.project.preview_url, target: "_blank", rel: "noopener" }, "Latest preview ↗")));
  if (past.length)
    out.push(h("div.panel", h("h3", "History"), h("ul.list", past.map((r) => h("li", h("div", h("b", r.title), r.response ? h("div.small.muted", { style: { whiteSpace: "pre-wrap" } }, r.response) : null), chip(r.status === "approved" ? "Approved" : "Changes requested", r.status === "approved" ? "ok" : "wait"))))));
  return out;
}

// ───────── Messages ─────────
function messages(d, id) {
  const thread = h("div.thread", d.messages.length ? d.messages.map((m) => h(`div.msg.${m.sender}`, m.body, h("time", fmtTime(m.created_at)))) : h("div.empty", "No messages yet. Ask anything here."));
  const body = h("textarea", { rows: 3, placeholder: "Write a message…" });
  const send = h("button.btn.small", { type: "submit" }, "Send");
  setTimeout(() => (thread.scrollTop = thread.scrollHeight));
  return h(
    "div.panel",
    thread,
    h(
      "form.form",
      {
        style: { marginTop: "14px" },
        onsubmit: async (e) => {
          e.preventDefault();
          if (await act(send, () => api("POST", `/api/portal/projects/${id}/messages`, { body: body.value }), "Sent")) reload();
        },
      },
      field("Message", body),
      h("div.actions", send)
    )
  );
}

// ───────── Files ─────────
function files(d, id) {
  const groups = [
    ["From you", d.files.filter((f) => f.uploaded_by === "client")],
    ["From the studio", d.files.filter((f) => f.uploaded_by === "studio")],
  ];
  const picker = h("input", { type: "file", multiple: true });
  const drop = h("label.drop", picker, "Upload other files (up to 25 MB each)");
  picker.onchange = async () => {
    for (const f of picker.files) await act(null, () => upload(`/api/portal/projects/${id}/files`, f), `Uploaded ${f.name}`);
    reload();
  };
  return [
    d.project.status === "quote" ? null : h("div.panel", drop),
    groups.map(([title, list]) => h("div.panel", h("h3", title), list.length ? h("div.files", list.map((f) => fileRow(f, false))) : h("p.muted", "None yet."))),
  ];
}

// ───────── Billing ─────────
function billing(d, id) {
  const out = [];
  out.push(
    h(
      "div.panel",
      h("h2", "Invoices"),
      d.invoices.length || d.upcoming.length
        ? h(
            "div.table-wrap",
            h(
              "table.t",
              h("thead", h("tr", h("th", "Invoice"), h("th", "For"), h("th", "Amount"), h("th", "Status"), h("th", ""))),
              h(
                "tbody",
                d.invoices.map((i) =>
                  h(
                    "tr",
                    h("td.mono", i.number),
                    h("td", i.label),
                    h("td.mono", money(i.amount_cents)),
                    h("td", i.status === "paid" ? chip(`Paid ${fmtDate(i.paid_at)}`, "ok") : chip(i.due_date ? `Due ${fmtDate(i.due_date)}` : "Due", "wait")),
                    h("td", i.status === "open" && d.payOnline && !(d.project.status === "quote" && d.agreements.some((a) => a.status === "pending" && !a.subscription_id)) ? payButton(i) : null)
                  )
                ),
                d.upcoming.map((i) => h("tr", h("td.muted", "—"), h("td", i.label), h("td.mono", money(i.amount_cents)), h("td", chip(i.due_trigger === "launch" ? "Due at launch" : "Upcoming")), h("td")))
              )
            )
          )
        : h("p.muted", "No invoices yet."),
      h("p.small.muted", "Payments are processed by Stripe. Card details never touch this site.")
    )
  );
  if (d.payments.length) out.push(h("div.panel", h("h3", "Payment history"), h("ul.list", d.payments.map((p) => h("li", h("span", fmtDate(p.paid_at)), h("b.mono", money(p.amount_cents)))))));
  for (const s of d.subscriptions) {
    const a = d.agreements.find((x) => x.subscription_id === s.id);
    const sub = h("button.btn.accent.small", { type: "button" }, `Subscribe · ${money(s.monthly_cents)}/month`);
    sub.onclick = async () => {
      const r = await act(sub, () => api("POST", `/api/portal/subscriptions/${s.id}/checkout`));
      if (r?.url) location.href = r.url;
    };
    out.push(
      h(
        "div.panel",
        h("div.panel-head", h("h3", s.name), chip(s.status === "offered" ? "Offered" : s.status === "active" ? "Active" : s.status.replace("_", " "), s.status === "active" ? "ok" : s.status === "offered" ? "info" : "wait")),
        h("p", `${money(s.monthly_cents)} per month · ${s.term_months ? `${s.term_months}-month minimum` : "month to month"}${s.commitment_ends ? ` · minimum term ends ${fmtDate(s.commitment_ends)}` : ""}`),
        s.status === "offered" && a ? [agreementBox(a, d.consentText, reload), a.status === "accepted" ? (d.payOnline ? sub : h("p.note.wait", "Online payment isn't switched on yet.")) : null] : null
      )
    );
  }
  return out;
}

// ───────── Agreements ─────────
function agreements(d) {
  if (!d.agreements.length) return h("div.empty", "No agreements yet.");
  return d.agreements.map((a) => h("div.panel", h("div.panel-head", h("h3", a.title), chip(a.status === "accepted" ? "Accepted" : "Waiting for you", a.status === "accepted" ? "ok" : "accent")), agreementBox(a, d.consentText, reload)));
}
