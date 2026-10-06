// Claude Code snapshots the first system prompt unless resume opts out.
// Use a fake CLI with that behavior behind the real HTTP request path:
// changing an agent must change its next persona without losing history.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";

interface CliVersion {
  version: string;
  supportsFlag: boolean;
  probeFails?: boolean;
}

interface Call {
  argv: string[];
  sessionId: string;
  persona: string;
  suppliedPersona: string;
  mode: number;
  history: string[];
  error?: string;
}

async function setup(t: TestContext, version: CliVersion) {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-prompt-"));
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stop?.();
    rmSync(home, { recursive: true, force: true });
  });
  const cli = join(home, "fake-claude.mjs");
  const versionFile = join(home, "version.json");
  const callsFile = join(home, "calls.json");
  const sessionsFile = join(home, "sessions.json");
  const setVersion = (next: CliVersion) => writeFileSync(versionFile, JSON.stringify(next));
  setVersion(version);
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, statSync, renameSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const version = JSON.parse(readFileSync(${JSON.stringify(versionFile)}, "utf8"));
if (args[0] === "--version") {
  console.log(version.version);
  process.exit(version.probeFails ? 1 : 0);
}
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const read = (file, otherwise) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : otherwise;
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const sessions = read(${JSON.stringify(sessionsFile)}, {});
  const sessionId = value(args.includes("--resume") ? "--resume" : "--session-id");
  const personaFile = value("--append-system-prompt-file");
  const suppliedPersona = readFileSync(personaFile, "utf8");
  const previous = sessions[sessionId];
  const persona = !previous || value("--system-prompt-snapshot") === "off"
    ? suppliedPersona : previous.persona;
  const history = previous?.history ?? [];
  const calls = read(${JSON.stringify(callsFile)}, []);
  const call = { argv: args, sessionId, persona, suppliedPersona,
    mode: statSync(personaFile).mode & 0o777, history: [...history] };
  if (args.includes("--system-prompt-snapshot") && !version.supportsFlag) {
    call.error = "unknown option --system-prompt-snapshot";
    calls.push(call);
    writeFileSync(${JSON.stringify(callsFile)} + ".tmp", JSON.stringify(calls)); renameSync(${JSON.stringify(callsFile)} + ".tmp", ${JSON.stringify(callsFile)});
    console.error(call.error);
    process.exit(1);
  }
  history.push(JSON.parse(input.trim()).message.content);
  sessions[sessionId] = { persona, history };
  writeFileSync(${JSON.stringify(sessionsFile)} + ".tmp", JSON.stringify(sessions)); renameSync(${JSON.stringify(sessionsFile)} + ".tmp", ${JSON.stringify(sessionsFile)});
  calls.push(call);
  writeFileSync(${JSON.stringify(callsFile)} + ".tmp", JSON.stringify(calls)); renameSync(${JSON.stringify(callsFile)} + ".tmp", ${JSON.stringify(callsFile)});
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
  const { bot } = await h.json("/api/bots", {
    method: "POST", body: JSON.stringify({ name: "Prompt reader", description: "OLD_ABOUT", skills: ["OLD_SKILL"] }),
  });
  const patch = async (body: Record<string, unknown>) => {
    const result = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(body) });
    assert.equal(result.status, 200);
  };
  await patch({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  const calls = (): Call[] => existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, "utf8")) : [];
  const turn = async (text: string) => {
    const n = calls().length + 1;
    const accepted = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.equal(accepted.status, 202);
    for (let i = 0; i < 200; i++) {
      const seen = calls();
      const { bots } = await h.json("/api/bots?messages=0");
      if (seen.length >= n && !bots.find((b: any) => b.id === bot.id)?.busy) {
        assert.equal(seen.length, n, "a turn was run more than once");
        assert.equal(seen[n - 1].error, undefined, "the CLI rejected the flag");
        return seen[n - 1];
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`the fake CLI did not finish turn ${n}: ${h.logs().slice(-800)}`);
  };
  return { h, bot, patch, turn, calls, setVersion };
}

