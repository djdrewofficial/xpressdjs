/**
 * Completed-inquiry alert payload — contract v1 (see docs/lead-alert-contract.md).
 *
 * Sent to LEAD_ALERT_WEBHOOK_URL (a NEW HighLevel inbound-webhook workflow),
 * never to the old S1 GHL_WEBHOOK_URL, whose Create/Update Contact action
 * would re-map every field. Keys are flat so HighLevel can reference them as
 * {{inboundWebhookRequest.<key>}}. The runner adds `attempt` and `sentAt` at
 * send time; everything else is fixed when the inquiry is saved, so every
 * retry of one inquiry carries the same `deliveryId`.
 */
export const ALERT_EVENT = "website_inquiry.completed";
export const ALERT_VERSION = 1;

export function buildAlertPayload(lead, { submissionId, contactId, contactIsNew, locationId, source, submittedAt }) {
  const eventTypeLabel = lead.eventType === "Other" && lead.eventTypeOther ? lead.eventTypeOther : lead.eventType;
  return {
    event: ALERT_EVENT,
    version: ALERT_VERSION,
    deliveryId: `${submissionId}:alert`,
    submissionId,
    contactId,
    contactIsNew: !!contactIsNew,
    locationId,
    contactUrl: `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`,
    submittedAt,
    source,
    sourcePage: lead.sourcePage || "",
    formLanguage: lead.locale === "es" ? "es" : "en",
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    phone: lead.phone,
    preferredLanguage: lead.commLanguage,
    preferredMethod: lead.preferredMethod,
    eventType: lead.eventType,
    eventTypeOther: lead.eventTypeOther || "",
    eventTypeLabel,
    eventDate: lead.eventDate,
    guests: lead.guests,
    startTime: lead.startTime,
    endTime: lead.endTime,
    venueName: lead.venueName,
    venueCity: lead.venueCity,
    relation: lead.relation || "",
    partnerAFirstName: lead.partner1First || "",
    partnerALastName: lead.partner1Last || "",
    partnerBFirstName: lead.partner2First || "",
    partnerBLastName: lead.partner2Last || "",
    notes: lead.notes || "",
    smsConsentThisSubmission: lead.smsConsent ? "Yes" : "No",
    consentCapturedAt: submittedAt,
  };
}
