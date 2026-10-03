# Completed-inquiry alert — integration contract v1

The website saves every completed Check Availability inquiry to HighLevel **itself** (contact upsert +
inquiry note) and then sends this alert so a HighLevel workflow can assign the lead and notify the team.

It is sent to **`LEAD_ALERT_WEBHOOK_URL`** — the trigger URL of a **new** HighLevel workflow — and
**never** to the old S1 inbound webhook (`GHL_WEBHOOK_URL`), whose *Create/Update Contact* action re-maps
every field (including SMS Consent) and would undo the website's protections.

## Transport

| | |
|---|---|
| Method | `POST`, `Content-Type: application/json`, UTF-8 |
| Headers | `X-Xpress-Delivery-Id: <deliveryId>`, `X-Xpress-Attempt: <n>` |
| Timeout | 10 s per attempt |
| Success | any `2xx` → delivered, never sent again |
| Retried | no response (timeout / dropped connection), `408`, `429`, `5xx`, any other non-listed status |
| Not retried | `400`, `404`, `410`, `422` → job marked **dead** immediately |
| Schedule | attempt 1 right after the save, then +1 m, +5 m, +15 m, +1 h, +3 h, +6 h, +12 h (8 attempts ≈ 22.5 h) → **dead** |
| Dead | kept in D1 (payload 30 days), counted by `GET /api/lead` (with token), logged by the Worker, and a "⚠️ WEBSITE INQUIRY — AUTOMATION FAILED" note is added to the contact |

## Delivery guarantee — at-least-once (best effort), NOT exactly-once

What the website guarantees:

* An alert is queued once per saved submission and retried until a `2xx` or the job goes **dead**.
* While a sender holds a job's lease, no other sender **starts** that job. Leases reduce overlap; they do
  not prevent duplicates.
* Every copy of one alert carries the **same `deliveryId`** and `submissionId`; `attempt` increases.

What it cannot guarantee — the team may receive **duplicate alerts** in these cases:

| Case | How the duplicate happens |
|---|---|
| Accepted, response lost | HighLevel processes attempt *n*; the connection drops or the 10 s timeout fires before the `2xx` arrives. The website must retry; HighLevel runs the workflow again. |
| Expired / slow sender | Sender A's request reaches HighLevel but A is killed, paused or slow (the local timeout aborts only the *wait*, not HighLevel's processing). A's 60 s lease expires and sender B re-sends. Both copies may be processed — possibly close together or out of order. |
| `5xx` / `429` after processing | HighLevel (or a proxy) returns an error even though the workflow was enrolled; the retry runs it again. |
| Guard-field race | If two copies are processed at nearly the same time, both workflow runs can read *Last Alerted Submission ID* before either writes it, and both continue. |
| Retry arriving after a newer submission | The same contact submits inquiry **A** (its alert keeps failing) and later inquiry **B** (alert delivered → field = B). A's retry then arrives: field ≠ A, so it passes the guard and alerts — and sets the field back to A, so a late retry of **B** would also pass. A single "last ID" field only remembers one submission. |
| Manual re-queue of a dead job | Re-sending a dead job after a person already followed up manually. |

The same applies to the website's own follow-ups: the inquiry **note** is also at-least-once, so a
contact can occasionally show the same inquiry note twice.

How to keep duplicates harmless:

* Put `submissionId`, `submittedAt` and `attempt` in the internal alert text, so a repeat is recognizable
  and an old inquiry's late retry isn't mistaken for a new one.
* The *Last Alerted Submission ID* guard (below) catches the common sequential repeat (same submission
  retried after its own earlier copy finished). It is a filter, not a guarantee. A stronger variant stores
  *every* alerted ID — e.g. append to a multi-line field and check **contains** `submissionId`, or add a tag
  `alerted-<submissionId>` and check for it — which fixes the "newer submission" case but still has the
  near-simultaneous race.
* Treat an alert as "a website inquiry exists for this contact — check the contact", not as a count.

