// Workflows: values between steps, conditions, and the gate.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_TIMEOUT_MIN,
  MAX_STEPS,
  MAX_TIMEOUT_MIN,
  clean,
  describe as describeWorkflow,
  fill,
  firesOn,
  holds,
  nextMove,
  problems,
  referencesIn,
  scopeOf,
  settled,
  slug,
  timedOut,
  whereToAsk,
  waitUntil,
  type Step,
  type WorkflowRun,
} from "../server/workflows.ts";

const scope = {
  trigger: { text: "the invoice from Acme looks wrong" },
  steps: { triage: { text: "Urgent: the total is off by 400" }, quiet: { text: "" } },
};

describe("values passed between steps", () => {
  test("a reference becomes what the earlier step said", () => {
    assert.equal(fill("Look at: {{steps.triage.text}}", scope), "Look at: Urgent: the total is off by 400");
    assert.equal(fill("{{trigger.text}}", scope), "the invoice from Acme looks wrong");
  });

  test("several references in one line", () => {
    assert.equal(
      fill("{{trigger.text}} / {{steps.triage.text}}", scope),
      "the invoice from Acme looks wrong / Urgent: the total is off by 400",
    );
  });

  test("whitespace inside the braces is allowed", () => {
    assert.equal(fill("{{ trigger.text }}", scope), "the invoice from Acme looks wrong");
  });

  test("a reference to nothing becomes nothing, not literal braces", () => {
    // an agent handed "{{steps.nope.text}}" as characters does its best
    // with them, which is worse than a sentence with a gap in it
    assert.equal(fill("Look at: {{steps.nope.text}}", scope), "Look at: ");
    assert.equal(fill("Look at: {{trigger.nope}}", scope), "Look at: ");
  });

  test("something that is not a reference is left alone", () => {
    assert.equal(fill("use {{ }} braces or { one }", scope), "use {{ }} braces or { one }");
    assert.equal(fill("", scope), "");
  });

  test("what a step mentions can be listed without running it", () => {
    assert.deepEqual(referencesIn("{{trigger.text}} then {{steps.a.text}}"), ["trigger.text", "steps.a.text"]);
    assert.deepEqual(referencesIn("nothing here"), []);
  });

  test("a filled value is not itself expanded again", () => {
    // otherwise a message containing braces would reach into the scope
    const sneaky = { trigger: { text: "{{steps.triage.text}}" }, steps: scope.steps };
    assert.equal(fill("{{trigger.text}}", sneaky), "{{steps.triage.text}}");
  });
});

describe("conditions", () => {
  test("no condition means the step runs", () => {
    assert.equal(holds(undefined, scope), true);
  });

  test("contains, and its negative", () => {
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "contains", right: "urgent" }, scope), true);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "contains", right: "routine" }, scope), false);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "not-contains", right: "routine" }, scope), true);
  });

  test("case and surrounding space do not decide it", () => {
    // a condition that fails on a trailing newline teaches people not to
    // use conditions
    const padded = { trigger: {}, steps: { a: { text: "  YES\n" } } };
    assert.equal(holds({ left: "{{steps.a.text}}", op: "equals", right: "yes" }, padded), true);
  });

  test("starts with, ends with, equals", () => {
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "starts-with", right: "urgent" }, scope), true);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "ends-with", right: "400" }, scope), true);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "equals", right: "urgent" }, scope), false);
  });

  test("empty and not empty, which is what a failed step looks like", () => {
    assert.equal(holds({ left: "{{steps.quiet.text}}", op: "empty" }, scope), true);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "not-empty" }, scope), true);
    assert.equal(holds({ left: "{{steps.nope.text}}", op: "empty" }, scope), true);
  });

  test("contains nothing is not contains everything", () => {
    // an empty right side would otherwise match every string, so a
    // half-written condition would silently always hold
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "contains", right: "" }, scope), false);
    assert.equal(holds({ left: "{{steps.triage.text}}", op: "starts-with", right: "" }, scope), false);
  });

  test("an operator nobody knows does not run the step", () => {
    assert.equal(holds({ left: "a", op: "sorcery" as never, right: "a" }, scope), false);
  });

  test("nothing in a condition is evaluated", () => {
    // the whole reason there is no sandbox here: this is a comparison,
    // not an expression, so there is nothing that can run away
    const hostile = { trigger: { text: "process.exit(1)" }, steps: {} };
    assert.equal(holds({ left: "{{trigger.text}}", op: "contains", right: "process" }, hostile), true);
  });
});

