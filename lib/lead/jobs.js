/**
 * Outbox runner for inquiries (table lead_jobs, see store.js).
 *
 * Job kinds (deterministic ID `${submissionId}:${kind}`, so never queued twice):
 *   save    — upsert the contact in HighLevel from the inquiry stored at intake,
 *             then ONE D1 transaction: submission saved + follow-ups queued +
 *             save job finished. If that D1 write fails after HighLevel
 *             confirmed, the job keeps its lease; when the lease expires the
 *             scheduled Worker repeats the upsert (HighLevel matches the same
 *             contact under the account's duplicate settings) and the D1 write.
 *   note    — the full inquiry + per-submission consent record on the contact
 *   source  — sets Source, only queued when the upsert CREATED the contact
 *   alert   — POSTs the completed-inquiry alert to LEAD_ALERT_WEBHOOK_URL
 *
 * Who runs them: /api/lead (the save inline, follow-ups via waitUntil) and the
 * scheduled Worker in workers/lead-alerts, every minute, for anything due or
 * whose lease expired. Pages Functions cannot run on a schedule themselves.
 *
 * Guarantees — AT-LEAST-ONCE, never exactly-once:
 *   - While a runner holds a job's lease, no other runner starts that job.
 *     A lease that expires (runner killed, or slower than LEASE_MS) lets
 *     another runner start it again, so the remote side can see a repeat.
 *   - No response (timeout / dropped connection) is AMBIGUOUS: the remote side
 *     may have acted. It is retried and counted in `ambiguous_attempts`.
 *   - A repeated contact save is an upsert of the same values, which HighLevel
 *     matches to the same contact — unless the account allows duplicate
 *     contacts, in which case a repeat could create a second contact.
 *   - Repeated notes/alerts are possible; alerts carry a stable `deliveryId`.
 *   - Retries back off 1m, 5m, 15m, 1h, 3h, 6h, 12h (8 attempts ≈ 22.5h); then
 *     — or at once on 400/404/410/422 — the job is `dead`: kept for manual
 *     recovery (personal data 30 days), counted by GET /api/lead, logged, and
 *     flagged with a note on the contact when there is one.
 */
import {
  createNote, updateContactSource, loadFieldMeta, resolveFields, buildCustomFields, upsertContact, inquiryNote,
} from "./highlevel.js";
import { buildAlertPayload } from "./alert.js";

export const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const LEASE_MS = 60 * 1000;
export const DEAD_PAYLOAD_RETENTION_MS = 30 * 24 * 3600e3;
const TERMINAL_HTTP = new Set([400, 404, 410, 422]);
const KIND_ORDER = "CASE kind WHEN 'save' THEN 0 WHEN 'note' THEN 1 WHEN 'source' THEN 2 ELSE 3 END";

/**
 * Atomically take the lease on one job. → job row (after claim) or null.
 * `ignoreSchedule` lets a visitor's own retry run a pending save immediately
 * instead of waiting for its backoff.
 */
export async function claimJob(db, id, now, { ignoreSchedule = false } = {}) {
  const lease = now + LEASE_MS;
  const pendingCond = ignoreSchedule ? "status = 'pending'" : "(status = 'pending' AND next_attempt_at <= ?)";
  const args = [lease, new Date(now).toISOString(), id, ...(ignoreSchedule ? [] : [now]), now];
  const r = await db.prepare(
    `UPDATE lead_jobs
        SET ambiguous_attempts = ambiguous_attempts + CASE WHEN status = 'sending' THEN 1 ELSE 0 END,
            status = 'sending', lease_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND (${pendingCond} OR (status = 'sending' AND lease_until < ?))`,
  ).bind(...args).run();
  if (r.meta.changes !== 1) return null;
  const job = await db.prepare("SELECT * FROM lead_jobs WHERE id = ?").bind(id).first();
  return job && job.lease_until === lease ? job : null;
}

