/**
 * HighLevel (LeadConnector) API helpers for the inquiry flow.
 *
 * Custom-field IDs are resolved from the location's metadata at runtime
 * (GET /locations/:id/customFields). The PINNED snapshot below — verified
 * against the account on 2026-10-03 — is only a fallback for when the token
 * can't read metadata. Two fields share the key `contact.comments`, so every
 * field is identified by key AND name, never by key alone.
 */

export const GHL_BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";
const META_TTL_MS = 10 * 60 * 1000;

// inquiry slot → { key, name } in the HighLevel contact model
export const FIELD_SPECS = {
  eventType:       { key: "contact.event_type", name: "Event Type" },
  eventDate:       { key: "contact.event_date", name: "Event Date" },
  guests:          { key: "contact.guest_count", name: "Guest Count" },
  startTime:       { key: "contact.event_start_time", name: "Event Start Time" },
  endTime:         { key: "contact.event_end_time", name: "Event End Time" },
  venueName:       { key: "contact.name_of_venue", name: "Name of Venue" },
  venueCity:       { key: "contact.venue_city", name: "Venue City" },
  relation:        { key: "contact.relationship_to_wedding", name: "Relationship to Wedding" },
  partner1First:   { key: "contact.partner_a_first_name", name: "Partner A First Name" },
  partner1Last:    { key: "contact.partner_a_last_name", name: "Partner A Last Name" },
  partner2First:   { key: "contact.partner_b_first_name", name: "Partner B First Name" },
  partner2Last:    { key: "contact.partner_b_last_name", name: "Partner B Last Name" },
  commLanguage:    { key: "contact.preferred_language", name: "Preferred Language" },
  preferredMethod: { key: "contact.preferred_method_of_communication", name: "Preferred Method of Communication" },
  leadStage:       { key: "contact.lead_stage", name: "Lead Stage" },
  leadComplete:    { key: "contact.lead_complete", name: "Lead Complete" },
  smsConsent:      { key: "contact.sms_consent", name: "SMS Consent" },
  // The existing inbound-webhook workflow writes `notes` here (not to
  // "Initial Booking Comments", which shares the same key).
  notes:           { key: "contact.comments", name: "Booking Comments" },
};

const SMS_CONSENT_OPTION =
  "By checking this box, you agree to receive booking confirmations, event updates, and promotional messages via SMS from Xpress Entertainment. Message & data rates may apply. Consent is not a condition of purchase. You may opt out anytime by replying STOP.";

export const PINNED_FIELDS = [
  { id: "hLBakaZYdqZdE15Ub6QZ", fieldKey: "contact.event_type", name: "Event Type", dataType: "TEXT" },
  { id: "ER8MxrMfajffqfgHbKQK", fieldKey: "contact.event_date", name: "Event Date", dataType: "DATE" },
  { id: "CfqxKNWJMhhaAzL0WCAV", fieldKey: "contact.guest_count", name: "Guest Count", dataType: "TEXT" },
  { id: "Y2Xe6bfKlQDpIZeZ0B8L", fieldKey: "contact.event_start_time", name: "Event Start Time", dataType: "TEXT" },
  { id: "KZ95MPxkuGVZCZu1fmcL", fieldKey: "contact.event_end_time", name: "Event End Time", dataType: "TEXT" },
  { id: "EnDkjGtO0tZT1l4oj2ni", fieldKey: "contact.name_of_venue", name: "Name of Venue", dataType: "TEXT" },
  { id: "d4TRmyeMC1WfaLINHOMS", fieldKey: "contact.venue_city", name: "Venue City", dataType: "TEXT" },
  { id: "z2c8pTbP8aOIIHOJ7rp6", fieldKey: "contact.relationship_to_wedding", name: "Relationship to Wedding", dataType: "TEXT" },
  { id: "kddP7XrKS52pD6CdYSUg", fieldKey: "contact.partner_a_first_name", name: "Partner A First Name", dataType: "TEXT" },
  { id: "dPVY9xurcduLSc3Q4eV8", fieldKey: "contact.partner_a_last_name", name: "Partner A Last Name", dataType: "TEXT" },
  { id: "vchmp7srRzRIsk03ONVH", fieldKey: "contact.partner_b_first_name", name: "Partner B First Name", dataType: "TEXT" },
  { id: "VzFUtxB9e6rww1kBBdsR", fieldKey: "contact.partner_b_last_name", name: "Partner B Last Name", dataType: "TEXT" },
  { id: "SAKxQ1MfRAHEFkCcpFMQ", fieldKey: "contact.preferred_language", name: "Preferred Language", dataType: "SINGLE_OPTIONS", picklistOptions: ["English", "Spanish"] },
  { id: "Yjxw1LNsWSTP7F8H1sJY", fieldKey: "contact.preferred_method_of_communication", name: "Preferred Method of Communication", dataType: "SINGLE_OPTIONS", picklistOptions: ["SMS", "Email"] },
  { id: "rKLRZJ99iztCuLlSbrNH", fieldKey: "contact.lead_stage", name: "Lead Stage", dataType: "TEXT" },
  { id: "cZ6x28YS5igRThJKTbxM", fieldKey: "contact.lead_complete", name: "Lead Complete", dataType: "TEXT" },
  { id: "tvb20gkW3iqS94TVxPa9", fieldKey: "contact.sms_consent", name: "SMS Consent", dataType: "CHECKBOX", picklistOptions: [SMS_CONSENT_OPTION] },
  { id: "wRyrPFfvHjgfJvu0x32G", fieldKey: "contact.comments", name: "Booking Comments", dataType: "TEXT" },
];

