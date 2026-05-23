/**
 * Cloudflare Pages Function — Check Availability lead handler.
 *
 * The browser POSTs the form as JSON to /api/lead. This function validates it,
 * drops obvious spam (honeypot), then forwards a clean payload to the
 * GoHighLevel Inbound Webhook. Keeping the webhook URL server-side means it
 * never appears in the page source.
 *
 * Set the secret in Cloudflare Pages → Settings → Environment variables:
 *   GHL_WEBHOOK_URL = https://services.leadconnectorhq.com/hooks/.....
 */
export async function onRequestPost({ request, env }) {
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request" }, 400);
  }

  // Honeypot: real users never fill this. Pretend success so bots don't retry.
  if (data.company) return json({ ok: true });

  // Minimum viable lead. The form captures progressively: as soon as a client
  // clears step 1 we get a partial lead (contact + consent, event/venue still
  // blank) so an AI agent can follow up; later steps send richer snapshots and
  // the final one is flagged complete.
  const complete = data.complete === true || data.stage === "complete";

  if (!data.firstName || !data.phone || !data.email) {
    return json({ ok: false, error: "Please fill in your name, phone, and email." }, 422);
  }
  if (!data.smsConsent) {
    return json({ ok: false, error: "Please agree to the SMS consent to continue." }, 422);
  }

  // Cloudflare Turnstile — only gate the final complete submission. Partial
  // captures (steps 1–2) rely on the honeypot so anti-spam never blocks the
  // early lead capture. Only enforced once TURNSTILE_SECRET_KEY is set.
  if (complete && env.TURNSTILE_SECRET_KEY) {
    if (!data.turnstileToken) {
      return json({ ok: false, error: "Anti-spam check failed — please try again." }, 403);
    }
    const verifyBody = new URLSearchParams();
    verifyBody.append("secret", env.TURNSTILE_SECRET_KEY);
    verifyBody.append("response", String(data.turnstileToken));
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) verifyBody.append("remoteip", ip);
    try {
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: verifyBody,
      });
      const result = await verify.json();
      if (!result.success) {
        return json({ ok: false, error: "Anti-spam check failed — please try again." }, 403);
      }
    } catch {
      return json({ ok: false, error: "Couldn't verify anti-spam. Please retry." }, 502);
    }
  }

  const webhook = env.GHL_WEBHOOK_URL;
  if (!webhook) {
    return json({ ok: false, error: "Lead routing is not configured yet." }, 503);
  }

  // Whitelist + enrich the payload sent to GoHighLevel
  const payload = {
    firstName: str(data.firstName),
    lastName: str(data.lastName),
    email: str(data.email),
    phone: str(data.phone),
    commLanguage: str(data.commLanguage),
    eventType: str(data.eventType),
    eventTypeOther: str(data.eventTypeOther),
    eventDate: str(data.eventDate),
    guests: str(data.guests),
    startTime: str(data.startTime),
    endTime: str(data.endTime),
    venueName: str(data.venueName),
    venueCity: str(data.venueCity),
    relation: str(data.relation),
    partner1First: str(data.partner1First),
    partner1Last: str(data.partner1Last),
    partner2First: str(data.partner2First),
    partner2Last: str(data.partner2Last),
    notes: str(data.notes),
    smsConsent: data.smsConsent ? "Yes" : "No",
    consentText: str(data.consentText),
    // Workflow routing: branch your GHL automations on `complete`/`leadStage`.
    // Incomplete → AI agent gathers the rest; complete → booking agent.
    leadStage: str(data.stage) || "step-1",
    complete: complete ? "Yes" : "No",
    tag: complete ? "lead complete - ready to book" : "lead incomplete - needs followup",
    source: "Website — Check Availability",
    submittedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return json({ ok: false, error: "We couldn't submit right now. Please try again or call us." }, 502);
  } catch {
    return json({ ok: false, error: "Network error. Please try again or call us." }, 502);
  }

  return json({ ok: true });
}

function str(v) {
  return v == null ? "" : String(v).slice(0, 2000);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
