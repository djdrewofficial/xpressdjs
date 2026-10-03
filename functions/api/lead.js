/**
 * Cloudflare Pages Function — Check Availability inquiry.
 *
 * POST /api/lead — accepts only COMPLETE inquiries:
 *   1. Refuse (503 not_ready, visitor keeps their answers) unless every launch
 *      requirement is configured — including the D1 ledger.
 *   2. Validate every required + conditional field (lib/lead/validate.js).
 *   3. INTAKE: write the validated inquiry, this submission's consent record
 *      and a `save` job to D1 in one transaction — BEFORE any HighLevel call.
 *      If D1 can't take it, nothing is sent to HighLevel (503 not_ready).
 *   4. Take the save job's lease and run it here: upsert the contact in
 *      HighLevel, then (one D1 transaction) mark it saved + queue the note /
 *      source / alert follow-ups. The browser hears "saved" ONLY once
 *      HighLevel has confirmed the contact.
 *   5. Anything unfinished — a failed or interrupted save, a D1 write that
 *      failed after HighLevel confirmed, any follow-up — is resumed by the
 *      scheduled Worker (workers/lead-alerts) from D1, with or without the
 *      visitor. Remote writes are at-least-once, never exactly-once.
 * The old S1 inbound webhook (GHL_WEBHOOK_URL) is NOT called: its Create/Update
 * Contact action would re-map every field, including SMS consent.
 *
 * GET /api/lead — readiness check (booleans only; outbox counts with
 * the X-Readiness-Token header matching READINESS_TOKEN).
 *
 * Configuration (Cloudflare Pages → Settings → Variables and Secrets / Bindings):
 *   LEADS_DB               D1 binding (required)
 *   GHL_API_TOKEN          secret (required)
 *   GHL_LOCATION_ID        plain (required)
 *   LEAD_ALERT_WEBHOOK_URL secret (required) — the NEW alert workflow's webhook
 *   TURNSTILE_SECRET_KEY   secret (enforced when set)
 *   READINESS_TOKEN        secret (optional) — unlocks outbox counts on GET
 */
import { validateLead } from "../../lib/lead/validate.js";
import { createStore, sha256Hex, saveJobId } from "../../lib/lead/store.js";
import { claimJob, runSaveJob, processSubmissionJobs, outboxStats } from "../../lib/lead/jobs.js";
import { configChecks } from "../../lib/lead/config.js";

const TIMEOUT_MS = 10000;
const fetchT = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

