/* XPRESS ENTERTAINMENT — interactions */
(function () {
  "use strict";

  /* ---- Year ---- */
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

  /* ---- Sticky nav state ---- */
  var nav = document.querySelector(".nav");
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle("scrolled", window.scrollY > 40);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- Mobile menu ---- */
  var burger = document.querySelector(".burger");
  var links = document.querySelector(".nav-links");
  if (burger && links) {
    burger.addEventListener("click", function () {
      burger.classList.toggle("open");
      links.classList.toggle("open");
      document.body.style.overflow = links.classList.contains("open") ? "hidden" : "";
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        burger.classList.remove("open");
        links.classList.remove("open");
        document.body.style.overflow = "";
      });
    });
  }

  /* ---- Scroll reveal ---- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (r) { io.observe(r); });
  } else {
    reveals.forEach(function (r) { r.classList.add("in"); });
  }

  /* ---- Animated counters ---- */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var suffix = el.getAttribute("data-suffix") || "";
    var dur = 1600, start = null;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.floor(eased * target);
      el.textContent = val.toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target.toLocaleString() + suffix;
    }
    requestAnimationFrame(tick);
  }
  var counters = document.querySelectorAll("[data-count]");
  if ("IntersectionObserver" in window && counters.length) {
    var cio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { animateCount(e.target); cio.unobserve(e.target); }
      });
    }, { threshold: 0.6 });
    counters.forEach(function (c) { cio.observe(c); });
  }

  /* ---- Custom cursor ---- */
  var fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (fine) {
    var cur = document.createElement("div");
    cur.className = "cursor";
    document.body.appendChild(cur);
    var x = 0, y = 0, cx = 0, cy = 0;
    document.addEventListener("mousemove", function (e) { x = e.clientX; y = e.clientY; });
    (function loop() {
      cx += (x - cx) * 0.18; cy += (y - cy) * 0.18;
      cur.style.transform = "translate(" + cx + "px," + cy + "px) translate(-50%,-50%)";
      requestAnimationFrame(loop);
    })();
    document.querySelectorAll("a, button, .card, .value, .info-card").forEach(function (el) {
      el.addEventListener("mouseenter", function () { cur.classList.add("grow"); });
      el.addEventListener("mouseleave", function () { cur.classList.remove("grow"); });
    });
  }

  /* ---- Video lightbox (click-to-play facade) ---- */
  var facades = document.querySelectorAll(".video-facade");
  if (facades.length) {
    /* Swap to hqdefault if a YouTube maxres poster is missing (404) */
    document.querySelectorAll(".video-facade img[data-fallback]").forEach(function (img) {
      var fb = img.getAttribute("data-fallback");
      if (!fb) return;
      function useFallback() { if (img.src !== fb) img.src = fb; }
      img.addEventListener("error", useFallback);
      if (img.complete && img.naturalWidth === 0) useFallback();
    });
    var vModal = null, vFrame = null, lastFocus = null;
    function buildVModal() {
      vModal = document.createElement("div");
      vModal.className = "video-modal";
      vModal.setAttribute("role", "dialog");
      vModal.setAttribute("aria-modal", "true");
      vModal.innerHTML =
        '<div class="video-modal-backdrop"></div>' +
        '<div class="video-modal-inner">' +
        '<button class="video-modal-close" type="button" aria-label="Close video">&times;</button>' +
        '<div class="video-modal-frame"></div>' +
        "</div>";
      document.body.appendChild(vModal);
      vFrame = vModal.querySelector(".video-modal-frame");
      vModal.querySelector(".video-modal-backdrop").addEventListener("click", closeVModal);
      vModal.querySelector(".video-modal-close").addEventListener("click", closeVModal);
    }
    function openVModal(src) {
      if (!src) return;
      if (!vModal) buildVModal();
      lastFocus = document.activeElement;
      var iframe = document.createElement("iframe");
      iframe.setAttribute("src", src);
      iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture; encrypted-media");
      iframe.setAttribute("allowfullscreen", "");
      iframe.setAttribute("title", "Video player");
      vFrame.appendChild(iframe);
      vModal.classList.add("open");
      document.body.style.overflow = "hidden";
      vModal.querySelector(".video-modal-close").focus();
    }
    function closeVModal() {
      if (!vModal) return;
      vModal.classList.remove("open");
      vFrame.innerHTML = "";
      document.body.style.overflow = "";
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    facades.forEach(function (f) {
      f.addEventListener("click", function () {
        openVModal(f.getAttribute("data-video-src"));
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && vModal && vModal.classList.contains("open")) closeVModal();
    });
  }

  /* ---- Contact form (demo handler) ---- */
  var form = document.querySelector("#availability-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector("button[type=submit] span");
      var orig = btn ? btn.textContent : "";
      if (btn) btn.textContent = "Sent! We'll be in touch ✦";
      form.reset();
      setTimeout(function () { if (btn) btn.textContent = orig; }, 4000);
    });
  }
})();
