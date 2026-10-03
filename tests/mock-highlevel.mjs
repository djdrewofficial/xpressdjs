// Local stand-in for HighLevel + the new completed-inquiry alert webhook, for
// `wrangler pages dev` / `wrangler dev` (scheduled Worker). Listens on :8799.
// Point the code at it with GHL_API_BASE=http://127.0.0.1:8799,
// LEAD_ALERT_WEBHOOK_URL=http://127.0.0.1:8799/alert and ALLOW_HTTP_ALERT_WEBHOOK=1.
//   POST /__mode {"upsert":"ok"|"fail"|"accepted-then-drop","upsertNew":true|false,"upsertDelay":ms,
//                 "alert":"ok"|"503"|"404"|"accepted-then-drop"|"hang"}
//   GET  /__log  every request received;  POST /__reset;  GET /hang never answers.
import http from "node:http";
import fs from "node:fs";

const META = JSON.parse(fs.readFileSync(new URL("./fixtures/ghl-contact-custom-fields.json", import.meta.url)));
const log = [];
const DEFAULT_MODE = { upsert: "ok", upsertNew: true, upsertDelay: 0, alert: "ok" };
let mode = { ...DEFAULT_MODE };
const seen = new Set(); // contact ids already "created"

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }); return res.end(); }
    if (url.pathname === "/hang") return; // never answers (calendar-load failure test)
    if (url.pathname === "/__log") return send(res, 200, log);
    if (url.pathname === "/__reset") { log.length = 0; mode = { ...DEFAULT_MODE }; return send(res, 200, {}); }
    if (url.pathname === "/__mode") { mode = { ...mode, ...JSON.parse(raw || "{}") }; return send(res, 200, mode); }

    const body = raw ? JSON.parse(raw) : null;
    const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, body };
    if (url.pathname === "/alert") entry.headers = { deliveryId: req.headers["x-xpress-delivery-id"], attempt: req.headers["x-xpress-attempt"] };
    log.push(entry);
    console.log(req.method, url.pathname, url.pathname === "/alert" ? `(${mode.alert})` : "");

    if (url.pathname.endsWith("/customFields")) return send(res, 200, META);
    if (url.pathname === "/contacts/upsert") {
      if (mode.upsertDelay) await new Promise((r) => setTimeout(r, mode.upsertDelay));
      if (mode.upsert === "fail") return send(res, 500, { message: "mock failure" });
      entry.processed = true;
      if (mode.upsert === "accepted-then-drop") return req.socket.destroy(); // saved, response lost
      // A real upsert matches the same contact by email; mimic that.
      const id = `mock_contact_${body.email}`;
      const isNew = !seen.has(id);
      seen.add(id);
      return send(res, 200, { new: mode.upsertNew && isNew, contact: { id } });
    }
    if (/^\/contacts\/[^/]+\/notes$/.test(url.pathname)) return send(res, 201, { note: { id: "note" } });
    if (/^\/contacts\/[^/]+$/.test(url.pathname) && req.method === "PUT") return send(res, 200, { succeded: true });
    if (url.pathname === "/alert") {
      entry.processed = mode.alert === "ok" || mode.alert === "accepted-then-drop";
      if (mode.alert === "ok") return send(res, 200, { status: "Success" });
      if (mode.alert === "accepted-then-drop") return req.socket.destroy(); // processed, response lost
      if (mode.alert === "hang") return;
      return send(res, Number(mode.alert) || 500, {});
    }
    send(res, 404, { message: "not mocked" });
  });
}).listen(8799, () => console.log("mock HighLevel on http://127.0.0.1:8799"));
