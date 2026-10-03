// Fault injection: intake-before-save, interrupted/ambiguous saves, Worker recovery.
// MOCKED HighLevel + alert webhook; real SQLite D1 with injected failures.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mock, resetMock, env, post, wedding, upserts, notes, alerts, jobRows, fieldValue,
  withClock, subRow, jobRow, settleWithin,
} from "./helpers.mjs";
import { processDueJobs, claimJob, runSaveJob, LEASE_MS, BACKOFF_MS } from "../lib/lead/jobs.js";
import { createStore, wrapDb, saveJobId } from "../lib/lead/store.js";
import worker from "../workers/lead-alerts/index.js";

beforeEach(resetMock);
const cron = (e, offsetMs) => withClock(offsetMs, () => worker.scheduled({}, e, { waitUntil() {} }));
const SAVED_BATCH = /SET status = 'saved'/;
const inquiryNotes = () => notes().filter((n) => /WEBSITE INQUIRY — complete/.test(n.body.body));

// ---- database failure BEFORE any HighLevel write -------------------------------------
test("D1 fails at intake → 503 not_ready, nothing written anywhere", async () => {
  const e = env();
  e.LEADS_DB.faults.push({ match: /INSERT INTO lead_submissions/, mode: "throw", times: 1 });
  const p = wedding();
  const r = await post(p, e);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "not_ready");
  assert.equal(mock.calls.length, 0, "no HighLevel call of any kind");
  assert.equal(subRow(e, p.submissionId), undefined, "transaction rolled back");
  assert.equal(jobRows(e).length, 0);
  await cron(e, LEASE_MS * 10);
  assert.equal(mock.calls.length, 0, "the Worker has nothing to resume either");
});

test("D1 down for the pre-check → 503 not_ready before Turnstile or HighLevel", async () => {
  const e = env({ TURNSTILE_SECRET_KEY: "s" });
  e.LEADS_DB.faults.push({ match: /SELECT \* FROM lead_submissions/, mode: "throw", times: 1 });
  const r = await post(wedding(), e);
  assert.equal(r.body.code, "not_ready");
  assert.equal(mock.calls.length, 0);
});

// ---- HighLevel saves, then D1 fails, visitor never retries ----------------------------
test("HighLevel confirms, the D1 'saved' write fails, visitor leaves → Worker redoes save + follow-ups", async () => {
  const e = env();
  mock.behavior.contactId = "c_matched"; // HighLevel matches the same contact on every upsert
  e.LEADS_DB.faults.push({ match: SAVED_BATCH, mode: "throw", times: 1 });
  const p = wedding();
  const r = await post(p, e);
  assert.equal(r.status, 200, "HighLevel confirmed → visitor sees 'Inquiry received'");
  assert.equal(r.body.saved, true);
  const sub = subRow(e, p.submissionId);
  assert.equal(sub.contact_id, null, "D1 didn't record it");
  assert.ok(sub.lead_json, "inquiry still durable for recovery");
  assert.equal(jobRow(e, saveJobId(p.submissionId)).status, "sending", "save keeps its lease");
  assert.equal(alerts().length, 0);

  await cron(e, 1000);
  assert.equal(upserts().length, 1, "lease still held → nobody repeats the save yet");

  await cron(e, LEASE_MS + 1000); // the visitor is long gone; only the Worker runs
  assert.equal(upserts().length, 2, "upsert repeated (at-least-once) — same contact matched");
  const after = subRow(e, p.submissionId);
  assert.equal(after.contact_id, "c_matched");
  assert.equal(after.lead_json, null);
  const save = jobRow(e, saveJobId(p.submissionId));
  assert.equal(save.status, "delivered");
  assert.equal(save.ambiguous_attempts, 1, "the interrupted round is recorded as ambiguous");
  assert.equal(inquiryNotes().length, 1);
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].body.contactId, "c_matched");
});

// ---- process interruption -----------------------------------------------------------------
test("interrupted BEFORE the remote save (intake done, process killed) → Worker saves", async () => {
  const e = env();
  const p = wedding();
  // Exactly what the request did before dying: validated intake, nothing else.
  const store = createStore(e.LEADS_DB);
  const { validateLead } = await import("../lib/lead/validate.js");
  await store.intake(p.submissionId, {
    lead: validateLead(p).lead, hash: "h", source: "Website — Check Availability", submittedAt: new Date().toISOString(),
  });
  assert.equal(mock.calls.length, 0);
  await cron(e, 0);
  assert.equal(upserts().length, 1);
  assert.equal(subRow(e, p.submissionId).status, "saved");
  assert.equal(alerts().length, 1);
});

