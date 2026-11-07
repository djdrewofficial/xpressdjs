import {
  HOLD_KEY,
  STORAGE_KEY,
  CHAT_STORAGE_PREFIXES,
  isMeasurementCookie,
  isReplayCookie,
  parseStored,
  serializeChoice,
  shouldLoadAnalytics,
  shouldLoadChat,
  shouldLoadReplay,
  undecided,
  withdrawalPlan,
} from "../../lib/consent/state.js";

function readConfig() {
  const el = document.getElementById("xe-consent-config");
  if (!el) return null;
  try {
    return JSON.parse(el.textContent || "");
  } catch {
    return null;
  }
}

function storageGet(store, key) {
  try {
    return { ok: true, value: store.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function storageSet(store, key, value) {
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function storageDel(store, key) {
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readLocalChoice() {
  const got = storageGet(localStorage, STORAGE_KEY);
  if (!got.ok) return null;
  return parseStored(got.value);
}

/** What the next load of this tab would apply. A same-tab hold beats a stale Allow. */
function readBootChoice() {
  const held = storageGet(sessionStorage, HOLD_KEY);
  if (held.ok && held.value) return parseStored(held.value);
  return readLocalChoice();
}

/**
 * Write the choice. If localStorage cannot be replaced, delete it.
 * If it still cannot be removed, keep a same-tab hold so reload does not
 * reapply a stale Allow. The hold does not reach other tabs.
 * Returns the choice the next boot of this tab would use, or null if that
 * record cannot be made to match `partial`.
 */
function forcePersist(partial) {
  const raw = serializeChoice(partial);
  const intended = parseStored(raw);
  if (storageSet(localStorage, STORAGE_KEY, raw)) {
    const back = storageGet(localStorage, STORAGE_KEY);
    if (back.ok && back.value === raw) {
      storageDel(sessionStorage, HOLD_KEY);
      return intended;
    }
  }
  if (storageDel(localStorage, STORAGE_KEY)) {
    const back = storageGet(localStorage, STORAGE_KEY);
    if (back.ok && (back.value == null || back.value === "")) {
      storageDel(sessionStorage, HOLD_KEY);
      return undecided();
    }
  }
  if (storageSet(sessionStorage, HOLD_KEY, raw)) return intended;
  return null;
}

function expireCookie(name) {
  const base = name + "=; Max-Age=0; path=/; SameSite=Lax";
  document.cookie = base;
  const host = location.hostname;
  document.cookie = base + "; domain=" + host;
  const parts = host.split(".");
  if (parts.length > 1) document.cookie = base + "; domain=." + parts.slice(-2).join(".");
}

/** JS-readable first-party cookies only. Not HttpOnly, third-party, or vendor-side records. */
function clearCookies(match) {
  document.cookie.split(";").forEach(function (part) {
    const name = part.split("=")[0].trim();
    if (name && match(name)) expireCookie(name);
  });
}

function clearChatStorage() {
  try {
    Object.keys(localStorage).forEach(function (key) {
      if (CHAT_STORAGE_PREFIXES.some(function (prefix) { return key.indexOf(prefix) === 0; })) {
        localStorage.removeItem(key);
      }
    });
    sessionStorage.removeItem("i18n.en-us");
  } catch { /* ignore */ }
}

function element(tag, attrs, text) {
  const node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else if (attrs[key] != null) node.setAttribute(key, String(attrs[key]));
    });
  }
  if (text) node.textContent = text;
  return node;
}

export function bootConsent() {
  if (window.__xeConsentBooted) return;
  const cfg = readConfig();
  if (!cfg || !cfg.strings) return;
  window.__xeConsentBooted = true;

  const s = cfg.strings;
  let analyticsInjected = false;
  let replayInjected = false;
  let chatInjected = false;
  let lastFocus = null;
  let memoryChoice = undecided();

  const region = element("div", { class: "consent-region", role: "region", "aria-label": s.bannerTitle });
  region.append(
    element("p", { class: "consent-title", id: "consent-banner-title" }, s.bannerTitle),
    element("p", { class: "consent-copy" }, s.bannerBody),
  );
  const actions = element("div", { class: "consent-actions" });
  const acceptBtn = element("button", { type: "button", "data-consent-accept": "" }, s.accept);
  const rejectBtn = element("button", { type: "button", "data-consent-reject": "" }, s.reject);
  const customBtn = element("button", { type: "button", "data-consent-customize": "" }, s.customize);
  actions.append(acceptBtn, rejectBtn, customBtn);
  region.append(actions);
  region.append(element("a", { href: cfg.privacyHref }, s.privacy));

  const dialog = element("div", {
    class: "consent-dialog",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "consent-dialog-title",
    hidden: "",
  });
  const card = element("div", { class: "consent-dialog-card" });
  card.append(
    element("h2", { id: "consent-dialog-title" }, s.dialogTitle),
    element("p", { class: "consent-copy" }, s.dialogBody),
  );
  const analyticsLabel = element("label", { class: "consent-check" });
  const analyticsBox = element("input", { type: "checkbox", "data-consent-analytics": "" });
  analyticsLabel.append(analyticsBox, element("span", null, s.analyticsLabel));
  const replayLabel = element("label", { class: "consent-check" });
  const replayBox = element("input", { type: "checkbox", "data-consent-replay": "" });
  replayLabel.append(replayBox, element("span", null, s.replayLabel));
  const chatLabel = element("label", { class: "consent-check" });
  const chatBox = element("input", { type: "checkbox", "data-consent-chat": "" });
  chatLabel.append(chatBox, element("span", null, s.chatLabel));
  card.append(
    analyticsLabel,
    element("p", { class: "consent-hint" }, s.analyticsHint),
    replayLabel,
    element("p", { class: "consent-hint" }, s.replayHint),
    chatLabel,
    element("p", { class: "consent-hint" }, s.chatHint),
  );
  const dialogActions = element("div", { class: "consent-actions" });
  const saveBtn = element("button", { type: "button", "data-consent-save": "" }, s.save);
  const dialogReject = element("button", { type: "button", "data-consent-reject-analytics": "" }, s.rejectAnalytics);
  const dialogAccept = element("button", { type: "button", "data-consent-accept-analytics": "" }, s.accept);
  const closeBtn = element("button", { type: "button", "data-consent-close": "" }, s.close);
  dialogActions.append(saveBtn, dialogReject, dialogAccept, closeBtn);
  card.append(dialogActions, element("a", { href: cfg.privacyHref }, s.privacy));
  dialog.append(card);

  let chatButton = null;

  function injectedState() {
    return { analytics: analyticsInjected, replay: replayInjected, chat: chatInjected };
  }

  function loadAnalytics() {
    if (analyticsInjected || !cfg.ga4 || window.__xeVendorsDisarmed) return;
    analyticsInjected = true;
    if (cfg.promptwatch) {
      const pw = document.createElement("script");
      pw.setAttribute("data-project-id", cfg.promptwatch);
      pw.src = "https://ingest.promptwatch.com/js/client.min.js";
      document.head.appendChild(pw);
    }
    const g = document.createElement("script");
    g.async = true;
    g.src = "https://www.googletagmanager.com/gtag/js?id=" + cfg.ga4;
    document.head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", cfg.ga4);
  }

  function loadReplay() {
    if (replayInjected || !cfg.clarity || cfg.replay === false || window.__xeVendorsDisarmed) return;
    replayInjected = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r);
      t.async = 1;
      t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0];
      y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", cfg.clarity);
  }

  function loadChat() {
    if (chatInjected || !cfg.chat || !cfg.widgetId || window.__xeVendorsDisarmed) return;
    chatInjected = true;
    if (chatButton) chatButton.remove();
    const script = document.createElement("script");
    script.src = "https://widgets.leadconnectorhq.com/loader.js";
    script.setAttribute("data-resources-url", "https://widgets.leadconnectorhq.com/chat-widget/loader.js");
    script.setAttribute("data-widget-id", cfg.widgetId);
    script.setAttribute("data-source", "WEB_USER");
    document.body.appendChild(script);
  }

  function ensureChatButton() {
    if (!cfg.chat || chatInjected || chatButton || window.__xeVendorsDisarmed) return;
    chatButton = element("button", { type: "button", class: "chat-launch", "data-chat-launch": "" }, s.chatButton);
    chatButton.setAttribute("aria-label", s.chatAria);
    chatButton.addEventListener("click", function () { openDialog(chatButton); });
    document.body.appendChild(chatButton);
  }

  function applyLoads(choice) {
    memoryChoice = choice;
    if (shouldLoadAnalytics(choice)) loadAnalytics();
    if (shouldLoadReplay(choice, cfg.replay)) loadReplay();
    if (shouldLoadChat(choice, cfg.chat)) loadChat();
    else ensureChatButton();
  }

  function disarmVendors() {
    window.__xeVendorsDisarmed = true;
    window.track = function () {};
    window.gtag = function () {};
    try {
      if (typeof window.clarity === "function") {
        window.clarity("consent", false);
        window.clarity("stop");
      }
    } catch { /* ignore */ }
  }

  function showBanner() {
    region.hidden = false;
    document.body.classList.add("has-consent-banner");
  }

  function hideBanner() {
    region.hidden = true;
    document.body.classList.remove("has-consent-banner");
  }

  function setInert(on) {
    Array.prototype.forEach.call(document.body.children, function (node) {
      if (node === dialog) return;
      if (on) {
        if (!node.hasAttribute("inert")) node.setAttribute("data-consent-inert", "");
        node.setAttribute("inert", "");
      } else if (node.hasAttribute("data-consent-inert")) {
        node.removeAttribute("inert");
        node.removeAttribute("data-consent-inert");
      }
    });
  }

  function focusable(root) {
    return Array.prototype.filter.call(
      root.querySelectorAll("button, a[href], input, select, textarea"),
      function (node) { return !node.disabled && !node.closest("[hidden]"); },
    );
  }

  function restoreFocus() {
    const opener = lastFocus;
    const visible = opener && opener.isConnected && !opener.closest("[hidden]") && opener.hidden !== true;
    const fallback = document.querySelector("[data-consent-open]");
    const target = visible ? opener : fallback;
    if (target && target.focus) target.focus();
  }

  function openDialog(opener) {
    lastFocus = opener || document.activeElement;
    const choice = memoryChoice.decided || memoryChoice.chat || memoryChoice.replay
      ? memoryChoice
      : (readBootChoice() || memoryChoice);
    analyticsBox.checked = choice.analytics === true;
    replayBox.checked = choice.replay === true;
    chatBox.checked = choice.chat === true;
    hideBanner();
    dialog.hidden = false;
    setInert(true);
    const nodes = focusable(card);
    if (nodes[0]) nodes[0].focus();
  }

  function closeDialog() {
    dialog.hidden = true;
    setInert(false);
    const choice = readBootChoice() || memoryChoice;
    if (!choice.decided && !choice.replay) showBanner();
    restoreFocus();
  }

  function commit(partial) {
    const next = {
      decided: partial.decided === true,
      analytics: partial.analytics === true,
      replay: partial.replay === true,
      chat: partial.chat === true,
    };
    const bootChoice = forcePersist(next);
    const plan = withdrawalPlan({
      injected: injectedState(),
      next: next,
      persisted: bootChoice,
      replayPageEnabled: cfg.replay !== false,
    });
    if (!next.analytics) clearCookies(isMeasurementCookie);
    if (!next.replay) {
      clearCookies(isReplayCookie);
      try { sessionStorage.removeItem("_cltk"); } catch { /* ignore */ }
    }
    if (!next.chat && (chatInjected || memoryChoice.chat === true)) clearChatStorage();
    if (!dialog.hidden) {
      dialog.hidden = true;
      setInert(false);
    }
    if (next.decided || next.replay) hideBanner();
    else showBanner();
    if (plan.disarm) disarmVendors();
    if (plan.reload) {
      location.reload();
      return;
    }
    if (plan.disarm) {
      memoryChoice = next;
      restoreFocus();
      return;
    }
    if (window.__xeVendorsDisarmed) {
      location.reload();
      return;
    }
    applyLoads(parseStored(serializeChoice(next)));
    restoreFocus();
  }

  function reconcile() {
    const choice = readBootChoice();
    if (!choice) return;
    const plan = withdrawalPlan({
      injected: injectedState(),
      next: choice,
      persisted: choice,
      replayPageEnabled: cfg.replay !== false,
    });
    if (!choice.analytics) clearCookies(isMeasurementCookie);
    if (!choice.replay) {
      clearCookies(isReplayCookie);
      try { sessionStorage.removeItem("_cltk"); } catch { /* ignore */ }
    }
    if (plan.disarm) {
      disarmVendors();
      if (plan.reload) location.reload();
      return;
    }
    if (window.__xeVendorsDisarmed) {
      location.reload();
      return;
    }
    if (choice.decided || choice.replay) hideBanner();
    applyLoads(choice);
  }

  acceptBtn.addEventListener("click", function () {
    commit({
      decided: true,
      analytics: true,
      replay: memoryChoice.replay === true,
      chat: memoryChoice.chat === true,
    });
  });
  rejectBtn.addEventListener("click", function () {
    commit({
      decided: true,
      analytics: false,
      replay: false,
      chat: memoryChoice.chat === true,
    });
  });
  customBtn.addEventListener("click", function () { openDialog(customBtn); });
  saveBtn.addEventListener("click", function () {
    commit({
      decided: true,
      analytics: analyticsBox.checked,
      replay: replayBox.checked,
      chat: chatBox.checked,
    });
  });
  dialogAccept.addEventListener("click", function () {
    analyticsBox.checked = true;
    commit({
      decided: true,
      analytics: true,
      replay: replayBox.checked,
      chat: chatBox.checked,
    });
  });
  dialogReject.addEventListener("click", function () {
    analyticsBox.checked = false;
    commit({
      decided: true,
      analytics: false,
      replay: replayBox.checked,
      chat: chatBox.checked,
    });
  });
  closeBtn.addEventListener("click", closeDialog);

  dialog.addEventListener("keydown", function (event) {
    if (dialog.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusable(card);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("click", function (event) {
    const opener = event.target && event.target.closest && event.target.closest("[data-consent-open]");
    if (!opener) return;
    event.preventDefault();
    openDialog(opener);
  });

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    reconcile();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") reconcile();
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) reconcile();
  });

  region.hidden = true;
  document.body.append(region, dialog);

  const initial = readBootChoice() || undecided();
  memoryChoice = initial;
  if (!shouldLoadAnalytics(initial)) clearCookies(isMeasurementCookie);
  if (!shouldLoadReplay(initial, true)) {
    clearCookies(isReplayCookie);
    try { sessionStorage.removeItem("_cltk"); } catch { /* ignore */ }
  }
  applyLoads(initial);
  if (!initial.decided && !initial.replay) showBanner();
}
