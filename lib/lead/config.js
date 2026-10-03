/**
 * Launch requirements shared by /api/lead and the scheduled alert Worker.
 * Submissions are refused (503 not_ready) until every check passes.
 * ALLOW_HTTP_ALERT_WEBHOOK exists only for local testing against a mock.
 */
export function configChecks(env) {
  const checks = {
    leadsDb: !!env.LEADS_DB,
    ghlApiToken: !!env.GHL_API_TOKEN,
    ghlLocationId: !!env.GHL_LOCATION_ID,
    alertWebhook: /^https:\/\//.test(env.LEAD_ALERT_WEBHOOK_URL || "") ||
      (!!env.ALLOW_HTTP_ALERT_WEBHOOK && /^http:\/\//.test(env.LEAD_ALERT_WEBHOOK_URL || "")),
  };
  const missing = Object.keys(checks).filter((k) => !checks[k]);
  return { ready: missing.length === 0, checks, missing };
}