export async function onRequestGet({ request, env }) {
  const cfg = configChecks(env);
  let dbReachable = false;
  let outbox;
  if (cfg.checks.leadsDb) {
    const store = createStore(env.LEADS_DB);
    try {
      await store.ready();
      dbReachable = true;
      const token = request.headers.get("X-Readiness-Token");
      if (env.READINESS_TOKEN && token === env.READINESS_TOKEN) outbox = await outboxStats(store.db);
    } catch (e) {
      console.log("lead: readiness D1 check failed:", e.message);
    }
  }
  const body = {
    ready: cfg.ready && dbReachable,
    checks: { ...cfg.checks, leadsDbReachable: dbReachable, turnstile: !!env.TURNSTILE_SECRET_KEY },
  };
  if (outbox) body.outbox = outbox;
  return json(body, body.ready ? 200 : 503);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, code: "bad_request" }, 400);
  }
  if (!data || typeof data !== "object") return json({ ok: false, code: "bad_request" }, 400);

  // Honeypot: real users never fill this. Pretend success so bots don't retry.
  if (data.company) return json({ ok: true, saved: true });

  const cfg = configChecks(env);
  if (!cfg.ready) {
    console.log(`lead: NOT READY — missing ${cfg.missing.join(", ")}; submission refused`);
    return json({ ok: false, code: "not_ready" }, 503);
  }

  const { ok, errors, lead } = validateLead(data);
  if (!ok) return json({ ok: false, code: "validation", errors }, 422);

  const store = createStore(env.LEADS_DB);
  const db = store.db;
  const id = lead.submissionId;
  const runFollowUpsSoon = () => {
    const p = processSubmissionJobs(db, env, id, { fetchImpl: fetchT })
      .catch((e) => console.log("lead: immediate follow-up run failed (scheduled worker will retry):", e.message));
    if (typeof context.waitUntil === "function") context.waitUntil(p);
  };
  const saved = (replay) => json({ ok: true, submissionId: id, saved: true, replay });

  try {
    const row = await store.get(id);
    if (row && row.contact_id) { // already confirmed: never save again
      runFollowUpsSoon();
      return saved(true);
    }
    // A save for this ID is running right now: answer before Turnstile so the
    // retry doesn't burn its single-use token. The browser asks again shortly.
    const job = await store.saveJob(id);
    if (job && job.status === "sending" && job.lease_until > Date.now()) {
      return json({ ok: false, code: "in_progress" }, 409);
    }
  } catch (e) {
    console.log("lead: D1 unavailable:", e.message);
    return json({ ok: false, code: "not_ready" }, 503);
  }

  if (env.TURNSTILE_SECRET_KEY) {
    const passed = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, data.turnstileToken, request);
    if (passed === "error") return json({ ok: false, code: "antispam_unavailable" }, 502);
    if (!passed) return json({ ok: false, code: "antispam" }, 403);
  }

  // ---- 1) Intake: durable BEFORE any HighLevel write -----------------------
  try {
    await store.intake(id, {
      lead,
      hash: await sha256Hex(JSON.stringify(lead)),
      source: sourceLabel(lead.sourcePage),
      submittedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.log("lead: D1 intake failed — nothing sent to HighLevel:", e.message);
    return json({ ok: false, code: "not_ready" }, 503);
  }

  // ---- 2) Save now (the scheduled Worker resumes it if this doesn't finish) --
  try {
    const job = await claimJob(db, saveJobId(id), Date.now(), { ignoreSchedule: true });
    if (!job) {
      const row = await store.get(id);
      if (row && row.contact_id) { runFollowUpsSoon(); return saved(true); }
      return json({ ok: false, code: "in_progress" }, 409);
    }
    const r = await runSaveJob(db, env, job, { fetchImpl: fetchT });
    if (r.saved) {
      // "local_write_failed": HighLevel confirmed but D1 didn't record it — the
      // save job's lease expires and the Worker redoes the save + follow-ups.
      if (r.state === "delivered" || r.state === "already_saved") runFollowUpsSoon();
      return saved(false);
    }
  } catch (e) {
    console.log("lead: save step failed (the queued save will be retried by the worker):", e.message);
  }
  // Not confirmed. The inquiry stays queued and the Worker keeps retrying; the
  // visitor keeps their answers and may press Submit again (same ID).
  return json({ ok: false, code: "save_failed" }, 502);
}

/** → true | false | "error" (Turnstile itself unreachable) */
async function verifyTurnstile(secret, token, request) {
  if (!token) return false;
  const body = new URLSearchParams();
  body.append("secret", secret);
  body.append("response", String(token));
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  try {
    const res = await fetchT("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const result = await res.json();
    return !!result.success;
  } catch {
    return "error";
  }
}

// Turn the referring page into a friendly CRM source label so leads can be
// split by where they came from (e.g. the A/V Rentals page vs. a wedding page).
// Falls back to the generic label when the referrer is missing/off-site.
function sourceLabel(ref) {
  const base = "Website — Check Availability";
  if (!ref) return base;
  let path;
  try { path = new URL(String(ref)).pathname; } catch { return base; }
  const map = [
    ["/services/av-rentals", "Website — A/V Rentals"],
    ["/services/fort-lauderdale-wedding-dj", "Website — Fort Lauderdale Wedding DJ"],
    ["/wedding-dj-miami", "Website — Miami Wedding DJ"],
    ["/south-florida-photo-booth-rental", "Website — Photo Booth"],
    ["/glam-booth", "Website — Photo Booth"],
    ["/epic-extras-1", "Website — Epic Extras"],
    ["/pricing", "Website — Pricing"],
    ["/wedding-blog", "Website — Blog"],
  ];
  for (const [needle, label] of map) {
    if (path.indexOf(needle) !== -1) return label;
  }
  return base;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
