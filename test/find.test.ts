// Finding a line in one conversation.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { findHits, splitHighlight, stepHit } from "../src/lib/find.ts";

const thread = [
  { kind: "text", text: "The launch is on Tuesday" },
  { kind: "text", text: "tuesday works for me" },
  { kind: "activity", text: "ran a tool called tuesday" },
  { kind: "text", text: "deleted mention of Tuesday", deleted: true },
  { kind: "screen", text: "iVBORw0KGgoAAAANSUhEUg" },
  { kind: "text", text: "Nothing here" },
];

describe("finding within a conversation", () => {
  test("matches text and notices, ignoring case", () => {
    assert.deepEqual(findHits(thread, "tuesday"), [0, 1]);
    assert.deepEqual(findHits(thread, "TUESDAY"), [0, 1]);
  });

  test("skips what has no words to find", () => {
    // tool activity, screen frames and tombstones are not transcript
    assert.ok(!findHits(thread, "tuesday").includes(2), "tool activity matched");
    assert.ok(!findHits(thread, "tuesday").includes(3), "a deleted message matched");
    assert.ok(!findHits(thread, "iVBOR").includes(4), "a screen frame matched");
  });

  test("a single character is not a search", () => {
    // otherwise every keystroke of a long word scrolls the thread about
    assert.deepEqual(findHits(thread, "t"), []);
    assert.deepEqual(findHits(thread, " "), []);
    assert.deepEqual(findHits(thread, ""), []);
  });

  test("highlighting keeps the original case and every occurrence", () => {
    const parts = splitHighlight("Tuesday, then tuesday again", "tuesday");
    assert.deepEqual(parts, [
      { text: "Tuesday", hit: true },
      { text: ", then ", hit: false },
      { text: "tuesday", hit: true },
      { text: " again", hit: false },
    ]);
  });

  test("text with no match comes back whole", () => {
    assert.deepEqual(splitHighlight("nothing here", "tuesday"), [
      { text: "nothing here", hit: false },
    ]);
  });

  test("stepping wraps at both ends", () => {
    assert.equal(stepHit(0, 3, 1), 1);
    assert.equal(stepHit(2, 3, 1), 0, "past the last hit returns to the first");
    assert.equal(stepHit(0, 3, -1), 2, "before the first returns to the last");
    assert.equal(stepHit(0, 0, 1), 0, "no hits is not a division by zero");
  });
});
