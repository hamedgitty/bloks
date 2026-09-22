// Questions are for the person, whatever the engine called them.
//
// The bug this holds shut: Claude Code asks permission to *use* its
// AskUserQuestion tool, so a question reaches us shaped like a request
// to run a command. Offered "always allow" for it, somebody writes a
// rule, and from then on every question is answered by the rule and the
// agent can never ask anything again.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decide, isQuestionTool, targetOf, type Rule } from "../server/policy.ts";

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r1",
  effect: "allow",
  field: "tool",
  op: "equals",
  value: "AskUserQuestion",
  enabled: true,
  createdAt: 0,
  ...over,
});

const ask = (tool: string) => targetOf(tool, {}, { botId: "b1", agent: "Ivy" });

describe("isQuestionTool", () => {
  test("our own asking tools", () => {
    for (const name of ["ask_user", "request_secret", "request_connection"]) {
      assert.equal(isQuestionTool(name), true, name);
    }
  });

  test("an engine's native one, however it is spelled", () => {
    for (const name of ["AskUserQuestion", "askuserquestion", "mcp__bloks__ask_user", "item/tool/requestUserInput"]) {
      assert.equal(isQuestionTool(name), true, name);
    }
  });

  test("an action is not a question", () => {
    for (const name of ["Bash", "edit", "write_file", "mcp__computer__click", "", undefined]) {
      assert.equal(isQuestionTool(name as string), false, String(name));
    }
  });
});

describe("decide", () => {
  test("a rule cannot allow a question, so the person is still asked", () => {
    const decision = decide([rule()], ask("AskUserQuestion"));
    assert.equal(decision.verdict, "ask");
    assert.match(decision.because, /for you to answer/);
  });

  test("a deny rule cannot silence a question either", () => {
    const decision = decide([rule({ effect: "deny" })], ask("ask_user"));
    assert.equal(decision.verdict, "ask");
  });

  test("an existing bad rule stops doing harm without being deleted", () => {
    // Somebody who already pressed the button has a rule on disk. The
    // upgrade has to give them back the ability to be asked.
    const saved = [rule(), rule({ id: "r2", value: "Bash" })];
    assert.equal(decide(saved, ask("AskUserQuestion")).verdict, "ask");
    // and the ordinary rule beside it still works
    assert.equal(decide(saved, ask("Bash")).verdict, "allow");
  });

  test("rules still govern everything that is not a question", () => {
    const decision = decide([rule({ value: "Bash" })], ask("Bash"));
    assert.equal(decision.verdict, "allow");
  });
});
