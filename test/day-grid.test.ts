// The hours the Day and Week views of Automations draw (src/lib/dayGrid.ts).
//
// The grid began at six, and a routine set between midnight and five was
// left out of both views: scheduled, and nowhere on the screen.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DAY_END, DAY_START, gridHours } from "../src/lib/dayGrid.ts";

const at = (hour: number, minute = 0) => hour * 60 + minute;

test("an ordinary day keeps its six to eleven grid", () => {
  assert.deepEqual(gridHours([]), { start: DAY_START, end: DAY_END });
  assert.deepEqual(gridHours([at(9), at(17, 30)]), { start: 6, end: 23 });
});

test("a routine before six opens the grid at its hour", () => {
  assert.equal(gridHours([at(3, 30), at(9)]).start, 3, "a 3:30 routine had no hour to sit in");
  assert.equal(gridHours([at(0, 0)]).start, 0, "a midnight routine had no hour to sit in");
  // five o'clock used to be squashed against the top of the six o'clock row
  assert.equal(gridHours([at(5, 45)]).start, 5);
});

test("a routine late at night gets the last hour drawn too", () => {
  assert.equal(gridHours([at(23, 15)]).end, 24);
  assert.equal(gridHours([at(22, 59)]).end, 23);
});

test("a time that is not one leaves the grid alone", () => {
  assert.deepEqual(gridHours([Number.NaN]), { start: 6, end: 23 });
});
