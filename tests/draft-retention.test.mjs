import assert from "node:assert/strict";
import test from "node:test";
import { DRAFT_MAX_AGE_MS, stampDraft, usableDraft } from "../lib/lead/draft.js";

const now = Date.parse("2026-11-07T16:00:00Z");

test("a fresh inquiry draft round-trips and drops SMS consent fields", () => {
  const stored = stampDraft({
    step: 1,
    firstName: "Ada",
    phone: "9545550100",
    smsConsent: true,
    consentText: "I consent",
  }, now);
  assert.equal(stored.smsConsent, undefined);
  assert.equal(stored.consentText, undefined);
  const restored = usableDraft(JSON.stringify(stored), now + 1000);
  assert.equal(restored.firstName, "Ada");
  assert.equal(restored.phone, "9545550100");
  assert.equal(restored.smsConsent, undefined);
});

test("drafts without a timestamp or older than 12 hours are discarded", () => {
  assert.equal(usableDraft(JSON.stringify({ firstName: "Ada" }), now), null);
  assert.equal(usableDraft("not-json", now), null);
  const expired = stampDraft({ firstName: "Ada" }, now - DRAFT_MAX_AGE_MS - 1);
  assert.equal(usableDraft(expired, now), null);
  const future = stampDraft({ firstName: "Ada" }, now + 120_000);
  assert.equal(usableDraft(future, now), null);
});
