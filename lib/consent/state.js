/**
 * Consent decisions for optional analytics, session replay, and chat.
 *
 * Replay is stored separately from analytics (version 2). A version 1 record
 * was one checkbox whose label covered analytics and session replay, so a v1
 * analytics allow still counts as replay. Splitting them is a product choice
 * for Drew and counsel to review. It is not a claim that the two boxes match
 * a legal definition of separate purposes.
 *
 * Cookie helpers only name values this page can read. They do not delete
 * HttpOnly cookies, cookies on other domains, or records a vendor already stored.
 */

export const CONSENT_VERSION = 2;
export const STORAGE_KEY = "xe-consent";
export const HOLD_KEY = "xe-consent-hold";

/** localStorage keys observed from the LeadConnector chat widget on the live site. */
export const CHAT_STORAGE_PREFIXES = [
  "v2_contact_session_",
  "v2_session_history_",
  "v2_history_",
  "v3_first_session_event_",
];

export function undecided() {
  return { v: CONSENT_VERSION, decided: false, analytics: false, replay: false, chat: false, ts: 0 };
}

export function isMeasurementCookie(name) {
  return name === "_ga"
    || name.startsWith("_ga_")
    || name === "_gid"
    || name === "_gat"
    || name.startsWith("_gat_");
}

export function isReplayCookie(name) {
  return name === "_clck" || name === "_clsk" || name === "CLID" || name === "MUID";
}

export function isAnalyticsCookie(name) {
  return isMeasurementCookie(name) || isReplayCookie(name);
}

export function parseStored(raw) {
  if (raw == null || raw === "") return undecided();
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return undecided();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undecided();
  if (data.v !== 1 && data.v !== CONSENT_VERSION) return undecided();
  const decided = data.decided === true;
  const chat = data.chat === true;
  if (!decided && !chat && data.replay !== true) return undecided();
  if (decided && typeof data.analytics !== "boolean") return undecided();
  const analytics = decided && data.analytics === true;
  const replay = data.v === 1 ? analytics : data.replay === true;
  return {
    v: data.v,
    decided: decided || replay,
    analytics,
    replay,
    chat,
    ts: typeof data.ts === "number" ? data.ts : 0,
  };
}

export function serializeChoice(partial, now = Date.now()) {
  const decided = partial.decided === true;
  const replay = partial.replay === true;
  return JSON.stringify({
    v: CONSENT_VERSION,
    decided: decided || replay,
    analytics: decided && partial.analytics === true,
    replay,
    chat: partial.chat === true,
    ts: now,
  });
}

export function allowsAnalytics(choice) {
  return !!(choice && choice.decided === true && choice.analytics === true);
}

export function allowsReplay(choice) {
  return !!(choice && choice.replay === true);
}

export function allowsChat(choice) {
  return !!(choice && choice.chat === true);
}

export function shouldLoadAnalytics(choice) {
  return allowsAnalytics(choice);
}

/**
 * Page-level replayEnabled false blocks Clarity even when the stored choice
 * allows replay. The inquiry form uses that because name, email, and phone
 * stay in the DOM. That block is separate from the stored replay choice.
 */
export function shouldLoadReplay(choice, replayEnabled) {
  return allowsReplay(choice) && replayEnabled !== false;
}

export function shouldLoadChat(choice, chatEnabled) {
  return allowsChat(choice) && chatEnabled !== false;
}

/**
 * Decide whether a running purpose must be disarmed, and whether a reload is safe.
 * `injected` is the in-memory load state. `persisted` is what the next boot would
 * read (null when that record is unreadable or still an Allow that could not be
 * replaced). A previous stored Allow is not an input: denial of something that
 * is actually loaded reloads whenever the next boot would not start it again.
 */
export function withdrawalPlan({ injected, next, persisted, replayPageEnabled = true }) {
  const stopAnalytics = !!(injected && injected.analytics && !allowsAnalytics(next));
  const stopReplay = !!(injected && injected.replay && !shouldLoadReplay(next, replayPageEnabled));
  const stopChat = !!(injected && injected.chat && !allowsChat(next));
  const stopping = stopAnalytics || stopReplay || stopChat;
  const wouldRestart = persisted == null
    || (stopAnalytics && allowsAnalytics(persisted))
    || (stopReplay && shouldLoadReplay(persisted, replayPageEnabled))
    || (stopChat && allowsChat(persisted));
  return {
    stopAnalytics,
    stopReplay,
    stopChat,
    disarm: stopping,
    reload: stopping && !wouldRestart,
  };
}