test("interrupted while waiting on HighLevel (request killed) → lease expires → Worker saves", async () => {
  const e = env();
  mock.behavior.upsert = "hang";
  const p = wedding();
  const r = await settleWithin(post(p, e), 50);
  assert.equal(r, "pending", "the request never answered (visitor sees a network error, answers kept)");
  assert.equal(jobRow(e, saveJobId(p.submissionId)).status, "sending");

  mock.behavior.upsert = "ok";
  await cron(e, LEASE_MS + 1000);
  assert.equal(subRow(e, p.submissionId).status, "saved");
  assert.equal(alerts().length, 1);
  // The visitor comes back and presses Submit again → told it's saved, nothing repeated.
  const again = await post(p, e);
  assert.equal(again.body.replay, true);
  assert.equal(alerts().length, 1);
});

test("interrupted AFTER the remote save, before the D1 write → Worker redoes it", async () => {
  const e = env();
  mock.behavior.contactId = "c_same";
  e.LEADS_DB.faults.push({ match: SAVED_BATCH, mode: "hang", times: 1 });
  const p = wedding();
  const r = await settleWithin(post(p, e), 50);
  assert.equal(r, "pending");
  assert.equal(upserts().length, 1, "HighLevel already has the contact");
  assert.equal(subRow(e, p.submissionId).contact_id, null);

  await cron(e, LEASE_MS + 1000);
  assert.equal(upserts().length, 2);
  assert.equal(subRow(e, p.submissionId).contact_id, "c_same");
  assert.equal(alerts().length, 1);
  assert.equal(inquiryNotes().length, 1);
});

test("ambiguous save (HighLevel processed it, response lost) → 502, then the visitor's retry re-upserts", async () => {
  const e = env();
  mock.behavior.upsert = "accepted-then-drop";
  mock.behavior.contactId = "c_amb";
  const p = wedding();
  const r1 = await post(p, e);
  assert.equal(r1.status, 502, "not confirmed → no 'Inquiry received'");
  assert.equal(r1.body.code, "save_failed");
  const job = jobRow(e, saveJobId(p.submissionId));
  assert.equal(job.last_outcome, "ambiguous");
  assert.equal(job.ambiguous_attempts, 1);
  mock.behavior.upsert = "ok";
  const r2 = await post(p, e);
  assert.equal(r2.status, 200);
  assert.equal(upserts().length, 2, "two remote writes for one inquiry — documented, not exactly-once");
  assert.equal(alerts().length, 1);
});

// ---- Worker recovery without a browser -----------------------------------------------------
test("HighLevel down at submit, visitor leaves; Worker retries with backoff and finishes", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  assert.equal((await post(p, e)).status, 502);
  await cron(e, 1000);
  assert.equal(upserts().length, 1, "backoff respected (not due yet)");
  await cron(e, BACKOFF_MS[0] + 1000); // still failing
  assert.equal(upserts().length, 2);
  mock.behavior.upsert = "ok";
  await cron(e, BACKOFF_MS[0] + BACKOFF_MS[1] + 2000);
  assert.equal(upserts().length, 3);
  assert.equal(subRow(e, p.submissionId).status, "saved");
  assert.equal(inquiryNotes().length, 1);
  assert.equal(alerts().length, 1);
});

test("Worker path keeps the consent / returning-contact protections", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  mock.behavior.upsertNew = false;
  const p = wedding({ preferredMethod: "Email", smsConsent: false, consentText: "", notes: "" });
  await post(p, e);
  mock.behavior.upsert = "ok";
  await cron(e, BACKOFF_MS[0] + 1000);
  const u = upserts().at(-1).body;
  assert.equal(fieldValue(u, "tvb20gkW3iqS94TVxPa9"), undefined);
  assert.equal(fieldValue(u, "wRyrPFfvHjgfJvu0x32G"), undefined);
  for (const k of ["tags", "dnd", "dndSettings", "source"]) assert.ok(!(k in u));
  assert.equal(jobRows(e).some((j) => j.kind === "source"), false);
  assert.equal(subRow(e, p.submissionId).sms_consent, 0);
});

