import {
  ANALYTICS_COOKIE_RE,
  CHAT_STORAGE_PREFIXES,
  STORAGE_KEY,
  parseStored,
  serializeChoice,
  shouldLoadAnalytics,
  shouldLoadChat,
  shouldLoadReplay,
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

function readChoice() {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseStored(null);
  }
}

function writeChoice(partial) {
  const raw = serializeChoice(partial);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    /* private mode */
  }
  return parseStored(raw);
}

function expireCookie(name) {
  const base = name + "=; Max-Age=0; path=/; SameSite=Lax";
  document.cookie = base;
  const host = location.hostname;
  document.cookie = base + "; domain=" + host;
  const parts = host.split(".");
  if (parts.length > 1) document.cookie = base + "; domain=." + parts.slice(-2).join(".");
}

function clearAnalyticsStorage() {
  document.cookie.split(";").forEach(function (part) {
    const name = part.split("=")[0].trim();
    if (name && ANALYTICS_COOKIE_RE.test(name)) expireCookie(name);
  });
  try { sessionStorage.removeItem("_cltk"); } catch { /* ignore */ }
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
  const policy = element("a", { href: cfg.privacyHref }, s.privacy);
  region.append(policy);

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
  const chatLabel = element("label", { class: "consent-check" });
  const chatBox = element("input", { type: "checkbox", "data-consent-chat": "" });
  chatLabel.append(chatBox, element("span", null, s.chatLabel));
  card.append(
    analyticsLabel,
    element("p", { class: "consent-hint" }, s.analyticsHint),
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

  function loadAnalytics() {
    if (analyticsInjected || !cfg.ga4) return;
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
    if (replayInjected || !cfg.clarity) return;
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
    if (chatInjected || !cfg.chat || !cfg.widgetId) return;
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
    if (!cfg.chat || chatInjected || chatButton) return;
    chatButton = element("button", { type: "button", class: "chat-launch", "data-chat-launch": "" }, s.chatButton);
    chatButton.setAttribute("aria-label", s.chatAria);
    chatButton.addEventListener("click", function () {
      const choice = readChoice();
      commit({ decided: choice.decided === true, analytics: choice.analytics === true, chat: true });
    });
    document.body.appendChild(chatButton);
  }

  function applyLoads(choice) {
    if (shouldLoadAnalytics(choice)) loadAnalytics();
    if (shouldLoadReplay(choice, cfg.replay)) loadReplay();
    if (shouldLoadChat(choice, cfg.chat)) loadChat();
    else ensureChatButton();
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

  function openDialog(opener) {
    lastFocus = opener || document.activeElement;
    const choice = readChoice();
    analyticsBox.checked = choice.analytics === true;
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
    if (!readChoice().decided) showBanner();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function commit(partial) {
    const prev = readChoice();
    const next = writeChoice({
      decided: partial.decided === true,
      analytics: partial.analytics === true,
      chat: partial.chat === true,
    });
    if (!next.analytics) clearAnalyticsStorage();
    if (!next.chat) clearChatStorage();
    const reload = (prev.analytics && !next.analytics && (analyticsInjected || replayInjected))
      || (prev.chat && !next.chat && chatInjected);
    if (!dialog.hidden) {
      dialog.hidden = true;
      setInert(false);
    }
    if (next.decided) hideBanner();
    else showBanner();
    if (reload) {
      location.reload();
      return;
    }
    applyLoads(next);
  }

  acceptBtn.addEventListener("click", function () {
    commit({ decided: true, analytics: true, chat: readChoice().chat === true });
  });
  rejectBtn.addEventListener("click", function () {
    commit({ decided: true, analytics: false, chat: readChoice().chat === true });
  });
  customBtn.addEventListener("click", function () { openDialog(customBtn); });
  saveBtn.addEventListener("click", function () {
    commit({ decided: true, analytics: analyticsBox.checked, chat: chatBox.checked });
  });
  dialogAccept.addEventListener("click", function () {
    analyticsBox.checked = true;
    commit({ decided: true, analytics: true, chat: chatBox.checked });
  });
  dialogReject.addEventListener("click", function () {
    analyticsBox.checked = false;
    commit({ decided: true, analytics: false, chat: chatBox.checked });
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

  region.hidden = true;
  document.body.append(region, dialog);

  const initial = readChoice();
  applyLoads(initial);
  if (!initial.decided) showBanner();
}
