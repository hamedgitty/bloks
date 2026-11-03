// GitHub 472: an agent on an ACP engine (Devin, OpenCode and the rest)
// with Its own browser on got no browser tools, and none for a computer
// either, and nothing said so. Worse, set to the Local VM it still
// claimed the VM, and its system words promised a desktop and computer
// tools it did not have.
//
// These boot the real server with stand-ins for OpenCode, which takes MCP
// servers from Bloks, and Pi, which does not (pi-acp keeps them unused),
// each writing down the session it was opened with and what it was told.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

// never a real container runtime: a Local VM claimed would say it is not there
const NO_RUNTIME = { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" };

/** A home with one stand-in ACP agent, run as both engines. Every request
 * it is sent is written down with the process it came to. */
function workspace(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-472-"));
  const log = join(home, "acp.jsonl");
  const cli = join(home, "fake-acp.cjs");
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
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, method: msg.method, params: msg.params }) + "\\n");
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s" + process.pid });
  if (msg.method !== "session/prompt") return reply({});
  say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: msg.params.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } });
  reply({ stopReason: "end_turn" });
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { opencode: { driver: "opencode", config: { cli } }, pi: { driver: "pi", config: { cli } } } }),
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const frames = (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    home,
    /** What the turn that said `marker` was told, and the servers its
     * session was opened with. */
    turn(marker: string) {
      const all = frames();
      const prompt = all.find((f) => f.method === "session/prompt" && JSON.stringify(f.params.prompt).includes(marker));
      if (!prompt) return null;
      const opened = all.find((f) => f.pid === prompt.pid && f.method === "session/new");
      return { told: prompt.params.prompt.map((p: any) => p.text ?? "").join(""), servers: (opened?.params?.mcpServers ?? []) as any[] };
    },
  };
}

async function agent(h: Harness, name: string, patch: Record<string, unknown>) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(patch) });
  const body = await set.text();
  assert.equal(set.status, 200, `setting ${name} up was refused: ${body}`);
  return JSON.parse(body).bot;
}

test("an OpenCode agent is handed its browser and this Mac's screen as MCP servers", async (t) => {
  const w = workspace(t);
  // the descriptor the desktop app writes for this Mac's computer-use
  // daemon; the stand-in never starts it, only says what it was given
  const cua = join(w.home, "Library", "Application Support", "Bloks");
  mkdirSync(cua, { recursive: true });
  writeFileSync(join(cua, "cua-connection.json"), JSON.stringify({ mcpCommand: "/opt/stand-in/cua-driver", mcpArgs: ["mcp"], mcpEnv: { CUA_SOCKET: "/tmp/cua.sock" } }));
  const h = await startHarness({ HOME: w.home, BLOKS_TEST_PLATFORM: "darwin", ...NO_RUNTIME });
  t.after(() => h.stop());

  const instances = (await h.json("/api/instances")).instances;
  assert.deepEqual(instances.find((i: any) => i.instanceId === "opencode").screens, { browser: true, computers: ["cloud", "vm", "mac"] });
  assert.deepEqual(instances.find((i: any) => i.instanceId === "pi").screens, { browser: false, computers: [] });

  const bot = await agent(h, "Shopper", { modelSelection: { instanceId: "opencode", model: "auto" }, browser: true, computer: "local" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "OPENCODE-TURN: compare two prices" }) });
  const turn = await waitFor(() => w.turn("OPENCODE-TURN"));
  assert.ok(turn, `the turn never reached the agent: ${h.logs().slice(-1500)}`);

  const browser = turn!.servers.find((s) => s.name === "bloks_browser");
  assert.ok(browser, `no browser in session/new: ${JSON.stringify(turn!.servers)}`);
  assert.equal(browser.command, process.execPath);
  assert.match(browser.args[0], /browser-proxy\.(ts|js)$/);
  const profile = browser.env.find((e: any) => e.name === "BLOKS_BROWSER_PROFILE")?.value;
  assert.equal(profile, join(w.home, ".bloks", "browser", bot.id), "not the agent's own profile");

  const computer = turn!.servers.find((s) => s.name === "bloks_computer");
  assert.deepEqual(computer, { name: "bloks_computer", command: "/opt/stand-in/cua-driver", args: ["mcp"], env: [{ name: "CUA_SOCKET", value: "/tmp/cua.sock" }] }, "the daemon's contract was not passed as given");

  assert.match(turn!.told, /computer tools work this person's own computer/);
  assert.doesNotMatch(turn!.told, /cannot be handed/);
  assert.ok(await idle(h, bot));
});

test("a Pi agent set to the Local VM with Its own browser on is told it has neither, and the VM is never claimed", async (t) => {
  const w = workspace(t);
  const h = await startHarness({ HOME: w.home, BLOKS_TEST_PLATFORM: "darwin", ...NO_RUNTIME });
  t.after(() => h.stop());
  const bot = await agent(h, "Pi agent", { modelSelection: { instanceId: "pi", model: "auto" }, browser: true, computer: "sandbox" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "PI-TURN: open the site" }) });
  const turn = await waitFor(() => w.turn("PI-TURN"));
  assert.ok(turn, `the turn never reached the agent: ${h.logs().slice(-1500)}`);
  assert.ok(await idle(h, bot));

  assert.deepEqual(turn!.servers.filter((s) => String(s.name).startsWith("bloks_")), [], "servers it would drop were sent anyway");
  // the promise 3.2.2 made, of a desktop it never had
  assert.doesNotMatch(turn!.told, /Linux desktop in a private VM/);
  assert.doesNotMatch(turn!.told, /Reach for the computer tools/);
  assert.match(turn!.told, /set to use the Local VM, but Pi, the engine you run on, cannot be handed it/);
  assert.match(turn!.told, /no browser tools from Bloks/);
  assert.match(turn!.told, /commands and files are not affected/);

  // A claimed VM with no runtime behind it says so in the chat; never
  // claimed, nothing is said, and nothing holds the VM.
  const notices = (await messagesOf(h, bot)).filter((m) => m.kind === "notice").map((m) => String(m.text));
  assert.ok(!notices.some((text) => /Local VM/.test(text)), `the VM was tried for an engine that cannot use it: ${JSON.stringify(notices)}`);
  assert.equal((await h.json("/api/local-vm")).inUseBy, null);
});
