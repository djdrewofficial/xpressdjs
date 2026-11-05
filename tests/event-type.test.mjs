import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TYPES, OTHER_EVENT_TYPES, WEDDING_ALIASES, OTHER_PARENT_ALIASES,
  canonicalEventType, canonicalOtherEventType, isWeddingEvent, shouldOfferConsult, fold,
} from "../lib/lead/event-type.js";

const PARENTS = [
  ["Wedding", "Wedding", true],
  ["wedding", "Wedding", true],
  ["WEDDING", "Wedding", true],
  ["  Wedding  ", "Wedding", true],
  ["weddings", "Wedding", true],
  ["Boda", "Wedding", true],
  ["boda", "Wedding", true],
  ["Bodas", "Wedding", true],
  ["Corporate Event", "Corporate Event", false],
  ["corporate event", "Corporate Event", false],
  ["CORPORATE", "Corporate Event", false],
  ["Evento Corporativo", "Corporate Event", false],
  ["Other", "Other", false],
  ["other", "Other", false],
  ["Otro", "Other", false],
  ["Wedding Anniversary", "", false],
  ["Aniversario de Bodas", "", false],
  ["Birthday Party", "", false],
  ["birthday", "", false],
  ["House Party", "", false],
  ["house party", "", false],
  ["Quinceanera", "", false],
  ["Quinceañera", "", false],
  ["", "", false],
];

test("parent event types: only wedding aliases offer a consult", () => {
  for (const [raw, canonical, wedding] of PARENTS) {
    assert.equal(canonicalEventType(raw), canonical, `canonical(${JSON.stringify(raw)})`);
    assert.equal(isWeddingEvent(raw), wedding, `wedding(${JSON.stringify(raw)})`);
    assert.equal(shouldOfferConsult(true, raw), wedding, `offer(${JSON.stringify(raw)})`);
    assert.equal(shouldOfferConsult(false, raw), false, `server blocks ${JSON.stringify(raw)}`);
    assert.equal(shouldOfferConsult("true", raw), false, "bookConsult must be boolean true");
  }
});

test("every real Other subtype skips the consult, including Wedding Anniversary", () => {
  for (const subtype of OTHER_EVENT_TYPES) {
    assert.equal(canonicalOtherEventType(subtype), subtype, subtype);
    assert.equal(canonicalOtherEventType(subtype.toUpperCase()), subtype, subtype + " upper");
    assert.equal(isWeddingEvent("Other", subtype), false, subtype);
    assert.equal(shouldOfferConsult(true, "Other"), false, subtype);
    assert.equal(canonicalEventType(subtype) === "Wedding", false, `${subtype} is not a wedding parent`);
  }
  assert.equal(canonicalOtherEventType("Aniversario de Bodas"), "Wedding Anniversary");
  assert.equal(canonicalOtherEventType("quinceañera"), "Quinceanera");
  assert.equal(canonicalOtherEventType("fiesta de cumpleaños"), "Birthday Party");
  assert.equal(canonicalOtherEventType("House Party"), "");
});

test("folded wedding aliases are exactly the ones the page hands the form script", () => {
  for (const alias of WEDDING_ALIASES) {
    assert.equal(fold(alias), alias);
    assert.equal(canonicalEventType(alias), "Wedding");
  }
  for (const alias of OTHER_PARENT_ALIASES) {
    assert.equal(canonicalEventType(alias), "Other");
  }
  assert.deepEqual(EVENT_TYPES, ["Wedding", "Corporate Event", "Other"]);
  assert.equal(OTHER_EVENT_TYPES.length, 17);
});
