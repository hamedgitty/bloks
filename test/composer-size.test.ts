// The composer's ceiling and edge fades (#50).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composerCeiling, edgeMask, MAX_LINES } from "../src/lib/composerSize.ts";

test("the ceiling is a whole number of lines plus padding, never between lines", () => {
  // the composer's real metrics: 14.5px text, leading-relaxed, py-1
  const line = 23.5625;
  const ceiling = composerCeiling(line, 4, 4);
  assert.equal(ceiling, Math.ceil(MAX_LINES * line + 8));
  // at rest, scrolled to the end, the view starts less than a line from
  // a line boundary: no half line against the border
  const lines = (ceiling - 8) / line;
  assert.ok(lines >= MAX_LINES && lines < MAX_LINES + 0.1, `showed ${lines} lines`);
});

test("a missing line height falls back rather than collapsing the composer", () => {
  assert.ok(composerCeiling(NaN, 4, 4) > 100);
  assert.ok(composerCeiling(0, 4, 4) > 100);
});

test("a composer that is not scrolling has no mask", () => {
  assert.equal(edgeMask(0, 100, 100), "");
  assert.equal(edgeMask(0, 197, 197.5), "");
});

test("only the edges with text beyond them fade", () => {
  const atTop = edgeMask(0, 197, 400);
  assert.match(atTop, /^linear-gradient\(to bottom, black,/);
  assert.match(atTop, /, transparent\)$/);
  const atBottom = edgeMask(203, 197, 400);
  assert.match(atBottom, /^linear-gradient\(to bottom, transparent,/);
  assert.match(atBottom, /, black\)$/);
  const middle = edgeMask(100, 197, 400);
  assert.match(middle, /^linear-gradient\(to bottom, transparent,.*, transparent\)$/);
});
