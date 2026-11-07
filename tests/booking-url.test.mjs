import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { bookingFrameSrc, queryHasContact } from "../lib/lead/booking-url.js";

const BASE = "https://api.leadconnectorhq.com/widget/booking/VusY7T1D0DLoYTQ1uNJ5";

test("booking frame address never keeps name, email, or phone query keys", () => {
  const leaked = BASE + "?first_name=Ada&last_name=Lovelace&email=ada%40example.com&phone=%2B19545550100&keep=1";
  const src = bookingFrameSrc(leaked);
  assert.equal(queryHasContact(src), false);
  assert.equal(src.includes("example.com"), false);
  assert.equal(src.includes("9545550100"), false);
  assert.equal(src.includes("Ada"), false);
  assert.match(src, /keep=1/);
  assert.equal(queryHasContact(bookingFrameSrc(BASE)), false);
});

test("the inquiry script does not put the contact object on the calendar URL", () => {
  const src = fs.readFileSync(new URL("../public/js/lead-form.js", import.meta.url), "utf8");
  assert.match(src, /function bookingFrameSrc/);
  assert.match(src, /DRAFT_MAX_AGE = 12 \* 60 \* 60 \* 1000/);
  assert.match(src, /d\.savedAt = Date\.now\(\)/);
  assert.doesNotMatch(src, /URLSearchParams\(contact\)/);
  assert.doesNotMatch(src, /frame\.src = prefilled/);
  assert.match(src, /track\("generate_lead", \{ form: "check_availability" \}\)/);
});
