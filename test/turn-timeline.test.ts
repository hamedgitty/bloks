// The scrubber beside a conversation (GitHub 521): where its turns start,
// what each one's preview says, where each sits on the rail, and which
// one is being read. The last two are the ones a long conversation leans
// on, so they are walked with a thousand turns as well as with three.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Message } from "../src/state/reducer.ts";
import {
  RAIL_GAP,
  drawsTick,
  firstLine,
  placeOf,
  railLayout,
  readingTurn,
  stepTurn,
  turnAtHeight,
  turnMarks,
} from "../src/lib/turnTimeline.ts";

let n = 0;
const msg = (over: Partial<Message>): Message => ({ id: `m${++n}`, at: 1_000 + n, role: "bot", kind: "text", text: "", ...over }) as Message;
const you = (text: string, over: Partial<Message> = {}) => msg({ role: "user", text, ...over });
const reply = (text: string) => msg({ role: "bot", text });
const tool = (name: string) => msg({ role: "bot", kind: "activity", tool: { name, ok: true } } as Partial<Message>);

describe("where turns start", () => {
  test("each thing a person said starts one, and the work after it is counted", () => {
    const list = [you("Update the checkout route"), tool("Bash"), tool("Bash"), tool("Read"), reply("Done."), you("Now the tests"), reply("Passing.")];
    const marks = turnMarks(list);
    assert.deepEqual(marks.map((m) => m.line), ["Update the checkout route", "Now the tests"]);
    assert.equal(marks[0].index, 0);
    assert.equal(marks[1].index, 5);
    assert.match(marks[0].work, /2 commands/);
    assert.equal(marks[1].work, "");
  });

  test("words sent one after another are one turn, not one per message", () => {
    const list = [you("first"), you("and also this"), reply("ok")];
    assert.equal(turnMarks(list).length, 1);
  });

  test("two people back to back in a room are two turns", () => {
    const list = [you("from Sam", { author: "p1" }), you("from Ada", { author: "p2" })];
    assert.equal(turnMarks(list).length, 2);
  });

  test("what was taken back, folded away as quiet, or still waiting starts nothing", () => {
    const list = [you("gone", { deleted: true }), you("quiet", { quiet: true }), you("later", { queued: true }), msg({ role: "user", kind: "options" })];
    assert.equal(turnMarks(list).length, 0);
  });

  test("a narrower view counts only what it includes", () => {
    const list = [you("main"), you("in a topic", { topicId: "t1" } as Partial<Message>), reply("x")];
    const marks = turnMarks(list, (m) => (m as { topicId?: string }).topicId === "t1");
    assert.deepEqual(marks.map((m) => m.line), ["in a topic"]);
    // its index is still its place in the whole list, which is where the
    // page draws it
    assert.equal(marks[0].index, 1);
  });
});

describe("a turn's first line", () => {
  test("no markdown marks and no file tags, one line", () => {
    assert.equal(firstLine("## **Fix** the `build`\nsecond line"), "Fix the build");
    assert.equal(firstLine("see [the docs](https://example.com) please"), "see the docs please");
  });

  test("a long line is cut at a word, with an ellipsis", () => {
    const line = firstLine("word ".repeat(40), 30);
    assert.ok(line.length <= 30);
    assert.ok(line.endsWith("…"));
    assert.ok(!line.includes("wor…"), "cut between words, not inside one");
  });
});

describe("the rail", () => {
  test("a few turns sit close together in the middle", () => {
    const layout = railLayout(3, 600);
    assert.equal(layout.gap, RAIL_GAP.max);
    assert.equal(layout.stride, 1);
    const first = placeOf(layout, 0);
    const last = placeOf(layout, 2);
    assert.ok(Math.abs(300 - (first + last) / 2) < 0.001);
  });

  test("a thousand turns fill the rail and are sampled, never drawn on top of each other", () => {
    const count = 1000;
    const layout = railLayout(count, 600);
    assert.ok(placeOf(layout, 0) >= 0);
    assert.ok(placeOf(layout, count - 1) <= 600);
    assert.ok(layout.stride > 1);
    const ticks = Array.from({ length: count }, (_, i) => i).filter((i) => drawsTick(layout, count, i, -1));
    for (let i = 1; i < ticks.length - 1; i++) {
      assert.ok(placeOf(layout, ticks[i]) - placeOf(layout, ticks[i - 1]) >= RAIL_GAP.min - 0.001);
    }
  });

  test("the turn being read and the last always get a tick", () => {
    const layout = railLayout(1000, 600);
    assert.ok(drawsTick(layout, 1000, 999, -1));
    assert.ok(drawsTick(layout, 1000, 517, 517));
  });

  test("anywhere on the rail answers for the nearest turn, every turn reachable", () => {
    const count = 1000;
    const layout = railLayout(count, 600);
    const reached = new Set<number>();
    for (let i = 0; i < count; i++) reached.add(turnAtHeight(layout, count, placeOf(layout, i)));
    assert.equal(reached.size, count);
    assert.equal(turnAtHeight(layout, count, -50), 0);
    assert.equal(turnAtHeight(layout, count, 10_000), count - 1);
  });
});

describe("the turn being read", () => {
  test("the last one that starts above the reading line", () => {
    const tops = [0, 400, 900, 1500];
    assert.equal(readingTurn(4, (i) => tops[i], 450), 1);
    assert.equal(readingTurn(4, (i) => tops[i], 2000), 3);
    assert.equal(readingTurn(4, (i) => tops[i], 10), 0);
  });

  test("turns not drawn yet are above everything that is", () => {
    // the page is drawn from its end: the first 600 turns are paged out
    const tops = (i: number) => (i < 600 ? null : (i - 600) * 100);
    assert.equal(readingTurn(1000, tops, 250), 602);
    assert.equal(readingTurn(1000, tops, -10), 599);
  });

  test("asks the page only a handful of times in a long conversation", () => {
    let asked = 0;
    readingTurn(1000, (i) => (asked++, i * 50), 12_345);
    assert.ok(asked <= 11, `asked ${asked} times`);
  });
});

describe("keys on the rail", () => {
  test("arrows step one, page keys ten, Home and End the ends", () => {
    assert.equal(stepTurn("ArrowUp", 5, 40), 4);
    assert.equal(stepTurn("ArrowDown", 5, 40), 6);
    assert.equal(stepTurn("PageUp", 5, 40), 0);
    assert.equal(stepTurn("PageDown", 35, 40), 39);
    assert.equal(stepTurn("Home", 20, 40), 0);
    assert.equal(stepTurn("End", 2, 40), 39);
    assert.equal(stepTurn("a", 2, 40), null);
  });
});
