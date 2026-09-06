// Tables a model actually emits, including the malformed ones.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { splitBlocks, splitRow, hasTable, type TableBlock } from "../src/lib/markdownTable.ts";

const tableIn = (text: string) => splitBlocks(text).find((b) => b.kind === "table") as TableBlock;

describe("splitRow", () => {
  test("outer pipes are optional", () => {
    assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
    assert.deepEqual(splitRow("a | b"), ["a", "b"]);
  });

  test("an escaped pipe stays inside its cell", () => {
    assert.deepEqual(splitRow("| a \\| b | c |"), ["a | b", "c"]);
  });
});

describe("splitBlocks", () => {
  test("the screenshot's table parses", () => {
    const text = [
      "For quick reference:",
      "",
      "| Model | Type | Was | Now |",
      "|---|---|---|---|",
      "| Anker P20i | Earbuds | $39 | $19 |",
      "| Bose QC45 | Over-ear ANC | $279 | $96.86 |",
      "",
      "Prices expire today.",
    ].join("\n");
    const blocks = splitBlocks(text);
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["lines", "table", "lines"],
    );
    const table = blocks[1] as TableBlock;
    assert.deepEqual(table.columns, ["Model", "Type", "Was", "Now"]);
    assert.equal(table.rows.length, 2);
    assert.deepEqual(table.rows[1], ["Bose QC45", "Over-ear ANC", "$279", "$96.86"]);
    assert.deepEqual((blocks[2] as { lines: string[] }).lines, ["", "Prices expire today."]);
  });

  test("alignment colons are read", () => {
    const table = tableIn("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
    assert.deepEqual(table.aligns, ["left", "center", "right"]);
  });

  test("a ragged row is padded rather than dropped", () => {
    const table = tableIn("| a | b | c |\n|---|---|---|\n| 1 | 2 |");
    assert.deepEqual(table.rows, [["1", "2", ""]]);
  });

  test("a row with extra cells is trimmed to the header", () => {
    const table = tableIn("| a | b |\n|---|---|\n| 1 | 2 | 3 |");
    assert.deepEqual(table.rows, [["1", "2"]]);
  });

  test("a header with no delimiter is left as text", () => {
    const text = "| not | a table |\njust some prose";
    assert.deepEqual(splitBlocks(text).map((b) => b.kind), ["lines"]);
    assert.equal(hasTable(text), false);
  });

  test("a delimiter of the wrong width is not this table's delimiter", () => {
    assert.equal(hasTable("| a | b |\n|---|\n| 1 | 2 |"), false);
  });

  test("a table with no body rows is still a table", () => {
    const table = tableIn("| a | b |\n|---|---|");
    assert.deepEqual(table.columns, ["a", "b"]);
    assert.deepEqual(table.rows, []);
  });

  test("two tables in one message both parse", () => {
    const text = "| a |\n|---|\n| 1 |\n\ntext between\n\n| b |\n|---|\n| 2 |";
    assert.deepEqual(
      splitBlocks(text).map((b) => b.kind),
      ["table", "lines", "table"],
    );
  });

  test("prose that merely contains a pipe is untouched", () => {
    const text = "run a | b to pipe it\nand then read the output";
    assert.deepEqual(splitBlocks(text).map((b) => b.kind), ["lines"]);
  });

  test("text with no table comes back as one block, offset zero", () => {
    const blocks = splitBlocks("hello\nworld");
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], { kind: "lines", lines: ["hello", "world"], offset: 0 });
  });
});
