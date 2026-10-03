// Shared mocks for the lead tests. HighLevel, the alert webhook and Turnstile
// are MOCKED; D1 is real SQLite via node:sqlite behind a D1-shaped wrapper.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { onRequestPost, onRequestGet } from "../functions/api/lead.js";
import { resetFieldMetaCache } from "../lib/lead/highlevel.js";

export const META = JSON.parse(fs.readFileSync(new URL("./fixtures/ghl-contact-custom-fields.json", import.meta.url)));
export const MIGRATION = fs.readFileSync(new URL("../migrations/0001_lead_submissions.sql", import.meta.url), "utf8");
export const ALERT_URL = "https://alerts.example.test/new-inquiry";
export const OLD_S1_WEBHOOK = "https://old-s1.example.test/hook";
export const API = "https://ghl.example.test";

// ---- D1 stand-in (prepare/bind/run/first/all/batch) + fault injection ----------
// d1.faults.push({ match: /regex on SQL/, mode: "throw" | "hang", times: 1 })
// makes the next matching statement (or a batch containing one) fail or never settle.
export function makeD1({ migrate = false } = {}) {
  const db = new DatabaseSync(":memory:");
  if (migrate) db.exec(MIGRATION);
  const d1 = { raw: db, faults: [] };
  const trip = async (sqls) => {
    const f = d1.faults.find((x) => x.times > 0 && sqls.some((q) => x.match.test(q)));
    if (!f) return;
    f.times--;
    if (f.mode === "hang") await new Promise(() => {}); // process killed mid-write
    throw new Error("D1_ERROR: injected fault");
  };
  const wrap = (sql, args) => ({
    sql, args,
    bind(...a) { return wrap(sql, a); },
    async run() { await trip([sql]); const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    async first() { await trip([sql]); return db.prepare(sql).get(...args) || null; },
    async all() { await trip([sql]); return { results: db.prepare(sql).all(...args) }; },
  });
  d1.prepare = (sql) => wrap(sql, []);
  d1.batch = async (stmts) => {
    await trip(stmts.map((x) => x.sql));
    db.exec("BEGIN");
    try {
      const out = [];
      for (const st of stmts) { const r = db.prepare(st.sql).run(...st.args); out.push({ meta: { changes: Number(r.changes) } }); }
      db.exec("COMMIT");
      return out;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  return d1;
}

// ---- fetch mock ------------------------------------------------------------------
export const mock = { calls: [], behavior: {}, received: [] };
export function resetMock() {
  mock.calls = [];
  mock.received = []; // alert bodies the "receiver" actually processed
  mock.behavior = {
    meta: "ok", upsert: "ok", upsertNew: true, upsertDelay: 0, note: "ok", source: "ok",
    alert: "ok", turnstile: true,
  };
  resetFieldMetaCache();
}
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let contactSeq = 0;

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : init.body;
  mock.calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body });
  const b = mock.behavior;
  if (url.includes("/customFields")) return b.meta === "ok" ? res(200, META) : res(401, { message: "scope" });
  if (url.endsWith("/contacts/upsert")) {
    if (b.upsertDelay) await new Promise((r) => setTimeout(r, b.upsertDelay));
    if (b.upsert === "fail") return res(500, { message: "boom" });
    if (b.upsert === "hang") return new Promise(() => {}); // runner killed while waiting
    if (b.upsert === "accepted-then-drop") { b.upsertProcessed = (b.upsertProcessed || 0) + 1; throw new TypeError("fetch failed: socket hang up"); }
    return res(200, { new: b.upsertNew, contact: { id: b.contactId || `contact_${++contactSeq}` } });
  }
  if (url.includes("/notes")) {
    if (b.note === "fail") return res(500, {});
    return res(201, { note: { id: "n" } });
  }
  if (/\/contacts\/[^/]+$/.test(url) && init.method === "PUT") return b.source === "ok" ? res(200, {}) : res(500, {});
  if (url === ALERT_URL) {
    const mode = typeof b.alert === "function" ? b.alert(body) : b.alert;
    if (mode === "ok") { mock.received.push(body); return res(200, { status: "Success" }); }
    // The receiver processed it, then the response was lost on the way back.
    if (mode === "accepted-then-drop") { mock.received.push(body); throw new TypeError("fetch failed: socket hang up"); }
    if (mode === "network") throw new TypeError("fetch failed: ECONNREFUSED");
    // The runner is killed mid-send (isolate evicted): the request never settles.
    if (mode === "hang") return new Promise(() => {});
    return res(Number(mode), {});
  }
  if (url === OLD_S1_WEBHOOK) return res(200, {});
  if (url.includes("turnstile")) return res(200, { success: b.turnstile });
  throw new Error("unexpected fetch " + url);
};
export const callsTo = (pred) => mock.calls.filter(pred);
export const upserts = () => callsTo((c) => c.url.endsWith("/contacts/upsert"));
export const notes = () => callsTo((c) => c.url.includes("/notes"));
export const alerts = () => callsTo((c) => c.url === ALERT_URL);
export const sourcePuts = () => callsTo((c) => c.method === "PUT");