test("a resumed Claude turn uses current About and skills with the same session and history", async (t) => {
  const h = await setup(t, { version: "2.1.289 (Claude Code)", supportsFlag: true });
  const first = await h.turn("Remember this first input.");
  assert.ok(first.argv.includes("--session-id"));
  assert.ok(!first.argv.includes("--resume"));
  assert.ok(!first.argv.includes("--system-prompt-snapshot"), "fresh sessions keep their existing arguments");
  assert.match(first.persona, /OLD_ABOUT/);
  assert.match(first.persona, /OLD_SKILL/);
  await h.patch({ description: "NEW_ABOUT, use NEW_CLI_PATH", skills: ["NEW_SKILL"] });
  const second = await h.turn("What is current?");
  assert.equal(second.argv[second.argv.indexOf("--resume") + 1], first.sessionId);
  assert.ok(!second.argv.includes("--session-id"), "resume must not start a new session");
  assert.equal(second.sessionId, first.sessionId);
  assert.match(second.persona, /NEW_ABOUT/);
  assert.match(second.persona, /NEW_SKILL/);
  assert.match(second.persona, /NEW_CLI_PATH/);
  assert.doesNotMatch(second.persona, /OLD_ABOUT|OLD_SKILL/);
  assert.equal(second.argv[second.argv.indexOf("--system-prompt-snapshot") + 1], "off");
  assert.deepEqual(second.history, ["Remember this first input."]);
  assert.equal(second.mode, 0o600, "the persona stays in a private file");
  assert.ok(!second.argv.some((arg) => arg.includes("NEW_ABOUT")), "persona text must not leak into argv");
  const { bots } = await h.h.json("/api/bots");
  assert.equal(bots.find((b: any) => b.id === h.bot.id).id, h.bot.id);
  assert.equal(bots.find((b: any) => b.id === h.bot.id).threadId, h.bot.threadId);
});

for (const [version, supportsFlag] of [
  ["2.1.256 (Claude Code)", false],
  ["2.1.257 (Claude Code)", true],
  ["2.0.300 (Claude Code)", false],
  ["2.2.0 (Claude Code)", true],
  ["3.0.0 (Claude Code)", true],
  ["custom Claude build", false],
  ["2.1.289-preview (Claude Code)", false],
] as const) {
  test(`resume flag is guarded for ${version}`, async (t) => {
    const h = await setup(t, { version, supportsFlag });
    const first = await h.turn("Keep the conversation.");
    const second = await h.turn("Continue it.");
    assert.equal(second.argv.includes("--system-prompt-snapshot"), supportsFlag);
    if (supportsFlag) assert.equal(second.argv[second.argv.indexOf("--system-prompt-snapshot") + 1], "off");
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(second.history, ["Keep the conversation."]);
  });
}

test("a failed version probe does not pass an unverified flag or retry the turn", async (t) => {
  const h = await setup(t, { version: "2.1.289 (Claude Code)", supportsFlag: false, probeFails: true });
  const first = await h.turn("First.");
  const second = await h.turn("Resume.");
  assert.ok(!second.argv.includes("--system-prompt-snapshot"));
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(h.calls().length, 2);
});

test("the normal health probe refreshes support after a CLI upgrade or downgrade", async (t) => {
  const h = await setup(t, { version: "2.1.256 (Claude Code)", supportsFlag: false });
  const first = await h.turn("Before the upgrade.");
  h.setVersion({ version: "2.1.289 (Claude Code)", supportsFlag: true });
  const { instances } = await h.h.json("/api/instances");
  assert.equal(instances.find((i: any) => i.instanceId === "claude").snapshot.version, "2.1.289 (Claude Code)");
  await h.patch({ description: "UPGRADED_ABOUT" });
  const upgraded = await h.turn("After the upgrade.");
  assert.ok(upgraded.argv.includes("--system-prompt-snapshot"));
  assert.match(upgraded.persona, /UPGRADED_ABOUT/);
  assert.equal(upgraded.sessionId, first.sessionId);
  h.setVersion({ version: "2.1.256 (Claude Code)", supportsFlag: false });
  await h.h.json("/api/instances");
  const downgraded = await h.turn("After the downgrade.");
  assert.ok(!downgraded.argv.includes("--system-prompt-snapshot"));
  assert.equal(downgraded.sessionId, first.sessionId);
  assert.deepEqual(downgraded.history, ["Before the upgrade.", "After the upgrade."]);
});
