import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_STORAGE_PREFIXES,
  allowsAnalytics,
  allowsChat,
  isAnalyticsCookie,
  parseStored,
  serializeChoice,
  shouldLoadAnalytics,
  shouldLoadChat,
  shouldLoadReplay,
  undecided,
  withdrawalPlan,
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
  assert.equal(analyticsOnly.replay, false);
  assert.equal(shouldLoadReplay(analyticsOnly, true), false);
  assert.equal(shouldLoadChat(analyticsOnly, true), false);

  const replayToo = parseStored(serializeChoice({ decided: true, analytics: true, replay: true, chat: false }));
  assert.equal(shouldLoadReplay(replayToo, true), true);
  assert.equal(shouldLoadReplay(replayToo, false), false);

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

test("a version 1 analytics allow still includes replay, because that checkbox was bundled", () => {
  const legacy = parseStored(JSON.stringify({
    v: 1, decided: true, analytics: true, chat: false, ts: 1,
  }));
  assert.equal(legacy.replay, true);
  assert.equal(shouldLoadReplay(legacy, true), true);
  const legacyDenied = parseStored(JSON.stringify({
    v: 1, decided: true, analytics: false, chat: false, ts: 1,
  }));
  assert.equal(legacyDenied.replay, false);
});

test("withdrawal follows injected state, not a previous stored allow", () => {
  const deny = parseStored(serializeChoice({ decided: true, analytics: false, replay: false, chat: false }));
  const running = { analytics: true, replay: true, chat: true };
  const cleared = withdrawalPlan({
    injected: running,
    next: deny,
    persisted: undecided(),
  });
  assert.equal(cleared.reload, true);
  assert.equal(cleared.disarm, true);

  const staleAllow = parseStored(serializeChoice({ decided: true, analytics: true, replay: true, chat: true }));
  const stuck = withdrawalPlan({
    injected: running,
    next: deny,
    persisted: null,
  });
  assert.equal(stuck.reload, false);
  assert.equal(stuck.disarm, true);
  const stillAllowed = withdrawalPlan({
    injected: running,
    next: deny,
    persisted: staleAllow,
  });
  assert.equal(stillAllowed.reload, false);

  const chatOnly = withdrawalPlan({
    injected: { analytics: false, replay: false, chat: true },
    next: parseStored(serializeChoice({ decided: true, analytics: true, replay: false, chat: false })),
    persisted: parseStored(serializeChoice({ decided: true, analytics: true, replay: false, chat: false })),
  });
  assert.equal(chatOnly.stopChat, true);
  assert.equal(chatOnly.stopAnalytics, false);
  assert.equal(chatOnly.reload, true);
});

test("cookie names are exact known analytics names, not broad prefixes", () => {
  for (const name of ["_ga", "_ga_GFTVJ190J0", "_gid", "_gat", "_gat_UA", "_clck", "_clsk", "CLID", "MUID"]) {
    assert.equal(isAnalyticsCookie(name), true, name);
  }
  for (const name of ["MR", "SM", "SMART", "MUIDB", "xe-consent", "xe-lead-draft", "marketing"]) {
    assert.equal(isAnalyticsCookie(name), false, name);
  }
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
