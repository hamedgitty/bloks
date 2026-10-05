// GitHub 150: Bloks moved (a standalone server gave way to the app) and
// agents on resumed sessions went on running the CLI from where it used
// to be. Agents are now told to run it through BLOKS_CLI, which every turn
// sets, and a session that was told something else is told once, in the
// turn itself, since an engine that keeps a session's first system prompt
// never reads the new one.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

interface Call {
  sessionId: string;
  resumed: boolean;
  persona: string;
  text: string;
  cli: string | null;
}

const OLD = 'node "/old/place/bloks-server/bin/bloks.mjs"';

test("agents run the CLI through BLOKS_CLI, and a session told otherwise hears it once", { skip: process.platform === "win32" }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-cli-moved-"));
  let h: Harness | undefined;
  t.after(async () => {
    await h?.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const cli = join(home, "fake-claude.mjs");
  const callsFile = join(home, "calls.json");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const resumed = args.includes("--resume");
  const sessionId = value(resumed ? "--resume" : "--session-id");
  const calls = existsSync(${JSON.stringify(callsFile)}) ? JSON.parse(readFileSync(${JSON.stringify(callsFile)}, "utf8")) : [];
  calls.push({
    sessionId,
    resumed,
    persona: readFileSync(value("--append-system-prompt-file"), "utf8"),
    text: JSON.parse(input.trim()).message.content,
    cli: process.env.BLOKS_CLI ?? null,
  });
  writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Answered " + calls.length }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: sessionId, result: "Answered " + calls.length });
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));

  h = await startHarness({ HOME: home });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Mover" }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  assert.equal(set.status, 200);

  const calls = (): Call[] => (existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : []);
  const turn = async (text: string): Promise<Call> => {
    const n = calls().length + 1;
    const accepted = await h!.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.equal(accepted.status, 202);
    for (let i = 0; i < 200; i++) {
      const { bots } = await h!.json("/api/bots?messages=0");
      if (calls().length >= n && !bots.find((b: any) => b.id === bot.id)?.busy) return calls()[n - 1];
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`turn ${n} never finished: ${h!.logs().slice(-800)}`);
  };

  // told the variable, never the path, and the variable is there to use
  const first = await turn("Start.");
  assert.match(first.persona, /node "\$BLOKS_CLI" help/);
  assert.doesNotMatch(first.persona, /bin\/bloks\.mjs/, "the install path is not written into the instructions");
  assert.ok(first.cli && first.cli.endsWith("bloks.mjs") && existsSync(first.cli), `BLOKS_CLI is ${first.cli}`);
  assert.equal(first.text, "Start.", "a new session needs no note");

  const second = await turn("Carry on.");
  assert.ok(second.resumed);
  assert.equal(second.text, "Carry on.", "a session told the same way hears nothing new");

  // A lane last told the old way, as one from before this change is: its
  // record names a written-out path. Bloks restarts from somewhere else.
  await h.stop();
  const botsFile = join(home, ".bloks", "bots.json");
  const saved = JSON.parse(readFileSync(botsFile, "utf8"));
  const lane = saved.find((b: any) => b.id === bot.id).tasks[0];
  assert.equal(lane.briefedCli, 'node "$BLOKS_CLI"', "the lane remembers how it was told");
  lane.briefedCli = OLD;
  writeFileSync(botsFile, JSON.stringify(saved));
  h = await startHarness({ HOME: home });

  const moved = await turn("And now?");
  assert.ok(moved.resumed, "the same session carries on");
  assert.equal(moved.sessionId, first.sessionId);
  assert.ok(moved.text.endsWith("And now?"));
  assert.match(moved.text, /^\(Bloks has moved since your earlier turns\. Run its command as `node "\$BLOKS_CLI"`/);
  assert.ok(moved.text.includes(OLD), "the note names the old command, so the agent can recognise it");

  const after = await turn("Once more.");
  assert.equal(after.text, "Once more.", "said once, not every turn");

  // a lane from before anything was recorded hears the plainer version
  await h.stop();
  const again = JSON.parse(readFileSync(botsFile, "utf8"));
  delete again.find((b: any) => b.id === bot.id).tasks[0].briefedCli;
  writeFileSync(botsFile, JSON.stringify(again));
  h = await startHarness({ HOME: home });
  const unknown = await turn("Still there?");
  assert.match(unknown.text, /^\(Run the bloks command as `node "\$BLOKS_CLI"` from now on\./);
  assert.ok(unknown.text.endsWith("Still there?"));
});
