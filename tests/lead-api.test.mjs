// POST/GET /api/lead — MOCKED HighLevel / alert webhook / Turnstile, real SQLite D1.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mock, resetMock, env, post, get, wedding, upserts, notes, alerts, sourcePuts, callsTo, jobRows, fieldValue,
  makeD1, META, OLD_S1_WEBHOOK, ALERT_URL,
} from "./helpers.mjs";
import { PINNED_FIELDS, resolveFields } from "../lib/lead/highlevel.js";
import { validateLead, normalizePhone, normalizeTime, todayInBusinessTz } from "../lib/lead/validate.js";
import { SCHEMA_SQL } from "../lib/lead/store.js";

beforeEach(resetMock);

// ---- launch requirements / readiness ----------------------------------------------
test("no D1 binding → 503 not_ready, nothing sent to HighLevel", async () => {
  const r = await post(wedding(), env({ LEADS_DB: undefined }));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "not_ready");
  assert.equal(mock.calls.length, 0);
});

test("missing alert webhook / token / location → 503 not_ready", async () => {
  for (const over of [{ LEAD_ALERT_WEBHOOK_URL: "" }, { LEAD_ALERT_WEBHOOK_URL: "http://plain.example" },
    { GHL_API_TOKEN: "" }, { GHL_LOCATION_ID: "" }]) {
    const r = await post(wedding(), env(over));
    assert.equal(r.status, 503, JSON.stringify(over));
    assert.equal(r.body.code, "not_ready");
  }
  assert.equal(mock.calls.length, 0);
});

test("D1 failing at request time → 503 not_ready (visitor keeps answers client-side)", async () => {
  const broken = { prepare() { throw new Error("D1_ERROR: unavailable"); }, batch() { throw new Error("x"); } };
  const r = await post(wedding(), env({ LEADS_DB: broken }));
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "not_ready");
  assert.equal(upserts().length, 0);
});

test("GET /api/lead readiness: booleans publicly, outbox counts only with the token", async () => {
  const ok = await get(env({ READINESS_TOKEN: "rt" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ready, true);
  assert.equal(ok.body.outbox, undefined);
  const withToken = await get(env({ READINESS_TOKEN: "rt" }), { "X-Readiness-Token": "rt" });
  assert.ok(withToken.body.outbox && Array.isArray(withToken.body.outbox.open));
  const bad = await get(env({ LEADS_DB: undefined, LEAD_ALERT_WEBHOOK_URL: "" }));
  assert.equal(bad.status, 503);
  assert.equal(bad.body.checks.leadsDb, false);
  assert.equal(bad.body.checks.alertWebhook, false);
  assert.ok(!JSON.stringify(bad.body).includes("test-token"), "never echoes secret values");
});

// ---- complete submission ------------------------------------------------------------
test("complete inquiry: contact saved synchronously, then note → source → alert; old S1 webhook never called", async () => {
  const e = env();
  const p = wedding();
  const r = await post(p, e);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, submissionId: p.submissionId, saved: true, replay: false });

  const order = mock.calls.map((c) => c.url.endsWith("/contacts/upsert") ? "upsert"
    : c.url.includes("/notes") ? "note" : c.method === "PUT" ? "source" : c.url === ALERT_URL ? "alert" : "meta");
  assert.deepEqual(order, ["meta", "upsert", "note", "source", "alert"]);
  assert.equal(callsTo((c) => c.url === OLD_S1_WEBHOOK).length, 0, "S1 contact-rewriting webhook not used");

  const u = upserts()[0].body;
  for (const k of ["tags", "source", "dnd", "dndSettings", "assignedTo"]) assert.ok(!(k in u), `upsert must not send ${k}`);
  assert.equal(u.email, "ana@example.com");
  assert.equal(u.phone, "+19545551234");
  assert.equal(fieldValue(u, "EnDkjGtO0tZT1l4oj2ni"), "The Addison");
  assert.equal(fieldValue(u, "wRyrPFfvHjgfJvu0x32G"), "Bilingual please");
  assert.ok(fieldValue(u, "tvb20gkW3iqS94TVxPa9")[0].startsWith("By checking this box"));

  assert.deepEqual(sourcePuts()[0].body, { source: "Website — Miami Wedding DJ" });

  const a = alerts()[0];
  assert.equal(a.headers["X-Xpress-Delivery-Id"], `${p.submissionId}:alert`);
  assert.equal(a.headers["X-Xpress-Attempt"], "1");
  assert.equal(a.body.event, "website_inquiry.completed");
  assert.equal(a.body.version, 1);
  assert.equal(a.body.submissionId, p.submissionId);
  assert.match(a.body.contactId, /^contact_/);
  assert.equal(a.body.smsConsentThisSubmission, "Yes");
  assert.equal(a.body.attempt, 1);

  const sub = e.LEADS_DB.raw.prepare("SELECT * FROM lead_submissions").get();
  assert.equal(sub.status, "saved");
  assert.equal(sub.lead_json, null, "stored inquiry wiped once saved");
  assert.equal(sub.sms_consent, 1);
  assert.match(sub.consent_text, /^I consent/);
  assert.equal(sub.preferred_method, "SMS");
  const jobs = jobRows(e);
  assert.deepEqual(jobs.map((j) => [j.kind, j.status, j.payload]), [
    ["alert", "delivered", null], ["note", "delivered", null], ["save", "delivered", null], ["source", "delivered", null],
  ], "all delivered, personal data wiped from the outbox");
});

