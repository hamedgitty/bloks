// Codex's async questions open a card, and nothing waits on it (GitHub 402).
//
// request_user_input_async tells the agent its question was taken and
// lets it carry on; the question itself arrives as a finished
// agentMessage with `delivery: "async"` and its questions beside the
// text. Bloks read it as a reply, so there was nothing to answer and
// nobody was told. These exercise the real driver and JSON-RPC transport
// against an in-memory app-server, as test/codex-approval.test.ts does,
// and then the harness itself against a stand-in Codex, for where the
// answer goes. No account, network or real data folder is used.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { asyncQuestion, CodexDriver } from "../server/drivers/codex.ts";
import { JoinClient } from "../server/join-client.ts";
import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { waitFor } from "./helpers/turns.ts";

async function setup(t: TestContext, fullAuto = false) {
  const peers: ReturnType<typeof makePeer>[] = [];
  function makePeer() {
    const frames: any[] = [];
    const stdout = new PassThrough();
    const peer = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined) {
            queueMicrotask(() => stdout.write(JSON.stringify({
              id: frame.id,
              result: frame.method === "thread/start" ? { thread: { id: "codex-thread" } } : frame.method === "turn/start" ? { turn: { id: "codex-turn" } } : {},
            }) + "\n"));
          }
          done();
        },
      }),
    });
    return {
      peer, frames,
      send(frame: unknown) { stdout.write(JSON.stringify(frame) + "\n"); },
    };
  }
  t.mock.method(childProcess, "spawn", () => {
    const peer = makePeer();
    peers.push(peer);
    return peer.peer;
  });
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fake-codex", fullAuto },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    for (const peer of peers) peer.send({ method: "turn/completed", params: { turn: { status: "completed" } } });
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function start(threadId = "task-a", extra: Record<string, unknown> = {}) {
    await instance.adapter.sendTurn({ threadId, text: "Look into it", ...extra });
    await setImmediate();
    await setImmediate();
    return peers.at(-1)!;
  }
  const opened = () => events.filter((e): e is Extract<RuntimeEvent, { type: "request.opened" }> => e.type === "request.opened");
  const resolved = () => events.filter((e): e is Extract<RuntimeEvent, { type: "request.resolved" }> => e.type === "request.resolved");
  return { instance, events, start, opened, resolved };
}

/** The frame installed Codex 0.164.0 sends for request_user_input_async. */
function asked(id: string, questions: unknown[], text = "Which environment should I inspect?\n- Local\n- Staging") {
  return {
    method: "item/completed",
    params: {
      threadId: "codex-thread", turnId: "codex-turn",
      item: { type: "agentMessage", id, text, phase: "final_answer", delivery: "async", questions },
    },
  };
}

test("an async question with choices opens a question card, and the turn is not held for it", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  const before = peer.frames.length;
  peer.send(asked("q-env", [{ title: "Which environment should I inspect?", options: ["Local", "Staging"] }]));
  await setImmediate();
  const [ask] = h.opened();
  assert.ok(ask, "no card opened for the question");
  assert.equal(ask.requestType, "question");
  assert.equal(ask.tool, "ask_user");
  assert.equal(ask.async, true);
  assert.equal(ask.summary, "Which environment should I inspect?");
  assert.deepEqual(ask.choices, ["Local", "Staging"]);
  // the card is the question, as a blocking one is: not a reply as well
  assert.ok(!h.events.some((e) => (e.type === "item.completed" && e.itemType === "assistant_text") || e.type === "content.delta"), "the question was also said as a reply");
  // nothing went back to Codex, and nothing was ended or answered for it
  assert.equal(peer.frames.length, before);
  assert.equal(h.resolved().length, 0);
  assert.ok(!h.events.some((e) => e.type === "turn.completed"));

  // ordinary words after it are still a reply
  peer.send({ method: "item/completed", params: { threadId: "codex-thread", turnId: "codex-turn", item: { type: "agentMessage", id: "m2", text: "Checking local first.", phase: "commentary" } } });
  await setImmediate();
  assert.ok(h.events.some((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "Checking local first."));
});

test("a free-text async question opens a card with no choices, and its answer comes back to be said", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(asked("q-free", [{ title: "What should the release be called?" }], "What should the release be called?"));
  await setImmediate();
  const [ask] = h.opened();
  assert.equal(ask.summary, "What should the release be called?");
  assert.deepEqual(ask.choices, []);

  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Lighthouse" });
  const [done] = h.resolved();
  assert.equal(done.requestId, ask.requestId);
  assert.equal(done.behavior, "answer");
  assert.equal(done.source, "user");
  assert.equal(done.answer, "Lighthouse");
  // answered once: a second press finds nothing waiting
  await assert.rejects(h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Again" }), /no such pending request/);
  assert.equal(h.resolved().length, 1);
});

