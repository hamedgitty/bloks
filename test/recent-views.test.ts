// Ctrl+Tab: the conversations a window has shown, newest first (#154).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { cycle, prune, RECENT_LIMIT, sameView, visit, type Viewed } from "../src/lib/recent.ts";

const ids = (list: Viewed[]) => list.map((v) => (v.lane ? `${v.id}/${v.lane}` : v.id));

describe("visiting", () => {
  test("puts the conversation at the front", () => {
    let list: Viewed[] = [];
    for (const id of ["a", "b", "c"]) list = visit(list, { id });
    assert.deepEqual(ids(list), ["c", "b", "a"]);
  });

  test("moves one already listed, never listing it twice", () => {
    let list: Viewed[] = [{ id: "c" }, { id: "b" }, { id: "a" }];
    list = visit(list, { id: "a" });
    assert.deepEqual(ids(list), ["a", "c", "b"]);
  });

  test("an agent's conversations are separate places to go back to", () => {
    let list: Viewed[] = [];
    list = visit(list, { id: "ada", lane: "general" });
    list = visit(list, { id: "ada", lane: "taxes" });
    list = visit(list, { id: "room" });
    assert.deepEqual(ids(list), ["room", "ada/taxes", "ada/general"]);
    list = visit(list, { id: "ada", lane: "general" });
    assert.deepEqual(ids(list), ["ada/general", "room", "ada/taxes"]);
  });

  test("keeps only so many, letting the oldest go", () => {
    let list: Viewed[] = [];
    for (let i = 0; i < RECENT_LIMIT + 5; i++) list = visit(list, { id: `c${i}` });
    assert.equal(list.length, RECENT_LIMIT);
    assert.equal(list[0].id, `c${RECENT_LIMIT + 4}`);
    assert.ok(!list.some((v) => v.id === "c0"));
  });
});

describe("Ctrl+Tab", () => {
  test("a first press goes to the one you were just in", () => {
    assert.equal(cycle(null, 4, false), 1);
  });

  test("holding Ctrl and pressing again walks further back, then round to the start", () => {
    let at = cycle(null, 3, false);
    const seen = [at];
    for (let i = 0; i < 3; i++) seen.push((at = cycle(at, 3, false)));
    // index 0 is the one on screen: wrapping onto it and letting go stays put
    assert.deepEqual(seen, [1, 2, 0, 1]);
  });

  test("Shift goes the other way, starting from the oldest", () => {
    assert.equal(cycle(null, 4, true), 3);
    assert.equal(cycle(3, 4, true), 2);
    assert.equal(cycle(0, 4, true), 3);
  });

  test("with only the one on screen there is nowhere to switch to", () => {
    assert.equal(cycle(null, 1, false), null);
    assert.equal(cycle(null, 0, true), null);
  });

  test("with Settings covering the newest one, the first press goes back to it", () => {
    assert.equal(cycle(null, 3, false, false), 0);
    assert.equal(cycle(null, 1, false, false), 0);
    assert.equal(cycle(null, 0, false, false), null);
  });

  test("two quick taps go back and forth between the last two", () => {
    let list: Viewed[] = [];
    for (const id of ["a", "b", "c"]) list = visit(list, { id });
    // on c; a tap lands on b and opening it is a visit
    const first = list[cycle(null, list.length, false)!];
    assert.equal(first.id, "b");
    list = visit(list, first);
    const second = list[cycle(null, list.length, false)!];
    assert.equal(second.id, "c");
  });
});

describe("what has gone", () => {
  test("a deleted conversation drops out of the list", () => {
    const list: Viewed[] = [{ id: "c" }, { id: "gone" }, { id: "a" }];
    const alive = new Set(["a", "c"]);
    assert.deepEqual(ids(prune(list, (v) => alive.has(v.id))), ["c", "a"]);
  });

  test("so does a closed conversation of an agent that is still here", () => {
    const list: Viewed[] = [{ id: "ada", lane: "open" }, { id: "ada", lane: "closed" }];
    assert.deepEqual(ids(prune(list, (v) => v.lane !== "closed")), ["ada/open"]);
  });
});

test("the same conversation is the same whether or not a lane was named", () => {
  assert.ok(sameView({ id: "room" }, { id: "room", lane: undefined }));
  assert.ok(!sameView({ id: "ada", lane: "a" }, { id: "ada", lane: "b" }));
  assert.ok(!sameView(null, { id: "room" }));
});