// ---- requests --------------------------------------------------------------------
export function futureDate(days = 200) {
  return new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
}
let seq = 0;
export function sid() {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}
export function wedding(over = {}) {
  return {
    submissionId: sid(), locale: "en",
    firstName: "Ana", lastName: "Lopez", email: "Ana@Example.com", phone: "(954) 555-1234",
    commLanguage: "English", preferredMethod: "SMS", smsConsent: true,
    consentText: "I consent to receive SMS notifications from Xpress Entertainment…",
    eventType: "Wedding", eventTypeOther: "", eventDate: futureDate(), guests: "150",
    startTime: "6pm", endTime: "11:30 PM",
    relation: "I'm A Bride!", partner1First: "Ana", partner1Last: "Lopez", partner2First: "Ben", partner2Last: "Cruz",
    venueName: "The Addison", venueCity: "Boca Raton", notes: "Bilingual please",
    turnstileToken: "tok", sourcePage: "https://xpressdjs.com/wedding-dj-miami/",
    ...over,
  };
}
export function env(over = {}) {
  return {
    GHL_API_TOKEN: "test-token", GHL_LOCATION_ID: "loc_1", GHL_API_BASE: API,
    LEAD_ALERT_WEBHOOK_URL: ALERT_URL, GHL_WEBHOOK_URL: OLD_S1_WEBHOOK, LEADS_DB: makeD1(), ...over,
  };
}

/** POST /api/lead. `jobs: "run"` awaits the post-response job run; "background" doesn't. */
export async function post(payload, e, { jobs = "run" } = {}) {
  const request = new Request("https://xpressdjs.com/api/lead", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const pending = [];
  const r = await onRequestPost({ request, env: e, waitUntil: (p) => pending.push(p) });
  if (jobs === "run") await Promise.all(pending);
  return { status: r.status, body: await r.json(), pending };
}
export async function get(e, headers = {}) {
  const r = await onRequestGet({ request: new Request("https://xpressdjs.com/api/lead", { headers }), env: e });
  return { status: r.status, body: await r.json() };
}
export const jobRows = (e) => e.LEADS_DB.raw.prepare("SELECT * FROM lead_jobs ORDER BY id").all();
export const fieldValue = (body, id) => (body.customFields.find((f) => f.id === id) || {}).field_value;

/** Fixed-offset clock for code that reads Date.now() directly. */
export async function withClock(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
}
export const subRow = (e, id) => e.LEADS_DB.raw.prepare("SELECT * FROM lead_submissions WHERE id = ?").get(id);
export const jobRow = (e, id) => e.LEADS_DB.raw.prepare("SELECT * FROM lead_jobs WHERE id = ?").get(id);
/** Resolve with the response, or "pending" if the request hasn't answered within ms (= visitor/process gone). */
export const settleWithin = (p, ms = 50) => Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), ms))]);