test("a question put aside is only settled, with nothing to say to the agent", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(asked("q-env", [{ title: "Which environment?", options: ["Local"] }]));
  await setImmediate();
  const [ask] = h.opened();
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "deny", message: "Dismissed by user." });
  const [done] = h.resolved();
  assert.equal(done.behavior, "deny");
  assert.equal(done.answer, undefined);
});

test("the same item said again is one card, and separate questions stay separate", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  const first = asked("q-1", [{ title: "Which environment?", options: ["Local", "Staging"] }]);
  peer.send(first);
  peer.send(first);
  peer.send(asked("q-2", [{ title: "Which region?", options: ["eu", "us"] }]));
  await setImmediate();
  peer.send(first);
  await setImmediate();
  const asks = h.opened();
  assert.deepEqual(asks.map((a) => a.summary), ["Which environment?", "Which region?"]);
  assert.notEqual(asks[0].requestId, asks[1].requestId);

  // each answer goes to its own question, in any order
  await h.instance.adapter.respondToRequest("task-a", asks[1].requestId!, { behavior: "answer", message: "eu" });
  await h.instance.adapter.respondToRequest("task-a", asks[0].requestId!, { behavior: "answer", message: "Staging" });
  assert.deepEqual(h.resolved().map((e) => [e.requestId, e.answer]), [[asks[1].requestId, "eu"], [asks[0].requestId, "Staging"]]);
  // and another conversation cannot answer either
  peer.send(asked("q-3", [{ title: "Which branch?" }]));
  await setImmediate();
  await assert.rejects(h.instance.adapter.respondToRequest("task-b", h.opened()[2].requestId!, { behavior: "answer", message: "main" }), /no such pending request/);
});

test("an async question outlives the turn that asked it, and is still answerable", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(asked("q-env", [{ title: "Which environment?", options: ["Local", "Staging"] }]));
  peer.send({ method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "codex-turn", status: "completed" } } });
  await setImmediate();
  assert.ok(h.events.some((e) => e.type === "turn.completed"));
  // a blocking question would be closed as "turn-ended" here; this one is not
  assert.equal(h.resolved().length, 0);
  const [ask] = h.opened();
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Local" });
  assert.equal(h.resolved()[0].answer, "Local");
  assert.equal(h.resolved()[0].turnId, ask.turnId);
});

test("full auto never answers an async question for the person", async (t) => {
  const h = await setup(t, true);
  const peer = await h.start("task-full", { fullAccess: true });
  peer.send(asked("q-env", [{ title: "Which environment?", options: ["Local", "Staging"] }]));
  await setImmediate();
  assert.equal(h.opened().length, 1);
  assert.equal(h.resolved().length, 0);
});

test("the blocking question keeps its own card and reply", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send({ id: "question", method: "item/tool/requestUserInput", params: {
    threadId: "codex-thread", turnId: "codex-turn",
    questions: [{ id: "date", question: "When?", options: [{ label: "Friday" }] }],
  } });
  await setImmediate();
  const [ask] = h.opened();
  assert.equal(ask.async, undefined);
  assert.deepEqual(ask.choices, ["Friday"]);
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Friday" });
  await setImmediate();
  assert.equal(h.resolved()[0].answer, undefined);
});

test("the agent withdraws a question it asked without waiting: settled once, with no answer", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  const item = asked("q-env", [{ title: "Which environment?", options: ["Local", "Staging"] }]);
  peer.send(item);
  await setImmediate();
  const before = peer.frames.length;
  const [ask] = h.opened();
  assert.equal(h.instance.adapter.withdrawAsk!("task-a", ask.requestId!), true);
  assert.deepEqual(
    h.resolved().map((e) => ({ requestId: e.requestId, behavior: e.behavior, source: e.source, answer: e.answer })),
    [{ requestId: ask.requestId, behavior: "withdrawn", source: "agent", answer: undefined }],
  );
  // nothing went to Codex, and nothing is left to answer or withdraw
  assert.equal(peer.frames.length, before);
  assert.equal(h.instance.adapter.withdrawAsk!("task-a", ask.requestId!), false);
  await assert.rejects(h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Local" }), /no such pending request/);
  // the same item said again does not open it again
  peer.send(item);
  await setImmediate();
  assert.equal(h.opened().length, 1);
  assert.equal(h.resolved().length, 1);
});

