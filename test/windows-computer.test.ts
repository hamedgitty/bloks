// GitHub 388: on Windows, 3.0.9 stopped an OpenCode agent's hourly
// routine from running its scripts. 3.0.9 took "This computer" out of the
// Computer choices off a Mac (GitHub 377), refused saving it, and told
// every agent with no screen "You have no computer". None of that was
// ever about where an agent runs: its engine, its commands and its files
// are on the machine Bloks runs on, whatever Computer says. Computer is
// only a screen the agent can see and click.
//
// These boot the real server as a Windows workspace (BLOKS_TEST_PLATFORM,
// server/hosted.ts) with a stand-in OpenCode that writes down what it was
// told and runs its "script", and check that what worked in 3.0.8 still
// does: an agent saved on This computer, a routine that runs on it, an
// agent on Automatic with no cloud box, and one set to a Local VM that
// was never set up.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

const OPENCODE = { instanceId: "opencode", model: "auto" };
// never a real container runtime: the Local VM stays not set up
const NO_RUNTIME = { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" };

/** A home with a stand-in OpenCode on the ACP protocol. Every prompt it
 * is sent is written down, and each one "runs the script": it writes a
 * file, as the reporter's routine's scripts did. */
function workspace(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-388-"));
  const prompts = join(home, "prompts.jsonl");
  const ran = join(home, "script-ran.jsonl");
  const cli = join(home, "fake-opencode.cjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s1" });
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text ?? "").join("");
  fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify(text) + "\\n");
  fs.appendFileSync(${JSON.stringify(ran)}, JSON.stringify({ pid: process.pid }) + "\\n");
  say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ran the hourly scripts." } } } });
  reply({ stopReason: "end_turn" });
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { opencode: { driver: "opencode", config: { cli } } } }));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lines = (file: string): any[] =>
    existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let h: Harness | null = null;
  return {
    home,
    /** The server, standing in for `platform`. One at a time, as the app
     * runs: the next start is the same workspace after an update. */
    async start(platform: string) {
      if (h) await h.stop();
      h = await startHarness({ HOME: home, BLOKS_TEST_PLATFORM: platform, ...NO_RUNTIME });
      t.after(() => h?.stop());
      return h;
    },
    prompts: () => lines(prompts) as string[],
    scriptRuns: () => lines(ran).length,
  };
}

async function agent(h: Harness, name: string, computer: string | null) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: OPENCODE, computer }) });
  const body = await set.text();
  assert.equal(set.status, 200, `setting ${name} up was refused: ${body}`);
  return JSON.parse(body).bot;
}

/** The system words the engine got on the turn that said `marker`. */
const toldWith = (prompts: string[], marker: string) => prompts.find((p) => p.includes(marker)) ?? null;

test("an OpenCode agent saved on This computer keeps running its hourly routine on Windows", async (t) => {
  const w = workspace(t);

  // Before: set up as the reporter had it, an agent on This computer
  // with an hourly routine that runs on it. 3.0.8 offered and saved this
  // on Windows; a Mac still does.
  let h = await w.start("darwin");
  const bot = await agent(h, "Hourly", "local");
  const made = await h.fetch("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: bot.id, targetKind: "agent", name: "Scripts", prompt: "HOURLY-SCRIPTS: run the scripts", every: 60, runsOn: "local" }),
  });
  const { routine } = await made.json();
  assert.equal(made.status, 201, JSON.stringify(routine));

  // After: the same workspace, on Windows
  h = await w.start("win32");
  const choices = (await h.json("/api/config")).hosted.computers.map((c: { id: string }) => c.id);
  assert.ok(!choices.includes("local"), "a PC is offered its own screen, which nothing here can work");
  const saved = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  assert.equal(saved.computer, "local", "the saved choice was rewritten under the person");

  // What a phone, or any older client, still sends must not be refused:
  // a refusal there fails the whole save, whatever else it carried.
  const resent = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ computer: "local", name: "Hourly" }) });
  assert.equal(resent.status, 200, `saving This computer on Windows was refused: ${await resent.text()}`);

  const run = await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" });
  assert.equal(run.status, 202);
  const told = await waitFor(() => toldWith(w.prompts(), "HOURLY-SCRIPTS"));
  assert.ok(told, `the routine's turn never reached OpenCode: ${h.logs().slice(-1500)}`);
  assert.equal(w.scriptRuns(), 1, "the routine's script did not run");
  assert.ok(await idle(h, bot));
  const runs = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id).runs;
  assert.equal(runs?.[0]?.state, "ok", `the routine's run did not go fine: ${JSON.stringify(runs?.[0])}`);

  // What 3.0.9 told it instead of nothing: "You have no computer". A
  // model reads that as "I cannot run anything", and the scripts stopped.
  assert.doesNotMatch(told!, /You have no computer/, "the agent was told it has no computer");
  assert.match(told!, /Bloks has not provided a screen to see or click/);
  assert.match(told!, /commands and files are not affected/, "the agent was not told its commands still run");
});

test("an agent on Automatic with no cloud box is told it has no screen, never that it cannot run commands", async (t) => {
  const w = workspace(t);
  const h = await w.start("win32");
  const bot = await agent(h, "Auto", null);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "AUTO-TURN: run build.ps1" }) });
  const told = await waitFor(() => toldWith(w.prompts(), "AUTO-TURN"));
  assert.ok(told, `the turn never reached OpenCode: ${h.logs().slice(-1500)}`);
  assert.doesNotMatch(told!, /You have no computer/);
  assert.match(told!, /commands and files are not affected/);
  // and still how to give it a screen, which is what GitHub 377 asked for
  assert.match(told!, /under Computer/);
  assert.match(told!, /Local VM/);
});

// 3.0.9's Settings on Windows: turning Automatic off chose the Local VM,
// and the Local VM is the first "Local" thing on the list. Picked by
// someone who only wanted the agent on this PC, with no container
// runtime set up, every turn then failed before the engine started.
test("a Local VM that is not set up gives the turn no screen and a notice, and the turn still runs", async (t) => {
  const w = workspace(t);
  const h = await w.start("win32");
  const bot = await agent(h, "Boxed", "sandbox");
  const made = await h.fetch("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: bot.id, targetKind: "agent", name: "Scripts", prompt: "VM-ROUTINE: run the scripts", every: 60 }),
  });
  const { routine } = await made.json();
  await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" });
  const told = await waitFor(() => toldWith(w.prompts(), "VM-ROUTINE"));
  assert.ok(told, `a Local VM that is not set up stopped the turn: ${h.logs().slice(-1500)}`);
  assert.equal(w.scriptRuns(), 1);
  assert.match(told!, /Local VM/);
  assert.match(told!, /bloks-test-container-runtime is installed but not running/, "the agent was not told why it has no screen");
  assert.match(told!, /commands and files are not affected/);
  assert.ok(await idle(h, bot));
  const runs = (await h.json("/api/routines")).routines.find((r: any) => r.id === routine.id).runs;
  assert.equal(runs?.[0]?.state, "ok", `the routine's run failed: ${JSON.stringify(runs?.[0])}`);
  const notices = (await messagesOf(h, bot)).filter((m) => m.kind === "notice").map((m) => String(m.text));
  assert.ok(
    notices.some((text) => /Local VM/.test(text) && /without a screen/.test(text)),
    `the person was not told the turn ran without its Local VM: ${JSON.stringify(notices)}`,
  );
});
