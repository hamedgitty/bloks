// The one number on the Dock icon.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { unreadCount } from "../src/lib/unread.ts";
import { openLaneUnread, pingedLane, readOpenLane, rowLane, rowState } from "../src/state/reducer.ts";
import { agentPreview } from "../src/lib/preview.ts";

describe("unreadCount", () => {
  test("counts unread agents and nothing else", () => {
    assert.equal(
      unreadCount([
        { unread: true },
        { unread: true },
        { unread: false },
        {},
      ]),
      2,
    );
  });

  test("archived agents cannot have news", () => {
    assert.equal(unreadCount([{ unread: true, archivedAt: 1724500000000 }, { unread: true }]), 1);
  });

  test("an empty roster is zero", () => {
    assert.equal(unreadCount([]), 0);
  });
});

describe("per-lane unread", () => {
  const lane = (id: string, unread: boolean, lastAt: number) => ({ id, unread, lastAt, createdAt: 0 });
  test("opening an agent goes to the lane that pinged, newest first", () => {
    const bot = { threadId: "a", activeTaskId: "a", tasks: [lane("a", false, 5), lane("b", true, 1), lane("c", true, 9)] };
    assert.equal(pingedLane(bot), "c");
    assert.equal(pingedLane({ ...bot, tasks: [lane("a", true, 5)] }), null, "the open lane is not somewhere to go");
  });
  test("a lane stopped on you comes before an unread one, read or not (#81)", () => {
    const bot = {
      threadId: "a",
      activeTaskId: "a",
      tasks: [lane("a", false, 5), lane("b", true, 9), { ...lane("c", false, 1), state: "needs-you" }],
    };
    assert.equal(pingedLane(bot), "c");
  });
  test("the agent's row is about the conversation a click on it opens", () => {
    const bot = {
      threadId: "a",
      activeTaskId: "a",
      tasks: [lane("a", false, 5), lane("b", true, 1), lane("c", true, 9), { ...lane("d", false, 0), state: "needs-you" }],
    };
    assert.equal(rowLane(bot)?.id, "d", "one stopped on you, in another conversation, wins");
    assert.equal(rowLane({ ...bot, tasks: bot.tasks.slice(0, 3) })?.id, "c", "then the newest unread");
    assert.equal(rowLane({ ...bot, tasks: [lane("a", false, 5), lane("b", false, 9)] })?.id, "a", "then the open one");
  });
  test("an agent working behind a quiet open conversation still reads as working", () => {
    const quiet = { threadId: "a", activeTaskId: "a", busy: true, tasks: [lane("a", false, 5), { ...lane("b", false, 9), state: "working" }] };
    assert.deepEqual(
      { state: rowState(quiet).state, unread: rowState(quiet).unread },
      { state: "working", unread: false },
      "the open one says nothing, so the work elsewhere shows",
    );
    assert.equal(agentPreview({ ...quiet, messages: [] }), "Working…");
    // what the click opens, when it has something to say, says it
    const pinged = { ...quiet, tasks: [...quiet.tasks, lane("c", true, 12)] };
    assert.deepEqual({ id: rowState(pinged).lane?.id, state: rowState(pinged).state, unread: rowState(pinged).unread }, { id: "c", state: "idle", unread: true });
    const openUnread = { ...quiet, tasks: [lane("a", true, 5), quiet.tasks[1]] };
    assert.deepEqual({ state: rowState(openUnread).state, unread: rowState(openUnread).unread }, { state: "idle", unread: true });
    // and an agent with nothing running anywhere is idle
    assert.equal(rowState({ ...quiet, busy: false, tasks: [lane("a", false, 5), lane("b", false, 9)] }).state, "idle");
    // a server too old to list conversations has only the agent's flag
    assert.equal(rowState({ threadId: "a", busy: true }).state, "working");
  });
  test("reading the open lane leaves the others, and the agent follows them", () => {
    const bot = { threadId: "a", activeTaskId: "a", unread: true, tasks: [lane("a", true, 5), lane("b", true, 1)] };
    const read = readOpenLane(bot);
    assert.equal(read.tasks[0].unread, false);
    assert.equal(read.unread, true, "b is still waiting");
    assert.equal(readOpenLane({ ...bot, tasks: [lane("a", true, 5)] }).unread, false);
    assert.equal(openLaneUnread(bot), true);
  });
  test("an agent flagged unread by a room turn, with no lane to show it, can still be read", () => {
    const bot = { threadId: "a", activeTaskId: "a", unread: true, tasks: [lane("a", false, 5)] };
    assert.equal(openLaneUnread(bot), true);
    assert.equal(readOpenLane(bot).unread, false);
  });
});