test("only a question asked without waiting, in its own conversation, can be withdrawn", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send({ id: "question", method: "item/tool/requestUserInput", params: {
    threadId: "codex-thread", turnId: "codex-turn",
    questions: [{ id: "date", question: "When?", options: [{ label: "Friday" }] }],
  } });
  peer.send({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread", turnId: "codex-turn", itemId: "c1", command: "ls" } });
  peer.send(asked("q-env", [{ title: "Which environment?" }]));
  await setImmediate();
  const [blocking, approval, later] = h.opened();
  assert.equal(later.async, true);
  for (const ask of [blocking, approval]) assert.equal(h.instance.adapter.withdrawAsk!("task-a", ask.requestId!), false);
  assert.equal(h.instance.adapter.withdrawAsk!("task-a", "no-such-request"), false);
  // another conversation's agent cannot withdraw it either
  assert.equal(h.instance.adapter.withdrawAsk!("task-b", later.requestId!), false);
  assert.equal(h.resolved().length, 0);
  // and each is still the person's to answer
  await h.instance.adapter.respondToRequest("task-a", blocking.requestId!, { behavior: "answer", message: "Friday" });
  await h.instance.adapter.respondToRequest("task-a", approval.requestId!, { behavior: "allow" });
  await h.instance.adapter.respondToRequest("task-a", later.requestId!, { behavior: "answer", message: "Local" });
  assert.ok(peer.frames.some((f) => f.id === "question" && f.result), "the blocking question was not answered");
  assert.ok(peer.frames.some((f) => f.id === "approval" && f.result), "the approval was not answered");
  assert.equal(h.resolved().find((e) => e.requestId === later.requestId)?.answer, "Local");
});

test("an answer given first stands: the question is no longer there to withdraw", async (t) => {
  const h = await setup(t);
  const peer = await h.start();
  peer.send(asked("q-env", [{ title: "Which environment?", options: ["Local", "Staging"] }]));
  await setImmediate();
  const [ask] = h.opened();
  await h.instance.adapter.respondToRequest("task-a", ask.requestId!, { behavior: "answer", message: "Staging" });
  assert.equal(h.instance.adapter.withdrawAsk!("task-a", ask.requestId!), false);
  assert.deepEqual(h.resolved().map((e) => [e.source, e.answer]), [["user", "Staging"]]);
});

test("only an async item with something to ask is read as a question", () => {
  assert.equal(asyncQuestion({ type: "agentMessage", text: "Done." }), null);
  assert.equal(asyncQuestion({ delivery: "async", questions: [] }), null);
  assert.equal(asyncQuestion({ delivery: "async", questions: [{ title: "  " }, { options: ["a"] }] }), null);
  // questions without the async marker are a reply that names its questions (server/codex-text.ts)
  assert.equal(asyncQuestion({ questions: [{ title: "Which?" }] }), null);
  assert.deepEqual(asyncQuestion({ delivery: "async", questions: [{ title: " Which? ", options: ["A", { label: "B" }, "A", "", 7] }, { title: "And?" }] }), {
    summary: "Which? · And?",
    choices: ["A", "B"],
  });
});

// ── where the answer goes, in the real harness ──

/** A Codex that asks without waiting. ASYNC-WORKING asks and keeps its
 * turn open until it is told more, saying what it was told; ASYNC-TWO
 * does the same with two questions; ASYNC-ENDS and ASYNC-LATER ask and
 * end their turn. Each says its question twice, as a replay. A turn that
 * quotes a question says what it was answered with, and in which sandbox
 * it ran, which is whose authority it had; WHICH-SANDBOX says only that.
 * BLOCKED asks a question its turn waits on and an approval, and waits.
 * CLI[tag|args] runs the agent's command line and says what it answered,
 * as CLI-tag. Each turn notes its words and credential in turns.jsonl. */
function codexHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-async-questions-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ ...extra, instances: { codex: { driver: "codex", config: { cli: join(home, "fake-codex.mjs") } } } }));
  writeFileSync(
    join(home, "fake-codex.mjs"),
    `#!${process.execPath}
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("codex-cli 0.164.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let thread, turn, sandbox;
const say = (id, item) => out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id, phase: "final_answer", ...item } } });
const finish = (text) => {
  say("answer-" + Date.now(), { text });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
};
const ask = (id, questions) => {
  const item = { text: questions.map((q) => [q.title, ...(q.options ?? []).map((o) => "- " + o)].join("\\n")).join("\\n"), delivery: "async", questions };
  say(id, item);
  say(id, item);
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "initialize") return reply();
  if (m.method === "initialized") return;
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, hidden: false }] });
  if (m.method === "skills/list") return reply({ data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] });
  if (m.method === "thread/start" || m.method === "thread/resume") { thread = m.params.threadId ?? "native-" + process.pid; sandbox = m.params.sandbox; return reply({ thread: { id: thread }, model: "gpt-6.1-sol" }); }
  if (m.method === "turn/steer") { reply({ turnId: turn }); return finish("TOLD " + JSON.stringify(m.params.input[0].text)); }
  if (m.method !== "turn/start") return reply();
  turn = "work-" + Date.now(); reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  const text = m.params.input.filter((i) => i.type === "text").map((i) => i.text).join("");
  appendFileSync(${JSON.stringify(join(home, "turns.jsonl"))}, JSON.stringify({ text, token: process.env.BLOKS_TOKEN }) + "\\n");
  if (text.includes("ASYNC-WORKING")) return ask("q-env", [{ title: "Which environment should I inspect?", options: ["Local", "Staging"] }]);
  if (text.includes("ASYNC-TWO")) {
    ask("q-env", [{ title: "Which environment should I inspect?", options: ["Local", "Staging"] }]);
    return ask("q-region", [{ title: "Which region?", options: ["eu", "us"] }]);
  }
  if (text.includes("ASYNC-LATER")) { ask("q-day", [{ title: "Which day works?", options: ["Monday", "Tuesday"] }]); return finish("Carried on without it."); }
  if (text.includes("BLOCKED")) {
    out({ id: "blocking", method: "item/tool/requestUserInput", params: { threadId: thread, turnId: turn, questions: [{ id: "date", question: "When should it ship?", options: [{ label: "Friday" }] }] } });
    return out({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: turn, itemId: "c1", command: "rm -rf build" } });
  }
  const cli = text.match(/CLI\\[(\\w+)\\|([^\\]]+)\\]/);
  if (cli) return execFile(process.execPath, [process.env.BLOKS_CLI, ...cli[2].trim().split(/\\s+/)], (_error, stdout) => finish("CLI-" + cli[1] + " " + stdout.trim()));
  if (text.includes("ASYNC-ENDS")) { ask("q-name", [{ title: "What should the release be called?" }]); return finish("Carried on without it."); }
  if (text.includes("Replying to")) return finish("GOT " + JSON.stringify({ text, sandbox }));
  if (text.includes("WHICH-SANDBOX")) return finish("SANDBOX " + JSON.stringify(sandbox));
  finish("Done.");
});
`,
    { mode: 0o755 },
  );
  return home;
}

