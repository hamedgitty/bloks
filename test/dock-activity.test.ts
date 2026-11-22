// What the side dock reads off a conversation (src/lib/dockActivity.ts,
// GitHub 522): which calls are the computer's, when it is running or
// waiting on the person, and which dot wins. The terminal is not read:
// its shells are the person's, not where an agent's commands run.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  browserStatus,
  computerStatus,
  computerWaiting,
  currentTurn,
  isComputerCall,
  strongest,
  tabsInScope,
  teammateActive,
  TEAMMATE_MS,
  turnComputerUse,
} from "../src/lib/dockActivity.ts";
import type { Message } from "../src/state/reducer.ts";

let n = 0;
const msg = (over: Partial<Message>): Message => ({ id: `m${++n}`, role: "bot", text: "", at: n, ...over }) as Message;
const ask = (text = "go") => msg({ role: "user", text });
const call = (name: string, ok?: boolean, command?: string) => msg({ kind: "activity", tool: { name, ...(command ? { command } : {}), ...(ok === undefined ? {} : { ok }) } });
const approval = (tool: string, over: Record<string, unknown> = {}) =>
  msg({ kind: "options", card: { title: "Approval needed", subtitle: "", options: ["Allow", "Deny"], requestId: "r1", tool, ...over } });

describe("which calls are the computer", () => {
  test("one surface across engines", () => {
    for (const name of ["mcp__computer__screenshot", "mcp__computer__computer_exec", "bloks_computer.click", "computer_exec", "computer_exec: ls", "computer"]) {
      assert.equal(isComputerCall(name), true, name);
    }
  });

  test("commands, reading, editing and the browser are not", () => {
    for (const name of ["Bash", "shell", "Read", "Edit", "WebSearch", "mcp__browser__open", "computers", "", undefined]) {
      assert.equal(isComputerCall(name), false, String(name));
    }
  });
});

describe("the turn in progress", () => {
  test("is everything after the person's last message, named by it", () => {
    const first = ask();
    const old = call("Bash", true);
    const second = ask();
    const now = call("Bash");
    const turn = currentTurn([first, old, second, now]);
    assert.equal(turn.turn, second.id);
    assert.deepEqual(turn.rows.map((m) => m.id), [now.id]);
    assert.equal(currentTurn([old]).turn, "start");
  });

  test("says the newest computer call and whether one still runs", () => {
    const earlier = call("mcp__computer__click", true);
    const screen = call("mcp__computer__screenshot");
    const turn = ask();
    const use = turnComputerUse([ask(), earlier, call("Bash"), screen]);
    assert.deepEqual({ latest: use.latest, running: use.running }, { latest: screen.id, running: true });
    assert.deepEqual(turnComputerUse([earlier, turn, call("Bash")]).latest, null, "commands never count");
    const stopped = msg({ kind: "activity", tool: { name: "computer_exec", stopped: true } });
    assert.equal(turnComputerUse([ask(), stopped]).running, false, "a call its turn left behind is not running");
  });
});

describe("dots", () => {
  test("an unanswered approval for a computer action is waiting", () => {
    assert.equal(computerWaiting([approval("mcp__computer__click")]), true);
    assert.equal(computerWaiting([approval("Bash")]), false, "a command is not the computer");
    assert.equal(computerWaiting([approval("mcp__computer__click", { answered: "Allow" })]), false);
    assert.equal(computerWaiting([approval("mcp__computer__click", { dismissed: true })]), false);
    assert.equal(computerWaiting([approval("mcp__computer__click", { runId: "w1" })]), false, "a workflow's gate is not an agent held");
  });

  test("the computer waits over working, and works only while its turn does", () => {
    const running = [ask(), call("mcp__computer__screenshot")];
    assert.equal(computerStatus(running, true), "working");
    assert.equal(computerStatus(running, false), null);
    assert.equal(computerStatus([...running, approval("computer_exec")], true), "waiting");
    assert.equal(computerStatus([ask(), call("Bash")], true), null);
  });

  test("the browser: driving is work, held by a person or a dialog is waiting", () => {
    assert.equal(browserStatus(null), null);
    assert.equal(browserStatus({ control: { by: "idle" }, tabs: [] }), null);
    assert.equal(browserStatus({ control: { by: "agent", botId: "b" }, tabs: [{}] }), "working");
    assert.equal(browserStatus({ control: { by: "agent", botId: "b" }, tabs: [{ dialog: { id: "d" } }] }), "waiting");
    assert.equal(browserStatus({ control: { by: "person", waiting: { botId: "b" } }, tabs: [] }), "waiting");
    assert.equal(browserStatus({ control: { by: "person" }, tabs: [] }), null);
  });

  test("waiting outranks a teammate, who outranks work", () => {
    assert.equal(strongest("working", "waiting", "teammate"), "waiting");
    assert.equal(strongest("working", "teammate"), "teammate");
    assert.equal(strongest(null, undefined, "working"), "working");
    assert.equal(strongest(), null);
  });

  test("a teammate counts for a few seconds after their last keystroke", () => {
    assert.equal(teammateActive({ at: 1000 }, 1000 + TEAMMATE_MS - 1), true);
    assert.equal(teammateActive({ at: 1000 }, 1000 + TEAMMATE_MS), false);
    assert.equal(teammateActive(undefined), false);
  });
});

describe("this chat's agent, or everyone's", () => {
  const tabs = [
    { id: "t1", by: { kind: "person" } },
    { id: "t2", by: { kind: "agent", botId: "ada" } },
    { id: "t3", by: { kind: "agent", botId: "sam" } },
  ];
  test("everyone's lists every tab", () => {
    assert.deepEqual(tabsInScope(tabs, "all", "ada", null).map((t) => t.id), ["t1", "t2", "t3"]);
  });
  test("the agent's lists what it opened, and the tab in front", () => {
    assert.deepEqual(tabsInScope(tabs, "agent", "ada", null).map((t) => t.id), ["t2"]);
    assert.deepEqual(tabsInScope(tabs, "agent", "ada", "t3").map((t) => t.id), ["t2", "t3"]);
    assert.deepEqual(tabsInScope(tabs, "agent", null, null).length, 3, "no agent here, nothing to narrow to");
  });
});