test("visitor gets success even if every follow-up fails; jobs stay queued", async () => {
  const e = env();
  mock.behavior.note = "fail"; mock.behavior.source = "fail"; mock.behavior.alert = "503";
  const r = await post(wedding(), e);
  assert.equal(r.status, 200);
  const followUps = jobRows(e).filter((j) => j.kind !== "save");
  assert.equal(followUps.length, 3);
  assert.ok(followUps.every((j) => j.status === "pending" && j.attempts === 1 && j.payload));
});

test("response is sent before follow-ups finish (calendar isn't held up by alerts)", async () => {
  const e = env();
  mock.behavior.alert = "hang";
  const r = await post(wedding(), e, { jobs: "background" });
  assert.equal(r.status, 200);
  assert.equal(r.pending.length, 1, "follow-ups handed to waitUntil");
  // Let note + source finish inside this test; the alert stays hung (no more calls).
  await new Promise((res) => setTimeout(res, 30));
});

// ---- returning contact ----------------------------------------------------------------
test("returning contact, box unticked, email preference: nothing granted, revoked, tagged or blanked", async () => {
  const e = env();
  mock.behavior.upsertNew = false;
  mock.behavior.contactId = "existing_contact";
  const p = wedding({
    preferredMethod: "Email", smsConsent: false, consentText: "", notes: "",
    eventType: "Corporate Event", relation: "", partner1First: "", partner1Last: "", partner2First: "", partner2Last: "",
  });
  const r = await post(p, e);
  assert.equal(r.status, 200);
  const u = upserts()[0].body;
  assert.equal(fieldValue(u, "tvb20gkW3iqS94TVxPa9"), undefined, "SMS Consent field untouched (neither granted nor revoked)");
  for (const k of ["tags", "dnd", "dndSettings", "source"]) assert.ok(!(k in u));
  for (const id of ["wRyrPFfvHjgfJvu0x32G", "z2c8pTbP8aOIIHOJ7rp6", "kddP7XrKS52pD6CdYSUg", "dPVY9xurcduLSc3Q4eV8",
    "vchmp7srRzRIsk03ONVH", "VzFUtxB9e6rww1kBBdsR"]) {
    assert.equal(fieldValue(u, id), undefined, `empty optional/conditional field ${id} not sent`);
  }
  assert.ok(u.customFields.every((f) => f.field_value !== "" && f.field_value != null), "no empty values at all");
  assert.equal(callsTo((c) => /\/tags|\/dnd|campaigns|workflow/.test(c.url)).length, 0);
  assert.equal(sourcePuts().length, 0, "existing contact's Source left alone");
  assert.equal(jobRows(e).some((j) => j.kind === "source"), false);

  const note = notes()[0].body.body;
  assert.match(note, /CONSENT RECORD FOR THIS SUBMISSION/);
  assert.match(note, /box NOT ticked .* This is not an opt-out: existing consent and DND settings were left unchanged/);
  const sub = e.LEADS_DB.raw.prepare("SELECT sms_consent, consent_text, preferred_method FROM lead_submissions").get();
  assert.deepEqual({ ...sub }, { sms_consent: 0, consent_text: null, preferred_method: "Email" });
  assert.equal(alerts()[0].body.smsConsentThisSubmission, "No");
  assert.equal(alerts()[0].body.contactIsNew, false);
});

