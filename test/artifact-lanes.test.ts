// A file one conversation of an agent makes is carded there, never under a
// reply in another conversation of the same agent that happened to be
// running at the time (GitHub 460), whether it was saved and swept up at
// the end of the turn or shared on purpose in the middle of it. Run end
// to end, through the server and a stand-in for Claude Code.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

async function waitFor<T>(check: () => T | false | undefined | Promise<T | false | undefined>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("fixture condition did not become true");
}

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-artifact-lanes-"));
  const cli = join(home, "engine.mjs");
  mkdirSync(join(home, ".bloks"));
  // Told HOLD <marker>, it says it is ready and waits for its release.
  // Told MAKE <base64 path>, it writes that file with a Write call, the
  // way Claude Code does, and says so. With SHARE in front as well, it
  // then shares the file with the real command.
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let first = true;
const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const frame = JSON.parse(line);
  if (frame.type !== "user") return;
  const text = String(frame.message.content);
  if (first) {
    first = false;
    out({ type: "system", subtype: "init", session_id: "fixture-" + Math.random(), model: "claude-sonnet-5" });
  }
  const done = (said) => {
    out({ type: "assistant", message: { content: [{ type: "text", text: said }] } });
    out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, result: said });
    setTimeout(() => process.exit(0), 30);
  };
  const held = text.match(/HOLD ([A-Za-z0-9]+)/);
  const made = text.match(/MAKE ([A-Za-z0-9+\\/=]+)/);
  if (held) {
    writeFileSync(${JSON.stringify(home)} + "/ready-" + held[1], "");
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(home)} + "/release-" + held[1])) return;
      clearInterval(timer);
      done("Filed the usage report.");
    }, 20);
  } else if (made) {
    const path = Buffer.from(made[1], "base64").toString("utf8");
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: path, content: "<h1>Dinners</h1>" } }] } });
    writeFileSync(path, "<h1>Dinners</h1>");
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "written" }] } });
    if (text.includes("SHARE")) spawnSync(process.execPath, [process.env.BLOKS_CLI, "share", path], { env: process.env, encoding: "utf8" });
    done("Here is the week of dinners.");
  } else done("Done.");
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  const h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Planner" }) });
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: withSecond } = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Usage" }) });
  const general = bot.threadId as string;
  const secondary = withSecond.tasks.find((task: any) => task.id !== general).id as string;
  const messages = async (lane: string): Promise<any[]> => (await h.json(`/api/bots/${bot.id}/messages?thread=${lane}&limit=500`)).messages;
  const busy = async (lane: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.tasks.find((task: any) => task.id === lane)?.busy;
  const say = (lane: string, text: string) => h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ taskId: lane, text }) });
  const cards = async (lane: string) => (await messages(lane)).filter((m) => m.kind === "artifact").map((m) => m.artifact.name);
  const files = join(home, ".bloks", "artifacts", bot.id);
  const make = (name: string) => Buffer.from(join(files, name)).toString("base64");
  return { home, general, secondary, busy, say, cards, make };
}

for (const share of [false, true]) {
  test(`a page made in General is carded in General only, though another conversation ran beside it${share ? ", shared on purpose" : ""}`, async (t) => {
    const f = await fixture(t);
    await f.say(f.secondary, "HOLD usage");
    await waitFor(() => existsSync(join(f.home, "ready-usage")));
    await f.say(f.general, `${share ? "SHARE " : ""}MAKE ${f.make("dinners-week-1.html")}`);
    await waitFor(async () => !(await f.busy(f.general)) && (await f.cards(f.general)).length > 0);
    writeFileSync(join(f.home, "release-usage"), "");
    await waitFor(async () => !(await f.busy(f.secondary)));
    // the other conversation's turn has ended and been swept by now
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await f.cards(f.general), ["dinners-week-1.html"], "one card where it was made");
    assert.deepEqual(await f.cards(f.secondary), [], "and none under the unrelated reply");
  });
}

test("one turn after another: each cards only its own, as before", async (t) => {
  const f = await fixture(t);
  await f.say(f.general, `MAKE ${f.make("first.html")}`);
  await waitFor(async () => !(await f.busy(f.general)) && (await f.cards(f.general)).length > 0);
  await f.say(f.secondary, `MAKE ${f.make("second.html")}`);
  await waitFor(async () => !(await f.busy(f.secondary)) && (await f.cards(f.secondary)).length > 0);
  assert.deepEqual(await f.cards(f.general), ["first.html"]);
  assert.deepEqual(await f.cards(f.secondary), ["second.html"]);
});
