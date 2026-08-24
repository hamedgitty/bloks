// Anchors: how a note names the place it is pinned to.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeAnchor, parseAnchor } from "../server/artifact-comments.ts";

describe("anchors", () => {
  test("a cell is named the way every spreadsheet names it", () => {
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 0 }), "cell A1");
    assert.equal(describeAnchor({ kind: "cell", row: 6, column: 1 }), "cell B7");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 25 }), "cell Z1");
  });

  test("columns carry past Z the way they do in a real sheet", () => {
    // this is the part everybody gets wrong: it is bijective base 26,
    // so after Z comes AA, not BA, and after AZ comes BA
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 26 }), "cell AA1");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 27 }), "cell AB1");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 51 }), "cell AZ1");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 52 }), "cell BA1");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 701 }), "cell ZZ1");
    assert.equal(describeAnchor({ kind: "cell", row: 0, column: 702 }), "cell AAA1");
  });

  test("lines and pages count from one, like people do", () => {
    assert.equal(describeAnchor({ kind: "line", index: 0 }), "line 1");
    assert.equal(describeAnchor({ kind: "page", index: 4 }), "page 5");
  });

  test("an anchor from a client is checked, not trusted", () => {
    assert.deepEqual(parseAnchor({ kind: "cell", row: 2, column: 3 }), {
      kind: "cell",
      row: 2,
      column: 3,
    });
    assert.deepEqual(parseAnchor({ kind: "line", index: 9 }), { kind: "line", index: 9 });
    for (const bad of [
      null,
      "cell",
      { kind: "cell" },
      { kind: "cell", row: -1, column: 0 },
      { kind: "cell", row: 1.5, column: 0 },
      { kind: "cell", row: 0, column: 2_000_000 },
      { kind: "line" },
      { kind: "elsewhere", index: 0 },
    ]) {
      assert.equal(parseAnchor(bad), null, JSON.stringify(bad));
    }
  });
});
