// Who a message in a room is aimed at.
import { test } from "node:test";
import assert from "node:assert/strict";

import { addressees } from "../server/bloks.ts";

const members = [
  { id: "a", name: "Ana" },
  { id: "b", name: "Bo" },
  { id: "c", name: "Bobby Tables" },
];

test("a message with no mention reaches everyone", () => {
  const { ids, mentioned } = addressees("what is the status?", members);
  assert.deepEqual(ids, ["a", "b", "c"]);
  assert.equal(mentioned, false);
});

test("a mention narrows the room to that member", () => {
  const { ids, mentioned } = addressees("@Ana can you take this", members);
  assert.deepEqual(ids, ["a"]);
  assert.equal(mentioned, true);
});

test("mentions are case insensitive", () => {
  assert.deepEqual(addressees("@ANA and @bo", members).ids.sort(), ["a", "b"]);
});

test("the longest matching name wins", () => {
  // "@Bobby Tables" contains "@Bo", so a naive scan would wake Bo instead
  const { ids } = addressees("@Bobby Tables please review", members);
  assert.deepEqual(ids, ["c"]);
});

test("several mentions reach several members", () => {
  const { ids } = addressees("@Ana and @Bo, compare notes", members);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("a") && ids.includes("b"));
});

test("a bare name without the @ is not a mention", () => {
  const { ids, mentioned } = addressees("Ana had a good idea", members);
  assert.equal(mentioned, false);
  assert.equal(ids.length, 3);
});

test("an empty room addresses nobody", () => {
  const { ids, mentioned } = addressees("anyone?", []);
  assert.deepEqual(ids, []);
  assert.equal(mentioned, false);
});
