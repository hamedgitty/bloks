// Rules a person writes about what their agents may do.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_RULES,
  PolicyStore,
  Wheel,
  applies,
  cleanRule,
  decide,
  describe as describeRule,
  heldRefusal,
  pausedMessage,
  refusal,
  targetOf,
  type Ask,
  type Rule,
} from "../server/policy.ts";

const rule = (over: Partial<Rule> & Pick<Rule, "effect" | "field" | "op" | "value">): Rule => ({
  id: `${over.effect}-${over.field}-${over.value}`,
  enabled: true,
  createdAt: 0,
  ...over,
});

const ask = (over: Partial<Ask> = {}): Ask => ({
  tool: "Bash",
  command: "rm -rf build",
  botId: "bot-1",
  agent: "Ivy",
  ...over,
});

describe("reading the target out of a request", () => {
  const who = { botId: "b", agent: "Ivy" };

  test("a shell command", () => {
    const target = targetOf("Bash", { command: "npm test" }, who);
    assert.equal(target.tool, "Bash");
    assert.equal(target.command, "npm test");
    assert.equal(target.path, undefined);
  });

  test("a file, under whichever name the tool used", () => {
    assert.equal(targetOf("Write", { file_path: "/tmp/a" }, who).path, "/tmp/a");
    assert.equal(targetOf("Edit", { path: "/tmp/b" }, who).path, "/tmp/b");
    assert.equal(targetOf("NotebookEdit", { notebook_path: "/tmp/c.ipynb" }, who).path, "/tmp/c.ipynb");
  });

  test("a url", () => {
    assert.equal(targetOf("WebFetch", { url: "https://example.com" }, who).url, "https://example.com");
  });

  test("what is not there stays absent, rather than becoming empty", () => {
    // this is what stops a rule about paths matching a request with none
    const target = targetOf("Bash", { command: "ls" }, who);
    assert.equal(target.path, undefined);
    assert.equal(target.url, undefined);
  });

  test("a blank value is the same as no value", () => {
    assert.equal(targetOf("Write", { file_path: "   " }, who).path, undefined);
  });

  test("a tool with no name still has one", () => {
    assert.equal(targetOf("", {}, who).tool, "tool");
  });

  test("who is asking travels with it", () => {
    const target = targetOf("Bash", {}, { botId: "bot-9", agent: "Kit" });
    assert.equal(target.botId, "bot-9");
    assert.equal(target.agent, "Kit");
  });
});

