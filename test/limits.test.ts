// Caps on anything that reaches disk or a system prompt.
import { test } from "node:test";
import assert from "node:assert/strict";

import { clamp, clampList } from "../server/limits.ts";

test("clamp trims, caps, and drops what is left empty", () => {
  assert.equal(clamp("  hello  ", 80), "hello");
  assert.equal(clamp("x".repeat(500), 80)?.length, 80);
  assert.equal(clamp("   ", 80), undefined);
  assert.equal(clamp("", 80), undefined);
});

test("clamp refuses anything that is not a string", () => {
  // a client can send whatever it likes, including a nested object that
  // would otherwise be stringified into a prompt
  for (const value of [null, undefined, 42, true, {}, [], { toString: () => "sneaky" }]) {
    assert.equal(clamp(value, 80), undefined);
  }
});

test("clampList caps both the entries and the count", () => {
  const list = clampList(Array.from({ length: 50 }, () => "y".repeat(900)), 400, 12);
  assert.equal(list?.length, 12);
  assert.ok(list?.every((item) => item.length === 400));
});

test("clampList drops junk entries but keeps the good ones", () => {
  assert.deepEqual(clampList(["a", null, "  b  ", 7, ""], 400, 12), ["a", "b"]);
});

test("clampList returns undefined rather than an empty list", () => {
  // callers use undefined to mean "the client did not set this", so an
  // all-junk array must not read as "set it to nothing"
  assert.equal(clampList([], 400, 12), undefined);
  assert.equal(clampList([null, "", "   "], 400, 12), undefined);
  assert.equal(clampList("not an array", 400, 12), undefined);
});
