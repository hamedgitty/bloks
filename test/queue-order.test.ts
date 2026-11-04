// Moving a waiting message up or down the line (server/queue-order.ts):
// the server and the app's strip come to the same order from the same
// list, and the words that keep their places keep them exactly.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dropPlace, moveInQueue, stepPlace } from "../server/queue-order.ts";

const none = new Set<string>();

describe("moving one waiting message", () => {
  test("before another, or to the end", () => {
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "c", { before: "a" }), { ok: true, order: ["c", "a", "b"], changed: true });
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "a", { before: null }), { ok: true, order: ["b", "c", "a"], changed: true });
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "a", { before: "c" }), { ok: true, order: ["b", "a", "c"], changed: true });
  });

  test("a move to where it already is changes nothing", () => {
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "b", { before: "c" }), { ok: true, order: ["a", "b", "c"], changed: false });
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "c", { before: null }), { ok: true, order: ["a", "b", "c"], changed: false });
    assert.deepEqual(moveInQueue(["a", "b", "c"], none, "b", { before: "b" }), { ok: true, order: ["a", "b", "c"], changed: false });
  });

  test("words that keep their places stay exactly where they were, and the rest trade places around them", () => {
    // x is being handed to a turn; y was sent with stop and send now
    const fixed = new Set(["x", "y"]);
    const line = ["y", "a", "x", "b", "c"];
    assert.deepEqual(moveInQueue(line, fixed, "c", { before: "a" }), { ok: true, order: ["y", "c", "x", "a", "b"], changed: true });
    const back = moveInQueue(line, fixed, "a", { before: null });
    assert.ok(back.ok);
    assert.deepEqual(back.order, ["y", "b", "x", "c", "a"]);
    assert.equal(back.order.indexOf("x"), 2);
    assert.equal(back.order.indexOf("y"), 0);
  });

  test("refused for a message not in the line, one that keeps its place, or a place that is not free", () => {
    const fixed = new Set(["x"]);
    assert.deepEqual(moveInQueue(["a", "x", "b"], fixed, "gone", { before: null }), { ok: false, why: "absent" });
    assert.deepEqual(moveInQueue(["a", "x", "b"], fixed, "x", { before: "a" }), { ok: false, why: "fixed" });
    assert.deepEqual(moveInQueue(["a", "x", "b"], fixed, "b", { before: "x" }), { ok: false, why: "place" });
    assert.deepEqual(moveInQueue(["a", "x", "b"], fixed, "b", { before: "elsewhere" }), { ok: false, why: "place" });
  });
});

describe("Move up and Move down", () => {
  test("one place among the ones that can move, and nothing past either end", () => {
    const line = ["a", "b", "c"];
    assert.deepEqual(stepPlace(line, none, "b", -1), { before: "a" });
    assert.deepEqual(stepPlace(line, none, "b", 1), { before: null });
    assert.deepEqual(stepPlace(line, none, "a", 1), { before: "c" });
    assert.equal(stepPlace(line, none, "a", -1), null);
    assert.equal(stepPlace(line, none, "c", 1), null);
    // the step asked for is the move it makes
    const down = moveInQueue(line, none, "a", stepPlace(line, none, "a", 1)!);
    assert.ok(down.ok);
    assert.deepEqual(down.order, ["b", "a", "c"]);
  });

  test("steps over a word that keeps its place, which stays put", () => {
    const fixed = new Set(["x"]);
    const line = ["a", "x", "b"];
    const place = stepPlace(line, fixed, "b", -1);
    assert.deepEqual(place, { before: "a" });
    const up = moveInQueue(line, fixed, "b", place!);
    assert.ok(up.ok);
    assert.deepEqual(up.order, ["b", "x", "a"]);
    assert.equal(stepPlace(line, fixed, "x", -1), null, "a fixed word has no step");
  });
});

describe("a drag", () => {
  test("lands before the first row after it that can be stepped over", () => {
    const line = ["a", "b", "c", "d"];
    // d dropped at the top
    assert.deepEqual(dropPlace(line, none, "d", 0), { before: "a" });
    // a dropped between c and d
    assert.deepEqual(dropPlace(line, none, "a", 2), { before: "d" });
    // a dropped at the bottom
    assert.deepEqual(dropPlace(line, none, "a", 3), { before: null });
  });

  test("dropped beside a row that cannot be stepped over, it goes before the next free one", () => {
    const fixed = new Set(["x"]);
    assert.deepEqual(dropPlace(["a", "b", "x", "c"], fixed, "a", 1), { before: "c" });
    assert.deepEqual(dropPlace(["a", "b", "x"], fixed, "a", 1), { before: null });
  });
});
