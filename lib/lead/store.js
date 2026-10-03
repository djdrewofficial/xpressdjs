/**
 * Durable inquiry ledger + job outbox (Cloudflare D1, binding `LEADS_DB`).
 *
 * lead_submissions — one row per browser submission ID. intake() writes the
 * validated inquiry (lead_json), this submission's consent record and a
 * `save` job in ONE D1 transaction BEFORE anything is sent to HighLevel, so
 * the scheduled Worker can always resume the contact save and every
 * follow-up even if the visitor's request dies or the visitor never returns.
 *
 * lead_jobs — the outbox, run by lib/lead/jobs.js:
 *   save    upsert the contact in HighLevel, then (one D1 transaction) mark the
 *           submission saved, queue the follow-ups and finish the save job
 *   note / source / alert — follow-ups queued by a successful save
 *
 * A D1 transaction only covers D1 rows. It can never undo a HighLevel write;
 * recovery after a remote save works by repeating the (idempotent-by-match)
 * upsert, not by rolling anything back. See docs/lead-alert-contract.md.
 *
 * D1 is REQUIRED: /api/lead refuses submissions without it.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lead_submissions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    lead_json TEXT,
    payload_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    contact_id TEXT,
    contact_new INTEGER,
    saved_at TEXT,
    sms_consent INTEGER NOT NULL,
    consent_text TEXT,
    consent_at TEXT NOT NULL,
    comm_language TEXT NOT NULL,
    preferred_method TEXT NOT NULL,
    form_locale TEXT NOT NULL,
    intake_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS lead_jobs (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    contact_id TEXT,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    ambiguous_attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    lease_until INTEGER,
    last_outcome TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT)`,
  "CREATE INDEX IF NOT EXISTS lead_jobs_due ON lead_jobs (status, next_attempt_at)",
  "CREATE INDEX IF NOT EXISTS lead_jobs_submission ON lead_jobs (submission_id)",
  "CREATE INDEX IF NOT EXISTS lead_submissions_created_at ON lead_submissions (created_at)",
];
export const SCHEMA_SQL = SCHEMA;

const ready = new WeakMap(); // db binding → Promise

export function ensureSchema(db) {
  if (!ready.has(db)) {
    const p = (async () => { for (const sql of SCHEMA) await db.prepare(sql).run(); })();
    p.catch(() => ready.delete(db)); // retry on the next request
    ready.set(db, p);
  }
  return ready.get(db);
}

/** Thin wrapper: every statement waits for the schema; batch() is one transaction. */
export function wrapDb(rawDb) {
  const stmtOf = (sql, args) => rawDb.prepare(sql).bind(...args);
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        sql,
        get args() { return args; },
        bind(...a) { args = a; return stmt; },
        async run() { await ensureSchema(rawDb); return stmtOf(sql, args).run(); },
        async first() { await ensureSchema(rawDb); return stmtOf(sql, args).first(); },
        async all() { await ensureSchema(rawDb); return stmtOf(sql, args).all(); },
      };
      return stmt;
    },
    async batch(stmts) {
      await ensureSchema(rawDb);
      return rawDb.batch(stmts.map((s) => stmtOf(s.sql, s.args)));
    },
  };
}

export const saveJobId = (submissionId) => `${submissionId}:save`;

export function createStore(rawDb, { now = () => Date.now() } = {}) {
  if (!rawDb) return null;
  const db = wrapDb(rawDb);
  const iso = () => new Date(now()).toISOString();

  return {
    db,
    ready: () => ensureSchema(rawDb),

    async get(id) {
      return db.prepare("SELECT * FROM lead_submissions WHERE id = ?").bind(id).first();
    },
    async saveJob(id) {
      return db.prepare("SELECT * FROM lead_jobs WHERE id = ?").bind(saveJobId(id)).first();
    },

    /**
     * Durably record the inquiry + its consent + a due `save` job (one D1
     * transaction). A repeat for an ID that isn't saved yet refreshes the
     * answers (the visitor may have corrected them) and makes the save due
     * now — reviving it if it had gone dead. A saved ID is never touched.
     */
    async intake(id, { lead, hash, source, submittedAt }) {
      const t = now();
      const c = lead.smsConsent;
      await db.batch([
        db.prepare(
          `INSERT INTO lead_submissions (id, status, lead_json, payload_hash, source, submitted_at, sms_consent,
              consent_text, consent_at, comm_language, preferred_method, form_locale, created_at, updated_at)
           VALUES (?, 'pending_save', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
              lead_json = excluded.lead_json, payload_hash = excluded.payload_hash, source = excluded.source,
              submitted_at = excluded.submitted_at, sms_consent = excluded.sms_consent,
              consent_text = excluded.consent_text, consent_at = excluded.consent_at,
              comm_language = excluded.comm_language, preferred_method = excluded.preferred_method,
              form_locale = excluded.form_locale, intake_count = lead_submissions.intake_count + 1,
              updated_at = excluded.updated_at
            WHERE lead_submissions.contact_id IS NULL`,
        ).bind(id, JSON.stringify(lead), hash, source, submittedAt, c ? 1 : 0, c ? lead.consentText : null,
          submittedAt, lead.commLanguage, lead.preferredMethod, lead.locale, iso(), iso()),
        db.prepare(
          `INSERT INTO lead_jobs (id, submission_id, kind, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, 'save', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
              next_attempt_at = excluded.next_attempt_at,
              attempts = CASE WHEN lead_jobs.status = 'dead' THEN 0 ELSE lead_jobs.attempts END,
              status = 'pending', finished_at = NULL, updated_at = excluded.updated_at
            WHERE lead_jobs.status IN ('pending', 'dead')`,
        ).bind(saveJobId(id), id, t, iso(), iso()),
      ]);
    },
  };
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
