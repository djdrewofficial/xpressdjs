/* Multi-step "Check Availability" lead form. Page provides window.__leadCfg:
   { consentText, turnstileKey, i18n: { sending, antispam, error, network } }

   Capture model (no manual "submit" button — only Back / Next):
   - The instant a visitor clears step 1 (contact + SMS consent) we POST an
     INCOMPLETE lead to /api/lead so GoHighLevel has it immediately. The 5-min
     "did they finish?" wait lives in GHL, not here, because a browser timer
     dies the moment they close the tab.
   - Advancing through later steps sends richer incomplete snapshots.
   - Hiding/closing the tab flushes the latest snapshot (sendBeacon) so any
     half-typed step still reaches GHL.
   - A best-effort 5-min idle timer also flushes the latest snapshot while the
     tab is still open.
   - The final "Next" on the last step sends the COMPLETE record + thank-you. */
(function () {
  var cfg = window.__leadCfg || {};
  var t = cfg.i18n || {};
  var form = document.getElementById("lead-form");
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };

  var steps = [].slice.call(form.querySelectorAll(".form-step"));
  var dots = [].slice.call(document.querySelectorAll(".stepper .step-dot"));
  var backBtn = form.querySelector('[data-nav="back"]');
  var nextBtn = form.querySelector('[data-nav="next"]');
  var lastIndex = steps.length - 1;
  var current = 0;

  function show(i) {
    current = i;
    steps.forEach(function (s, idx) { s.hidden = idx !== i; });
    dots.forEach(function (d, idx) {
      d.classList.toggle("active", idx === i);
      d.classList.toggle("done", idx < i);
    });
    if (backBtn) backBtn.hidden = i === 0;
    var f = steps[i].querySelector("input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])");
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
  }

  function validStep(i) {
    var fields = steps[i].querySelectorAll("input, select, textarea");
    for (var k = 0; k < fields.length; k++) {
      if (fields[k].disabled) continue;
      if (!fields[k].checkValidity()) { fields[k].reportValidity(); return false; }
    }
    return true;
  }

  // Conditional fields + partner prefill (in step 2)
  var eventType = $("eventType"), grpOther = $("grp-other"), grpRelation = $("grp-relation"),
      grpPartners = $("grp-partners"), otherSelect = $("eventTypeOther");
  var relationRadios = form.querySelectorAll('input[name="relation"]');
  var partnerInputs = ["partner1First", "partner1Last", "partner2First", "partner2Last"].map($);

  function setGroup(group, fields, on) {
    if (group) group.hidden = !on;
    fields.forEach(function (el) {
      if (!el) return;
      el.disabled = !on;
      if (on) el.setAttribute("required", "required");
      else { el.removeAttribute("required"); if (el.type !== "radio") el.value = ""; el.checked = false; }
    });
  }
  function syncEventType() {
    var v = eventType.value;
    setGroup(grpOther, [otherSelect], v === "Other");
    var w = v === "Wedding";
    if (grpRelation) grpRelation.hidden = !w;
    relationRadios.forEach(function (r) {
      r.disabled = !w;
      if (w) r.setAttribute("required", "required");
      else { r.removeAttribute("required"); r.checked = false; }
    });
    if (!w) setGroup(grpPartners, partnerInputs, false); else syncRelation();
  }
  function syncRelation() {
    var chosen = "";
    relationRadios.forEach(function (r) { if (r.checked) chosen = r.value; });
    setGroup(grpPartners, partnerInputs, !!chosen);
    // When the person filling this out is the bride/groom, prefill Partner 1
    // (Partner A) with the name they gave in step 1.
    if (chosen && /bride|groom|novia|novio/i.test(chosen)) {
      var fn = ($("firstName").value || "").trim(), ln = ($("lastName").value || "").trim();
      if (fn && !partnerInputs[0].value) partnerInputs[0].value = fn;
      if (ln && !partnerInputs[1].value) partnerInputs[1].value = ln;
    }
  }
  if (eventType) eventType.addEventListener("change", syncEventType);
  relationRadios.forEach(function (r) { r.addEventListener("change", syncRelation); });

  // ---- Payload --------------------------------------------------------------
  function buildPayload(stage, complete) {
    var tsToken = "";
    if (complete && cfg.turnstileKey) {
      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      tsToken = tsEl ? tsEl.value : "";
    }
    var val = function (id) { var el = $(id); return el ? el.value : ""; };
    return {
      firstName: val("firstName").trim(),
      lastName: val("lastName").trim(),
      phone: val("phone").trim(),
      email: val("email").trim(),
      commLanguage: (form.querySelector('input[name="commLanguage"]:checked') || {}).value || "",
      eventType: eventType ? eventType.value : "",
      eventTypeOther: (otherSelect && !otherSelect.disabled) ? otherSelect.value : "",
      eventDate: val("eventDate"),
      guests: val("guests"),
      startTime: val("startTime").trim(),
      endTime: val("endTime").trim(),
      venueName: val("venueName").trim(),
      venueCity: val("venueCity").trim(),
      relation: (form.querySelector('input[name="relation"]:checked') || {}).value || "",
      partner1First: partnerInputs[0] ? partnerInputs[0].value.trim() : "",
      partner1Last: partnerInputs[1] ? partnerInputs[1].value.trim() : "",
      partner2First: partnerInputs[2] ? partnerInputs[2].value.trim() : "",
      partner2Last: partnerInputs[3] ? partnerInputs[3].value.trim() : "",
      notes: val("notes").trim(),
      smsConsent: $("smsConsent") ? $("smsConsent").checked : false,
      consentText: cfg.consentText,
      stage: stage,
      complete: !!complete,
      turnstileToken: tsToken,
    };
  }

  // ---- Progressive / abandonment capture ------------------------------------
  // A lead is only worth sending once we have the minimum GHL requires.
  function mvlReady() {
    return !!($("firstName") && $("firstName").value.trim() &&
              $("phone") && $("phone").value.trim() &&
              $("email") && $("email").value.trim() &&
              $("smsConsent") && $("smsConsent").checked);
  }

  var dirty = false;        // unsent field changes exist
  var sentComplete = false; // final record already sent
  var idleTimer = null;
  var IDLE_MS = 5 * 60 * 1000;

  function flushIncomplete(useBeacon) {
    if (sentComplete || !mvlReady() || !dirty) return;
    if ($("company") && $("company").value) return; // honeypot tripped
    dirty = false;
    var body = JSON.stringify(buildPayload("step-" + (current + 1), false));
    if (useBeacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon("/api/lead", new Blob([body], { type: "application/json" }))) return;
      } catch (e) {}
    }
    try {
      fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { flushIncomplete(false); }, IDLE_MS);
  }

  form.addEventListener("input", function () { dirty = true; resetIdle(); });
  form.addEventListener("change", function () { dirty = true; resetIdle(); });

  // Flush the latest snapshot when the visitor leaves / backgrounds the tab.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushIncomplete(true);
  });
  window.addEventListener("pagehide", function () { flushIncomplete(true); });

  // ---- Final (complete) submission ------------------------------------------
  function submitComplete() {
    var errEl = $("form-error"); if (errEl) errEl.hidden = true;
    if ($("company") && $("company").value) return; // honeypot tripped
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (cfg.turnstileKey) {
      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      if (!tsEl || !tsEl.value) { errEl.textContent = t.antispam; errEl.hidden = false; return; }
    }

    var label = nextBtn.querySelector(".btn-label"); var orig = label ? label.textContent : "";
    nextBtn.disabled = true; if (label) label.textContent = t.sending;
    if (idleTimer) clearTimeout(idleTimer);

    fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload("complete", true)) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) {
          sentComplete = true; dirty = false;
          form.hidden = true;
          $("form-success").hidden = false;
          $("form-success").scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          errEl.textContent = (res.j && res.j.error) || t.error;
          errEl.hidden = false;
          nextBtn.disabled = false; if (label) label.textContent = orig;
          if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
        }
      })
      .catch(function () {
        errEl.textContent = t.network;
        errEl.hidden = false;
        nextBtn.disabled = false; if (label) label.textContent = orig;
        if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
      });
  }

  // ---- Navigation (handles click + Enter via form submit) -------------------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!validStep(current)) return;
    if (current < lastIndex) {
      // First valid step-1 advance is the critical immediate capture for GHL.
      flushIncomplete(false);
      show(current + 1);
    } else {
      submitComplete();
    }
  });
  if (backBtn) backBtn.addEventListener("click", function () { if (current > 0) show(current - 1); });

  show(0);
})();