## How an inquiry is saved — and recovered when something fails

A D1 transaction can never undo a HighLevel write. Recovery therefore works by **storing the inquiry
first and repeating the remote save**, not by rolling anything back.

1. **Intake (D1 only, before any HighLevel call).** One transaction writes the validated inquiry
   (`lead_submissions.lead_json`), this submission's consent record, and a due `save` job. If D1 can't
   take it, the visitor gets "temporarily unavailable" with their answers intact and **nothing is sent to
   HighLevel**.
2. **Save.** The request takes the save job's 60 s lease and upserts the contact. Only when HighLevel
   confirms does the visitor see **Inquiry received**.
3. **Record (D1, one transaction).** The submission is marked saved, the inquiry text is wiped, the note /
   source / alert jobs are queued and the save job is finished.

| Failure | What the visitor sees | Recovery (no browser needed) |
|---|---|---|
| D1 fails at intake | "Temporarily unavailable", answers kept | Nothing was written anywhere; the visitor resubmits |
| HighLevel error (`5xx`, `429`, `401`…) | "Couldn't confirm", answers kept | Save stays queued; Worker retries on the backoff schedule; the visitor's own retry runs it immediately |
| No response from HighLevel (timeout / dropped) — **ambiguous** | "Couldn't confirm" | Retried like above. If HighLevel had processed it, the retry is a second upsert of the same values |
| Process killed before or during the upsert | Network error, answers kept | Lease expires after 60 s; the Worker runs the save |
| HighLevel confirmed, then the D1 record fails or the process dies | **Inquiry received** (HighLevel did confirm) | The save job keeps its lease; after 60 s the Worker repeats the upsert and the D1 record, then delivers the follow-ups |
| Visitor never comes back in any of the above | — | The Worker finishes from D1. A save that never succeeds goes **dead** after 8 attempts (≈22.5 h) and shows in the readiness counts |

**What is not guaranteed:** remote writes are at-least-once. A repeated upsert normally matches the same
contact under the account's duplicate-contact settings and rewrites the same values; if those settings
allow duplicates, a repeat could create a second contact. When the first, unconfirmed upsert actually
created the contact, the repeat reports it as existing and the automatic **Source** label is skipped.
A visitor who corrects answers after a failed save gets the corrected answers saved; once an inquiry is
saved, a later submit with the same ID changes nothing.


## Payload (flat JSON → `{{inboundWebhookRequest.<key>}}`)

| Key | Type | Notes |
|---|---|---|
| `event` | string | always `website_inquiry.completed` |
| `version` | number | `1`; additive changes keep 1, breaking changes bump it |
| `deliveryId` | string | `<submissionId>:alert` — **dedupe key** |
| `submissionId` | UUID | the browser-generated inquiry ID |
| `contactId` | string | HighLevel contact the website saved/matched |
| `contactIsNew` | boolean | `true` if the upsert created the contact |
| `locationId` | string | `tRQqRP2zGXszbRBr9wU3` |
| `contactUrl` | string | `https://app.gohighlevel.com/v2/location/<loc>/contacts/detail/<contactId>` (verify the domain matches your white-label app URL) |
| `submittedAt` | ISO-8601 UTC | when the website saved the inquiry |
| `source`, `sourcePage` | string | e.g. `Website — Miami Wedding DJ`, referring URL |
| `formLanguage` | `en` \| `es` | which page version was used |
| `firstName`, `lastName`, `email`, `phone` | string | email lower-cased, phone E.164 |
| `preferredLanguage` | `English` \| `Spanish` | |
| `preferredMethod` | `SMS` \| `Email` | |
| `eventType` | `Wedding` \| `Corporate Event` \| `Other` | |
| `eventTypeOther`, `eventTypeLabel` | string | subtype for Other; label = subtype or eventType |
| `eventDate` | `YYYY-MM-DD` | never in the past (Eastern time) |
| `guests` | string (integer) | 1–5000 |
| `startTime`, `endTime` | string | normalized `h:mm AM/PM` |
| `venueName`, `venueCity` | string | |
| `relation`, `partnerA*`, `partnerB*` | string | weddings only, else `""` |
| `notes` | string | may be `""` |
| `smsConsentThisSubmission` | `Yes` \| `No` | consent on **this** inquiry only — **not** an opt-out and must not be written to the SMS Consent field |
| `consentCapturedAt` | ISO-8601 UTC | |
| `attempt`, `sentAt` | number, ISO | added per attempt |

