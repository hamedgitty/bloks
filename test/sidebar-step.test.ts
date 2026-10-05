// ⌥↑ and ⌥↓ through the sidebar, and ⌥⇧ to what wants you (#154).
// The rows come in the order the sidebar draws them; all this decides is
// where a step lands.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { stepRow, type SidebarRow } from "../src/lib/sidebarStep.ts";

const row = (id: string, flags: Partial<SidebarRow> = {}): SidebarRow => ({
  id,
  waiting: false,
  folded: false,
  ...flags,
});

const rows = [
  row("room"),
  row("ada", { waiting: true }),
  row("ben"),
  row("cy", { folded: true, waiting: true }),
  row("dee"),
  row("eve", { waiting: true }),
];

describe("a step", () => {
  test("goes to the row above or below, in the order shown", () => {
    assert.equal(stepRow(rows, "ada", 1), "ben");
    assert.equal(stepRow(rows, "ben", -1), "ada");
    assert.equal(stepRow(rows, "ada", -1), "room");
  });

  test("stops at the ends instead of jumping round to the other one", () => {
    // a wrap would read as the list having moved under you
    assert.equal(stepRow(rows, "room", -1), null);
    assert.equal(stepRow(rows, "eve", 1), null);
  });

  test("passes over the rows of a folded section", () => {
    assert.equal(stepRow(rows, "ben", 1), "dee");
    assert.equal(stepRow(rows, "dee", -1), "ben");
  });

  test("starts from the open row even when it sits in a folded section", () => {
    // a folded section still shows the open row, so that is where you are
    assert.equal(stepRow(rows, "cy", 1), "dee");
    assert.equal(stepRow(rows, "cy", -1), "ben");
  });

  test("with nothing open in the list, down starts at the top and up at the bottom", () => {
    assert.equal(stepRow(rows, null, 1), "room");
    assert.equal(stepRow(rows, null, -1), "eve");
    // open, but filtered out of view by a search or a project
    assert.equal(stepRow(rows, "gone", 1), "room");
  });

  test("an empty list goes nowhere", () => {
    assert.equal(stepRow([], null, 1), null);
    assert.equal(stepRow([], "ada", -1), null);
  });
});

describe("a step with Shift", () => {
  test("goes to the next row that is unread or waiting on you", () => {
    assert.equal(stepRow(rows, "room", 1, true), "ada");
    assert.equal(stepRow(rows, "ada", 1, true), "eve", "cy is folded away");
    assert.equal(stepRow(rows, "eve", -1, true), "ada");
  });

  test("and stays put when there is none further that way", () => {
    assert.equal(stepRow(rows, "eve", 1, true), null);
    assert.equal(stepRow(rows, "ada", -1, true), null);
    assert.equal(stepRow([row("a"), row("b")], "a", 1, true), null);
  });

  test("with nothing open, finds the first or last one waiting", () => {
    assert.equal(stepRow(rows, null, 1, true), "ada");
    assert.equal(stepRow(rows, null, -1, true), "eve");
  });
});
