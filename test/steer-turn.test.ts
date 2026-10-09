// What the person says to a running turn goes into it (GitHub 213).
//
// Words sent while the agent worked used to wait for the turn to end, so
// the agent finished work the person had already changed their mind
// about and only then read what they wrote. Now Claude Code reads them
// on the stdin it was given the prompt on, and Codex takes them through
// turn/steer. They join the conversation when the turn takes them, and
// when it cannot, they wait for the next turn exactly as before, said
// once either way.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** A stand-in Claude Code that reads stdin a line at a time, as the real
 * one does with --input-format stream-json, and keeps every line it was
 * handed in heard-<n> for the n-th process. `script` is the body of an
 * async function with `next(ms)` (the next user message's words, or null
 * once ms pass), `out(frame)`, `nap(ms)` and `prompt` in scope. */
function workspace(script: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-steer-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
  const cli = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const n = (existsSync(home + "/spawns") ? Number(readFileSync(home + "/spawns", "utf8")) : 0) + 1;
writeFileSync(home + "/spawns", String(n));
const out = (frame) => console.log(JSON.stringify(frame));
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let wake = null;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    const words = String(frame.message?.content ?? "");
    appendFileSync(home + "/heard-" + n, words + "\\n");
    lines.push(words);
  }
  wake?.();
});
const next = async (ms) => {
  const until = Date.now() + ms;
  while (!lines.length && Date.now() < until) {
    await new Promise((r) => { wake = r; setTimeout(r, 50); });
  }
  return lines.shift() ?? null;
};
const prompt = await next(10000);
out({ type: "system", subtype: "init", session_id: "sess-steer", model: "claude-sonnet-5" });
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
const done = (text, turns = 1) => out({ type: "result", subtype: "success", is_error: false, num_turns: turns, duration_api_ms: 400, total_cost_usd: 0, session_id: "sess-steer", result: text });
${script}
`;
  writeFileSync(join(home, "fake-claude.mjs"), cli, { mode: 0o755 });
  return home;
}

async function agent(h: Harness) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Steady" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  return bot as { id: string };
}

const messages = async (h: Harness, bot: { id: string }) => (await h.json(`/api/bots/${bot.id}/messages?limit=100`)).messages as any[];
const busy = async (h: Harness, bot: { id: string }) => Boolean((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy);
const texts = (list: any[]) => list.filter((m) => m.kind === "text" && !m.deleted).map((m) => m.text as string);
const spawns = (home: string) => (existsSync(join(home, "spawns")) ? Number(readFileSync(join(home, "spawns"), "utf8")) : 0);
const heard = (home: string, n: number) => (existsSync(join(home, `heard-${n}`)) ? readFileSync(join(home, `heard-${n}`), "utf8") : "");

async function boot(t: TestContext, script: string) {
  const home = workspace(script);
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, h, bot: await agent(h) };
}

test("the person's message goes into the running turn, after what the agent has said so far", async (t) => {
  const { home, h, bot } = await boot(
    t,
    `say("Working on it");
const more = await next(15000);
if (more) { say("Changed course: " + more); done("Changed course", 2); }
else { say("Nothing else came"); done("Nothing else came"); }`,
  );

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK find a boat tour" }) });
  assert.ok(await waitFor(async () => texts(await messages(h, bot)).includes("Working on it")), "the turn never started");

  const sent = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SECOND only in the morning" }) });
  assert.notEqual(sent.queued, true, "it waited for the next turn instead of going into this one");
  assert.equal(sent.steered, true);
  // in the conversation at once, not waiting above the composer
  const now = await messages(h, bot);
  const second = now.find((m) => m.text === "SECOND only in the morning");
  assert.ok(second, "it is not in the conversation");
  assert.ok(!second.queued, "it is still flagged as waiting");

  assert.ok(await waitFor(async () => !(await busy(h, bot))), "the turn never ended");
  const after = texts(await messages(h, bot));
  assert.deepEqual(after.slice(after.findIndex((x) => x.startsWith("FIRST_ASK"))), [
    "FIRST_ASK find a boat tour",
    "Working on it",
    "SECOND only in the morning",
    "Changed course: SECOND only in the morning",
  ]);
  // one turn took both, so the engine was started once and heard it once
  assert.equal(spawns(home), 1);
  assert.equal(heard(home, 1).split("SECOND only in the morning").length - 1, 1);
});

test("words the engine reads just after it finished are answered in the same turn, not dropped or said twice", async (t) => {
  // The engine had already written its result when the words reached it,
  // so it answers them with a second result in the same process. Ending
  // the turn on the first one showed the agent idle while it was still
  // answering, and nothing would have taken that answer.
  const { home, h, bot } = await boot(
    t,
    `say("Working on it");
