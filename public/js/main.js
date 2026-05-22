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
    var isMobileNav = function () { return window.matchMedia("(max-width: 940px)").matches; };
    function closeMenu() {
      burger.classList.remove("open");
      links.classList.remove("open");
      if (nav) nav.classList.remove("menu-open");
      document.body.style.overflow = "";
      links.querySelectorAll(".nav-item.open").forEach(function (i) { i.classList.remove("open"); });
    }
    burger.addEventListener("click", function () {
      var willOpen = !links.classList.contains("open");
      burger.classList.toggle("open", willOpen);
      links.classList.toggle("open", willOpen);
      if (nav) nav.classList.toggle("menu-open", willOpen);
      document.body.style.overflow = willOpen ? "hidden" : "";
      if (!willOpen) links.querySelectorAll(".nav-item.open").forEach(function (i) { i.classList.remove("open"); });
    });
    /* On mobile, a group toggle (DJs / Services / Epic Extras) expands its
       submenu instead of navigating away, and keeps the menu open. */
    links.querySelectorAll(".dd-toggle").forEach(function (t) {
      t.addEventListener("click", function (e) {
        if (!isMobileNav()) return;
        e.preventDefault();
        var item = t.closest(".nav-item");
        if (item) item.classList.toggle("open");
      });
    });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        if (a.classList.contains("dd-toggle") && isMobileNav()) return;
        closeMenu();
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

  /* ---- Sample gallery lightbox (one photo at a time, arrows/swipe) ---- */
  var galleryCards = document.querySelectorAll(".gallery-card");
  if (galleryCards.length) {
    var gModal = null, gImg = null, gTitleEl = null, gPrev = null, gNext = null, gLast = null;
    var gItems = [], gIndex = 0;
    function buildGModal() {
      gModal = document.createElement("div");
      gModal.className = "gallery-modal";
      gModal.setAttribute("role", "dialog");
      gModal.setAttribute("aria-modal", "true");
      gModal.innerHTML =
        '<div class="gallery-modal-backdrop"></div>' +
        '<div class="gallery-modal-inner">' +
        '<button class="gallery-modal-close" type="button" aria-label="Close gallery">&times;</button>' +
        '<h3 class="gallery-modal-title"></h3>' +
        '<div class="gallery-stage">' +
        '<button class="gallery-nav gallery-prev" type="button" aria-label="Previous photo">‹</button>' +
        '<div class="gallery-viewport"><img class="gallery-current" alt="" /></div>' +
        '<button class="gallery-nav gallery-next" type="button" aria-label="Next photo">›</button>' +
        '</div>' +
        "</div>";
      document.body.appendChild(gModal);
      gImg = gModal.querySelector(".gallery-current");
      gTitleEl = gModal.querySelector(".gallery-modal-title");
      gPrev = gModal.querySelector(".gallery-prev");
      gNext = gModal.querySelector(".gallery-next");
      gModal.querySelector(".gallery-modal-backdrop").addEventListener("click", closeGModal);
      gModal.querySelector(".gallery-modal-close").addEventListener("click", closeGModal);
      gPrev.addEventListener("click", function (e) { e.stopPropagation(); step(-1); });
      gNext.addEventListener("click", function (e) { e.stopPropagation(); step(1); });
      var vp = gModal.querySelector(".gallery-viewport");
      var sx = 0, sy = 0;
      vp.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
      vp.addEventListener("touchend", function (e) {
        var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    function render() {
      if (!gItems.length) return;
      var it = gItems[gIndex];
      gImg.src = it.src; gImg.alt = it.alt || "";
      var multi = gItems.length > 1;
      gPrev.style.display = multi ? "" : "none";
      gNext.style.display = multi ? "" : "none";
    }
    function step(dir) {
      if (!gItems.length) return;
      gIndex = (gIndex + dir + gItems.length) % gItems.length;
      render();
    }
    function openGModal(id, title) {
      var source = document.getElementById("gsrc-" + id);
      if (!source) return;
      if (!gModal) buildGModal();
      gLast = document.activeElement;
      gTitleEl.textContent = title || "Sample Gallery";
      gItems = Array.prototype.map.call(source.querySelectorAll("img"), function (im) {
        return { src: im.getAttribute("src"), alt: im.getAttribute("alt") };
      });
      gIndex = 0;
      render();
      gModal.classList.add("open");
      document.body.style.overflow = "hidden";
      gModal.querySelector(".gallery-modal-close").focus();
    }
    function closeGModal() {
      if (!gModal) return;
      gModal.classList.remove("open");
      if (gImg) gImg.src = "";
      document.body.style.overflow = "";
      if (gLast && gLast.focus) gLast.focus();
    }
    galleryCards.forEach(function (c) {
      c.addEventListener("click", function () {
        openGModal(c.getAttribute("data-gallery"), c.getAttribute("data-title"));
      });
    });
    document.addEventListener("keydown", function (e) {
      if (!gModal || !gModal.classList.contains("open")) return;
      if (e.key === "Escape") closeGModal();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
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