async function fixture(t: TestContext) {
  const home = codexHome();
  let h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kat" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const messages = async () => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=100`)).messages as any[];
  const say = (text: string) => h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: bot.threadId }) });
  const card = async () => {
    const found = await waitFor(async () => (await messages()).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered));
    assert.ok(found, "no card appeared");
    return found;
  };
  const respond = (requestId: string, body: Record<string, unknown>) =>
    h.json(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId, ...body }) });
  const lane = async () => {
    const { bots } = await h.json("/api/bots?messages=0");
    return bots.find((b: any) => b.id === bot.id)?.tasks.find((task: any) => task.id === bot.threadId);
  };
  const heard = async (word: string) => {
    const said = await waitFor(async () => (await messages()).find((m) => m.kind === "text" && m.role === "bot" && (m.text ?? "").startsWith(`${word} `)));
    assert.ok(said, `the agent never said ${word}`);
    return JSON.parse(String(said.text).slice(word.length + 1));
  };
  /** The cards still asking, once there are `count` of them. */
  const asking = async (count: number) => {
    const open = await waitFor(async () => {
      const found = (await messages()).filter((m) => m.kind === "options" && m.card?.requestId && !m.card.answered);
      return found.length === count ? found : null;
    });
    assert.ok(open, `${count} open cards never appeared`);
    return open;
  };
  /** The credential of the latest turn whose words include `marker`, to
   * act as its agent with while that turn runs. */
  const token = async (marker: string) => {
    const turns = join(home, "turns.jsonl");
    const found = await waitFor(() =>
      existsSync(turns)
        ? readFileSync(turns, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { text: string; token?: string }).filter((turn) => turn.text.includes(marker)).at(-1)?.token
        : undefined,
    );
    assert.ok(found, `no turn said ${marker}`);
    return found;
  };
  const as = (token: string, method: string, path: string) => h.fetch(path, { method, headers: { authorization: `Bearer ${token}` } });
  return {
    get h() {
      return h;
    },
    home, bot, messages, say, card, respond, lane, heard, asking, token, as,
    /** Gone with no chance to tidy up, then started again on the same data. */
    async reboot() {
      await h.crash();
      h = await startHarness({ HOME: home });
    },
  };
}