const ask = (id: string, extra: Partial<Step> = {}): Step => ({
  id,
  action: "ask",
  text: "have a look",
  targetId: "bot-1",
  ...extra,
});

describe("what is wrong with a workflow", () => {
  test("a workflow that is fine has nothing wrong with it", () => {
    assert.deepEqual(problems({ trigger: { kind: "manual" }, steps: [ask("triage")] }), []);
  });

  test("a step reading a later step is refused when it is saved", () => {
    // this is the one worth catching early: at run time it is an empty
    // gap in a prompt hours later, which nobody connects back to here
    const found = problems({
      trigger: { kind: "manual" },
      steps: [ask("first", { text: "see {{steps.second.text}}" }), ask("second")],
    });
    assert.equal(found.length, 1);
    assert.match(found[0], /has not run by then/);
  });

  test("a step reading itself", () => {
    const found = problems({
      trigger: { kind: "manual" },
      steps: [ask("only", { text: "see {{steps.only.text}}" })],
    });
    assert.match(found[0] ?? "", /reads its own answer/);
  });

  test("a backward reference is fine, which is the point", () => {
    assert.deepEqual(
      problems({
        trigger: { kind: "manual" },
        steps: [ask("first"), ask("second", { text: "see {{steps.first.text}}" })],
      }),
      [],
    );
  });

  test("a reference inside a condition is checked too", () => {
    const found = problems({
      trigger: { kind: "manual" },
      steps: [ask("a", { when: { left: "{{steps.later.text}}", op: "contains", right: "x" } }), ask("later")],
    });
    assert.match(found[0] ?? "", /has not run by then/);
  });

  test("the trigger has to say where to watch", () => {
    assert.match(
      problems({ trigger: { kind: "message" }, steps: [ask("a")] })[0] ?? "",
      /needs somewhere to watch/,
    );
    assert.match(
      problems({ trigger: { kind: "reaction", targetId: "room-1" }, steps: [ask("a")] })[0] ?? "",
      /needs an emoji/,
    );
  });

  test("a step has to say who it is for", () => {
    const found = problems({
      trigger: { kind: "manual" },
      steps: [{ id: "a", action: "ask", text: "do it" }],
    });
    assert.match(found[0] ?? "", /who to ask/);
    const room = problems({
      trigger: { kind: "manual" },
      steps: [{ id: "a", action: "post", text: "hello" }],
    });
    assert.match(room[0] ?? "", /which room/);
  });

  test("an approval borrows the place the run is already working in", () => {
    // it does not need a target of its own, but it does need one to be
    // findable: a gate with nowhere to appear is a run that stops dead
    assert.deepEqual(
      problems({ trigger: { kind: "manual" }, steps: [ask("triage"), { id: "gate", action: "approve", text: "ok?" }] }),
      [],
    );
    assert.deepEqual(
      problems({ trigger: { kind: "message", targetId: "room-1" }, steps: [{ id: "gate", action: "approve", text: "ok?" }] }),
      [],
    );
  });

  test("a gate with nowhere to appear is refused when it is saved", () => {
    const found = problems({ trigger: { kind: "manual" }, steps: [{ id: "gate", action: "approve", text: "ok?" }] });
    assert.match(found[0] ?? "", /nowhere to put its question/);
  });

  test("where a gate asks, resolved the same way the runner will", () => {
    const steps: Step[] = [
      { id: "triage", action: "ask", text: "x", targetId: "bot-1" },
      { id: "tell", action: "post", text: "y", targetId: "room-9" },
      { id: "gate", action: "approve", text: "?" },
      { id: "own", action: "approve", text: "?", targetId: "bot-7" },
    ];
    // the nearest earlier step wins, and a post step means a room
    assert.deepEqual(whereToAsk({ trigger: { kind: "manual" }, steps }, 2), { id: "room-9", kind: "room" });
    // a gate naming its own agent uses it
    assert.deepEqual(whereToAsk({ trigger: { kind: "manual" }, steps }, 3), { id: "bot-7", kind: "agent" });
    // nothing earlier, so the trigger's place
    assert.deepEqual(
      whereToAsk({ trigger: { kind: "message", targetId: "room-1", targetKind: "room" }, steps: [steps[2]] }, 0),
      { id: "room-1", kind: "room" },
    );
    assert.equal(whereToAsk({ trigger: { kind: "manual" }, steps: [steps[2]] }, 0), null);
  });

  test("a workflow with no steps, and one with too many", () => {
    assert.match(problems({ trigger: { kind: "manual" }, steps: [] })[0] ?? "", /at least one step/);
    const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ask(`s${i}`));
    assert.ok(problems({ trigger: { kind: "manual" }, steps: many }).some((p) => /at most/.test(p)));
  });

  test("two steps with the same name", () => {
    assert.ok(
      problems({ trigger: { kind: "manual" }, steps: [ask("same"), ask("same")] }).some((p) =>
        /both called/.test(p),
      ),
    );
  });
});