// ---- concurrency + expired leases ------------------------------------------------------------
test("visitor retry while the Worker holds the save lease → 409 in_progress (no second save)", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  await post(p, e);
  const db = wrapDb(e.LEADS_DB);
  const held = await claimJob(db, saveJobId(p.submissionId), Date.now() + BACKOFF_MS[0] + 1);
  assert.ok(held, "Worker took the lease");
  mock.behavior.upsert = "ok";
  const r = await post(p, e);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "in_progress");
  assert.equal(upserts().length, 1);
});

test("Worker + Worker + visitor racing on a due save → exactly one runs it", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  await post(p, e);
  mock.behavior.upsert = "ok";
  mock.behavior.upsertDelay = 20;
  const off = BACKOFF_MS[0] + 1000;
  const results = await withClock(off, () => Promise.all([
    worker.scheduled({}, e, {}), worker.scheduled({}, e, {}), post(p, e),
  ]));
  assert.equal(upserts().length, 2, "1 failed at submit + exactly 1 now");
  assert.ok([200, 409].includes(results[2].status));
  assert.equal(alerts().length, 1);
});

test("expired lease: slow runner A and takeover runner B both upsert; follow-ups still queued once", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  await post(p, e);
  mock.behavior.upsert = "ok";
  mock.behavior.contactId = "c_race";
  mock.behavior.upsertDelay = 30;
  const db = wrapDb(e.LEADS_DB);
  const t0 = Date.now() + BACKOFF_MS[0] + 1;
  const A = await claimJob(db, saveJobId(p.submissionId), t0);
  const B = await claimJob(db, saveJobId(p.submissionId), t0 + LEASE_MS + 1); // A looked dead
  assert.ok(A && B);
  const [ra, rb] = await Promise.all([runSaveJob(db, e, A), runSaveJob(db, e, B)]);
  assert.ok(ra.saved && rb.saved);
  assert.equal(upserts().length, 3, "1 failed + A + B: a duplicate remote write after a lease expiry");
  assert.equal(subRow(e, p.submissionId).contact_id, "c_race");
  assert.deepEqual(jobRows(e).filter((j) => j.kind !== "save").map((j) => j.kind).sort(), ["alert", "note", "source"]);
  await processDueJobs(db, e, { now: () => t0 + LEASE_MS + 10 });
  assert.equal(alerts().length, 1);
  assert.equal(inquiryNotes().length, 1);
});

test("runner that loses the race checks first and skips the remote write", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  await post(p, e);
  mock.behavior.upsert = "ok";
  const db = wrapDb(e.LEADS_DB);
  const t0 = Date.now() + BACKOFF_MS[0] + 1;
  const A = await claimJob(db, saveJobId(p.submissionId), t0);
  const B = await claimJob(db, saveJobId(p.submissionId), t0 + LEASE_MS + 1);
  await runSaveJob(db, e, B);
  const ra = await runSaveJob(db, e, A); // A wakes up after B finished
  assert.equal(ra.state, "already_saved");
  assert.equal(upserts().length, 2, "A did not upsert again");
});

test("corrected answers on retry (after a failed save) are what gets saved", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding({ venueName: "Wrong Venue" });
  await post(p, e);
  mock.behavior.upsert = "ok";
  await post({ ...p, venueName: "Right Venue" }, e);
  assert.equal(fieldValue(upserts().at(-1).body, "EnDkjGtO0tZT1l4oj2ni"), "Right Venue");
  assert.equal(subRow(e, p.submissionId).intake_count, 2);
  // After it is saved, a "retry" with different answers changes nothing.
  await post({ ...p, venueName: "Third Venue" }, e);
  assert.equal(upserts().length, 2);
});

test("a dead save is revived by the visitor's next Submit", async () => {
  const e = env();
  mock.behavior.upsert = "fail";
  const p = wedding();
  await post(p, e);
  // Simulate the save having exhausted its retries.
  const db = wrapDb(e.LEADS_DB);
  await db.prepare("UPDATE lead_jobs SET status = 'dead', finished_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), saveJobId(p.submissionId)).run();
  mock.behavior.upsert = "ok";
  const r = await post(p, e);
  assert.equal(r.status, 200);
  assert.equal(jobRow(e, saveJobId(p.submissionId)).status, "delivered");
});