### Synthetic sample (not a real inquiry)

```json
{
  "event": "website_inquiry.completed",
  "version": 1,
  "deliveryId": "3f6c2a1e-8b4d-4c7a-9e21-5d0b7f9a1c33:alert",
  "submissionId": "3f6c2a1e-8b4d-4c7a-9e21-5d0b7f9a1c33",
  "contactId": "SAMPLE_CONTACT_ID",
  "contactIsNew": true,
  "locationId": "tRQqRP2zGXszbRBr9wU3",
  "contactUrl": "https://app.gohighlevel.com/v2/location/tRQqRP2zGXszbRBr9wU3/contacts/detail/SAMPLE_CONTACT_ID",
  "submittedAt": "2026-10-03T19:42:10.512Z",
  "source": "Website — Miami Wedding DJ",
  "sourcePage": "https://xpressdjs.com/wedding-dj-miami/",
  "formLanguage": "en",
  "firstName": "Sample",
  "lastName": "Couple",
  "email": "sample.couple@example.com",
  "phone": "+13055550199",
  "preferredLanguage": "English",
  "preferredMethod": "Email",
  "eventType": "Wedding",
  "eventTypeOther": "",
  "eventTypeLabel": "Wedding",
  "eventDate": "2027-11-13",
  "guests": "180",
  "startTime": "6:00 PM",
  "endTime": "11:00 PM",
  "venueName": "Sample Venue Ballroom",
  "venueCity": "Coral Gables",
  "relation": "I'm A Bride!",
  "partnerAFirstName": "Sample",
  "partnerALastName": "Couple",
  "partnerBFirstName": "Example",
  "partnerBLastName": "Partner",
  "notes": "SYNTHETIC TEST PAYLOAD — not a real inquiry.",
  "smsConsentThisSubmission": "No",
  "consentCapturedAt": "2026-10-03T19:42:10.512Z",
  "attempt": 1,
  "sentAt": "2026-10-03T19:42:11.020Z"
}
```

## The new HighLevel workflow ("Website Inquiry — Completed Alert")

1. **Trigger:** Inbound Webhook (new URL → store it as `LEAD_ALERT_WEBHOOK_URL`). Send the sample above
   to it once so HighLevel can show the keys for mapping.
2. **Find Contact by exact Contact ID** = `{{inboundWebhookRequest.contactId}}` (configured 2026-10-03).
   Found → steps 3–4. Not found → exception email. **No Create/Update Contact action, and no field mapping
   of inquiry data** — the website already saved those fields.
3. **Repeat filter (recommended, not a guarantee — see "Delivery guarantee" above):** create one contact
   field, e.g. *Last Alerted Submission ID*.
   If/Else: field **equals** `{{inboundWebhookRequest.submissionId}}` → **End**. Otherwise → *Update
   Contact Field* (that single field only) = `{{inboundWebhookRequest.submissionId}}`, then continue.
4. **Assign** to Andrew Segura; **internal email + in-app notification** using the payload keys
   (name, event date/type, venue, preferred method, `contactUrl`).
5. **Do not** add the old hot-lead / `lead complete - ready to book` tag, touch DND, or write
   `smsConsentThisSubmission` into SMS Consent.

The booking workflow ("Video Consult Booking Alert", calendar `VusY7T1D0DLoYTQ1uNJ5`) stays the only
place that marks a consultation as booked (`consult-booked`).