describe("what arrives from a client", () => {
  test("a trigger nobody shipped is refused by name, not quietly made manual", () => {
    // "schedule" is a reasonable guess and not one of ours. Coercing it
    // to manual hands back a workflow that will never fire and says
    // nothing about it, which is the worst of both.
    const workflow = clean({ name: "Weekly", trigger: { kind: "schedule" }, steps: [ask("look")] })!;
    const found = problems(workflow);
    assert.match(found[0] ?? "", /there is no "schedule" trigger/);
    assert.match(found[0] ?? "", /manual, message, reaction, webhook/);
  });

  test("no trigger at all is manual, which is the honest default", () => {
    const workflow = clean({ name: "By hand", steps: [ask("look")] })!;
    assert.equal(workflow.trigger.kind, "manual");
    assert.deepEqual(problems(workflow), []);
  });

  test("a step gets a name a person can type in a template", () => {
    const workflow = clean({
      name: "Invoices",
      trigger: { kind: "manual" },
      steps: [{ action: "ask", text: "Triage this invoice", targetId: "bot-1" }],
    })!;
    assert.equal(workflow.steps[0].id, "triage-this-invoice");
  });

  test("two steps that would take the same name get different ones", () => {
    const workflow = clean({
      trigger: { kind: "manual" },
      steps: [
        { action: "ask", text: "look", targetId: "b" },
        { action: "ask", text: "look", targetId: "b" },
      ],
    })!;
    assert.deepEqual(workflow.steps.map((s) => s.id), ["look", "look-2"]);
  });

  test("an approval gets a timeout whether or not one was asked for", () => {
    const workflow = clean({ trigger: { kind: "manual" }, steps: [{ action: "approve", text: "ok?" }] })!;
    assert.equal(workflow.steps[0].timeoutMin, DEFAULT_TIMEOUT_MIN);
    // nobody answering is not consent
    assert.equal(workflow.steps[0].onTimeout, "stop");
  });

  test("a timeout longer than we keep runs is cut to what we keep", () => {
    const workflow = clean({
      trigger: { kind: "manual" },
      steps: [{ action: "approve", text: "ok?", timeoutMin: 999_999 }],
    })!;
    assert.equal(workflow.steps[0].timeoutMin, MAX_TIMEOUT_MIN);
  });

  test("a trigger listens to the person unless told otherwise", () => {
    // the default that stops a workflow posting into the room it watches
    // and setting itself off forever
    assert.equal(clean({ trigger: { kind: "message", targetId: "room-1" }, steps: [] })!.trigger.from, "user");
    assert.equal(
      clean({ trigger: { kind: "message", targetId: "room-1", from: "anyone" }, steps: [] })!.trigger.from,
      "anyone",
    );
  });

  test("nonsense is refused rather than half accepted", () => {
    assert.equal(clean(null), null);
    assert.equal(clean("a workflow"), null);
    const junk = clean({ trigger: { kind: "telepathy" }, steps: [{ action: "detonate", text: "x" }] })!;
    // an action nobody shipped falls back to asking, which is the
    // harmless one: it says something and does nothing
    assert.equal(junk.steps[0].action, "ask");
    // a trigger nobody shipped does not, because the fallback would be a
    // workflow that never fires
    assert.equal(junk.trigger.kind, "telepathy");
    assert.match(problems(junk)[0] ?? "", /there is no "telepathy" trigger/);
  });

  test("a target that is not an id is dropped rather than carried", () => {
    const workflow = clean({
      trigger: { kind: "message", targetId: "../../etc/passwd" },
      steps: [{ action: "ask", text: "x", targetId: "also bad" }],
    })!;
    assert.equal(workflow.trigger.targetId, undefined);
    assert.equal(workflow.steps[0].targetId, undefined);
  });

  test("more steps than we hold are cut, not spread over two workflows", () => {
    const many = Array.from({ length: MAX_STEPS + 5 }, () => ({ action: "ask", text: "x", targetId: "b" }));
    assert.equal(clean({ trigger: { kind: "manual" }, steps: many })!.steps.length, MAX_STEPS);
  });
});

