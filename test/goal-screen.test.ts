// A goal on screen: `/goal` in the composer's list, the chip's words and
// its one press, the dialog's state, and what a goal is allowed to
// interrupt you for. The server's side is goals.test.ts and goal-loop.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOKS_COMMANDS, matches, segments, withBloksCommands, type Command } from "../src/lib/slashCommands.ts";
import { goalAction, goalState, goalStateShort } from "../src/lib/goals.ts";
import { noticeFor, type NotifyContext } from "../src/lib/notify.ts";
import { initialState, reducer, type LaneGoal } from "../src/state/reducer.ts";

const skill = (id: string, source: Command["source"] = "library", kind?: Command["kind"]): Command => ({
  id,
  name: id,
  description: `${id} does a thing`,
  source,
  ...(kind ? { kind } : {}),
});

test("/goal is offered first in an agent conversation, and only at the start of a message", () => {
  const listed = withBloksCommands([skill("tldr"), skill("gather", "engine")], {});
  assert.deepEqual(matches(listed, "g").map((c) => c.id), ["goal", "gather"]);
  // a command is read only where the server reads one: first
  assert.deepEqual(matches(listed, "goal", 8, false).map((c) => c.id), []);
  // and it is marked in the box like any other command the agent knows
  assert.deepEqual(segments("/goal ship it", new Set(listed.filter((c) => !c.prefix).map((c) => c.id))), [
    { text: "/goal", skill: true },
    { text: " ship it", skill: false },
  ]);
});

test("an engine's own goal gives way, and a conversation that takes no goal is offered none", () => {
  // typing /goal reaches Bloks, never the engine, so listing the engine's
  // would offer something that cannot be reached
  const listed = withBloksCommands([skill("goal", "engine", "command"), skill("goal", "engine", "skill")], {});
  assert.deepEqual(listed.map((c) => c.source), ["bloks"]);
  // a dollar skill of the same name is a different word, and stays
  const dollar = { ...skill("goal", "engine", "skill"), prefix: "$" as const };
  assert.equal(withBloksCommands([dollar], {}).length, 2);
  assert.deepEqual(withBloksCommands([skill("tldr")], { noGoals: true }).map((c) => c.id), ["tldr"]);
  assert.equal(BLOKS_COMMANDS[0].kind, "command");
});

const goal = (over: Partial<LaneGoal>): LaneGoal => ({
  text: "ship it",
  budget: 20,
  turns: 3,
  status: "active",
  startedAt: 1,
  ...over,
});

test("the chip says which turn of how many, or how the goal ended and why", () => {
  assert.equal(goalState(goal({})), "turn 3 of 20");
  assert.equal(goalState(goal({ judging: true })), "checking turn 3 of 20");
  assert.equal(goalState(goal({ status: "paused" })), "paused at turn 3 of 20");
  assert.equal(goalState(goal({ status: "done", turns: 1 })), "done in 1 turn");
  assert.equal(goalState(goal({ status: "blocked", lastReason: "needs the staging password" })), "blocked: needs the staging password");
  assert.equal(goalState(goal({ status: "out", turns: 20 })), "out of turns (20 of 20)");
  // and short enough for a phone, where the goal itself needs the room
  assert.equal(goalStateShort(goal({})), "3 of 20");
  assert.equal(goalStateShort(goal({ status: "paused" })), "paused, 3 of 20");
  assert.equal(goalStateShort(goal({ status: "blocked", lastReason: "a long reason that would not fit" })), "needs you");
});

test("the chip's one press: pause what goes, resume what stopped short, more turns for what ran out", () => {
  assert.deepEqual(goalAction(goal({})), { label: "Pause", body: { status: "paused" } });
  assert.deepEqual(goalAction(goal({ status: "paused" })), { label: "Resume", body: { status: "active" } });
  assert.deepEqual(goalAction(goal({ status: "blocked" })), { label: "Resume", body: { status: "active" } });
  assert.deepEqual(goalAction(goal({ status: "out", turns: 20 })), { label: "More turns", body: { status: "active", budget: 30 } });
  // never past the server's cap, and nothing to resume once done
  assert.deepEqual(goalAction(goal({ status: "out", budget: 95, turns: 95 }))?.body, { status: "active", budget: 100 });
  assert.equal(goalAction(goal({ status: "out", budget: 100, turns: 100 })), null);
  assert.equal(goalAction(goal({ status: "done" })), null);
});

test("Set a goal opens on the conversation it was asked from, and closes", () => {
  const open = reducer(initialState, { type: "openGoal", botId: "bot-1", taskId: "lane-2" });
  assert.deepEqual(open.goalFor, { botId: "bot-1", taskId: "lane-2" });
  assert.equal(reducer(open, { type: "closeGoal" }).goalFor, null);
});

const bot = { id: "bot-1", name: "Sage", notifications: true };
const away: NotifyContext = { focused: false, selectedId: "", threadId: "t1", bot };

test("a goal says where it ended up once, and its turns on the way stay quiet", () => {
  const done = noticeFor({ role: "bot", kind: "notice", goal: "done", text: "Goal done: shipped (3 turns)." }, away);
  assert.equal(done?.title, "Sage");
  assert.equal(done?.urgent, false);
  // blocked has stopped the work, like a question, so it outranks the switch
  const blocked = noticeFor(
    { role: "bot", kind: "notice", goal: "blocked", text: "Goal blocked: needs a key." },
    { ...away, bot: { ...bot, notifications: false } },
  );
  assert.equal(blocked?.title, "Sage needs you");
  assert.equal(blocked?.urgent, true);
  assert.ok(noticeFor({ role: "bot", kind: "notice", goal: "out", text: "Goal stopped after 20 turns." }, away));
  // the person's own doing is not news to them
  assert.equal(noticeFor({ role: "bot", kind: "notice", goal: "set", text: "Goal set: x." }, away), null);
  assert.equal(noticeFor({ role: "bot", kind: "notice", goal: "paused", text: "Goal paused." }, away), null);
  // twenty replies on the way to a goal are the work, not twenty banners
  assert.equal(noticeFor({ role: "bot", kind: "text", text: "Fixed the parser." }, { ...away, goalRunning: true }), null);
  assert.ok(noticeFor({ role: "bot", kind: "text", text: "Fixed the parser." }, away));
  // and nothing about a conversation already on screen
  assert.equal(noticeFor({ role: "bot", kind: "notice", goal: "done", text: "Goal done." }, { ...away, focused: true, selectedId: "bot-1" }), null);
});
