// Engine switches mid-thread: when the story must be replayed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { engineIsFresh, freshTurnText } from "../server/turn-context.ts";

describe("engine freshness", () => {
  test("a switch is fresh, a return visit is fresh, staying is not", () => {
    const base = { resumeCursors: {}, hasUserTurn: true };
    // same engine as last time: nothing missed
    assert.equal(engineIsFresh({ ...base, instanceId: "a", lastInstanceId: "a" }), false);
    // A -> B: B missed everything
    assert.equal(engineIsFresh({ ...base, instanceId: "b", lastInstanceId: "a" }), true);
    // A -> B -> A: A's old cursor missed B's turns, even though A HAS one
    assert.equal(
      engineIsFresh({
        instanceId: "a",
        lastInstanceId: "b",
        resumeCursors: { a: "cursor-1" },
        hasUserTurn: true,
      }),
      true,
    );
  });

  test("legacy lanes fall back to the cursor map", () => {
    // exactly our cursor: this lane has only ever been ours
    assert.equal(
      engineIsFresh({ instanceId: "a", resumeCursors: { a: "c1" }, hasUserTurn: true }),
      false,
    );
    // someone else's cursor is on the lane
    assert.equal(
      engineIsFresh({ instanceId: "a", resumeCursors: { b: "c2" }, hasUserTurn: true }),
      true,
    );
    // two cursors: ambiguous history, replay to be safe
    assert.equal(
      engineIsFresh({ instanceId: "a", resumeCursors: { a: "c1", b: "c2" }, hasUserTurn: true }),
      true,
    );
  });

  test("a lane with no user turn never replays", () => {
    assert.equal(
      engineIsFresh({ instanceId: "b", lastInstanceId: "a", resumeCursors: {}, hasUserTurn: false }),
      false,
    );
  });

  test("the replay carries the labelled story and the new message", () => {
    const text = freshTurnText(
      [
        { role: "user", text: "Plan the launch." },
        { role: "assistant", text: "Drafted a three week plan." },
      ],
      "Now compress it to two weeks.",
    );
    assert.match(text, /picking up this conversation mid-thread/);
    assert.match(text, /User: Plan the launch\./);
    assert.match(text, /Assistant: Drafted a three week plan\./);
    assert.match(text, /--- the new message ---\n\nNow compress it to two weeks\./);
    // an empty history adds nothing
    assert.equal(freshTurnText([], "hi"), "hi");
  });
});