describe("what a run does next", () => {
  const workflow = {
    steps: [
      { id: "triage", action: "ask", text: "look", targetId: "bot-1" },
      {
        id: "escalate",
        action: "ask",
        text: "chase it",
        targetId: "bot-2",
        when: { left: "{{steps.triage.text}}", op: "contains", right: "urgent" },
      },
      { id: "gate", action: "approve", text: "send it?" },
    ] as Step[],
  };

  const runAt = (cursor: number, values: Record<string, Record<string, string>> = {}): WorkflowRun => ({
    id: "run-1",
    workflowId: "wf-1",
    startedAt: 1_000,
    state: "running",
    cursor,
    trigger: {},
    values,
    steps: [],
  });

  test("the first step, with nothing to decide", () => {
    const move = nextMove(workflow, runAt(0));
    assert.equal(move.kind, "step");
    assert.equal(move.kind === "step" && move.step.id, "triage");
  });

  test("a step whose condition holds runs", () => {
    const move = nextMove(workflow, runAt(1, { triage: { text: "URGENT, chase this" } }));
    assert.equal(move.kind, "step");
  });

  test("a step whose condition does not hold is skipped, not failed", () => {
    const move = nextMove(workflow, runAt(1, { triage: { text: "nothing much" } }));
    assert.equal(move.kind, "skip");
    assert.equal(move.kind === "skip" && move.step.id, "escalate");
  });

  test("past the last step is done", () => {
    assert.equal(nextMove(workflow, runAt(3)).kind, "done");
  });

  test("a run that has stopped is recognisably stopped", () => {
    assert.equal(settled({ ...runAt(0), state: "done" }), true);
    assert.equal(settled({ ...runAt(0), state: "failed" }), true);
    assert.equal(settled({ ...runAt(0), state: "stopped" }), true);
    assert.equal(settled({ ...runAt(0), state: "waiting" }), false);
    assert.equal(settled(runAt(0)), false);
  });

  test("a scope is the trigger and everything finished so far", () => {
    const run = runAt(2, { triage: { text: "urgent" } });
    run.trigger = { text: "hello" };
    assert.deepEqual(scopeOf(run), { trigger: { text: "hello" }, steps: { triage: { text: "urgent" } } });
  });
});

describe("the gate and its clock", () => {
  const gate: Step = { id: "gate", action: "approve", text: "send it?", timeoutMin: 60 };

  test("waiting ends a set time after it starts", () => {
    assert.equal(waitUntil(gate, 1_000), 1_000 + 60 * 60_000);
  });

  test("an approval with no timeout of its own still has one", () => {
    assert.equal(
      waitUntil({ id: "g", action: "approve", text: "?" }, 0),
      DEFAULT_TIMEOUT_MIN * 60_000,
    );
  });

  test("only runs that are actually waiting time out", () => {
    const waiting = (id: string, until: number, state: WorkflowRun["state"] = "waiting"): WorkflowRun => ({
      id,
      workflowId: "wf",
      startedAt: 0,
      state,
      cursor: 1,
      trigger: {},
      values: {},
      steps: [],
      waiting: { stepId: "gate", threadId: "t", messageId: "m", until, onTimeout: "stop" },
    });
    const runs = [waiting("a", 500), waiting("b", 5_000), waiting("c", 500, "running")];
    assert.deepEqual(timedOut(runs, 1_000).map((r) => r.id), ["a"]);
  });

  test("the moment it is due counts as due", () => {
    const run: WorkflowRun = {
      id: "a",
      workflowId: "wf",
      startedAt: 0,
      state: "waiting",
      cursor: 0,
      trigger: {},
      values: {},
      steps: [],
      waiting: { stepId: "g", threadId: "t", messageId: "m", until: 1_000, onTimeout: "stop" },
    };
    assert.equal(timedOut([run], 1_000).length, 1);
  });
});

