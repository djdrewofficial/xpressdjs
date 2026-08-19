/**
 * Cloudflare Pages Function — Check Availability lead handler.
 *
 * The browser POSTs the form as JSON to /api/lead. This function validates it,
 * drops obvious spam (honeypot), then forwards a clean payload to the
 * GoHighLevel Inbound Webhook. Keeping the webhook URL server-side means it
 * never appears in the page source.
 *
 * Set the secrets in Cloudflare Pages → Settings → Environment variables:
 *   GHL_WEBHOOK_URL    = https://services.leadconnectorhq.com/hooks/.....
 *   GHL_API_TOKEN      = HighLevel Private Integration token ("Xpress Lead AI Worker")
 *   ANTHROPIC_API_KEY  = Claude API key for intent classification
 * Plain variable:
 *   GHL_LOCATION_ID    = tRQqRP2zGXszbRBr9wU3
 *
 * On the FINAL (complete) submission this function also asks Claude to
 * classify the lead's intent (pricing / consult / availability / general),
 * then upserts the contact in HighLevel with `intent-*` + `ai-workflow-active`
 * tags and the Preferred Method of Communication custom field. Those tags
 * trigger the lead-response workflow. Classification is strictly best-effort:
 * any failure falls back to `intent-general` and never blocks the lead.
 */
export async function onRequestPost({ request, env, waitUntil }) {
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
    preferredMethod: normalizePreferred(data.preferredMethod),
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
    source: sourceLabel(data.sourcePage),
    sourcePage: str(data.sourcePage),
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

  // ---- AI intent classification (complete submissions only) -----------------
  // Runs after the response is returned so the visitor never waits on it.
  if (complete && env.GHL_API_TOKEN && env.GHL_LOCATION_ID) {
    waitUntil(classifyAndTag(payload, env).catch((e) => console.log("AI tagging failed:", e.message)));
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// AI intent classification + HighLevel tagging
// ---------------------------------------------------------------------------
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const INTENTS = ["pricing", "consult", "availability", "general"];

async function classifyAndTag(p, env) {
  // 1) Ask Claude for the lead's primary intent — default to general on any hiccup
  let intent = "general";
  let summary = "";
  if (env.ANTHROPIC_API_KEY) {
    try {
      const inquiry = [
        p.notes && `Message: ${p.notes}`,
        p.eventType && `Event type: ${p.eventTypeOther || p.eventType}`,
        p.eventDate && `Event date: ${p.eventDate}`,
        p.venueName && `Venue: ${p.venueName}, ${p.venueCity}`,
        `Form submitted: Check Availability page`,
      ].filter(Boolean).join("\n");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 200,
          system:
            "You classify inquiries for Xpress Entertainment, a South Florida DJ company. " +
            "Classify the lead's PRIMARY intent as exactly one of: " +
            "pricing (asking about cost or packages), consult (explicitly wants to talk, meet, or get a call), " +
            "availability (wants to know if their date is open), general (anything else). " +
            "This form lives on the Check Availability page, so availability is the default " +
            "UNLESS the message clearly asks about price (then pricing) or clearly asks for a call/meeting (then consult). " +
            'Respond ONLY with JSON: {"intent":"...","summary":"one sentence about what they want"}',
          messages: [{ role: "user", content: inquiry }],
        }),
      });
      if (res.ok) {
        const d = await res.json();
        const m = (d.content?.[0]?.text || "").match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (INTENTS.includes(parsed.intent)) intent = parsed.intent;
          summary = parsed.summary || "";
        }
      }
    } catch (e) {
      console.log("Claude classification failed, using general:", e.message);
    }
  }

  // 2) Upsert the contact with intent tags + preferred method custom field
  const upsert = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_API_TOKEN}`,
      Version: GHL_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationId: env.GHL_LOCATION_ID,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      phone: p.phone,
      tags: [`intent-${intent}`, "ai-workflow-active"],
      customFields: [
        { key: "preferred_method_of_communication", field_value: p.preferredMethod },
      ],
    }),
  });
  if (!upsert.ok) {
    console.log("GHL upsert failed:", upsert.status, await upsert.text());
    return;
  }

  // 3) Best-effort note so the team sees the AI's read on the inquiry
  try {
    const { contact } = await upsert.json();
    if (contact?.id) {
      await fetch(`${GHL_BASE}/contacts/${contact.id}/notes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GHL_API_TOKEN}`,
          Version: GHL_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: [
            `WEBSITE INQUIRY — AI classified intent: ${intent}`,
            summary && `AI summary: ${summary}`,
            p.eventDate && `Event date: ${p.eventDate}`,
            p.preferredMethod && `Preferred contact: ${p.preferredMethod}`,
            p.commLanguage && `Language: ${p.commLanguage}`,
            p.notes && `Message: ${p.notes}`,
          ].filter(Boolean).join("\n"),
        }),
      });
    }
  } catch (e) {
    console.log("Note creation failed (non-fatal):", e.message);
  }
}

function normalizePreferred(v) {
  if (!v) return "SMS";
  return String(v).trim().toLowerCase().startsWith("e") ? "Email" : "SMS";
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

function str(v) {
  return v == null ? "" : String(v).slice(0, 2000);
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
