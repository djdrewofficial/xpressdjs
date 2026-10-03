# Inquiry → consultation launch runbook

Prepared 2026-10-03. Branch `lead-flow-preview` → `main`. Pages project `xpress`, account `61a7f997240f29b8ad5ac9524458c9ac`.

## Production resources (prepared, idle until launch)

| Resource | Value |
|---|---|
| D1 database | `xpress-leads` — `d35d01b3-7d5d-43d0-927c-f9635c32bcf9` (schema applied, empty) |
| Pages Production binding | `LEADS_DB` → `xpress-leads` |
| Pages Production vars | `GHL_LOCATION_ID` (plain), `LEAD_ALERT_WEBHOOK_URL` (secret), `READINESS_TOKEN` (secret) — **`GHL_API_TOKEN` (secret) entered by Drew** |
| Unchanged | `PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (widget "Xpress Ent Website", `xpressdjs.com`), `GHL_WEBHOOK_URL`, `CF_DEPLOY_HOOK`, Google vars, `NODE_VERSION` |
| Retry Worker | `xpress-lead-alerts` (cron every minute, `LEADS_DB` → `xpress-leads`, `GHL_LOCATION_ID`, secret `LEAD_ALERT_WEBHOOK_URL`) — **secret `GHL_API_TOKEN` entered by Drew** |
| Alert workflow | "Website Inquiry — Completed Alert" (published) via `LEAD_ALERT_WEBHOOK_URL` |
| Rollback target | production deployment `e80285c7-ef6b-49cd-a447-82d3a9e7314e` (commit `e1a40cc`, https://e80285c7.xpress.pages.dev) |

Pages environment changes apply only to NEW deployments; the live site keeps running the old
code and bindings until the merge deploys.

## Launch (after approval)

1. **Drew:** add the dedicated website token as `GHL_API_TOKEN`
   - Pages: Workers & Pages → xpress → Settings → Variables and Secrets → **Production** → Add → Secret.
   - Worker: Workers & Pages → xpress-lead-alerts → Settings → Variables and Secrets → Add → Secret → Deploy
     (or `npx wrangler secret put GHL_API_TOKEN -c workers/lead-alerts/wrangler.toml`).
2. Verify both secrets exist (names only) — **do not merge until both are present**, otherwise the new
   form refuses every inquiry with "temporarily unavailable" (answers kept, nothing lost, but no leads).
3. Merge PR `lead-flow-preview` → `main` with a **merge commit** (keeps a single revert point).
   Cloudflare builds production (~2 min).
4. Verify:
   - `curl -H "X-Readiness-Token: <token>" https://xpressdjs.com/api/lead` → `200 {"ready":true,…}`
   - `https://xpressdjs.com/js/lead-form.js` contains `calendarContact`
   - the form still shows production Turnstile key `0x4AAAAAADT5iTBeYfMmbein`
5. One real production inquiry (Drew's details, Email preference) → "Inquiry received" + prefilled
   calendar (stop before booking); D1 shows the submission `saved` and jobs `delivered`; HighLevel
   contact + alert workflow execution; Drew receives the events@ email and in-app alert.
6. `npx wrangler tail xpress-lead-alerts` shows the cron running.

## Rollback

**Restore the previous website (instant, no rebuild):**
Workers & Pages → xpress → Deployments → production deployment `e80285c7` (commit `e1a40cc`, Aug 20)
→ ⋯ → **Rollback to this deployment**. API equivalent:
`POST /accounts/61a7f997240f29b8ad5ac9524458c9ac/pages/projects/xpress/deployments/e80285c7-ef6b-49cd-a447-82d3a9e7314e/rollback`

Then make it permanent: `git revert -m 1 <merge commit>` on `main` and push (otherwise the next push to
`main` or a deploy-hook rebuild redeploys the new code).

**Preserve queued inquiries:**
- Do **not** delete `xpress-leads`, its Pages binding, or the `xpress-lead-alerts` Worker. The Worker
  keeps finishing saves, notes and alerts from D1 on its own; it does not depend on the website.
- Leave the new Production vars in place; the old code ignores them.
- Check the queue (personal data stays in D1; this prints counts only):
  `npx wrangler d1 execute xpress-leads --remote --command "SELECT kind, status, COUNT(*) n FROM lead_jobs WHERE status IN ('pending','sending','dead') GROUP BY kind, status"`
- Only when nothing is `pending`/`sending` may the Worker be paused. `dead` jobs need manual follow-up
  (contact flagged with "AUTOMATION FAILED").
- After rollback the old form posts to the S1 inbound webhook (`GHL_WEBHOOK_URL`, still configured) —
  keep the S1 workflow published. `GET /api/lead` (readiness) does not exist in the old code.

**What a rollback does not undo:** contacts, notes and alerts already created in HighLevel.