describe("what sets a workflow off", () => {
  const onMessage = { kind: "message" as const, targetId: "room-1", contains: "invoice", from: "user" as const };

  test("a message in the watched room, mentioning the word", () => {
    assert.equal(
      firesOn(onMessage, { kind: "message", targetId: "room-1", text: "the invoice is wrong", fromUser: true }),
      true,
    );
  });

  test("the same message somewhere else does not", () => {
    assert.equal(
      firesOn(onMessage, { kind: "message", targetId: "room-2", text: "the invoice is wrong", fromUser: true }),
      false,
    );
  });

  test("a message without the word does not", () => {
    assert.equal(firesOn(onMessage, { kind: "message", targetId: "room-1", text: "morning", fromUser: true }), false);
  });

  test("no word means any message", () => {
    const any = { kind: "message" as const, targetId: "room-1", from: "user" as const };
    assert.equal(firesOn(any, { kind: "message", targetId: "room-1", text: "anything", fromUser: true }), true);
  });

  test("an agent talking does not set off a workflow that watches the person", () => {
    // this is what stops a workflow that posts into the room it watches
    // from triggering itself forever
    assert.equal(
      firesOn(onMessage, { kind: "message", targetId: "room-1", text: "the invoice is wrong", fromUser: false }),
      false,
    );
  });

  test("unless it was told to listen to anyone", () => {
    assert.equal(
      firesOn(
        { ...onMessage, from: "anyone" },
        { kind: "message", targetId: "room-1", text: "the invoice is wrong", fromUser: false },
      ),
      true,
    );
  });

  test("a reaction fires on its emoji and no other", () => {
    const onReaction = { kind: "reaction" as const, targetId: "room-1", emoji: "🚀", from: "user" as const };
    assert.equal(firesOn(onReaction, { kind: "reaction", targetId: "room-1", emoji: "🚀", fromUser: true }), true);
    assert.equal(firesOn(onReaction, { kind: "reaction", targetId: "room-1", emoji: "👍", fromUser: true }), false);
  });

  test("a message never fires a reaction trigger, or the other way round", () => {
    const onReaction = { kind: "reaction" as const, targetId: "room-1", emoji: "🚀", from: "user" as const };
    assert.equal(firesOn(onReaction, { kind: "message", targetId: "room-1", text: "🚀", fromUser: true }), false);
    assert.equal(firesOn(onMessage, { kind: "reaction", targetId: "room-1", emoji: "🚀", fromUser: true }), false);
  });

  test("manual and webhook triggers are never set off by talking", () => {
    for (const kind of ["manual", "webhook"] as const) {
      assert.equal(
        firesOn({ kind, targetId: "room-1" }, { kind: "message", targetId: "room-1", text: "x", fromUser: true }),
        false,
      );
    }
  });
});

describe("saying what a workflow does", () => {
  const base = { id: "w", name: "n", enabled: true, createdAt: 0 };

  test("a manual one with two steps", () => {
    assert.equal(
      describeWorkflow({
        ...base,
        trigger: { kind: "manual" },
        steps: [
          { id: "a", action: "ask", text: "x" },
          { id: "b", action: "post", text: "y" },
        ],
      }),
      "When you run it, 2 steps",
    );
  });

  test("one step reads as one step", () => {
    assert.equal(
      describeWorkflow({ ...base, trigger: { kind: "manual" }, steps: [{ id: "a", action: "ask", text: "x" }] }),
      "When you run it, 1 step",
    );
  });

  test("a gate is worth saying out loud", () => {
    assert.match(
      describeWorkflow({
        ...base,
        trigger: { kind: "message", targetId: "r", contains: "invoice" },
        steps: [
          { id: "a", action: "ask", text: "x" },
          { id: "g", action: "approve", text: "?" },
        ],
      }),
      /When a message mentions "invoice", 2 steps, one waits for you/,
    );
  });
});

describe("naming a step", () => {
  test("from the words, not from a random string", () => {
    assert.equal(slug("Triage the invoice"), "triage-the-invoice");
    assert.equal(slug("  Spaces   and PUNCTUATION!! "), "spaces-and-punctuation");
  });

  test("something with no letters in it still gets a name", () => {
    assert.equal(slug("!!!"), "step");
    assert.equal(slug(""), "step");
  });

  test("a name already taken gets a number", () => {
    assert.equal(slug("look", ["look"]), "look-2");
    assert.equal(slug("look", ["look", "look-2"]), "look-3");
  });
});
