/**
 * Server-side validation for the Check Availability inquiry.
 *
 * Returns `{ ok, errors, lead }`. Errors are `{ field, code }` pairs — the
 * browser owns the (translated) wording, so nothing here is user-facing text.
 * `lead` is the normalized record that gets saved to HighLevel.
 *
 * Option values are canonical English on both the EN and ES pages (the ES page
 * only translates the labels), so the CRM receives one consistent value set.
 */

export const EVENT_TYPES = ["Wedding", "Corporate Event", "Other"];
export const OTHER_EVENT_TYPES = [
  "Banquet", "Bar Mitzvah", "Bat Mitzvah", "Birthday Party", "Class Reunion", "Community Celebration",
  "Company Holiday Party", "Family Reunion", "Graduation Celebration", "Night Club / Bar Dance",
  "Private Party", "Quinceanera", "PA / Sound Reinforcement", "School Dance", "Sweet 16",
  "Wedding Anniversary", "Other / Not Listed",
];
export const RELATIONS = [
  "I'm A Bride!", "I'm a Groom!", "I'm a Family Member", "I'm a Wedding Planner / Coordinator",
];
export const LANGUAGES = ["English", "Spanish"];
export const METHODS = ["SMS", "Email"];

const MAX_GUESTS = 5000;
const MAX_YEARS_AHEAD = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;

/** Today's date (YYYY-MM-DD) in the business's time zone. */
export function todayInBusinessTz(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Normalize a phone number to E.164, or return "" if it isn't plausible. */
export function normalizePhone(raw) {
  const s = String(raw || "").trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+") && !s.startsWith("+1")) {
    return digits.length >= 8 && digits.length <= 15 ? "+" + digits : "";
  }
  let nanp = digits;
  if (nanp.length === 11 && nanp[0] === "1") nanp = nanp.slice(1);
  // NANP: area code and exchange can't start with 0 or 1.
  if (nanp.length !== 10 || /^[01]/.test(nanp) || /^[01]/.test(nanp.slice(3))) return "";
  return "+1" + nanp;
}

/** Parse "6pm", "6:00 PM", "6:30 p. m.", "18:00" → "6:00 PM". "" if unparseable or ambiguous. */
export function normalizeTime(raw) {
  const s = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  let m = s.match(/^(\d{1,2})(?::([0-5]\d))? ?([ap])\.? ?m?\.?$/);
  if (m) {
    const h = +m[1];
    if (h < 1 || h > 12) return "";
    return `${h}:${m[2] || "00"} ${m[3] === "a" ? "AM" : "PM"}`;
  }
  m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  // 24-hour only when unambiguous ("18:00", "06:30"); "6:00" could be AM or PM.
  if (m && (+m[1] > 12 || m[1].length === 2 && m[1][0] === "0")) {
    const h24 = +m[1];
    const h = h24 % 12 || 12;
    return `${h}:${m[2]} ${h24 < 12 ? "AM" : "PM"}`;
  }
  return "";
}

function isRealDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const [y, mo, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function text(v, max) {
  const s = v == null ? "" : String(v).trim().replace(/\s+/g, " ");
  return { value: s, tooLong: s.length > max };
}

export function validateLead(data, { today = todayInBusinessTz() } = {}) {
  const errors = [];
  const err = (field, code) => errors.push({ field, code });
  const lead = {};

  const need = (field, max = 100) => {
    const t = text(data[field], max);
    if (!t.value) err(field, "required");
    else if (t.tooLong) err(field, "too_long");
    lead[field] = t.value;
  };
  const choice = (field, allowed) => {
    const v = text(data[field], 200).value;
    if (!v) err(field, "required");
    else if (!allowed.includes(v)) err(field, "invalid_choice");
    lead[field] = v;
  };

  // Submission identity
  const submissionId = String(data.submissionId || "");
  if (!UUID_RE.test(submissionId)) err("submissionId", "invalid");
  lead.submissionId = submissionId.toLowerCase();

  // Step 1 — contact
  need("firstName");
  need("lastName");

  const emailRaw = text(data.email, 254).value;
  if (!emailRaw) err("email", "required");
  else if (!EMAIL_RE.test(emailRaw)) err("email", "invalid_email");
  lead.email = emailRaw.toLowerCase();

  const phoneRaw = text(data.phone, 40).value;
  if (!phoneRaw) err("phone", "required");
  lead.phone = phoneRaw ? normalizePhone(phoneRaw) : "";
  if (phoneRaw && !lead.phone) err("phone", "invalid_phone");

  choice("commLanguage", LANGUAGES);
  choice("preferredMethod", METHODS);

  // SMS consent is optional — only text-message contact requires it. The value
  // is recorded exactly as given (strict boolean), never inferred.
  lead.smsConsent = data.smsConsent === true;
  if (lead.preferredMethod === "SMS" && !lead.smsConsent) err("smsConsent", "consent_required_for_sms");
  lead.consentText = text(data.consentText, 1000).value;
  if (lead.smsConsent && !lead.consentText) err("smsConsent", "invalid");

  // Step 2 — event
  choice("eventType", EVENT_TYPES);
  if (lead.eventType === "Other") choice("eventTypeOther", OTHER_EVENT_TYPES);
  else lead.eventTypeOther = "";

  const date = text(data.eventDate, 10).value;
  lead.eventDate = date;
  if (!date) err("eventDate", "required");
  else if (!isRealDate(date)) err("eventDate", "invalid_date");
  else if (date < today) err("eventDate", "past_date");
  else {
    const maxYear = Number(today.slice(0, 4)) + MAX_YEARS_AHEAD;
    if (date > `${maxYear}${today.slice(4)}`) err("eventDate", "date_too_far");
  }

  const guestsRaw = text(data.guests, 10).value;
  if (!guestsRaw) err("guests", "required");
  else if (!/^\d+$/.test(guestsRaw) || +guestsRaw < 1 || +guestsRaw > MAX_GUESTS) err("guests", "invalid_guests");
  lead.guests = guestsRaw ? String(+guestsRaw || guestsRaw) : "";

  for (const f of ["startTime", "endTime"]) {
    const raw = text(data[f], 20).value;
    if (!raw) { err(f, "required"); lead[f] = ""; continue; }
    lead[f] = normalizeTime(raw);
    if (!lead[f]) err(f, "invalid_time");
  }

  if (lead.eventType === "Wedding") {
    choice("relation", RELATIONS);
    need("partner1First"); need("partner1Last");
    need("partner2First"); need("partner2Last");
  } else {
    lead.relation = lead.partner1First = lead.partner1Last = lead.partner2First = lead.partner2Last = "";
  }

  // Step 3 — venue & notes
  need("venueName", 200);
  need("venueCity", 120);
  const notes = String(data.notes == null ? "" : data.notes).trim();
  if (notes.length > 2000) err("notes", "too_long");
  lead.notes = notes;

  // Context (not user-facing fields)
  lead.locale = data.locale === "es" ? "es" : "en";
  lead.sourcePage = text(data.sourcePage, 500).value;

  return { ok: errors.length === 0, errors, lead };
}
