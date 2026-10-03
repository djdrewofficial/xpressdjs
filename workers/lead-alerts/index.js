/**
 * xpress-lead-alerts — scheduled Worker that finishes inquiry follow-ups.
 *
 * Cloudflare Pages Functions cannot run on a schedule, so this standalone
 * Worker (Cron Trigger, every minute) shares the Pages project's D1 database
 * and delivers any lead_jobs row that is due or whose lease expired —
 * including jobs left behind when a visitor closed the browser or the Pages
 * request was cut short. Retry/backoff/terminal rules: lib/lead/jobs.js.
 *
 * It has no public routes (workers_dev = false); `fetch` only answers 404.
 */
import { processDueJobs } from "../../lib/lead/jobs.js";
import { wrapDb } from "../../lib/lead/store.js";

const TIMEOUT_MS = 10000;
const fetchT = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

export default {
  async scheduled(controller, env, ctx) {
    if (!env.LEADS_DB || !env.GHL_API_TOKEN || !env.GHL_LOCATION_ID) {
      console.log("lead-alerts: missing LEADS_DB / GHL_API_TOKEN / GHL_LOCATION_ID — nothing processed");
      return;
    }
    const summary = await processDueJobs(wrapDb(env.LEADS_DB), env, { fetchImpl: fetchT, limit: 50 });
    if (summary.delivered || summary.retry || summary.dead) console.log("lead-alerts:", JSON.stringify(summary));
  },

  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
