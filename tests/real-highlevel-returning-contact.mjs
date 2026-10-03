// REAL HighLevel check (NOT part of `npm test`) — returning-contact behavior of
// the exact upsert the website sends. It WRITES to the live CRM, so it refuses
// to run unless every guard below is set deliberately.
//
//   HL_REAL_TEST=I_UNDERSTAND_THIS_WRITES_TO_HIGHLEVEL \
//   GHL_API_TOKEN=... GHL_LOCATION_ID=tRQqRP2zGXszbRBr9wU3 \
//   HL_TEST_CONTACT_ID=<id of a dedicated TEST contact> \
//   node tests/real-highlevel-returning-contact.mjs
//
// Prepare the test contact first in HighLevel: give it the email/phone below
// (or set HL_TEST_EMAIL / HL_TEST_PHONE to match it), a couple of unrelated
// tags, SMS DND ON for one channel, SMS Consent checked, and some Booking
// Comments / partner names. Pause any workflow that triggers on contact
// updates for that contact. The script then sends the website's upsert for a
// returning visitor who did NOT tick the SMS box, chose Email, left notes empty
// and picked a non-wedding event, and compares before/after.
// Only the upsert is sent — no note, no alert, no source change.
import { loadFieldMeta, resolveFields, buildCustomFields, upsertContact, headers, base } from "../lib/lead/highlevel.js";
import { validateLead } from "../lib/lead/validate.js";

const env = process.env;
if (env.HL_REAL_TEST !== "I_UNDERSTAND_THIS_WRITES_TO_HIGHLEVEL" || !env.GHL_API_TOKEN || !env.GHL_LOCATION_ID || !env.HL_TEST_CONTACT_ID) {
  console.error("Refusing to run: set HL_REAL_TEST, GHL_API_TOKEN, GHL_LOCATION_ID and HL_TEST_CONTACT_ID (see header).");
  process.exit(2);
}

const getContact = async () => {
  const r = await fetch(`${base(env)}/contacts/${env.HL_TEST_CONTACT_ID}`, { headers: headers(env) });
  if (!r.ok) throw new Error(`GET contact ${r.status}`);
  return (await r.json()).contact;
};
const pick = (c) => ({
  firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, tags: [...(c.tags || [])].sort(), dnd: c.dnd, dndSettings: c.dndSettings,
  source: c.source, assignedTo: c.assignedTo,
  customFields: Object.fromEntries((c.customFields || []).map((f) => [f.id, f.value])),
});

const rawBefore = await getContact();
const before = pick(rawBefore);
if (env.HL_EXPECT_EMAIL && before.email !== env.HL_EXPECT_EMAIL) {
  console.error(`Refusing: contact ${env.HL_TEST_CONTACT_ID} has email ${before.email}, expected ${env.HL_EXPECT_EMAIL}`);
  process.exit(2);
}
const future = new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10);
const { ok, errors, lead } = validateLead({
  submissionId: crypto.randomUUID(), locale: "en",
  // The contact's own name/email so nothing about its identity changes.
  firstName: before.firstName, lastName: before.lastName, email: env.HL_TEST_EMAIL || before.email,
  phone: env.HL_TEST_PHONE || before.phone,
  commLanguage: "English", preferredMethod: "Email", smsConsent: false, consentText: "",
  eventType: "Corporate Event", eventDate: future, guests: "25", startTime: "7pm", endTime: "9pm",
  venueName: "Integration Test Venue", venueCity: "Test City", notes: "",
});
// A placeholder test phone (e.g. +19540000000) fails the site's NANP check; send the contact's
// EXISTING phone verbatim so the upsert matches and doesn't change it.
const onlyPhone = errors.length === 1 && errors[0].field === "phone";
if (!ok && !onlyPhone) throw new Error("payload invalid: " + JSON.stringify(errors));
if (onlyPhone) { lead.phone = before.phone; console.log(`NOTE: test phone ${before.phone} fails site validation; sent verbatim.`); }

const meta = await loadFieldMeta(env);
const resolved = resolveFields(meta.fields);
const { customFields } = buildCustomFields(lead, resolved);
const sentAt = new Date().toISOString();
const result = await upsertContact(env, lead, customFields);
const rawAfter = await getContact();
const after = pick(rawAfter);
if (env.HL_EVIDENCE_FILE) {
  const fs = await import("node:fs");
  fs.writeFileSync(env.HL_EVIDENCE_FILE, JSON.stringify({ sentAt, upsertBody: { firstName: lead.firstName, lastName: lead.lastName,
    email: lead.email, phone: lead.phone, customFields }, result, before: rawBefore, after: rawAfter }, null, 2));
}

const checks = [];
const same = (label, a, b) => checks.push([label, JSON.stringify(a) === JSON.stringify(b), a, b]);
same("matched the SAME contact", result.id, env.HL_TEST_CONTACT_ID);
same("not reported as new", result.isNew, false);
same("tags unchanged", before.tags, after.tags);
same("DND flag unchanged", before.dnd, after.dnd);
same("DND settings unchanged", before.dndSettings, after.dndSettings);
same("source unchanged", before.source, after.source);
same("assignment unchanged", before.assignedTo, after.assignedTo);
for (const slot of ["smsConsent", "notes", "relation", "partner1First", "partner1Last", "partner2First", "partner2Last"]) {
  const id = resolved[slot]?.id;
  if (id) same(`${slot} (${id}) unchanged`, before.customFields[id], after.customFields[id]);
}
// Every custom field this upsert did NOT write must be byte-identical.
const written = new Set(customFields.map((f) => f.id));
for (const id of new Set([...Object.keys(before.customFields), ...Object.keys(after.customFields)])) {
  if (!written.has(id)) same(`unwritten field ${id} unchanged`, before.customFields[id], after.customFields[id]);
}
same("name unchanged", [before.firstName, before.lastName], [after.firstName, after.lastName]);
same("email unchanged", before.email, after.email);
same("phone unchanged", before.phone, after.phone);
same("event type written", after.customFields[resolved.eventType.id], "Corporate Event");
same("preferred method written", after.customFields[resolved.preferredMethod.id], "Email");

let failed = 0;
for (const [label, pass, a, b] of checks) {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${pass ? "" : `\n      before: ${JSON.stringify(a)}\n      after:  ${JSON.stringify(b)}`}`);
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll returning-contact checks passed against real HighLevel.");
process.exit(failed ? 1 : 0);
