import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYTICS_COOKIE_RE,
  CHAT_STORAGE_PREFIXES,
  allowsAnalytics,
  allowsChat,
  parseStored,
  serializeChoice,
  shouldLoadAnalytics,
  shouldLoadChat,
  shouldLoadReplay,
  undecided,
} from "../lib/consent/state.js";

test("missing or broken storage does not allow analytics, replay, or chat", () => {
  for (const raw of [null, "", "nope", "{", "[]", JSON.stringify({ v: 1 })]) {
    const choice = parseStored(raw);
    assert.equal(choice.decided, false);
    assert.equal(allowsAnalytics(choice), false);
    assert.equal(allowsChat(choice), false);
    assert.equal(shouldLoadAnalytics(choice), false);
    assert.equal(shouldLoadReplay(choice, true), false);
    assert.equal(shouldLoadChat(choice, true), false);
  }
});

test("analytics and chat stay off until that purpose is stored as allowed", () => {
  const rejected = parseStored(serializeChoice({ decided: true, analytics: false, chat: false }));
  assert.equal(rejected.decided, true);
  assert.equal(shouldLoadAnalytics(rejected), false);
  assert.equal(shouldLoadReplay(rejected, true), false);
  assert.equal(shouldLoadChat(rejected, true), false);

  const analyticsOnly = parseStored(serializeChoice({ decided: true, analytics: true, chat: false }));
  assert.equal(shouldLoadAnalytics(analyticsOnly), true);
  assert.equal(shouldLoadReplay(analyticsOnly, true), true);
  assert.equal(shouldLoadReplay(analyticsOnly, false), false);
  assert.equal(shouldLoadChat(analyticsOnly, true), false);

  const chatOnly = parseStored(serializeChoice({ decided: false, analytics: true, chat: true }));
  assert.equal(chatOnly.decided, false);
  assert.equal(chatOnly.analytics, false);
  assert.equal(shouldLoadAnalytics(chatOnly), false);
  assert.equal(shouldLoadChat(chatOnly, true), true);
  assert.equal(shouldLoadChat(chatOnly, false), false);
});

test("a stored allow is what reloads, and a later reject parses as denied", () => {
  const allowed = parseStored(serializeChoice({ decided: true, analytics: true, chat: true }, 10));
  assert.equal(allowsAnalytics(allowed), true);
  assert.equal(allowsChat(allowed), true);
  const revoked = parseStored(serializeChoice({ decided: true, analytics: false, chat: false }, 20));
  assert.deepEqual(
    { analytics: allowsAnalytics(revoked), chat: allowsChat(revoked) },
    { analytics: false, chat: false },
  );
  assert.notEqual(undecided().decided, true);
});

test("cookie and chat storage names match what the live homepage set", () => {
  for (const name of ["_ga", "_ga_GFTVJ190J0", "_gid", "_clck", "_clsk", "CLID", "MUID"]) {
    assert.equal(ANALYTICS_COOKIE_RE.test(name), true, name);
  }
  assert.equal(ANALYTICS_COOKIE_RE.test("xe-consent"), false);
  assert.equal(ANALYTICS_COOKIE_RE.test("xe-lead-draft"), false);
  const observed = [
    "v2_contact_session_tRQqRP2zGXszbRBr9wU3_session_id",
    "v2_session_history_tRQqRP2zGXszbRBr9wU3",
    "v2_history_tRQqRP2zGXszbRBr9wU3",
    "v3_first_session_event_tRQqRP2zGXszbRBr9wU3",
  ];
  for (const key of observed) {
    assert.equal(CHAT_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)), true, key);
  }
});
