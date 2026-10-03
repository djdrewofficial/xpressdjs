// Outbox delivery (lib/lead/jobs.js + workers/lead-alerts) — MOCKED endpoints, real SQLite D1.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mock, resetMock, env, post, wedding, alerts, notes, jobRows } from "./helpers.mjs";
import { processDueJobs, processSubmissionJobs, claimJob, finishJob, outboxStats, BACKOFF_MS, MAX_ATTEMPTS, LEASE_MS } from "../lib/lead/jobs.js";
import { wrapDb } from "../lib/lead/store.js";
import worker from "../workers/lead-alerts/index.js";

beforeEach(resetMock);

/** Save an inquiry whose alert fails during the request; returns env + alert job. */
async function savedWithFailingAlert(mode = "503") {
  const e = env();
  mock.behavior.alert = mode;
  const p = wedding();
  const r = await post(p, e);
  assert.equal(r.status, 200);
  const job = jobRows(e).find((j) => j.kind === "alert");
  return { e, p, job, db: wrapDb(e.LEADS_DB) };
}
const alertJob = (e) => jobRows(e).find((j) => j.kind === "alert");

test("visitor closed the browser after a failed alert → the scheduled Worker delivers it later", async () => {
  const { e, job } = await savedWithFailingAlert("503");
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.ok(job.next_attempt_at - Date.now() > 50e3 && job.next_attempt_at - Date.now() <= BACKOFF_MS[0], "backs off ~1 minute");

  mock.behavior.alert = "ok";
  const realNow = Date.now;
  Date.now = () => realNow() + BACKOFF_MS[0] + 1000; // a minute later, cron fires
  try {
    await worker.scheduled({}, e, { waitUntil() {} });
  } finally { Date.now = realNow; }
  const after = alertJob(e);
  assert.equal(after.status, "delivered");
  assert.equal(after.payload, null);
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].attempt, 2);
});

test("runner killed mid-send (lease expires) → reclaimed after LEASE_MS, counted as ambiguous, delivered", async () => {
  const e = env();
  mock.behavior.alert = "hang"; // the in-request runner never finishes
  const r = await post(wedding(), e, { jobs: "background" });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(alertJob(e).status, "sending");

  mock.behavior.alert = "ok";
  const db = wrapDb(e.LEADS_DB);
  const t0 = Date.now();
  const early = await processDueJobs(db, e, { now: () => t0 + 1000 });
  assert.equal(early.delivered, 0, "lease still held → nobody else sends");
  await processDueJobs(db, e, { now: () => t0 + LEASE_MS + 1000 });
  const j = alertJob(e);
  assert.equal(j.status, "delivered");
  assert.equal(j.ambiguous_attempts, 1, "the killed attempt is recorded as ambiguous");
  assert.equal(j.attempts, 2);
});

test("webhook accepted remotely but response lost → retried; duplicate copy carries the same deliveryId", async () => {
  const { e, db, p } = await savedWithFailingAlert("accepted-then-drop");
  let j = alertJob(e);
  assert.equal(j.status, "pending");
  assert.equal(j.last_outcome, "ambiguous");
  assert.equal(j.ambiguous_attempts, 1);
  assert.equal(mock.received.length, 1, "receiver DID process attempt 1");

  mock.behavior.alert = "ok";
  await processDueJobs(db, e, { now: () => Date.now() + BACKOFF_MS[0] + 1000 });
  j = alertJob(e);
  assert.equal(j.status, "delivered");
  assert.equal(mock.received.length, 2, "at-least-once: the receiver saw it twice");
  const ids = new Set(mock.received.map((b) => b.deliveryId));
  assert.deepEqual([...ids], [`${p.submissionId}:alert`], "same deliveryId on every copy (lets the receiver detect this repeat)");
  assert.deepEqual(mock.received.map((b) => b.attempt), [1, 2]);
});