test("smsConsent must be a real boolean true — strings are not consent", async () => {
  await post(wedding({ preferredMethod: "Email", smsConsent: "true" }), env());
  assert.equal(fieldValue(upserts()[0].body, "tvb20gkW3iqS94TVxPa9"), undefined);
});

test("Spanish visitor, Other event: canonical values, subtype in note + alert", async () => {
  const p = wedding({
    locale: "es", commLanguage: "Spanish", eventType: "Other", eventTypeOther: "Quinceanera",
    relation: "", partner1First: "", partner1Last: "", partner2First: "", partner2Last: "",
  });
  await post(p, env());
  const u = upserts()[0].body;
  assert.equal(fieldValue(u, "hLBakaZYdqZdE15Ub6QZ"), "Other");
  assert.equal(fieldValue(u, "SAKxQ1MfRAHEFkCcpFMQ"), "Spanish");
  assert.match(notes()[0].body.body, /Event: Other — Quinceanera/);
  assert.equal(alerts()[0].body.eventTypeLabel, "Quinceanera");
  assert.equal(alerts()[0].body.formLanguage, "es");
});

// ---- validation -------------------------------------------------------------------------
test("invalid submissions are rejected with field codes and nothing is sent", async () => {
  const cases = [
    [{ email: "ana@example" }, "email", "invalid_email"],
    [{ phone: "555-1234" }, "phone", "invalid_phone"],
    [{ eventDate: "2020-01-01" }, "eventDate", "past_date"],
    [{ eventDate: "2027-02-30" }, "eventDate", "invalid_date"],
    [{ eventDate: "2099-01-01" }, "eventDate", "date_too_far"],
    [{ guests: "0" }, "guests", "invalid_guests"],
    [{ startTime: "6:00" }, "startTime", "invalid_time"],
    [{ partner2Last: "" }, "partner2Last", "required"],
    [{ relation: "Cousin" }, "relation", "invalid_choice"],
    [{ eventType: "Other", eventTypeOther: "" }, "eventTypeOther", "required"],
    [{ commLanguage: "French" }, "commLanguage", "invalid_choice"],
    [{ preferredMethod: "SMS", smsConsent: false }, "smsConsent", "consent_required_for_sms"],
    [{ venueCity: " " }, "venueCity", "required"],
    [{ notes: "x".repeat(2001) }, "notes", "too_long"],
    [{ submissionId: "abc" }, "submissionId", "invalid"],
  ];
  for (const [over, field, code] of cases) {
    const r = await post(wedding(over), env());
    assert.equal(r.status, 422, JSON.stringify(over));
    assert.ok(r.body.errors.some((x) => x.field === field && x.code === code),
      `${JSON.stringify(over)} → expected ${field}/${code}, got ${JSON.stringify(r.body.errors)}`);
  }
  const legacy = await post({ firstName: "A", phone: "9545551234", email: "a@b.co", smsConsent: true, stage: "step-1", complete: false }, env());
  assert.equal(legacy.status, 422, "old partial-capture payloads rejected");
  assert.equal(mock.calls.length, 0);
});

