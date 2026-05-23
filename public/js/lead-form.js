/* Multi-step "Check Availability" lead form. Page provides window.__leadCfg:
   { consentText, turnstileKey, i18n: { sending, antispam, error, network } } */
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
  var submitBtn = form.querySelector('[data-nav="submit"]');
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
    if (submitBtn) submitBtn.hidden = i !== steps.length - 1;
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

  if (nextBtn) nextBtn.addEventListener("click", function () { if (validStep(current)) show(current + 1); });
  if (backBtn) backBtn.addEventListener("click", function () { if (current > 0) show(current - 1); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!validStep(current)) return;
    var errEl = $("form-error"); if (errEl) errEl.hidden = true;
    if ($("company") && $("company").value) return; // honeypot tripped
    if (!form.checkValidity()) { form.reportValidity(); return; }

    var tsToken = "";
    if (cfg.turnstileKey) {
      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      tsToken = tsEl ? tsEl.value : "";
      if (!tsToken) { errEl.textContent = t.antispam; errEl.hidden = false; return; }
    }

    var label = submitBtn.querySelector(".btn-label"); var orig = label.textContent;
    submitBtn.disabled = true; label.textContent = t.sending;

    var payload = {
      firstName: $("firstName").value.trim(),
      lastName: $("lastName").value.trim(),
      phone: $("phone").value.trim(),
      email: $("email").value.trim(),
      commLanguage: (form.querySelector('input[name="commLanguage"]:checked') || {}).value || "",
      eventType: eventType.value,
      eventTypeOther: otherSelect.disabled ? "" : otherSelect.value,
      eventDate: $("eventDate").value,
      guests: $("guests").value,
      startTime: $("startTime").value.trim(),
      endTime: $("endTime").value.trim(),
      venueName: $("venueName").value.trim(),
      venueCity: $("venueCity").value.trim(),
      relation: (form.querySelector('input[name="relation"]:checked') || {}).value || "",
      partner1First: partnerInputs[0].value.trim(),
      partner1Last: partnerInputs[1].value.trim(),
      partner2First: partnerInputs[2].value.trim(),
      partner2Last: partnerInputs[3].value.trim(),
      notes: $("notes").value.trim(),
      smsConsent: $("smsConsent").checked,
      consentText: cfg.consentText,
      turnstileToken: tsToken,
    };

    fetch("/api/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          $("form-success").hidden = false;
          $("form-success").scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          errEl.textContent = (res.j && res.j.error) || t.error;
          errEl.hidden = false;
          submitBtn.disabled = false; label.textContent = orig;
          if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
        }
      })
      .catch(function () {
        errEl.textContent = t.network;
        errEl.hidden = false;
        submitBtn.disabled = false; label.textContent = orig;
        if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
      });
  });

  show(0);
})();