test("an answer to a question asked mid-turn goes into that turn, quoting the question", async (t) => {
  const f = await fixture(t);
  await f.say("ASYNC-WORKING on the outage");
  const asked = await f.card();
  assert.equal(asked.card.title, "Your agent has a question");
  assert.equal(asked.card.subtitle, "Which environment should I inspect?");
  assert.deepEqual(asked.card.options, ["Local", "Staging"]);
  // the turn is still running while the card waits, and the lane says it needs the person
  assert.equal((await f.lane()).state, "needs-you");
  const all = await f.messages();
  assert.equal(all.filter((m) => m.kind === "options").length, 1, "a replayed question opened a second card");
  assert.ok(!all.some((m) => m.role === "bot" && m.kind === "text" && /Which environment/.test(m.text ?? "")), "the question was said as a reply as well as a card");

  assert.equal((await f.respond(asked.card.requestId, { behavior: "answer", message: "Staging" })).outcome, "delivered");
  const told = await f.heard("TOLD");
  assert.match(told, /Which environment should I inspect\?/);
  assert.match(told, /Staging$/);
  const after = await f.messages();
  assert.equal(after.find((m) => m.id === asked.id).card.answered, "answer");
  const answer = after.find((m) => m.role === "user" && m.text === "Staging");
  assert.ok(answer, "the answer is not in the conversation");
  assert.equal(answer.midTurn, true);
  assert.equal(answer.replyTo?.id, asked.id);
});

test("an answer given after the turn ended starts the next turn, and is said once", async (t) => {
  const f = await fixture(t);
  await f.say("ASYNC-ENDS the release notes");
  const asked = await f.card();
  assert.deepEqual(asked.card.options, []);
  assert.ok(await waitFor(async () => (await f.messages()).find((m) => m.kind === "text" && m.text === "Carried on without it.")));
  // the turn is over and the question is still open, and still waiting on the person
  const settled = await waitFor(async () => {
    const now = await f.lane();
    return now && !now.busy && !now.settling ? now : null;
  });
  assert.ok(settled, "the turn never ended");
  assert.equal(settled.state, "needs-you");
  assert.ok(!(await f.messages()).find((m) => m.id === asked.id).card.answered, "the question closed with its turn");

  assert.equal((await f.respond(asked.card.requestId, { behavior: "answer", message: "Lighthouse" })).outcome, "delivered");
  const got = (await f.heard("GOT")).text;
  assert.match(got, /What should the release be called\?/);
  assert.match(got, /Lighthouse$/);
  // pressed again, nothing more is said
  assert.equal((await f.respond(asked.card.requestId, { behavior: "answer", message: "Lighthouse" })).outcome, "unavailable");
  const after = await f.messages();
  assert.equal(after.filter((m) => m.role === "user" && m.text === "Lighthouse").length, 1);
  assert.equal(after.filter((m) => m.kind === "text" && (m.text ?? "").startsWith("GOT ")).length, 1);
});

