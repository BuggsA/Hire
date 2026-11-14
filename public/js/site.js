// Public site: mobile menu, header shadow, reveal-on-scroll and the animated week board.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const btn = document.querySelector(".menu-btn");
  const nav = document.getElementById("nav");
  if (btn && nav) {
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (e) => {
      if (e.target.closest("a")) nav.classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        nav.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
        btn.focus();
      }
    });
  }

  const header = document.querySelector(".site-header");
  const onScroll = () => header && header.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Reveal on scroll (content is visible without JavaScript or with reduced motion)
  const items = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) items.forEach((el) => el.classList.add("in"));
  else {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))),
      { rootMargin: "0px 0px -8% 0px" }
    );
    items.forEach((el, i) => {
      if (!el.className.match(/\bd\d\b/)) el.classList.add(`d${i % 3}`);
      io.observe(el);
    });
  }

  // The week board fills day by day, once, when it comes into view
  document.querySelectorAll("[data-week]").forEach((board) => {
    const days = [...board.querySelectorAll(".day")];
    const meter = board.querySelector("[data-week-meter]");
    const label = board.querySelector("[data-week-label]");
    const set = (n) => {
      days.forEach((d, i) => {
        d.classList.toggle("done", i < n);
        d.classList.toggle("now", i === n && n < days.length);
      });
      if (meter) meter.style.width = `${(n / days.length) * 100}%`;
      if (label) label.textContent = n >= days.length ? "Launched on day 5" : `Day ${n + 1} of 5`;
    };
    if (reduce) return set(days.length);
    set(0);
    const go = () => {
      let n = 0;
      const tick = () => {
        n++;
        set(n);
        if (n < days.length) setTimeout(tick, 700);
      };
      setTimeout(tick, 500);
    };
    if (!("IntersectionObserver" in window)) return go();
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        go();
      }
    }, { threshold: 0.4 });
    io.observe(board);
  });
})();
