// Quote request form: pre-selects ?package=, runs Turnstile, sends JSON, shows clear errors.
(() => {
  const form = document.getElementById("quote-form");
  if (!form) return;
  const started = Date.now();
  const msg = form.querySelector(".form-msg");
  const submit = form.querySelector('button[type="submit"]');
  const pkg = new URLSearchParams(location.search).get("package");
  const radio = pkg && form.querySelector(`input[name="package"][value="${CSS.escape(pkg)}"]`);
  if (radio) radio.checked = true;

  let token = "";
  const siteKey = form.dataset.sitekey;
  const mountTurnstile = () => {
    if (!siteKey || !window.turnstile || typeof window.turnstile.render !== "function") return false;
    window.turnstile.render("#turnstile", { sitekey: siteKey, action: "quote", callback: (t) => (token = t), "expired-callback": () => (token = "") });
    return true;
  };
  if (siteKey) {
    const wait = setInterval(() => mountTurnstile() && clearInterval(wait), 300);
    setTimeout(() => clearInterval(wait), 15000);
  }

  const show = (text, ok) => {
    msg.hidden = false;
    msg.className = `form-msg ${ok ? "ok" : "err"}`;
    msg.textContent = text;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    const name = form.elements.name;
    const email = form.elements.email;
    if (!name.value.trim()) {
      name.setAttribute("aria-invalid", "true");
      name.focus();
      return show("Please tell me your name.", false);
    }
    if (!email.validity.valid || !email.value.trim()) {
      email.setAttribute("aria-invalid", "true");
      email.focus();
      return show("Please enter a valid email address.", false);
    }
    const data = {
      name: name.value,
      email: email.value,
      phone: form.elements.phone.value,
      business: form.elements.business.value,
      website: form.elements.website.value,
      location: form.elements.location.value,
      package: (form.querySelector('input[name="package"]:checked') || {}).value || "",
      addons: [...form.querySelectorAll('input[name="addons"]:checked')].map((c) => Number(c.value)),
      timeline: form.elements.timeline.value,
      care_plan: form.elements.care_plan.value,
      message: form.elements.message.value,
      company_website: form.elements.company_website.value,
      started,
      turnstile: token,
      source: document.referrer ? new URL(document.referrer).host : "",
    };
    submit.classList.add("is-busy");
    try {
      const r = await fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || "Something went wrong. Please try again.");
      form.querySelectorAll("input, textarea, select, button").forEach((el) => (el.disabled = true));
      show("Thank you! Your request is in. I'll reply within one business day; a confirmation email is on its way.", true);
      msg.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (err) {
      show(err.message, false);
      if (window.turnstile && siteKey) window.turnstile.reset("#turnstile");
      token = "";
    } finally {
      submit.classList.remove("is-busy");
    }
  });
})();