/** HTTP helper errors look like "... HTTP nnn: ..."; anything else had no response. */
function classify(e) {
  const m = /HTTP (\d{3})/.exec((e && e.message) || "");
  if (m) return { ok: false, outcome: `http_${m[1]}`, status: +m[1], error: e.message };
  return { ok: false, outcome: "ambiguous", error: (e && e.message) || String(e) };
}

/** Perform one follow-up job. → { ok, outcome, status?, error? } — never throws. */
export async function deliver(job, env, fetchImpl) {
  const payload = JSON.parse(job.payload || "{}");
  try {
    if (job.kind === "note") {
      await createNote(env, job.contact_id, payload.body, { fetchImpl });
      return { ok: true, outcome: "ok" };
    }
    if (job.kind === "source") {
      await updateContactSource(env, job.contact_id, payload.source, { fetchImpl });
      return { ok: true, outcome: "ok" };
    }
    if (job.kind === "alert") {
      if (!env.LEAD_ALERT_WEBHOOK_URL) return { ok: false, outcome: "not_configured", error: "LEAD_ALERT_WEBHOOK_URL not set" };
      const body = { ...payload, attempt: job.attempts, sentAt: new Date().toISOString() };
      const res = await fetchImpl(env.LEAD_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Xpress-Delivery-Id": payload.deliveryId,
          "X-Xpress-Attempt": String(job.attempts),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true, outcome: "ok", status: res.status };
      return { ok: false, outcome: `http_${res.status}`, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: false, outcome: "unknown_kind", status: 400, error: `unknown job kind ${job.kind}` };
  } catch (e) {
    return classify(e);
  }
}

/** Record a non-save result — only if we still hold the lease. → "delivered" | "retry" | "dead" | "lost_lease" */
export async function finishJob(db, job, result, now) {
  const at = new Date(now).toISOString();
  const err = result.error ? String(result.error).slice(0, 500) : null;
  if (result.ok) {
    const r = await db.prepare(
      `UPDATE lead_jobs SET status = 'delivered', payload = NULL, lease_until = NULL, last_outcome = 'ok',
              last_error = NULL, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'sending' AND lease_until = ?`,
    ).bind(at, at, job.id, job.lease_until).run();
    return r.meta.changes === 1 ? "delivered" : "lost_lease";
  }
  const amb = result.outcome === "ambiguous" ? 1 : 0;
  const terminal = TERMINAL_HTTP.has(result.status) || job.attempts >= MAX_ATTEMPTS;
  if (terminal) {
    const r = await db.prepare(
      `UPDATE lead_jobs SET status = 'dead', lease_until = NULL, last_outcome = ?, last_error = ?,
              ambiguous_attempts = ambiguous_attempts + ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'sending' AND lease_until = ?`,
    ).bind(result.outcome, err, amb, at, at, job.id, job.lease_until).run();
    return r.meta.changes === 1 ? "dead" : "lost_lease";
  }
  const next = now + BACKOFF_MS[Math.min(job.attempts, BACKOFF_MS.length) - 1];
  const r = await db.prepare(
    `UPDATE lead_jobs SET status = 'pending', lease_until = NULL, next_attempt_at = ?, last_outcome = ?,
            last_error = ?, ambiguous_attempts = ambiguous_attempts + ?, updated_at = ?
      WHERE id = ? AND status = 'sending' AND lease_until = ?`,
  ).bind(next, result.outcome, err, amb, at, job.id, job.lease_until).run();
  return r.meta.changes === 1 ? "retry" : "lost_lease";
}

/** Follow-up jobs for a confirmed save. */
export function followUpJobs(lead, sub, contact, skipped, locationId) {
  const ctx = { source: sub.source, submittedAt: sub.submitted_at, skipped };
  return [
    { kind: "note", payload: { body: inquiryNote(lead, ctx) } },
    ...(contact.isNew ? [{ kind: "source", payload: { source: sub.source } }] : []),
    {
      kind: "alert",
      payload: buildAlertPayload(lead, {
        submissionId: sub.id, contactId: contact.id, contactIsNew: contact.isNew,
        locationId, source: sub.source, submittedAt: sub.submitted_at,
      }),
    },
  ];
}

/**
 * Run a claimed `save` job.
 * → { state: "delivered" | "local_write_failed" | "retry" | "dead" | "lost_lease" | "already_saved",
 *     saved: boolean }   — saved = HighLevel confirmed the contact during this run
 *                          (or an earlier run already recorded it).
 */
export async function runSaveJob(db, env, job, { fetchImpl = fetch, now = Date.now } = {}) {
  const sub = await db.prepare("SELECT * FROM lead_submissions WHERE id = ?").bind(job.submission_id).first();
  const at = () => new Date(now()).toISOString();
  const finishDelivered = () => db.prepare(
    `UPDATE lead_jobs SET status = 'delivered', lease_until = NULL, last_outcome = 'ok', last_error = NULL,
            updated_at = ?, finished_at = ? WHERE id = ? AND status = 'sending' AND lease_until = ?`,
  ).bind(at(), at(), job.id, job.lease_until);

  if (sub && sub.contact_id) { // a racing runner already recorded the save
    await finishDelivered().run();
    return { state: "already_saved", saved: true };
  }
  if (!sub || !sub.lead_json) {
    const state = await finishJob(db, job, { ok: false, outcome: "missing_inquiry", status: 400, error: "inquiry row missing" }, now());
    return { state, saved: false };
  }
  const lead = JSON.parse(sub.lead_json);

  // 1) Remote write. Not undoable; a repeat is an upsert of the same values.
  let contact, skipped;
  try {
    const meta = await loadFieldMeta(env, { fetchImpl });
    const built = buildCustomFields(lead, resolveFields(meta.fields));
    skipped = built.skipped;
    contact = await upsertContact(env, lead, built.customFields, { fetchImpl });
  } catch (e) {
    const result = classify(e);
    const state = await finishJob(db, job, result, now());
    console.log(`lead-jobs: save ${job.id} attempt ${job.attempts} failed (${result.outcome}) → ${state}`);
    return { state, saved: false };
  }

  // 2) Local record, one transaction. If it fails the save job keeps its lease
  //    and is redone (upsert + this write) once the lease expires.
  const t = now();
  const jobs = followUpJobs(lead, sub, contact, skipped, env.GHL_LOCATION_ID);
  try {
    await db.batch([
      db.prepare(
        `UPDATE lead_submissions SET status = 'saved', contact_id = ?, contact_new = ?, saved_at = ?,
                lead_json = NULL, updated_at = ?
          WHERE id = ? AND contact_id IS NULL`,
      ).bind(contact.id, contact.isNew ? 1 : 0, at(), at(), sub.id),
      ...jobs.map((j) => db.prepare(
        `INSERT INTO lead_jobs (id, submission_id, kind, contact_id, payload, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).bind(`${sub.id}:${j.kind}`, sub.id, j.kind, contact.id, JSON.stringify(j.payload), t, at(), at())),
      finishDelivered(),
    ]);
  } catch (e) {
    console.log(`lead-jobs: HighLevel saved contact ${contact.id} for ${sub.id} but the D1 write failed ` +
      `(${e.message}); the save will be redone after the lease expires`);
    return { state: "local_write_failed", saved: true, contactId: contact.id };
  }
  return { state: "delivered", saved: true, contactId: contact.id };
}

async function flagDead(env, job, result, fetchImpl) {
  console.log(`lead-jobs: DEAD ${job.id} after ${job.attempts} attempts (${result.outcome}: ${result.error || ""})`);
  if (job.kind === "source" || !job.contact_id) return; // a dead save has no contact to flag
  const what = job.kind === "alert" ? "new-inquiry ALERT to the team" : "inquiry details NOTE";
  await createNote(env, job.contact_id,
    `⚠️ WEBSITE INQUIRY — AUTOMATION FAILED. The ${what} could not be delivered after ${job.attempts} ` +
    `attempt(s) (last result: ${result.outcome}). Submission ${job.submission_id}. Please follow up with this ` +
    `contact manually and check the inquiry outbox (job ${job.id}).`,
    { fetchImpl }).catch((e) => console.log(`lead-jobs: could not flag ${job.id} on the contact:`, e.message));
}

async function runIds(db, env, ids, { fetchImpl, now }) {
  const summary = { delivered: 0, retry: 0, dead: 0, skipped: 0, lost_lease: 0, local_write_failed: 0, already_saved: 0 };
  for (const id of ids) {
    const job = await claimJob(db, id, now());
    if (!job) { summary.skipped++; continue; }
    if (job.kind === "save") {
      const r = await runSaveJob(db, env, job, { fetchImpl, now });
      summary[r.state]++;
      if (r.state === "dead") console.log(`lead-jobs: DEAD ${job.id} — the inquiry was never confirmed saved in HighLevel`);
      // The follow-ups this save just queued are due now.
      if (r.state === "delivered") {
        const more = await processSubmissionJobs(db, env, job.submission_id, { fetchImpl, now });
        for (const k of Object.keys(more)) summary[k] += more[k];
      }
      continue;
    }
    const result = await deliver(job, env, fetchImpl);
    const state = await finishJob(db, job, result, now());
    summary[state]++;
    if (state === "retry") console.log(`lead-jobs: ${job.id} attempt ${job.attempts} failed (${result.outcome}), will retry`);
    if (state === "dead") await flagDead(env, job, result, fetchImpl);
  }
  return summary;
}

/** Run every unfinished follow-up of one submission (right after its save). */
export async function processSubmissionJobs(db, env, submissionId, { fetchImpl = fetch, now = Date.now } = {}) {
  const { results } = await db.prepare(
    `SELECT id FROM lead_jobs WHERE submission_id = ? AND kind != 'save' AND status IN ('pending', 'sending')
      ORDER BY ${KIND_ORDER}`,
  ).bind(submissionId).all();
  return runIds(db, env, results.map((r) => r.id), { fetchImpl, now });
}

/** Run jobs that are due or whose lease expired (scheduled Worker). */
export async function processDueJobs(db, env, { fetchImpl = fetch, now = Date.now, limit = 25 } = {}) {
  const t = now();
  const { results } = await db.prepare(
    `SELECT id FROM lead_jobs
      WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'sending' AND lease_until < ?)
      ORDER BY ${KIND_ORDER}, next_attempt_at LIMIT ?`,
  ).bind(t, t, limit).all();
  const summary = await runIds(db, env, results.map((r) => r.id), { fetchImpl, now });
  // Retention: personal data of dead jobs / never-saved inquiries kept 30 days.
  const cutoff = new Date(t - DEAD_PAYLOAD_RETENTION_MS).toISOString();
  await db.prepare("UPDATE lead_jobs SET payload = NULL WHERE status = 'dead' AND payload IS NOT NULL AND finished_at < ?")
    .bind(cutoff).run();
  await db.prepare(
    `UPDATE lead_submissions SET lead_json = NULL WHERE lead_json IS NOT NULL AND contact_id IS NULL AND id IN
       (SELECT submission_id FROM lead_jobs WHERE kind = 'save' AND status = 'dead' AND finished_at < ?)`,
  ).bind(cutoff).run();
  return summary;
}

/** Counts for the readiness endpoint / monitoring. No personal data. */
export async function outboxStats(db, { now = Date.now() } = {}) {
  const { results } = await db.prepare(
    `SELECT status, kind, COUNT(*) AS n, MIN(created_at) AS oldest FROM lead_jobs
      WHERE status IN ('pending', 'sending', 'dead') GROUP BY status, kind`,
  ).all();
  const overdue = await db.prepare(
    `SELECT COUNT(*) AS n FROM lead_jobs
      WHERE (status = 'pending' AND next_attempt_at < ?) OR (status = 'sending' AND lease_until < ?)`,
  ).bind(now - 5 * 60e3, now - 5 * 60e3).first();
  return { open: results, overdueOver5Min: overdue ? overdue.n : 0 };
}
