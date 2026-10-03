/* Three-step "Check Availability" inquiry → consultation calendar.
   Page provides window.__leadCfg:
     { locale, consentText, turnstileKey, bookingUrl, i18n: { next, submit, sending, summary, errors{}, codes{} } }

   Flow:
   - Back / Next move between steps; nothing is sent until the visitor submits
     the COMPLETE inquiry on step 3 (no partial / exit / idle captures).
   - Each inquiry carries a submission ID (kept in sessionStorage until it is
     saved) so a retry can never create a second inquiry — the server keeps
     the durable record of which IDs were already saved.
   - Answers are kept in sessionStorage while the visitor is working, so a
     failed submit or an accidental reload doesn't lose them. SMS consent is
     never restored — the box must be ticked by the visitor every time.
   - Only after the server confirms the contact is saved in HighLevel does the
     consultation calendar appear. Showing it books nothing: a booking exists
     only once HighLevel's own widget confirms it. */
(function () {
  var cfg = window.__leadCfg || {};
  var t = cfg.i18n || {};
  var E = t.errors || {};
  var C = t.codes || {};
  var form = document.getElementById("lead-form");
  if (!form) return;
  var $ = function (id) { return document.getElementById(id); };

  var steps = [].slice.call(form.querySelectorAll(".form-step"));
  var stepper = $("lead-stepper");
  var dots = [].slice.call(document.querySelectorAll(".stepper .step-dot"));
  var backBtn = form.querySelector('[data-nav="back"]');
  var nextBtn = form.querySelector('[data-nav="next"]');
  var nextLabel = nextBtn.querySelector(".btn-label");
  var errEl = $("form-error");
  var lastIndex = steps.length - 1;
  var current = 0;
  var inFlight = false;

  // ---- Session storage (best-effort; private mode may throw) ----------------
  var SID_KEY = "xe-lead-sid", DRAFT_KEY = "xe-lead-draft";
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [].map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  var submissionId = ssGet(SID_KEY);
  if (!submissionId) { submissionId = uuid(); ssSet(SID_KEY, submissionId); }

  // ---- Steps -----------------------------------------------------------------
  function show(i, opts) {
    current = i;
    steps.forEach(function (s, idx) { s.hidden = idx !== i; });
    dots.forEach(function (d, idx) {
      d.classList.toggle("active", idx === i);
      d.classList.toggle("done", idx < i);
    });
    if (backBtn) backBtn.hidden = i === 0;
    if (nextLabel) nextLabel.textContent = i === lastIndex ? (t.submit || "Submit") : (t.next || "Next");
    if (opts && opts.scroll && stepper) {
      // On phones the Next button sits far below the step's first field; bring
      // the top of the form back into view instead of leaving the visitor mid-page.
      var top = stepper.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight * 0.5) stepper.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (!opts || !opts.noFocus) {
      var f = steps[i].querySelector("input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])");
      if (f) { try { f.focus({ preventScroll: true }); } catch (e) {} }
    }
    saveDraft();
  }

  // ---- Field rules (mirror lib/lead/validate.js; the server re-checks) ------
  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function phoneOk(v) {
    var s = String(v || "").trim(), digits = s.replace(/\D/g, "");
    if (s.charAt(0) === "+" && s.indexOf("+1") !== 0) return digits.length >= 8 && digits.length <= 15;
    if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
    return digits.length === 10 && !/^[01]/.test(digits) && !/^[01]/.test(digits.slice(3));
  }
  function timeOk(v) {
    var s = String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
    var m = s.match(/^(\d{1,2})(?::([0-5]\d))? ?([ap])\.? ?m?\.?$/);
    if (m) return +m[1] >= 1 && +m[1] <= 12;
    m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    return !!m && (+m[1] > 12 || (m[1].length === 2 && m[1].charAt(0) === "0"));
  }
  var EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

  function wantsSms() {
    var m = form.querySelector('input[name="preferredMethod"]:checked');
    return !!m && m.value === "SMS";
  }

  /** Error code for one field, or "" when it's fine. */
  function fieldCode(el) {
    if (el.disabled) return "";
    var v = (el.value || "").trim();
    if (el.id === "smsConsent") return wantsSms() && !el.checked ? "consent_required_for_sms" : "";
    if (el.type === "radio") return el.required && !radioVal(el.name) ? "required" : "";
    if (el.required && !v) return "required";
    if (!v) return "";
    switch (el.id) {
      case "email": return EMAIL_RE.test(v) ? "" : "invalid_email";
      case "phone": return phoneOk(v) ? "" : "invalid_phone";
      case "eventDate":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "invalid_date";
        return v < todayLocal() ? "past_date" : (v > el.max ? "date_too_far" : "");
      case "guests": return /^\d+$/.test(v) && +v >= 1 && +v <= 5000 ? "" : "invalid_guests";
      case "startTime": case "endTime": return timeOk(v) ? "" : "invalid_time";
    }
    if (el.maxLength > 0 && v.length > el.maxLength) return "too_long";
    return "";
  }

  function flag(el, code) {
    el.setCustomValidity(code ? (E[code] || E.invalid || "Please check this field.") : "");
  }

  function validStep(i) {
    var fields = steps[i].querySelectorAll("input, select, textarea");
    for (var k = 0; k < fields.length; k++) {
      var el = fields[k];
      if (el.disabled || el.id === "company") continue;
      var code = fieldCode(el);
      flag(el, code);
      if (code) { el.reportValidity(); return false; }
    }
    return true;
  }

  // Clear a field's custom error as soon as the visitor edits it.
  function clearFlag(e) {
    var el = e.target;
    if (!el || !el.setCustomValidity) return;
    if (el.type === "radio") {
      form.querySelectorAll('input[name="' + el.name + '"]').forEach(function (r) { r.setCustomValidity(""); });
    } else el.setCustomValidity("");
    if (el.name === "preferredMethod" && $("smsConsent")) $("smsConsent").setCustomValidity("");
  }

  // ---- Conditional fields + partner prefill (step 2) ------------------------
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
    var chosen = radioVal("relation");
    setGroup(grpPartners, partnerInputs, !!chosen);
    // When the person filling this out is the bride/groom, prefill Partner 1
    // (Partner A) with the name they gave in step 1.
    if (chosen && /bride|groom/i.test(chosen)) {
      var fn = ($("firstName").value || "").trim(), ln = ($("lastName").value || "").trim();
      if (fn && !partnerInputs[0].value) partnerInputs[0].value = fn;
      if (ln && !partnerInputs[1].value) partnerInputs[1].value = ln;
    }
  }
  if (eventType) eventType.addEventListener("change", syncEventType);
  relationRadios.forEach(function (r) { r.addEventListener("change", syncRelation); });

  // Event date: today .. +5 years (server enforces the same in Eastern time).
  var dateEl = $("eventDate");
  if (dateEl) {
    var today = todayLocal();
    dateEl.min = today;
    dateEl.max = (+today.slice(0, 4) + 5) + today.slice(4);
  }

  // ---- Draft persistence -----------------------------------------------------
  var DRAFT_FIELDS = ["firstName", "lastName", "phone", "email", "eventType", "eventTypeOther", "eventDate",
    "guests", "startTime", "endTime", "partner1First", "partner1Last", "partner2First", "partner2Last",
    "venueName", "venueCity", "notes"];
  var DRAFT_RADIOS = ["commLanguage", "preferredMethod", "relation"];

  function radioVal(name) { return (form.querySelector('input[name="' + name + '"]:checked') || {}).value || ""; }
  function setRadio(name, v) {
    form.querySelectorAll('input[name="' + name + '"]').forEach(function (r) { r.checked = !!v && r.value === v; });
  }

  function saveDraft() {
    if (inFlight) return;
    var d = { step: current };
    DRAFT_FIELDS.forEach(function (id) { var el = $(id); if (el && el.value) d[id] = el.value; });
    DRAFT_RADIOS.forEach(function (n) { var v = radioVal(n); if (v) d[n] = v; });
    ssSet(DRAFT_KEY, JSON.stringify(d));
  }
  function restoreDraft() {
    var raw = ssGet(DRAFT_KEY); if (!raw) return 0;
    var d; try { d = JSON.parse(raw); } catch (e) { return 0; }
    var setVal = function (id) { var el = $(id); if (el && d[id] != null) el.value = d[id]; };
    ["firstName", "lastName", "phone", "email", "eventType"].forEach(setVal);
    setRadio("commLanguage", d.commLanguage); setRadio("preferredMethod", d.preferredMethod);
    if (eventType) syncEventType();
    setVal("eventTypeOther");
    setRadio("relation", d.relation);
    if (eventType && eventType.value === "Wedding") syncRelation();
    ["partner1First", "partner1Last", "partner2First", "partner2Last", "eventDate", "guests", "startTime",
     "endTime", "venueName", "venueCity", "notes"].forEach(setVal);
    // Resume on the saved step only if every step before it is still valid
    // (e.g. a visitor who wants texts must re-tick the consent box on step 1).
    var target = Math.min(+d.step || 0, lastIndex);
    for (var i = 0; i < target; i++) {
      var ok = [].every.call(steps[i].querySelectorAll("input, select, textarea"), function (el) {
        return el.disabled || el.id === "company" || !fieldCode(el);
      });
      if (!ok) return i;
    }
    return target;
  }

  // ---- Analytics -------------------------------------------------------------
  var started = false;
  function markStart() {
    if (started) return;
    started = true;
    try { if (window.track) window.track("form_start", { form: "check_availability" }); } catch (e) {}
  }

  form.addEventListener("input", function (e) { clearFlag(e); markStart(); saveDraft(); });
  form.addEventListener("change", function (e) { clearFlag(e); markStart(); saveDraft(); });

  // ---- Errors ----------------------------------------------------------------
  function showError(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
  function hideError() { errEl.hidden = true; errEl.textContent = ""; }

  function fieldEl(name) {
    return $(name) || form.querySelector('input[name="' + name + '"]:not([disabled])');
  }

  /** Server validation errors → jump to the first bad field and explain it. */
  function showFieldErrors(errors) {
    var first = null;
    errors.forEach(function (er) {
      var el = fieldEl(er.field);
      if (!el || el.disabled) return;
      flag(el, er.code);
      if (!first) first = { el: el, code: er.code };
    });
    if (!first) { showError(C.generic); return; }
    var stepIdx = steps.findIndex(function (s) { return s.contains(first.el); });
    if (stepIdx > -1 && stepIdx !== current) show(stepIdx, { scroll: true, noFocus: true });
    showError((t.summary ? t.summary + " " : "") + (E[first.code] || E.invalid));
    first.el.reportValidity();
  }

  // ---- Submit ----------------------------------------------------------------
  function buildPayload() {
    var tsEl = cfg.turnstileKey ? form.querySelector('[name="cf-turnstile-response"]') : null;
    var val = function (id) { var el = $(id); return el && !el.disabled ? el.value : ""; };
    var consent = !!($("smsConsent") && $("smsConsent").checked);
    return {
      submissionId: submissionId,
      locale: cfg.locale || "en",
      firstName: val("firstName").trim(),
      lastName: val("lastName").trim(),
      phone: val("phone").trim(),
      email: val("email").trim(),
      commLanguage: radioVal("commLanguage"),
      preferredMethod: radioVal("preferredMethod"),
      smsConsent: consent,
      consentText: consent ? cfg.consentText : "",
      eventType: eventType ? eventType.value : "",
      eventTypeOther: val("eventTypeOther"),
      eventDate: val("eventDate"),
      guests: val("guests"),
      startTime: val("startTime").trim(),
      endTime: val("endTime").trim(),
      relation: radioVal("relation"),
      partner1First: val("partner1First").trim(),
      partner1Last: val("partner1Last").trim(),
      partner2First: val("partner2First").trim(),
      partner2Last: val("partner2Last").trim(),
      venueName: val("venueName").trim(),
      venueCity: val("venueCity").trim(),
      notes: val("notes").trim(),
      turnstileToken: tsEl ? tsEl.value : "",
      // Attribution: the page the visitor came from before the form.
      sourcePage: document.referrer || "",
    };
  }

  function setBusy(on) {
    inFlight = on;
    nextBtn.disabled = on;
    if (backBtn) backBtn.disabled = on;
    nextBtn.setAttribute("aria-busy", on ? "true" : "false");
    if (nextLabel) nextLabel.textContent = on ? (t.sending || "Sending…") : (t.submit || "Submit");
  }

  function submitComplete() {
    if (inFlight) return; // double click / double Enter
    hideError();
    if ($("company") && $("company").value) return; // honeypot tripped
    for (var i = 0; i <= lastIndex; i++) {
      var ok = [].every.call(steps[i].querySelectorAll("input, select, textarea"), function (el) {
        return el.disabled || el.id === "company" || !fieldCode(el);
      });
      if (!ok) { if (i !== current) show(i, { scroll: true, noFocus: true }); validStep(i); return; }
    }
    if (cfg.turnstileKey) {
      var tsEl = form.querySelector('[name="cf-turnstile-response"]');
      if (!tsEl || !tsEl.value) { showError(C.antispam); return; }
    }
    setBusy(true);
    attempt(0);
  }

  function attempt(n) {
    fetch("/api/lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; });
      })
      .then(function (res) {
        if (res.j.ok === true) return onSaved(res.j);
        // Same submission already being saved by an earlier request: wait, ask again.
        if (res.j.code === "in_progress" && n < 5) {
          return setTimeout(function () { attempt(n + 1); }, 2500);
        }
        fail(res.j);
      })
      .catch(function () { fail({ code: "network" }); });
  }

  function fail(j) {
    setBusy(false);
    saveDraft();
    if (j.code === "validation" && j.errors && j.errors.length) { showFieldErrors(j.errors); return; }
    showError(C[j.code] || C.generic);
    // Turnstile tokens are single-use; get a fresh one for the retry.
    if (window.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
  }

  function onSaved() {
    inFlight = true; // stays locked — this inquiry is done
    ssDel(DRAFT_KEY); ssDel(SID_KEY);
    try { if (window.track) window.track("generate_lead", { form: "check_availability" }); } catch (e) {}
    form.hidden = true;
    if (stepper) stepper.hidden = true;
    var ok = $("form-success");
    ok.hidden = false;
    loadCalendar();
    ok.scrollIntoView({ behavior: "smooth", block: "start" });
    try { ok.focus({ preventScroll: true }); } catch (e) {}
  }

  // ---- Consultation calendar (HighLevel booking widget) ----------------------
  // The visitor books inside HighLevel's own widget, which shows its own
  // confirmation. Nothing here treats loading or clicking it as a booking.
  function loadCalendar() {
    var box = $("booking-embed"), slow = $("booking-slow");
    if (!box || !cfg.bookingUrl) { if (slow) slow.hidden = false; return; }
    var widgetId = cfg.bookingUrl.split("/").pop();
    var frame = document.createElement("iframe");
    frame.src = cfg.bookingUrl;
    frame.id = widgetId + "_" + Date.now();
    frame.title = t.calendarTitle || "Book a consultation";
    frame.setAttribute("scrolling", "no");
    frame.style.cssText = "width:100%;border:none;overflow:hidden;min-height:780px;";
    var loaded = false;
    frame.addEventListener("load", function () { loaded = true; if (slow) slow.hidden = true; });
    box.appendChild(frame);
    // Cross-origin iframes don't report HTTP errors, so the fallback link is
    // always visible; this extra notice covers a calendar that never loads.
    setTimeout(function () { if (!loaded && slow) slow.hidden = false; }, 15000);
    var s = document.createElement("script");
    s.src = "https://link.msgsndr.com/js/form_embed.js";
    s.async = true;
    document.body.appendChild(s);
  }

  // ---- Navigation (handles click + Enter via form submit) -------------------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (inFlight) return;
    hideError();
    if (!validStep(current)) return;
    if (current < lastIndex) show(current + 1, { scroll: true });
    else submitComplete();
  });
  if (backBtn) backBtn.addEventListener("click", function () {
    if (current > 0 && !inFlight) { hideError(); show(current - 1, { scroll: true }); }
  });

  show(restoreDraft(), { noFocus: true });
})();