let metaCache = null; // { at, fields, source }

export function headers(env) {
  return {
    Authorization: `Bearer ${env.GHL_API_TOKEN}`,
    Version: VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export function base(env) {
  return env.GHL_API_BASE || GHL_BASE;
}

/** Live custom-field metadata (cached per isolate), pinned snapshot on failure. */
export async function loadFieldMeta(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (metaCache && now - metaCache.at < META_TTL_MS) return metaCache;
  try {
    const res = await fetchImpl(
      `${base(env)}/locations/${encodeURIComponent(env.GHL_LOCATION_ID)}/customFields?model=contact`,
      { headers: headers(env) },
    );
    if (!res.ok) throw new Error(`customFields HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.customFields)) throw new Error("customFields missing");
    metaCache = { at: now, fields: body.customFields, source: "live" };
  } catch (e) {
    console.log("HighLevel field metadata unavailable, using pinned snapshot:", e.message);
    metaCache = { at: now, fields: PINNED_FIELDS, source: "pinned" };
  }
  return metaCache;
}

export function resetFieldMetaCache() { metaCache = null; }

/** slot → field definition, matched on key + name. Missing slots are omitted. */
export function resolveFields(fields) {
  const out = {};
  for (const [slot, spec] of Object.entries(FIELD_SPECS)) {
    const hit = fields.filter((f) => f.fieldKey === spec.key && f.name === spec.name);
    if (hit.length === 1) out[slot] = hit[0];
    else console.log(`HighLevel field not resolved for ${slot} (${spec.key} / ${spec.name}): ${hit.length} matches`);
  }
  return out;
}

/**
 * Custom-field values for the upsert. Only non-empty values are written so a
 * returning contact's unrelated data is never blanked. Values that a picklist
 * doesn't accept are skipped and reported (they still go into the note).
 */
export function buildCustomFields(lead, resolved) {
  const values = {
    eventType: lead.eventType,
    eventDate: lead.eventDate,
    guests: lead.guests,
    startTime: lead.startTime,
    endTime: lead.endTime,
    venueName: lead.venueName,
    venueCity: lead.venueCity,
    relation: lead.relation,
    partner1First: lead.partner1First,
    partner1Last: lead.partner1Last,
    partner2First: lead.partner2First,
    partner2Last: lead.partner2Last,
    commLanguage: lead.commLanguage,
    preferredMethod: lead.preferredMethod,
    leadStage: "complete",
    leadComplete: "Yes",
    notes: lead.notes,
  };
  const customFields = [];
  const skipped = [];
  for (const [slot, value] of Object.entries(values)) {
    const f = resolved[slot];
    if (!value) continue;
    if (!f) { skipped.push(slot); continue; }
    const opts = f.picklistOptions;
    if (Array.isArray(opts) && opts.length && !opts.includes(value)) { skipped.push(slot); continue; }
    customFields.push({ id: f.id, field_value: value });
  }
  // SMS consent: written only when the visitor actually opted in. An unchecked
  // box is not a revocation (that's STOP), so an existing opt-in is left alone.
  if (lead.smsConsent) {
    const f = resolved.smsConsent;
    const opt = f && Array.isArray(f.picklistOptions) ? f.picklistOptions[0] : "";
    if (f && opt) customFields.push({ id: f.id, field_value: [opt] });
    else skipped.push("smsConsent");
  }
  return { customFields, skipped };
}

/**
 * Create-or-update the contact. HighLevel matches existing contacts using the
 * location's duplicate-contact settings. No `tags`, `source` or DND fields are
 * sent, so existing tags, attribution and DND protections are untouched.
 */
export async function upsertContact(env, lead, customFields, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${base(env)}/contacts/upsert`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({
      locationId: env.GHL_LOCATION_ID,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      customFields,
    }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`upsert HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
  let body;
  try { body = JSON.parse(bodyText); } catch { throw new Error("upsert returned non-JSON"); }
  const id = body?.contact?.id;
  if (!id) throw new Error("upsert response had no contact id");
  return { id, isNew: body.new === true };
}

/** Set Source on a contact this form just CREATED (never on an existing contact). */
export async function updateContactSource(env, contactId, source, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${base(env)}/contacts/${encodeURIComponent(contactId)}`, {
    method: "PUT",
    headers: headers(env),
    body: JSON.stringify({ source }),
  });
  if (!res.ok) throw new Error(`source HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function createNote(env, contactId, text, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${base(env)}/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ body: text }),
  });
  if (!res.ok) throw new Error(`note HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Full inquiry + consent record for the contact's notes. */
export function inquiryNote(lead, { source, submittedAt, skipped = [] }) {
  const eventLabel = lead.eventType === "Other" && lead.eventTypeOther
    ? `Other — ${lead.eventTypeOther}` : lead.eventType;
  const lines = [
    "WEBSITE INQUIRY — complete (Check Availability form)",
    `Submission ID: ${lead.submissionId}`,
    `Submitted: ${submittedAt}`,
    `Source: ${source}${lead.sourcePage ? ` (${lead.sourcePage})` : ""}`,
    `Form language: ${lead.locale === "es" ? "Spanish (/es)" : "English"}`,
    "",
    `Name: ${lead.firstName} ${lead.lastName}`,
    `Email: ${lead.email}`,
    `Phone: ${lead.phone}`,
    `Preferred language: ${lead.commLanguage}`,
    `Preferred contact method: ${lead.preferredMethod}`,
    "",
    `Event: ${eventLabel}`,
    `Date: ${lead.eventDate}`,
    `Guests: ${lead.guests}`,
    `Time: ${lead.startTime} – ${lead.endTime}`,
    `Venue: ${lead.venueName}, ${lead.venueCity}`,
  ];
  if (lead.eventType === "Wedding") {
    lines.push(
      `Relation to wedding: ${lead.relation}`,
      `Partner A: ${lead.partner1First} ${lead.partner1Last}`,
      `Partner B: ${lead.partner2First} ${lead.partner2Last}`,
    );
  }
  lines.push("", `Notes: ${lead.notes || "(none)"}`, "");
  // Consent for THIS submission only. The contact's SMS Consent field / DND
  // settings are the historical record and are only ever set to "consented"
  // (never cleared) by this form.
  lines.push("CONSENT RECORD FOR THIS SUBMISSION");
  if (lead.smsConsent) {
    lines.push(`SMS consent: GIVEN (box ticked) at ${submittedAt}`, `Wording shown: "${lead.consentText}"`);
  } else {
    lines.push(
      `SMS consent: box NOT ticked at ${submittedAt}. This is not an opt-out: existing consent and DND settings were left unchanged.`,
    );
  }
  if (skipped.length) lines.push("", `Not written to custom fields (see values above): ${skipped.join(", ")}`);
  return lines.join("\n");
}