test("a collaborator's answer arrives as their own words, with their authority and never the owner's", async (t) => {
  // An answer said as the owner's would carry the owner's authority into
  // the turn it starts: on an agent in full access, Codex unsandboxed.
  const licence = await teamPlan();
  t.after(() => licence.close());
  const home = codexHome({ remote: { enabled: true }, profile: { name: "Hamed" }, ...licence.config });
  const h = await startHarness({ HOME: home, ...licence.env });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const lan = new URL(h.url).host;
  const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Sam" }) });
  const client = new JoinClient(() => "http://127.0.0.1:9");
  const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
  await client.claim(found.session, { name: "Sam" });
  assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
  const sam = ((await client.status(found.session)) as any).credentials as { deviceToken: string; personId: string };
  const as = (path: string, body?: unknown) =>
    h.fetchRemote(path, { method: body === undefined ? "GET" : "POST", token: sam.deviceToken, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kat" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, approvals: "full" }) });
  // the owner's own turn here runs with nothing between it and the machine
  await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WHICH-SANDBOX", taskId: bot.threadId }) });
  const owners = await waitFor(async () => (await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=100`)).messages.find((m: any) => (m.text ?? "").startsWith("SANDBOX ")));
  assert.equal(owners && JSON.parse(owners.text.slice(8)), "danger-full-access");

  const lane = async () => (await as(`/api/member/agents/${bot.id}/private/messages`)).body;
  const said = await as(`/api/member/agents/${bot.id}/private/messages`, { text: "ASYNC-ENDS the notes" });
  assert.equal(said.status, 202, JSON.stringify(said.body));
  const asked = await waitFor(async () => (await lane()).messages.find((m: any) => m.kind === "options" && !m.card?.answered));
  assert.ok(asked, "no card appeared in the collaborator's conversation");
  assert.ok(await waitFor(async () => ((await lane()).busy ? null : true)), "the collaborator's turn never ended");

  const answered = await as(`/api/member/agents/${bot.id}/private/cards/${asked.id}`, { answer: "Lighthouse" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const got = await waitFor(async () => (await lane()).messages.find((m: any) => m.role === "bot" && (m.text ?? "").startsWith("GOT ")));
  assert.ok(got, "the collaborator's answer never reached the agent");
  const heard = JSON.parse(got.text.slice(4));
  assert.match(heard.text, /What should the release be called\?/);
  assert.match(heard.text, /Lighthouse$/);
  assert.equal(heard.sandbox, "workspace-write", "the collaborator's answer ran with the owner's authority");
  // written down as theirs, quoting the question, and said once
  const after = (await lane()).messages.filter((m: any) => m.role === "user" && m.text === "Lighthouse");
  assert.equal(after.length, 1);
  assert.equal(after[0].author, sam.personId);
  assert.equal(after[0].replyTo?.id, asked.id);
});

// ── the agent withdrawing a question of its own ──

test("an agent withdraws a question it asked without waiting: it closes saying so, and nothing is answered", async (t) => {
  const f = await fixture(t);
  await f.say("ASYNC-TWO on the outage");
  const [env, region] = await f.asking(2);
  assert.equal(env.card.subtitle, "Which environment should I inspect?");
  assert.equal(region.card.subtitle, "Which region?");
  const token = await f.token("ASYNC-TWO");
  const questions = `/api/bots/${f.bot.id}/questions`;

  // its own, by the id it withdraws them with, oldest first
  const listed = await f.as(token, "GET", questions);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).questions.map((q: any) => [q.id, q.question, q.choices, q.conversation?.taskId]), [
    [env.id, "Which environment should I inspect?", ["Local", "Staging"], f.bot.threadId],
    [region.id, "Which region?", ["eu", "us"], f.bot.threadId],
  ]);
  // the agent's, from its own turn: not the person's window
  assert.equal((await f.h.fetch(questions)).status, 403);
  assert.equal((await f.h.fetch(`${questions}/${env.id}`, { method: "DELETE" })).status, 403);

  const withdrawn = await f.as(token, "DELETE", `${questions}/${env.id}`);
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
  assert.deepEqual(await withdrawn.json(), { ok: true, withdrawn: env.id });
  const closed = (await f.messages()).find((m) => m.id === env.id).card;
  assert.equal(closed.withdrawn, true);
  assert.equal(closed.closed, "Kat withdrew this question. No answer is needed.");
  assert.equal(closed.answered, "Closed without an answer");
  // the other question still waits on the person
  assert.ok(!(await f.messages()).find((m) => m.id === region.id).card.answered, "the other question closed with it");
  assert.equal((await f.lane()).state, "needs-you");

  // with both withdrawn the turn is still at work, and nothing waits on the person
  assert.equal((await f.as(token, "DELETE", `${questions}/${region.id}`)).status, 200);
  assert.equal((await f.lane()).state, "working");
  assert.deepEqual((await f.h.json("/api/trace/live")).agents.filter((a: any) => a.taskId === f.bot.threadId).map((a: any) => a.state), ["working"]);
  const activity = await f.h.json("/api/activity");
  assert.ok(!activity.waiting.some((w: any) => w.threadId === f.bot.threadId), "Activity still has it waiting on the person");
  assert.ok(activity.running.some((r: any) => r.threadId === f.bot.threadId), "Activity lost the work going on");
  assert.deepEqual((await (await f.as(token, "GET", questions)).json()).questions, []);

  // again changes nothing, and an answer now is not taken
  assert.equal((await f.as(token, "DELETE", `${questions}/${env.id}`)).status, 404);
  assert.equal((await f.respond(env.card.requestId, { behavior: "answer", message: "Staging" })).outcome, "unavailable");
  const after = await f.messages();
  assert.deepEqual(after.find((m) => m.id === env.id).card, closed);
  // nothing was answered for the person or said to the agent, and no turn started
  assert.deepEqual(after.filter((m) => m.role === "user").map((m) => m.text), ["ASYNC-TWO on the outage"]);
  assert.ok(!after.some((m) => (m.text ?? "").startsWith("TOLD ")), "the agent was told something");
  // the record says the agent withdrew each, once
  const records = await waitFor(async () => {
    const found = (await f.h.json("/api/ledger")).entries.filter((e: any) => e.kind === "approval");
    return found.length >= 2 ? found : null;
  });
  assert.deepEqual(records?.map((e: any) => [e.summary, e.detail.answer, e.detail.decidedBy]).sort(), [
    ["Which environment should I inspect?", "withdrawn", "agent"],
    ["Which region?", "withdrawn", "agent"],
  ]);
});

test("an agent withdraws only its own questions asked without waiting, in a room as in its conversation", async (t) => {
  const f = await fixture(t);
  const { bot: lee } = await f.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Lee" }) });
  await f.h.fetch(`/api/bots/${lee.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  const { blok: room } = await f.h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ship", memberIds: [f.bot.id, lee.id] }) });
  const inRoom = async () => (await f.h.json(`/api/bloks/${room.id}/messages?limit=50`)).messages as any[];

  // Lee asks in the room without waiting
  await f.h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Lee ASYNC-WORKING on the release" }) });
  const lees = await waitFor(async () => (await inRoom()).find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered));
  assert.ok(lees, "Lee's question never reached the room");
  const leeToken = await f.token("ASYNC-WORKING");
  // Kat's turn waits on a question and an approval
  await f.say("BLOCKED until it is decided");
  const kats = await f.asking(2);
  const blocking = kats.find((m) => m.card.title === "Your agent has a question");
  const approval = kats.find((m) => m.card.title === "Approval needed");
  assert.ok(blocking && approval, "Kat's question or approval is missing");
  const katToken = await f.token("BLOCKED");
  const kat = `/api/bots/${f.bot.id}/questions`;

  // what Kat's turn waits on stays the person's, and Lee's is not Kat's to touch
  assert.deepEqual((await (await f.as(katToken, "GET", kat)).json()).questions, []);
  for (const id of [blocking.id, approval.id]) {
    const refused = await f.as(katToken, "DELETE", `${kat}/${id}`);
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /^Only a question you asked without waiting can be withdrawn\./);
  }
  for (const id of [lees.id, "no-such-question"]) assert.equal((await f.as(katToken, "DELETE", `${kat}/${id}`)).status, 404);
  assert.equal((await f.as(katToken, "GET", `/api/bots/${lee.id}/questions`)).status, 403);
  assert.equal((await f.as(katToken, "DELETE", `/api/bots/${lee.id}/questions/${lees.id}`)).status, 403);
  assert.ok(!(await inRoom()).find((m) => m.id === lees.id).card.answered, "Lee's question closed");

  // Lee finds it in the room, and withdraws it there
  const listed = (await (await f.as(leeToken, "GET", `/api/bots/${lee.id}/questions`)).json()).questions;
  assert.deepEqual(listed.map((q: any) => [q.id, q.room?.id, q.room?.name]), [[lees.id, room.id, "Ship"]]);
  assert.equal((await f.as(leeToken, "DELETE", `/api/bots/${lee.id}/questions/${lees.id}`)).status, 200);
  const closed = (await inRoom()).find((m) => m.id === lees.id).card;
  assert.equal(closed.withdrawn, true);
  assert.equal(closed.closed, "Lee withdrew this question. No answer is needed.");

  // and Kat's are answered as ever
  assert.equal((await f.respond(blocking.card.requestId, { behavior: "answer", message: "Friday" })).outcome, "delivered");
  assert.equal((await f.respond(approval.card.requestId, { behavior: "allow" })).outcome, "delivered");
});

test("a question whose engine was rebuilt since is withdrawn without asking another engine, and stays so after a restart", async (t) => {
  const f = await fixture(t);
  // the agent's own flag says a turn is running; a lane's summary does not
  const idle = () =>
    waitFor(async () => {
      const kat = (await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.bot.id);
      const now = kat?.tasks.find((task: any) => task.id === f.bot.threadId);
      return kat && !kat.busy && now && !now.settling ? now : null;
    });
  await f.say("ASYNC-ENDS the release notes");
  const old = await f.card();
  assert.ok(await idle(), "the turn never ended");
  // switched off and on again, so the engine now is not the one that asked
  for (const enabled of [false, true]) {
    const switched = await f.h.fetch("/api/instances/codex/enabled", { method: "PUT", body: JSON.stringify({ enabled }) });
    assert.equal(switched.status, 200, await switched.text());
  }
  await f.say("ASYNC-LATER the launch");
  const [, later] = await f.asking(2);
  assert.equal(later.card.subtitle, "Which day works?");
  assert.ok(await idle(), "the second turn never ended");

  // from a turn of its own, with its command line
  await f.say("CLI[list|questions]");
  assert.deepEqual((await f.heard("CLI-list")).map((q: any) => q.id), [old.id, later.id]);
  assert.ok(await idle(), "the listing turn never ended");
  await f.say(`CLI[unask|unask ${old.id}]`);
  assert.deepEqual(await f.heard("CLI-unask"), { ok: true, withdrawn: old.id });
  assert.ok(await idle(), "the withdrawing turn never ended");
  const withdrawn = (await f.messages()).find((m) => m.id === old.id).card;
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.closed, "Kat withdrew this question. No answer is needed.");

  // the new engine's question is still the person's, and answered as ever
  assert.equal((await f.lane()).state, "needs-you");
  assert.equal((await f.respond(old.card.requestId, { behavior: "answer", message: "Lighthouse" })).outcome, "unavailable");
  assert.equal((await f.respond(later.card.requestId, { behavior: "answer", message: "Tuesday" })).outcome, "delivered");
  const got = (await f.heard("GOT")).text;
  assert.match(got, /Which day works\?/);
  assert.match(got, /Tuesday$/);
  assert.ok(await idle(), "the answer's turn never ended");
  // answered first, the answer stands: there is nothing left to withdraw
  await f.say(`CLI[again|unask ${later.id}]`);
  assert.deepEqual(await f.heard("CLI-again"), { error: "No open question of yours has that id, so nothing changed. `bloks questions` lists them." });
  assert.ok(await idle(), "the second withdrawing turn never ended");
  const answered = (await f.messages()).find((m) => m.id === later.id).card;
  assert.equal(answered.answered, "answer");
  assert.equal(answered.withdrawn, undefined);

  // after a restart it is as it was, and nothing asks again
  const cards = (await f.messages()).filter((m) => m.kind === "options");
  await f.reboot();
  assert.deepEqual((await f.messages()).filter((m) => m.kind === "options"), cards);
  assert.equal((await f.lane()).state, "idle");
});

test("a withdrawal whose card could not be saved says so, and trying again finishes it", async (t) => {
  const f = await fixture(t);
  await f.say("ASYNC-TWO on the outage");
  const [env, region] = await f.asking(2);
  const token = await f.token("ASYNC-TWO");
  const questions = `/api/bots/${f.bot.id}/questions`;
  // the conversation cannot be written for now: something else is where its file goes
  const file = join(f.home, ".bloks", `messages-${f.bot.threadId}.json`);
  renameSync(file, `${file}.aside`);
  mkdirSync(file);
  const failed = await f.as(token, "DELETE", `${questions}/${env.id}`);
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).error, "The question was withdrawn, but its card could not be closed. Nothing was answered; run unask again to finish it.");
  rmSync(file, { recursive: true });
  renameSync(`${file}.aside`, file);

  const again = await f.as(token, "DELETE", `${questions}/${env.id}`);
  assert.equal(again.status, 200, await again.clone().text());
  // written down this time, and the other question as it was
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.find((m: any) => m.id === env.id).card.withdrawn, true);
  assert.ok(!saved.find((m: any) => m.id === region.id).card.answered, "the other question closed with it");
  // nothing left behind: the other still asks, and only it
  assert.equal((await f.lane()).state, "needs-you");
  assert.deepEqual((await (await f.as(token, "GET", questions)).json()).questions.map((q: any) => q.id), [region.id]);
  assert.equal((await f.as(token, "DELETE", `${questions}/${env.id}`)).status, 404);
  // and recorded once
  const records = (await f.h.json("/api/ledger")).entries.filter((e: any) => e.kind === "approval");
  assert.deepEqual(records.map((e: any) => [e.summary, e.detail.answer]), [["Which environment should I inspect?", "withdrawn"]]);
});
