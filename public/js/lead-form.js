/* Multi-step "Check Availability" lead form. Page provides window.__leadCfg:
   { consentText, turnstileKey, i18n: { sending, antispam, error, network } }

   Progressive capture: the moment a client clears step 1 (contact + SMS
   consent) we POST a partial lead to /api/lead so GoHighLevel has it even if
   they bail before finishing. Each later step sends an updated snapshot. There
   is no separate "send" button — finishing step 3 just sends the complete
   record and shows the thank-you. */
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
  var finishBtn = form.querySelector('[data-nav="finish"]');
  var current = 0;

  function show(i) {
    current = i;
    steps.forEach(function (s, idx) { s.hidden = idx !== i; });
    dots.forEach(function (d, idx) {
      d.classList.toggle("active", idx === i);
      d.classList.toggle("done", idx < i);
    });
    if (backBtn) backBtn.hidden = i === 0;
    if (nextBtn) nextBtn.hidden = i === steps.length - 1;
    if (finishBtn) finishBtn.hidden = i !== steps.length - 1;
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

  // ---- Payload + progressive send -------------------------------------------
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

  // Send each partial stage at most once. Fire-and-forget: never block the UI
  // and never surface partial errors — the final complete send carries all the
  // same data anyway, so a dropped partial just loses the early-capture safety
  // net for that one stage.
  var sentStage = {};
  function capturePartial(stage) {
    if (sentStage[stage]) return;
    if ($("company") && $("company").value) return; // honeypot tripped
    sentStage[stage] = true;
    try {
      fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(stage, false)),
        keepalive: true,
      }).catch(function () {});
    } catch (e) {}
  }

  if (nextBtn) nextBtn.addEventListener("click", function () {
    if (!validStep(current)) return;
    // current 0 => just finished step 1; 1 => just finished step 2
    capturePartial(current === 0 ? "step-1" : "step-2");
    show(current + 1);
  });
  if (backBtn) backBtn.addEventListener("click", function () { if (current > 0) show(current - 1); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!validStep(current)) return;
    var errEl = $("form-error"); if (errEl) errEl.hidden = true;
    if ($("company") && $("company").value) return; // honeypot tripped
    if (!form.checkValidity()) { form.reportValidity(); return; }

    if (cfg.turnstileKey) {
      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      if (!tsEl || !tsEl.value) { errEl.textContent = t.antispam; errEl.hidden = false; return; }
    }

    var label = finishBtn.querySelector(".btn-label"); var orig = label.textContent;
    finishBtn.disabled = true; label.textContent = t.sending;

    fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildPayload("complete", true)) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          $("form-success").hidden = false;
          $("form-success").scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          errEl.textContent = (res.j && res.j.error) || t.error;
          errEl.hidden = false;
          finishBtn.disabled = false; label.textContent = orig;
          if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
        }
      })
      .catch(function () {
        errEl.textContent = t.network;
        errEl.hidden = false;
        finishBtn.disabled = false; label.textContent = orig;
        if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
      });
  });

  show(0);
})();