test("concurrent runners (request + several cron isolates) → exactly one delivery", async () => {
  const { e, db } = await savedWithFailingAlert("503");
  mock.behavior.alert = "ok";
  const later = Date.now() + BACKOFF_MS[0] + 1000;
  const sid = alertJob(e).submission_id;
  await Promise.all([
    processDueJobs(db, e, { now: () => later }),
    processDueJobs(db, e, { now: () => later }),
    processDueJobs(db, e, { now: () => later }),
    processSubmissionJobs(db, e, sid, { now: () => later }),
    processSubmissionJobs(db, e, sid, { now: () => later }),
  ]);
  assert.equal(mock.received.length, 1);
  assert.equal(alertJob(e).status, "delivered");
});

test("a runner whose lease expired can't overwrite the new owner's result", async () => {
  const { e, db } = await savedWithFailingAlert("503");
  const t = Date.now() + BACKOFF_MS[0] + 1000;
  const a = await claimJob(db, alertJob(e).id, t);
  assert.ok(a);
  const b = await claimJob(db, a.id, t + LEASE_MS + 1);
  assert.ok(b, "B takes over the expired lease");
  assert.equal(await finishJob(db, b, { ok: true, outcome: "ok" }, t + LEASE_MS + 2), "delivered");
  assert.equal(await finishJob(db, a, { ok: false, outcome: "http_503", status: 503 }, t + LEASE_MS + 3), "lost_lease");
  assert.equal(alertJob(e).status, "delivered");
});

test("bounded backoff: 1m,5m,15m,1h,3h,6h,12h then DEAD — visible in stats, flagged on the contact", async () => {
  const { e, db } = await savedWithFailingAlert("503");
  const gaps = [];
  let t = Date.now();
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    const j = alertJob(e);
    gaps.push(j.next_attempt_at - t);
    t = j.next_attempt_at + 1;
    await processDueJobs(db, e, { now: () => t });
  }
  const dead = alertJob(e);
  assert.equal(dead.status, "dead");
  assert.equal(dead.attempts, MAX_ATTEMPTS);
  assert.ok(dead.payload, "payload kept for manual recovery");
  gaps.forEach((g, i) => assert.ok(Math.abs(g - BACKOFF_MS[i]) < 2000, `gap ${i}: ${g} vs ${BACKOFF_MS[i]}`));
  assert.ok(notes().some((n) => /AUTOMATION FAILED/.test(n.body.body) && /ALERT/.test(n.body.body)));
  const stats = await outboxStats(db);
  assert.ok(stats.open.some((r) => r.status === "dead" && r.kind === "alert" && r.n === 1));
  const before = mock.received.length;
  await processDueJobs(db, e, { now: () => t + 30 * 864e5 });
  assert.equal(mock.received.length, before, "dead jobs are never retried automatically");
});

test("404 from the alert webhook (workflow missing) → dead immediately", async () => {
  const { e } = await savedWithFailingAlert("404");
  const j = alertJob(e);
  assert.equal(j.status, "dead");
  assert.equal(j.attempts, 1);
  assert.equal(j.last_outcome, "http_404");
});

test("note job failing then recovering is retried too; no duplicate inquiry note", async () => {
  const e = env();
  mock.behavior.note = "fail";
  await post(wedding(), e);
  mock.behavior.note = "ok";
  await processDueJobs(wrapDb(e.LEADS_DB), e, { now: () => Date.now() + BACKOFF_MS[0] + 1000 });
  assert.equal(notes().filter((n) => /WEBSITE INQUIRY — complete/.test(n.body.body) ).length, 2, "1 failed + 1 delivered call");
  assert.equal(jobRows(e).find((j) => j.kind === "note").status, "delivered");
});

test("dead-job personal data is wiped after 30 days", async () => {
  const { e, db } = await savedWithFailingAlert("404");
  await processDueJobs(db, e, { now: () => Date.now() + 31 * 864e5 });
  assert.equal(alertJob(e).payload, null);
  assert.equal(alertJob(e).status, "dead");
});

test("worker without config logs and does nothing", async () => {
  await worker.scheduled({}, { LEADS_DB: undefined }, {});
  assert.equal(mock.calls.length, 0);
});
