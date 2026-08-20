// Dashes out of prose, and out of nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";

import { houseStyle } from "../server/house-style.ts";

const EM = "—";
const EN = "–";

test("a spaced em dash becomes a comma", () => {
  assert.equal(houseStyle(`good work ${EM} the tests pass`), "good work, the tests pass");
});

test("an unspaced em dash becomes a comma too", () => {
  assert.equal(houseStyle(`staying in my lane${EM}so nobody duplicates`), "staying in my lane, so nobody duplicates");
});

test("a pair of em dashes reads as a clause", () => {
  assert.equal(
    houseStyle(`The plan ${EM} which we discussed ${EM} is ready.`),
    "The plan, which we discussed, is ready.",
  );
});

test("a number range keeps its en dash", () => {
  // 3–5 is a range, not punctuation; turning it into "3, 5" changes the
  // meaning of the sentence
  assert.equal(houseStyle(`revenue grew 3${EN}5 percent`), "revenue grew 3–5 percent");
  assert.equal(houseStyle(`open Mon${EN}Fri`), "open Mon–Fri");
});

test("a spaced en dash is punctuation and does get replaced", () => {
  assert.equal(houseStyle(`one ${EN} two`), "one, two");
});

test("fenced code is left byte for byte", () => {
  const input = `before ${EM} after\n\n\`\`\`js\nconst a = 1; // a ${EM} b\n\`\`\`\n\ntail ${EM} end`;
  const out = houseStyle(input);
  assert.ok(out.includes(`// a ${EM} b`), "the comment inside the fence was rewritten");
  assert.ok(out.startsWith("before, after"));
  assert.ok(out.endsWith("tail, end"));
});

test("replacement never leaves doubled punctuation", () => {
  assert.equal(houseStyle(`already, ${EM} doubled`), "already, doubled");
  assert.equal(houseStyle(`a colon: ${EM} then more`), "a colon: then more");
});

test("text with no dashes is returned unchanged", () => {
  const said = "Plain prose, with a comma and a colon: nothing to do here.";
  assert.equal(houseStyle(said), said);
});

test("an empty string survives", () => {
  assert.equal(houseStyle(""), "");
});