// The bridge forwards Claude's own tool_name and tool input untouched
// (server/permission-proxy.ts), so these are the shapes a rule is really
// checked against. Pinned by example, because a rename on that side would
// otherwise quietly stop every path rule from ever matching.
describe("the requests that actually arrive", () => {
  const who = { botId: "b", agent: "Ivy" };

  test("a shell command, as Bash sends it", () => {
    const target = targetOf("Bash", { command: "rm -rf build", description: "clean" }, who);
    assert.equal(target.command, "rm -rf build");
    assert.equal(decide([rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf" })], target).verdict, "deny");
  });

  test("a file write, as Write sends it", () => {
    const target = targetOf("Write", { file_path: "/etc/hosts", content: "..." }, who);
    assert.equal(target.path, "/etc/hosts");
    assert.equal(decide([rule({ effect: "deny", field: "path", op: "starts-with", value: "/etc" })], target).verdict, "deny");
  });

  test("a fetch, as WebFetch sends it", () => {
    const target = targetOf("WebFetch", { url: "https://pastebin.com/x", prompt: "read it" }, who);
    assert.equal(target.url, "https://pastebin.com/x");
    assert.equal(decide([rule({ effect: "deny", field: "url", op: "contains", value: "pastebin" })], target).verdict, "deny");
  });

  test("an edit, as Edit sends it", () => {
    const target = targetOf("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }, who);
    assert.equal(target.path, "/tmp/a.ts");
  });

  test("a tool with an input we have never seen decides nothing on its own", () => {
    // no command, no path, no url: only a rule about the tool itself can
    // apply, which is the safe way to meet something new
    const target = targetOf("SomeNewTool", { whatever: 1 }, who);
    assert.equal(target.command, undefined);
    assert.equal(decide([rule({ effect: "deny", field: "command", op: "contains", value: "x" })], target).verdict, "ask");
    assert.equal(decide([rule({ effect: "deny", field: "tool", op: "equals", value: "somenewtool" })], target).verdict, "deny");
  });
});

describe("whether a rule applies", () => {
  test("the plain comparisons", () => {
    assert.equal(applies(rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf" }), ask()), true);
    assert.equal(applies(rule({ effect: "deny", field: "command", op: "contains", value: "curl" }), ask()), false);
    assert.equal(applies(rule({ effect: "allow", field: "tool", op: "equals", value: "bash" }), ask()), true);
    assert.equal(
      applies(rule({ effect: "allow", field: "path", op: "starts-with", value: "/tmp/" }), ask({ path: "/tmp/x" })),
      true,
    );
    assert.equal(
      applies(rule({ effect: "allow", field: "path", op: "ends-with", value: ".md" }), ask({ path: "/a/b.md" })),
      true,
    );
  });

  test("case is not a way past a rule", () => {
    assert.equal(
      applies(rule({ effect: "deny", field: "command", op: "contains", value: "RM -RF" }), ask()),
      true,
    );
  });

  test("a rule about something the request does not have does not apply", () => {
    // including a "does not contain" one: a request with no path has not
    // satisfied it, it is simply not what the rule is about
    const noPath = ask({ path: undefined });
    assert.equal(applies(rule({ effect: "deny", field: "path", op: "contains", value: "/etc" }), noPath), false);
    assert.equal(applies(rule({ effect: "deny", field: "path", op: "not-contains", value: "/tmp" }), noPath), false);
  });

  test("a rule scoped to one agent leaves the others alone", () => {
    const mine = rule({ effect: "deny", field: "tool", op: "equals", value: "bash", botId: "bot-1" });
    assert.equal(applies(mine, ask({ botId: "bot-1" })), true);
    assert.equal(applies(mine, ask({ botId: "bot-2" })), false);
  });

  test("an empty value matches nothing rather than everything", () => {
    // a half written rule that matched every request would be the worst
    // possible way for this to fail
    assert.equal(applies(rule({ effect: "deny", field: "command", op: "contains", value: "" }), ask()), false);
    assert.equal(applies(rule({ effect: "deny", field: "command", op: "starts-with", value: "" }), ask()), false);
  });

  test("a rule this build cannot read is unknown, not false", () => {
    assert.equal(applies(rule({ effect: "deny", field: "sorcery" as never, op: "contains", value: "x" }), ask()), "unknown");
    assert.equal(applies(rule({ effect: "deny", field: "tool", op: "sorcery" as never, value: "x" }), ask()), "unknown");
  });
});

describe("deciding", () => {
  test("no rules means ask, which is the whole difference from a gateway", () => {
    // the thing an empty policy replaces here is a person deciding, not
    // an open door
    const out = decide([], ask());
    assert.equal(out.verdict, "ask");
  });

  test("a matching deny refuses, and says which rule", () => {
    const out = decide([rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf" })], ask());
    assert.equal(out.verdict, "deny");
    assert.match(out.because, /rm -rf/);
  });

  test("a matching allow permits without asking", () => {
    const out = decide([rule({ effect: "allow", field: "tool", op: "equals", value: "bash" })], ask());
    assert.equal(out.verdict, "allow");
  });

  test("deny beats allow, whatever order they were written in", () => {
    // an operator can then reason about what is forbidden without reading
    // every allow rule written since
    const rules = [
      rule({ effect: "allow", field: "tool", op: "equals", value: "bash" }),
      rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf" }),
    ];
    assert.equal(decide(rules, ask()).verdict, "deny");
    assert.equal(decide([...rules].reverse(), ask()).verdict, "deny");
  });

  test("a disabled rule decides nothing", () => {
    const off = rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf", enabled: false });
    assert.equal(decide([off], ask()).verdict, "ask");
  });

  test("a deny nobody can evaluate denies", () => {
    // it has not been shown not to apply, and permitting it would be the
    // unsafe direction
    const out = decide([rule({ effect: "deny", field: "tool", op: "sorcery" as never, value: "x" })], ask());
    assert.equal(out.verdict, "deny");
    assert.match(out.because, /cannot check/);
  });

  test("an allow nobody can evaluate does not allow", () => {
    const out = decide([rule({ effect: "allow", field: "tool", op: "sorcery" as never, value: "x" })], ask());
    assert.equal(out.verdict, "ask", "an unreadable allow permitted something");
  });

  test("the first matching deny is the one reported", () => {
    const rules = [
      rule({ id: "first", effect: "deny", field: "tool", op: "equals", value: "bash" }),
      rule({ id: "second", effect: "deny", field: "command", op: "contains", value: "rm" }),
    ];
    const out = decide(rules, ask());
    assert.equal(out.verdict === "deny" && out.rule.id, "first");
  });

  test("a rule for another agent does not decide this one", () => {
    const theirs = rule({ effect: "deny", field: "tool", op: "equals", value: "bash", botId: "bot-2" });
    assert.equal(decide([theirs], ask({ botId: "bot-1" })).verdict, "ask");
  });
});

describe("what the agent is told", () => {
  test("a refusal names the rule and says not to go round it", () => {
    // an agent told only "not allowed" tries a different way round
    const out = decide([rule({ effect: "deny", field: "command", op: "contains", value: "rm -rf" })], ask());
    const message = refusal(out as Extract<typeof out, { verdict: "deny" }>);
    assert.match(message, /rm -rf/);
    assert.match(message, /another way round/);
    assert.match(message, /say what you could not do/);
  });

  test("a rule reads back as a sentence", () => {
    assert.equal(
      describeRule(rule({ effect: "deny", field: "command", op: "not-contains", value: "npm" })),
      'deny when command not contains "npm"',
    );
  });
});

describe("what a client may send", () => {
  const good = { effect: "deny", field: "command", op: "contains", value: "rm -rf" };

  test("a rule that is one comes back clean", () => {
    const out = cleanRule(good);
    assert.ok("rule" in out);
    assert.equal(out.rule.effect, "deny");
    assert.equal(out.rule.enabled, true);
  });

  test("everything that is not a rule is refused at the door", () => {
    // refusing here is what keeps the runtime honest: nothing saved this
    // way can reach the unknown branch
    assert.ok("error" in cleanRule({ ...good, effect: "maybe" }));
    assert.ok("error" in cleanRule({ ...good, field: "sorcery" }));
    assert.ok("error" in cleanRule({ ...good, op: "sorcery" }));
    assert.ok("error" in cleanRule({ ...good, value: "   " }));
  });

  test("each refusal says what is wrong in words", () => {
    const out = cleanRule({ ...good, field: "sorcery" });
    assert.ok("error" in out && out.error.length > 10);
  });

  test("a value too long to read is cut rather than refused", () => {
    const out = cleanRule({ ...good, value: "x".repeat(900) });
    assert.ok("rule" in out && out.rule.value.length <= 200);
  });

  test("an agent id that is not one is dropped, so the rule covers everybody", () => {
    const out = cleanRule({ ...good, botId: "../../etc" });
    assert.ok("rule" in out && out.rule.botId === undefined);
  });

  test("a rule can arrive switched off", () => {
    const out = cleanRule({ ...good, enabled: false });
    assert.ok("rule" in out && out.rule.enabled === false);
  });
});

describe("keeping them", () => {
  const fresh = () => new PolicyStore(join(mkdtempSync(join(tmpdir(), "bloks-rules-")), "rules.json"));
  const body = { effect: "deny" as const, field: "command" as const, op: "contains" as const, value: "rm -rf", enabled: true };

  test("what is added comes back", () => {
    const store = fresh();
    const made = store.add(body, 1_000);
    assert.ok(made?.id);
    assert.equal(store.list().length, 1);
  });

  test("the list reads in the order it runs", () => {
    // a list that reads in a different order than it evaluates is a trap
    const store = fresh();
    store.add({ ...body, effect: "allow", value: "npm" }, 1_000);
    store.add(body, 2_000);
    assert.deepEqual(store.list().map((r) => r.effect), ["deny", "allow"]);
  });

  test("switching one off leaves it there", () => {
    const store = fresh();
    const made = store.add(body, 1_000)!;
    assert.equal(store.setEnabled(made.id, false)?.enabled, false);
    assert.equal(store.list().length, 1);
    assert.equal(decide(store.list(), ask()).verdict, "ask");
  });

  test("removing one, and removing it twice", () => {
    const store = fresh();
    const made = store.add(body, 1_000)!;
    assert.equal(store.remove(made.id), true);
    assert.equal(store.remove(made.id), false);
  });

  test("a rule about an agent that is gone goes with it", () => {
    // it would never fire again, and would read as protection that is
    // not there
    const store = fresh();
    store.add({ ...body, botId: "bot-1" }, 1_000);
    store.add({ ...body, value: "curl" }, 1_000);
    store.removeForBot("bot-1");
    assert.deepEqual(store.list().map((r) => r.value), ["curl"]);
  });

  test("rules do not pile up forever", () => {
    const store = fresh();
    for (let i = 0; i < MAX_RULES + 5; i++) store.add({ ...body, value: `v${i}` }, i);
    assert.equal(store.list().length, MAX_RULES);
  });

  test("they survive being reopened", () => {
    const file = join(mkdtempSync(join(tmpdir(), "bloks-rules-")), "rules.json");
    new PolicyStore(file).add(body, 1_000);
    assert.equal(new PolicyStore(file).list().length, 1);
  });
});

// Taking over an agent's computer has to mean something, or it is a label
// on a screen.
describe("taking the wheel", () => {
  test("nobody is driving until somebody takes it", () => {
    const wheel = new Wheel();
    assert.equal(wheel.heldBy("bot-1"), null);
    assert.deepEqual(wheel.all(), []);
  });

  test("taking it, and handing it back", () => {
    const wheel = new Wheel();
    const hold = wheel.take("bot-1", "signing in", 1_000);
    assert.equal(hold.why, "signing in");
    assert.equal(wheel.heldBy("bot-1")?.since, 1_000);
    assert.equal(wheel.release("bot-1")?.why, "signing in");
    assert.equal(wheel.heldBy("bot-1"), null);
  });

  test("handing back something nobody held is not an error", () => {
    assert.equal(new Wheel().release("bot-1"), null);
  });

  test("a hold with no reason still has one", () => {
    assert.ok(new Wheel().take("bot-1", "   ", 1).why.length > 0);
  });

  test("one agent at a time, and other agents are untouched", () => {
    const wheel = new Wheel();
    wheel.take("bot-1", "a", 1);
    wheel.take("bot-2", "b", 2);
    assert.equal(wheel.all().length, 2);
    wheel.release("bot-1");
    assert.equal(wheel.heldBy("bot-2")?.why, "b");
  });

  test("taking it twice replaces rather than stacks", () => {
    const wheel = new Wheel();
    wheel.take("bot-1", "first", 1);
    wheel.take("bot-1", "second", 2);
    assert.equal(wheel.all().length, 1);
    assert.equal(wheel.heldBy("bot-1")?.why, "second");
  });

  test("the agent is told to wait, not to find another way", () => {
    // "no" is what an agent works around; "wait" is not
    const message = pausedMessage(new Wheel().take("bot-1", "signing in", 1));
    assert.match(message, /signing in/);
    assert.match(message, /Do not do this another way/);
    assert.match(message, /wait to be asked again/);
  });

  test("the person is told something different, because they can fix it", () => {
    // pausedMessage is aimed at a model and stops it working around the
    // refusal. This one is aimed at whoever just pressed something, and
    // names the fix rather than the rule
    const hold = new Wheel().take("bot-1", "signing in", 1);
    const refusal = heldRefusal(hold, "Kestrel");
    assert.match(refusal, /Kestrel/);
    assert.match(refusal, /signing in/);
    assert.match(refusal, /Hand the wheel back/);
    assert.notEqual(refusal, pausedMessage(hold));
  });

  test("a hold counts what it turned away, so it can say what it cost", () => {
    const wheel = new Wheel();
    wheel.take("bot-1", "driving", 1);
    assert.equal(wheel.heldBy("bot-1")?.turnedAway, 0);
    wheel.noteTurnedAway("bot-1");
    wheel.noteTurnedAway("bot-1");
    assert.equal(wheel.heldBy("bot-1")?.turnedAway, 2);
    // and only the agent named
    wheel.noteTurnedAway("bot-2");
    assert.equal(wheel.heldBy("bot-1")?.turnedAway, 2);
    // the release carries the count with it
    assert.equal(wheel.release("bot-1")?.turnedAway, 2);
  });

  test("taking the wheel again starts the count over", () => {
    // a new hold is a new period, and the count belongs to the period
    const wheel = new Wheel();
    wheel.take("bot-1", "first", 1);
    wheel.noteTurnedAway("bot-1");
    wheel.take("bot-1", "second", 2);
    assert.equal(wheel.heldBy("bot-1")?.turnedAway, 0);
  });

  test("noting a turn away for nobody's hold does nothing", () => {
    const wheel = new Wheel();
    wheel.noteTurnedAway("bot-1");
    assert.equal(wheel.heldBy("bot-1"), null);
  });
});
