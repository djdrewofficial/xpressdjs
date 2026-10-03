-- D1 schema for /api/lead (binding LEADS_DB) and workers/lead-alerts.
-- GENERATED from lib/lead/store.js SCHEMA_SQL — the code also applies it
-- idempotently on first use, so running this file is optional.
--   npx wrangler d1 execute xpress-leads --remote --file migrations/0001_lead_submissions.sql
-- lead_submissions: one row per browser submission ID. lead_json holds the
--   validated inquiry from intake (BEFORE any HighLevel write) until the save is
--   confirmed, then is wiped; consent columns are this submission's consent record.
-- lead_jobs: outbox (save / note / source / alert). Payloads are wiped on delivery;
--   dead jobs (and never-saved inquiries) keep personal data 30 days for manual recovery.
CREATE TABLE IF NOT EXISTS lead_submissions (
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
  updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS lead_jobs (
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
  finished_at TEXT);

CREATE INDEX IF NOT EXISTS lead_jobs_due ON lead_jobs (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS lead_jobs_submission ON lead_jobs (submission_id);

CREATE INDEX IF NOT EXISTS lead_submissions_created_at ON lead_submissions (created_at);
