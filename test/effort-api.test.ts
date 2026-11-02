// Reasoning effort over the real request path (GitHub 334): each engine
// offers the levels it takes, a level being chosen has to be one of
// them, a saved one survives a move to an engine without it, and a turn
// is sent the nearest level its engine has. Claude Code, which takes all
// five, is told the level on its command line.
//
// The harness runs against a throwaway home with no CLIs on PATH; where a
// turn has to run, a stand-in engine records how it was started.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const ALL = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE = { instanceId: "claude", model: "claude-opus-5-5" };
const GROK = { instanceId: "grok_cli", model: "grok-4.7" };
const OPENCODE = { instanceId: "opencode", model: "auto" };

async function until<T>(check: () => T | null | Promise<T | null>, ms = 15_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await check();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("the levels each engine takes", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h?.stop();
  });

  const hire = async (body: Record<string, unknown> = {}) =>
    (await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Thinker", ...body }) })).bot;
  const patch = (id: string, body: Record<string, unknown>) =>
    h.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  const defaults = (agentDefaults: Record<string, unknown>) =>
    h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ agentDefaults }) });

  test("the engine list says which levels each engine has", async () => {
    const { instances } = await h.json("/api/instances");
    const levels = Object.fromEntries(instances.map((i: any) => [i.instanceId, i.efforts]));
    assert.deepEqual(levels.claude, ALL);
    assert.deepEqual(levels.codex, ALL);
    assert.deepEqual(levels.grok_cli, ["low", "medium", "high"]);
    assert.deepEqual(levels.opencode, []);
  });

  test("a Claude agent takes Extra high and Max, and goes back to the engine's own with null", async () => {
    const bot = await hire();
    await patch(bot.id, { modelSelection: CLAUDE });
    for (const effort of ["xhigh", "max"]) {
      const res = await patch(bot.id, { effort });
      assert.equal(res.status, 200, effort);
      assert.equal((await res.json()).bot.effort, effort);
    }
    const cleared = await patch(bot.id, { effort: null });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).bot.effort, undefined);
    const strange = await patch(bot.id, { effort: "ultra" });
    assert.equal(strange.status, 400);
    assert.equal((await strange.json()).error, "effort is off, low, medium, high, xhigh or max");
  });

  test("a level the engine lacks is refused, saying what it has, and nothing changes", async () => {
    const bot = await hire();
    await patch(bot.id, { modelSelection: CLAUDE, effort: "high" });
    // moving to Grok CLI and asking for Max in one go
    const refused = await patch(bot.id, { modelSelection: GROK, effort: "max" });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "Grok CLI takes effort low, medium or high, not max");
    const { bots } = await h.json("/api/bots?messages=0");
    const kept = bots.find((b: any) => b.id === bot.id);
    assert.deepEqual(kept.modelSelection, CLAUDE);
    assert.equal(kept.effort, "high");
  });

  test("an engine with no dial keeps any level for an engine that has one", async () => {
    // as every engine did before the levels were per engine, so a client
    // that offers the dial everywhere is not refused for it
    const bot = await hire();
    await patch(bot.id, { modelSelection: OPENCODE });
    const kept = await patch(bot.id, { effort: "max" });
    assert.equal(kept.status, 200);
    assert.equal((await kept.json()).bot.effort, "max");
    assert.equal((await patch(bot.id, { effort: "ultra" })).status, 400);
  });

  test("a saved Max survives a move to an engine without it, and moving back brings it back", async () => {
    const bot = await hire();
    await patch(bot.id, { modelSelection: CLAUDE, effort: "max" });
    const moved = await patch(bot.id, { modelSelection: GROK });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).bot.effort, "max");
    // said again unchanged, as a client sending the whole record would
    assert.equal((await patch(bot.id, { effort: "max" })).status, 200);
    // a new level is judged, though
    assert.equal((await patch(bot.id, { effort: "xhigh" })).status, 400);
    const back = await patch(bot.id, { modelSelection: CLAUDE });
    assert.equal((await back.json()).bot.effort, "max");
  });

  test("New agents take a level the default engine has, and a hire is born with it", async () => {
    const ok = await defaults({ modelSelection: CLAUDE, effort: "max" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).agentDefaults.effort, "max");
    const born = await hire();
    assert.equal(born.effort, "max");
    assert.deepEqual(born.modelSelection, CLAUDE);

    // the whole section comes back each time: changing only the model
    // keeps the level, which new agents then run at the nearest
    const moved = await defaults({ modelSelection: GROK, effort: "max" });
    assert.equal(moved.status, 200);
    const onGrok = await hire();
    assert.equal(onGrok.effort, "max");
    assert.deepEqual(onGrok.modelSelection, GROK);
    const refused = await defaults({ modelSelection: GROK, effort: "xhigh" });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "Grok CLI takes effort low, medium or high, not xhigh");

    await defaults({});
  });

  test("a hire can say its own level, checked against the engine it starts on", async () => {
    const made = await hire({ effort: "xhigh" });
    assert.equal(made.effort, "xhigh");

    await defaults({ modelSelection: GROK });
    const before = (await h.json("/api/bots?messages=0")).bots.length;
    const refused = await h.fetch("/api/bots", { method: "POST", body: JSON.stringify({ name: "Too keen", effort: "max" }) });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).error, "Grok CLI takes effort low, medium or high, not max");
    assert.equal((await h.json("/api/bots?messages=0")).bots.length, before, "a refused hire made somebody anyway");
    await defaults({});
  });
});