test("honeypot pretends success without sending anything", async () => {
  const r = await post(wedding({ company: "spam inc" }), env());
  assert.equal(r.body.ok, true);
  assert.equal(mock.calls.length, 0);
});

// ---- duplicates / retries ---------------------------------------------------------------
test("retrying a saved submission: success, no second save, no second note or alert", async () => {
  const e = env();
  const p = wedding();
  await post(p, e);
  const again = await post({ ...p, turnstileToken: "" }, e);
  assert.equal(again.body.replay, true);
  assert.equal(upserts().length, 1);
  assert.equal(notes().length, 1);
  assert.equal(alerts().length, 1);
});

test("double click: concurrent requests with one ID → one save, one alert", async () => {
  const e = env();
  const p = wedding();
  mock.behavior.upsertDelay = 50;
  const [a, b] = await Promise.all([post(p, e), post(p, e)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const retry = await post(p, e);
  assert.equal(retry.body.ok, true);
  assert.equal(upserts().length, 1);
  assert.equal(alerts().length, 1);
});

test("HighLevel save failure → 502 save_failed, save stays queued; visitor retry saves once, right away", async () => {
  const e = env();
  const p = wedding();
  mock.behavior.upsert = "fail";
  const r1 = await post(p, e);
  assert.equal(r1.status, 502);
  assert.equal(r1.body.code, "save_failed");
  assert.deepEqual(jobRows(e).map((j) => [j.kind, j.status]), [["save", "pending"]], "only the save is queued; no follow-ups");
  mock.behavior.upsert = "ok";
  const r2 = await post(p, e); // within the 1-minute backoff: the visitor's retry runs it immediately
  assert.equal(r2.status, 200);
  assert.equal(alerts().length, 1);
});

test("Turnstile enforced when configured; saved-ID replays skip it", async () => {
  const e = env({ TURNSTILE_SECRET_KEY: "secret" });
  const p = wedding({ turnstileToken: "" });
  assert.equal((await post(p, e)).body.code, "antispam");
  mock.behavior.turnstile = false;
  assert.equal((await post({ ...p, turnstileToken: "bad" }, e)).status, 403);
  mock.behavior.turnstile = true;
  assert.equal((await post({ ...p, turnstileToken: "good" }, e)).status, 200);
  assert.equal((await post({ ...p, turnstileToken: "" }, e)).status, 200);
  assert.equal(upserts().length, 1);
});

// ---- metadata / schema / helpers ----------------------------------------------------------
test("field resolution: live metadata and pinned snapshot agree; comments → Booking Comments", async () => {
  mock.behavior.meta = "fail";
  assert.equal((await post(wedding(), env())).status, 200);
  const live = resolveFields(META.customFields);
  const pinned = resolveFields(PINNED_FIELDS);
  assert.equal(Object.keys(live).length, 18);
  for (const slot of Object.keys(live)) assert.equal(pinned[slot].id, live[slot].id, slot);
  assert.equal(live.notes.id, "wRyrPFfvHjgfJvu0x32G");
});

test("runtime schema matches the migration file", async () => {
  const e = env();
  await post(wedding(), e);
  const viaMigration = makeD1({ migrate: true });
  for (const t of ["lead_submissions", "lead_jobs"]) {
    const cols = (raw) => raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
    assert.deepEqual(cols(e.LEADS_DB.raw), cols(viaMigration.raw), t);
  }
  assert.equal(SCHEMA_SQL.length, 5);
});

test("normalizers + Eastern-time date rule", () => {
  assert.equal(normalizePhone("1 (954) 555 1234"), "+19545551234");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeTime("6:30 p. m."), "6:30 PM");
  assert.equal(normalizeTime("18:00"), "6:00 PM");
  assert.equal(normalizeTime("6:00"), "");
  assert.equal(todayInBusinessTz(new Date("2027-03-02T01:30:00Z")), "2027-03-01");
  const v = validateLead(wedding({ eventDate: "2027-03-01" }), { today: "2027-03-01" });
  assert.ok(!v.errors.some((x) => x.field === "eventDate"));
});
