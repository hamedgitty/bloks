// A resumed Claude Code session keeps its system prompt byte for byte
// (GitHub 193). The system prompt sits in front of the whole conversation
// in the prompt cache, so an agent editing its MEMORY.md, or a note being
// kept about the person, used to make the next turn write the entire
// session to the cache again. What moved is told in the turn's message
// instead, and a fresh session still gets it all in the system prompt.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";

interface Call {
  argv: string[];
  persona: string;
  message: string;
}

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-stable-prompt-"));
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stop?.();
    rmSync(home, { recursive: true, force: true });
  });
  const cli = join(home, "fake-claude.mjs");
  const callsFile = join(home, "calls.json");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const sessionId = value(args.includes("--resume") ? "--resume" : "--session-id");
  const persona = readFileSync(value("--append-system-prompt-file"), "utf8");
  const content = JSON.parse(input.trim()).message.content;
  const message = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
  const file = ${JSON.stringify(callsFile)};
  const calls = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  calls.push({ argv: args, persona, message });
  writeFileSync(file + ".tmp", JSON.stringify(calls)); renameSync(file + ".tmp", file);
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Answered " + calls.length }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1,
    duration_api_ms: 1, session_id: sessionId, result: "Answered " + calls.length });
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  const h = await startHarness({ HOME: home });
  stop = () => h.stop();
  const post = (path: string, body: unknown) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  const { bot } = await post("/api/bots", { name: "Keeper" });
  const patched = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  assert.equal(patched.status, 200);
  const memoryFile = join(home, ".bloks", "workspaces", bot.id, "MEMORY.md");
  const remember = (text: string) => {
    mkdirSync(join(home, ".bloks", "workspaces", bot.id), { recursive: true });
    writeFileSync(memoryFile, text);
  };
  const calls = (): Call[] => (existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : []);
  const settle = async (n: number) => {
    for (let i = 0; i < 200; i++) {
      const seen = calls();
      const { bots } = await h.json("/api/bots?messages=0");
      if (seen.length >= n && !bots.find((b: any) => b.id === bot.id)?.busy) {
        assert.equal(seen.length, n, "a turn was run more than once");
        return seen[n - 1];
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`the fake CLI did not finish turn ${n}: ${h.logs().slice(-800)}`);
  };
  const turn = async (text: string) => {
    const n = calls().length + 1;
    const accepted = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.equal(accepted.status, 202);
    return settle(n);
  };
  return { h, bot, post, remember, calls, settle, turn };
}

test("a memory change between resumed turns leaves the system prompt alone and is told in the message", async (t) => {
  const s = await setup(t);
  s.remember("- OLD_MEMORY_LINE\n");
  const first = await s.turn("Hello.");
  assert.ok(first.argv.includes("--session-id"));
  assert.match(first.persona, /OLD_MEMORY_LINE/, "a fresh session reads its memory in the system prompt");
  assert.doesNotMatch(first.message, /your memory changed/);

  s.remember("- NEW_MEMORY_LINE\n");
  const second = await s.turn("Again.");
  assert.ok(second.argv.includes("--resume"));
  assert.equal(second.persona, first.persona, "the system prompt is byte for byte what the session started with");
  assert.match(second.message, /your memory changed/);
  assert.match(second.message, /NEW_MEMORY_LINE/);
  assert.ok(second.message.endsWith("Again."), "the person's words come last");

  // told once: the next turn has nothing new to say about it
  const third = await s.turn("Once more.");
  assert.equal(third.persona, first.persona);
  assert.equal(third.message, "Once more.");
});

test("a kept note about the person is told in the message, not the system prompt", async (t) => {
  const s = await setup(t);
  const first = await s.turn("Hello.");
  await s.post("/api/profile/notes", { text: "Prefers NOTE_TIMEZONE answers" });
  const second = await s.turn("Again.");
  assert.equal(second.persona, first.persona);
  assert.doesNotMatch(second.persona, /NOTE_TIMEZONE/);
  assert.match(second.message, /notes about the person you work for changed/);
  assert.match(second.message, /NOTE_TIMEZONE/);
});

test("nothing is added to the message when memory and notes have not moved", async (t) => {
  const s = await setup(t);
  s.remember("- STEADY_MEMORY\n");
  const first = await s.turn("Hello.");
  const second = await s.turn("Just this.");
  assert.equal(second.persona, first.persona);
  assert.equal(second.message, "Just this.");
});

test("a fresh session gets the current memory and notes in its system prompt", async (t) => {
  const s = await setup(t);
  s.remember("- BEFORE\n");
  await s.turn("Hello.");
  s.remember("- AFTER_FRESH\n");
  await s.post("/api/profile/notes", { text: "Goes by FRESH_NOTE" });
  // a new lane is a new session: no cursor, nothing cached to keep
  const made = await s.post(`/api/bots/${s.bot.id}/tasks`, {});
  const task = made.bot.tasks.at(-1);
  assert.notEqual(task.id, s.bot.threadId);
  const n = s.calls().length + 1;
  const accepted = await s.h.fetch(`/api/bots/${s.bot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "Fresh start.", taskId: task.id }),
  });
  assert.equal(accepted.status, 202);
  const fresh = await s.settle(n);
  assert.ok(fresh.argv.includes("--session-id"));
  assert.match(fresh.persona, /AFTER_FRESH/);
  assert.match(fresh.persona, /FRESH_NOTE/);
  assert.doesNotMatch(fresh.persona, /BEFORE/);
  assert.equal(fresh.message, "Fresh start.");
});

test("in a room the conversation is told in the message and the system prompt holds", async (t) => {
  const s = await setup(t);
  const { bot: other } = await s.post("/api/bots", { name: "Bystander" });
  const { blok } = await s.post("/api/bloks", { name: "Stable room", memberIds: [s.bot.id, other.id] });
  await s.post(`/api/bloks/${blok.id}/messages`, { text: "@Keeper FIRST_ROOM_LINE" });
  const first = await s.settle(1);
  assert.doesNotMatch(first.persona, /FIRST_ROOM_LINE/, "the room's history is not in the system prompt");
  assert.match(first.persona, /Stable room/, "the room's briefing still is");
  assert.match(first.message, /^\(Recent conversation in this room:\n.*Room opened with Keeper, Bystander.*\nUser: @Keeper FIRST_ROOM_LINE\)\n\n@Keeper FIRST_ROOM_LINE$/s);

  await s.post(`/api/bloks/${blok.id}/messages`, { text: "@Keeper SECOND_ROOM_LINE" });
  const second = await s.settle(2);
  assert.ok(second.argv.includes("--resume"));
  assert.equal(second.persona, first.persona);
  assert.doesNotMatch(second.persona, /ROOM_LINE/);
  // only what the session has not heard, in the order it was said
  assert.match(second.message, /In this room since your last turn here:\nKeeper \(you\): Answered 1\nUser: @Keeper SECOND_ROOM_LINE/);
  assert.doesNotMatch(second.message, /FIRST_ROOM_LINE/);
});
