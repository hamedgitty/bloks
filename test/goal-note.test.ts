// A goal turn's note reads as what moves, not as the engine's instructions.
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstGoalNote, nextGoalNote } from "../server/goals.ts";
import { goalNoteForPerson } from "../src/lib/goalNote.ts";

test("the first goal note shows the goal and its check, and says it is turn 1", () => {
  const note = firstGoalNote({ text: "Ship the docs", check: "pnpm test", budget: 20 });
  const read = goalNoteForPerson(note);
  assert.deepEqual(read.turn, { of: 1, budget: 20 });
  assert.match(read.body, /Ship the docs/);
  assert.match(read.body, /pnpm test/);
  assert.doesNotMatch(read.body, /From Bloks|Goal: done/);
});

test("a later goal note keeps the next step and drops the framing", () => {
  const note = nextGoalNote({ text: "Ship the docs", turns: 3, budget: 20 }, "fix the broken links", null);
  const read = goalNoteForPerson(note);
  assert.deepEqual(read.turn, { of: 3, budget: 20 });
  assert.match(read.body, /Next: fix the broken links/);
  assert.doesNotMatch(read.body, /From Bloks|Goal: done/);
});

test("text that is not a goal note is shown as it is", () => {
  assert.deepEqual(goalNoteForPerson("just words"), { body: "just words" });
});
