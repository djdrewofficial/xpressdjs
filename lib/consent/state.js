/** Pure consent decisions. Optional analytics/replay/chat stay off until a stored choice allows them. */

export const CONSENT_VERSION = 1;
export const STORAGE_KEY = "xe-consent";

export const ANALYTICS_COOKIE_RE = /^(_ga|_gid|_gat|_clck|_clsk|CLID|MUID|MR|SM)/;

/** localStorage keys observed from the LeadConnector chat widget on the live site. */
export const CHAT_STORAGE_PREFIXES = [
  "v2_contact_session_",
  "v2_session_history_",
  "v2_history_",
  "v3_first_session_event_",
];

export function undecided() {
  return { v: CONSENT_VERSION, decided: false, analytics: false, chat: false, ts: 0 };
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
  if (data.v !== CONSENT_VERSION) return undecided();
  const decided = data.decided === true;
  const chat = data.chat === true;
  if (!decided && !chat) return undecided();
  if (decided && typeof data.analytics !== "boolean") return undecided();
  return {
    v: CONSENT_VERSION,
    decided,
    analytics: decided && data.analytics === true,
    chat,
    ts: typeof data.ts === "number" ? data.ts : 0,
  };
}

export function serializeChoice(partial, now = Date.now()) {
  const decided = partial.decided === true;
  return JSON.stringify({
    v: CONSENT_VERSION,
    decided,
    analytics: decided && partial.analytics === true,
    chat: partial.chat === true,
    ts: now,
  });
}

export function allowsAnalytics(choice) {
  return !!(choice && choice.decided === true && choice.analytics === true);
}

export function allowsChat(choice) {
  return !!(choice && choice.chat === true);
}

export function shouldLoadAnalytics(choice) {
  return allowsAnalytics(choice);
}

/** Session replay is a separate switch from page-measurement analytics. Inquiry pages pass replayEnabled false. */
export function shouldLoadReplay(choice, replayEnabled) {
  return allowsAnalytics(choice) && replayEnabled !== false;
}

export function shouldLoadChat(choice, chatEnabled) {
  return allowsChat(choice) && chatEnabled !== false;
}