const more = await next(15000);
done("Done");
if (more) { await nap(1500); say("Then: " + more); done("Then"); }`,
  );

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK" }) });
  assert.ok(await waitFor(async () => texts(await messages(h, bot)).includes("Working on it")), "the turn never started");
  const sent = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SECOND" }) });
  assert.equal(sent.steered, true);

  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await busy(h, bot), true, "the turn ended on the first result while the engine was still answering");

  assert.ok(await waitFor(async () => !(await busy(h, bot))), "the turn never ended");
  const after = texts(await messages(h, bot));
  assert.deepEqual(after.slice(after.indexOf("FIRST_ASK")), ["FIRST_ASK", "Working on it", "SECOND", "Then: SECOND"]);
  assert.equal(spawns(home), 1, "the words started a turn of their own as well");
});

test("once the engine has stopped taking words, they wait for the next turn and go once", async (t) => {
  // An empty result first (what a resumed session left running, GitHub
  // 134) shuts stdin, so from then on this turn cannot take more.
  const { home, h, bot } = await boot(
    t,
    `out({ type: "result", subtype: "success", is_error: false, num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, session_id: "sess-steer", result: "" });
writeFileSync(home + "/shut-" + n, "1");
await nap(prompt.includes("LATER") ? 0 : 1500);
say("Answer to " + (prompt.includes("LATER") ? "LATER" : "FIRST_ASK"));
done("Answer");`,
  );

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK" }) });
  assert.ok(await waitFor(() => existsSync(join(home, "shut-1"))), "the engine never started");
  const sent = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LATER" }) });
  assert.equal(sent.queued, true, "it should have waited for the next turn");

  const after = await waitFor(async () => {
    const list = texts(await messages(h, bot));
    return list.includes("Answer to LATER") && !(await busy(h, bot)) ? list : null;
  });
  assert.ok(after, "the waiting message never got its turn");
  assert.deepEqual(after.slice(after.indexOf("FIRST_ASK")), ["FIRST_ASK", "Answer to FIRST_ASK", "LATER", "Answer to LATER"]);
  assert.equal(spawns(home), 2);
  assert.ok(!heard(home, 1).includes("LATER"), "the turn that had stopped taking words was handed them anyway");
  assert.ok(heard(home, 2).includes("LATER"));
});

// ── Codex, against an in-memory app-server ──

async function codex(t: TestContext) {
  // the driver's native log is pointed at a throwaway home, and the write
  // itself is caught below, so nothing lands in a real ~/.bloks
  const home = mkdtempSync(join(tmpdir(), "bloks-steer-codex-"));
  const was = process.env.HOME;
  process.env.HOME = home;
  const state = { refuse: false, frames: [] as any[] };
  const stdout = new PassThrough();
  const peer = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    kill() {},
    stdin: new Writable({
      write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk));
        state.frames.push(frame);
        if (frame.method && frame.id !== undefined) {
          const reply =
            frame.method === "turn/steer" && state.refuse
              ? { id: frame.id, error: { code: -32600, message: "expectedTurnId does not match the active turn" } }
              : {
                  id: frame.id,
                  result:
                    frame.method === "thread/start" ? { thread: { id: "codex-thread" } }
                    : frame.method === "turn/start" ? { turn: { id: "codex-turn-1" } }
                    : frame.method === "turn/steer" ? { turnId: "codex-turn-1" }
                    : {},
                };
          queueMicrotask(() => stdout.write(JSON.stringify(reply) + "\n"));
        }
        done();
      },
    }),
  });
  t.mock.method(childProcess, "spawn", () => peer);
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const { CodexDriver } = await import("../server/drivers/codex.ts");
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fake-codex", fullAuto: false },
  });
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.env.HOME = was;
    rmSync(home, { recursive: true, force: true });
  });
  const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
  return { instance, state, send };
}

test("Codex takes the person's words through turn/steer, naming the turn it is running", async (t) => {
  const { instance, state, send } = await codex(t);
  assert.equal(typeof instance.adapter.steerTurn, "function", "the Codex driver cannot take words mid-turn");
  await instance.adapter.sendTurn({ threadId: "task-a", text: "find a boat tour" });
  await waitFor(async () => {
    await setImmediate();
    return state.frames.some((f) => f.method === "turn/start" && f.id !== undefined) ? true : null;
  }, 5_000);
  for (let i = 0; i < 5; i++) await setImmediate();

  assert.equal(await instance.adapter.steerTurn!("task-a", "only in the morning"), true);
  const steer = state.frames.find((f) => f.method === "turn/steer");
  assert.deepEqual(steer.params, {
    threadId: "codex-thread",
    expectedTurnId: "codex-turn-1",
    input: [{ type: "text", text: "only in the morning" }],
  });

  // Codex refuses when the turn it was told is no longer the active one,
  // and then the words were not taken: the harness keeps them instead.
  state.refuse = true;
  assert.equal(await instance.adapter.steerTurn!("task-a", "too late"), false);

  send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  for (let i = 0; i < 5; i++) await setImmediate();
  state.refuse = false;
  assert.equal(await instance.adapter.steerTurn!("task-a", "after the end"), false, "words were taken by a turn that had ended");
  assert.equal(state.frames.filter((f) => f.method === "turn/steer").length, 2, "a finished turn was still asked");
});
