/** Inquiry drafts are first-party session storage, not advertising. They expire and never store SMS consent. */
export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function stampDraft(draft, now) {
  const copy = { ...draft, savedAt: now };
  delete copy.smsConsent;
  delete copy.consentText;
  return copy;
}

export function usableDraft(raw, now, maxAge = DRAFT_MAX_AGE_MS) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (typeof data.savedAt !== "number") return null;
  if (data.savedAt > now + 60_000) return null;
  if (now - data.savedAt > maxAge) return null;
  delete data.smsConsent;
  delete data.consentText;
  return data;
}
