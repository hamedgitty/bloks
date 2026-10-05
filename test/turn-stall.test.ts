// A tool call gone silent, and a Stop that stops (GitHub 146, 147).
//
// An agent ran `ls` on a Dropbox folder, macOS held the read, and the
// Claude Code process went quiet in the middle of the call. Nothing ended
// the turn: not time, and not Stop, which sent one SIGTERM to a process
// that ignored it. These stand-in CLIs do the same things on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { callDetail, describeStall, isStalled, stallPreface } from "../server/drivers/stall.ts";
import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("the stall rule: an open call, nobody being asked, and silence past the limit", () => {
  const base = { open: 1, asking: 0, lastSign: 0, now: 60_000, limitMs: 60_000 };
  assert.equal(isStalled(base), true);
  assert.equal(isStalled({ ...base, now: 59_999 }), false, "not yet");
  assert.equal(isStalled({ ...base, open: 0 }), false, "the model thinking is never cut short");
  assert.equal(isStalled({ ...base, asking: 1 }), false, "waiting on the person is not the engine's silence");
  assert.equal(isStalled({ ...base, limitMs: 0 }), false, "0 is never");
});

test("the stall message names the call, and says what to do about a cloud folder", () => {
  assert.equal(callDetail({ command: "ls  -la\n~/x" }), "ls -la ~/x");
  assert.equal(callDetail({ file_path: "/tmp/a.txt" }), "/tmp/a.txt");
  assert.equal(callDetail(undefined), null);
  const plain = describeStall({ name: "Bash", input: { command: "make test" }, since: 0 }, 15 * 60_000);
  assert.match(plain, /^Bash \(make test\) made no progress for 15 minutes/);
  assert.doesNotMatch(plain, /cloud folder/);
  const cloud = describeStall({ name: "Read", input: { file_path: "/Users/a/Library/CloudStorage/Dropbox/r.pdf" }, since: 0 }, 5 * 60_000);
  assert.match(cloud, /cloud folder/);
  assert.match(cloud, /tccutil reset FileProviderDomain dev\.bloks\.app/);
  assert.match(stallPreface(plain), /^\(Bloks stopped your last turn: Bash \(make test\)/);
});

/** A stand-in Claude Code. Told HANG, it starts a Bash call and never
 * finishes it, ignoring SIGTERM. Told HOLD-PIPE, it also leaves a
 * grandchild outside its group holding the output open. Told THINK, it
 * goes quiet with no call open, then answers. Every prompt is written down. */
function fakeClaude(home: string) {
  const heard = join(home, "heard.log");
  const grandchild = join(home, "grandchild.pid");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  appendFileSync(${JSON.stringify(heard)}, input + "\\n----\\n");
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" });
  if (input.includes("HANG")) {
    process.on("SIGTERM", () => {});
    if (input.includes("HOLD-PIPE")) {
      const held = spawn("/bin/sleep", ["60"], { stdio: ["ignore", "inherit", "inherit"], detached: true });
      writeFileSync(${JSON.stringify(grandchild)}, String(held.pid));
    }
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls ~/Library/CloudStorage/Dropbox/Reports" } }] } });
    setInterval(() => {}, 1000);
    return;
  }
  if (input.includes("THINK")) await new Promise((r) => setTimeout(r, 5_000));
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." });
});
`,
    { mode: 0o755 },
  );
  return { cli, heard, grandchild };
}

async function setup(t: any, stallMinutes: number) {
  const home = mkdtempSync(join(tmpdir(), "bloks-stall-"));
  const fake = fakeClaude(home);
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: fake.cli, permissionMode: "bypassPermissions" } } }, turns: { stallMinutes } }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    if (existsSync(fake.grandchild)) {
      try {
        process.kill(Number(readFileSync(fake.grandchild, "utf8")), "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Reader" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const busy = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy;
  const say = (text: string) => h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  const chat = async () => (await h.json(`/api/bots/${bot.id}/messages?limit=100`)).messages as any[];
  const prompts = () => (existsSync(fake.heard) ? readFileSync(fake.heard, "utf8").split("\n----\n").filter(Boolean) : []);
  return { h, bot, busy, say, chat, prompts, fake };
}

test("a tool call gone silent ends its turn, says which call, and the agent hears why next time", async (t) => {
  const s = await setup(t, 0.05); // three seconds
  await s.say("HANG please read the report");
  assert.ok(await waitFor(() => s.busy()), "the turn never started");
  const started = Date.now();
  assert.ok(await waitFor(async () => !(await s.busy()), 20_000), "the stalled turn was never ended");
  assert.ok(Date.now() - started < 15_000);
  const said = (await s.chat()).filter((m) => m.kind === "notice" || m.kind === "activity").map((m) => m.text ?? m.tool?.name ?? "").join("\n");
  assert.match(said, /Bash \(ls ~\/Library\/CloudStorage\/Dropbox\/Reports\) made no progress/);
  assert.match(said, /cloud folder/);
  assert.doesNotMatch(said, /stopped early/, "a stall is not reported as a crash");

  // the next turn starts by telling the agent, once
  await s.say("what happened?");
  assert.ok(await waitFor(() => s.prompts().length >= 2 && !s.prompts()[1].includes("HANG")), "the next turn never ran");
  assert.ok(await waitFor(async () => !(await s.busy())));
  assert.match(s.prompts()[1], /Bloks stopped your last turn: Bash \(ls ~\/Library\/CloudStorage/);
  await s.say("and now?");
  assert.ok(await waitFor(() => s.prompts().length >= 3));
  assert.doesNotMatch(s.prompts()[2], /Bloks stopped your last turn/, "the note is said once");
});

test("quiet thinking with no call open is not a stall", async (t) => {
  const s = await setup(t, 0.05);
  await s.say("THINK about it for a while");
  assert.ok(await waitFor(() => s.busy()));
  assert.ok(await waitFor(async () => !(await s.busy()), 20_000));
  const messages = await s.chat();
  assert.ok(messages.some((m) => m.role === "bot" && m.kind === "text" && m.text === "Done."), "the answer after a long think was lost");
  assert.ok(!messages.some((m) => /made no progress/.test(m.text ?? "")));
});

test("Stop ends a turn whose engine ignores SIGTERM, quietly", async (t) => {
  const s = await setup(t, 0); // the limit off: only Stop can end it
  await s.say("HANG and ignore everything");
  assert.ok(await waitFor(async () => (await s.busy()) && s.prompts().length >= 1));
  await new Promise((r) => setTimeout(r, 500));
  const stopped = Date.now();
  await s.h.fetch(`/api/bots/${s.bot.id}/interrupt`, { method: "POST", body: "{}" });
  assert.ok(await waitFor(async () => !(await s.busy()), 12_000), "Stop did not end the turn");
  assert.ok(Date.now() - stopped < 10_000);
  const said = (await s.chat()).map((m) => m.text ?? "").join("\n");
  assert.doesNotMatch(said, /stopped early|did not finish/, "a Stop the person asked for is not an error");
  // and the conversation takes work again
  await s.say("are you back?");
  assert.ok(await waitFor(() => s.prompts().length >= 2));
});

test("Stop ends the turn even when something the engine started holds its output open", async (t) => {
  const s = await setup(t, 0);
  await s.say("HANG HOLD-PIPE and never let go");
  assert.ok(await waitFor(() => existsSync(s.fake.grandchild)));
  assert.ok(await s.busy());
  await s.h.fetch(`/api/bots/${s.bot.id}/interrupt`, { method: "POST", body: "{}" });
  assert.ok(await waitFor(async () => !(await s.busy()), 15_000), "a held pipe kept the turn alive");
});

test("the limit is one of the offered choices", async (t) => {
  const s = await setup(t, 15);
  assert.equal((await s.h.json("/api/config")).turns.stallMinutes, 15);
  const bad = await s.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ turns: { stallMinutes: 7 } }) });
  assert.equal(bad.status, 400);
  const ok = await s.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ turns: { stallMinutes: 0 } }) });
  assert.equal(ok.status, 200);
  assert.equal((await s.h.json("/api/config")).turns.stallMinutes, 0);
});