/** A workspace whose Claude Code and Grok CLI are stand-ins that write
 * down how each was started; Claude's also hands over the turn's
 * credential and holds the turn until released. */
async function standIns(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-effort-"));
  const claudeSeen = join(home, "claude-argv.jsonl");
  const grokSeen = join(home, "grok-argv.jsonl");
  const tokenFile = join(home, "token");
  const release = join(home, "release");
  const claude = join(home, "fake-claude.mjs");
  writeFileSync(
    claude,
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.302 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
appendFileSync(${JSON.stringify(claudeSeen)}, JSON.stringify(args) + "\\n");
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  writeFileSync(${JSON.stringify(tokenFile)}, process.env.BLOKS_TOKEN ?? "");
  for (let i = 0; i < 1200 && !existsSync(${JSON.stringify(release)}); i++) await new Promise((r) => setTimeout(r, 50));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  const grok = join(home, "fake-grok.mjs");
  writeFileSync(
    grok,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("grok 1.0.4"); process.exit(0); }
appendFileSync(${JSON.stringify(grokSeen)}, JSON.stringify(args) + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), "{}");
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: {
        claude: { driver: "claudeAgent", config: { cli: claude } },
        grok_cli: { driver: "grokCli", config: { cli: grok } },
      },
    }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    writeFileSync(release, "");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const lines = (file: string): string[][] =>
    existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const effortIn = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  return {
    h,
    /** The command line of the first turn each was started for, not of
     * a version check or a catalog probe. */
    claudeTurn: () => until(() => lines(claudeSeen).find((args) => args.includes("-p")) ?? null),
    grokTurn: () => until(() => lines(grokSeen).find((args) => args.includes("--permission-mode")) ?? null),
    effortIn,
    token: () => until(() => (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") || null : null)),
  };
}

function bloks(h: Harness, token: string, args: string[]) {
  return new Promise<{ code: number; out: any }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, BLOKS_URL: h.url, BLOKS_TOKEN: token } }, (error, stdout) => {
      resolve({ code: error ? ((error as any).code ?? 1) : 0, out: JSON.parse(stdout || "{}") });
    });
  });
}

test("a Claude agent at Max is started with --effort max, and `bloks hire --effort` sets a hire's level", async (t) => {
  const s = await standIns(t);
  const { bot } = await s.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Deep" }) });
  const set = await s.h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: CLAUDE, effort: "max" }) });
  assert.equal(set.status, 200);
  await s.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Think hard" }) });
  const args = await s.claudeTurn();
  assert.ok(args, `the turn never started: ${s.h.logs().slice(-800)}`);
  assert.equal(s.effortIn(args, "--effort"), "max");
  assert.equal(s.effortIn(args, "--model"), "claude-opus-5-5");

  // the agent whose turn that is hires a teammate, as an agent does
  const token = await s.token();
  assert.match(token ?? "", /^blk_/, "the stand-in never got a credential");
  const hired = await bloks(s.h, token!, ["hire", "--name", "Careful", "--title", "Reviewer", "--effort", "xhigh"]);
  assert.equal(hired.code, 0, JSON.stringify(hired.out));
  assert.equal(hired.out.bot.effort, "xhigh");
  const { bots } = await s.h.json("/api/bots?messages=0");
  assert.equal(bots.find((b: any) => b.id === hired.out.bot.id)?.effort, "xhigh");

  const wrong = await bloks(s.h, token!, ["hire", "--name", "Odd", "--effort", "ultra"]);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.out.error, /effort is off, low, medium, high, xhigh or max/);
  const help = await bloks(s.h, "", ["help"]);
  assert.match(help.out.commands.find((c: any) => c.name === "hire").use, /--effort <level>/);
});

test("an agent saved at Max and moved to Grok CLI is sent High, the nearest Grok has", async (t) => {
  const s = await standIns(t);
  const { bot } = await s.h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Moved" }) });
  await s.h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: CLAUDE, effort: "max" }) });
  const moved = await s.h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: GROK }) });
  assert.equal((await moved.json()).bot.effort, "max", "the saved level is kept");
  await s.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Go" }) });
  const args = await s.grokTurn();
  assert.ok(args, `the turn never reached Grok CLI: ${s.h.logs().slice(-800)}`);
  assert.equal(s.effortIn(args, "--reasoning-effort"), "high");
});
