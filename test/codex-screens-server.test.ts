// GitHub 482, through the real server: a Codex agent with Its own browser
// on and a computer set is handed both, the harness gets the Local VM
// ready for it instead of telling it to move engines, switching either
// off takes it away on the next turn, and in a container or over SSH the
// helpers run on this computer and Codex there reaches them through the
// gate, as an MCP client would.
//
// No real Codex, container or host: a stand-in app-server writes down
// each thread config it is handed and, working elsewhere, opens an MCP
// session on each screen server's address with the headers it was given.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { fakePlaces } from "./helpers/fake-places.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

// never a real container runtime: a Local VM claimed says it is not there
const NO_RUNTIME = { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" };

/** A stand-in `codex app-server` at `cli`, writing one line to `log` per
 * turn: how its thread was opened, the config, and the words. With
 * `dial`, it opens an MCP session on each bloks_ server it was handed an
 * address for, and writes down which server answered. */
function fakeCodex(cli: string, log: string, dial = false) {
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let config = {}, method, thread;
const dialled = async () => {
  if (!${dial}) return {};
  const answered = {};
  for (const [key, table] of Object.entries(config)) {
    if (!key.startsWith("mcp_servers.bloks_") || !table.url) continue;
    // fakePlaces runs on this host, where Docker's built-in DNS is absent
    const url = table.url.replace("host.docker.internal", "127.0.0.1");
    try {
      const res = await fetch(url, { method: "POST", headers: { ...table.http_headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } } }) });
      const text = await res.text();
      answered[key.slice("mcp_servers.".length)] = (/"serverInfo":\\{"name":"([^"]+)"/.exec(text) || [])[1] || "status " + res.status;
    } catch (error) { answered[key.slice("mcp_servers.".length)] = String(error); }
  }
  return answered;
};
require("node:readline").createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Test", isDefault: true }] });
  if (m.method === "config/read") return reply({ config: {} });
  if (m.method === "thread/start" || m.method === "thread/resume") {
    config = m.params.config || {}; method = m.method; thread = m.params.threadId || "codex-thread";
    return reply({ thread: { id: thread }, model: "gpt-6.1-sol" });
  }
  if (m.method !== "turn/start") return reply();
  const answered = await dialled();
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, config, answered, told: m.params.input[0].text }) + "\\n");
  reply({ turn: { id: "turn" } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn", status: "completed" } } });
});
`,
    { mode: 0o755 },
  );
  return (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
}

/** The descriptor the desktop app writes for this Mac's computer-use
 * daemon, pointing at a stand-in that answers an MCP initialize. */
function standInCua(home: string) {
  const dir = join(home, "Library", "Application Support", "Bloks");
  mkdirSync(dir, { recursive: true });
  const daemon = join(home, "cua-stand-in.cjs");
  writeFileSync(
    daemon,
    `#!${process.execPath}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cua-stand-in", version: "1" } } }) + "\\n");
});
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "cua-connection.json"), JSON.stringify({ mcpCommand: daemon, mcpArgs: ["mcp"], mcpEnv: { CUA_SOCKET: "/tmp/cua-stand-in.sock" } }));
  return daemon;
}

async function codexAgent(h: Harness, patch: Record<string, unknown>) {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Shopper" }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, ...patch }) });
  assert.equal(set.status, 200, await set.clone().text());
  return (await set.json()).bot as { id: string; threadId: string };
}

function workspace(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-482-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  return home;
}

test("a Codex agent is handed its browser and this Mac's screen, and loses each once it is switched off", async (t) => {
  const home = workspace(t);
  const cli = join(home, "codex");
  const turns = fakeCodex(cli, join(home, "turns.jsonl"));
  const daemon = standInCua(home);
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli } } } }));
  const h = await startHarness({ HOME: home, BLOKS_TEST_PLATFORM: "darwin", ...NO_RUNTIME });
  t.after(() => h.stop());

  const instances = (await h.json("/api/instances")).instances;
  assert.deepEqual(instances.find((i: any) => i.instanceId === "codex").screens, { browser: true, computers: ["cloud", "vm", "mac"] });

  const bot = await codexAgent(h, { browser: true, computer: "local" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "compare two prices" }) });
  assert.ok(await waitFor(() => turns().length >= 1, 30_000), h.logs().slice(-2000));
  assert.ok(await idle(h, bot));
  const first = turns()[0];
  assert.equal(first.method, "thread/start");
  const browser = first.config["mcp_servers.bloks_browser"];
  assert.ok(browser, JSON.stringify(first.config));
  assert.equal(browser.env.BLOKS_BROWSER_PROFILE, join(home, ".bloks", "browser", bot.id), "not the agent's own profile");
  assert.deepEqual(first.config["mcp_servers.bloks_computer"], {
    command: daemon, args: ["mcp"], env: { CUA_SOCKET: "/tmp/cua-stand-in.sock" },
    default_tools_approval_mode: "approve", startup_timeout_sec: 30, tool_timeout_sec: 300,
  }, "the daemon's contract was not passed as given");
  // told of the tools it has, not sent to another engine
  assert.match(first.told, /computer tools work this person's own computer/);
  assert.doesNotMatch(first.told, /cannot be handed|such as Claude Code/);

  const off = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ browser: false, computer: "off" }) });
  assert.equal(off.status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "and now?" }) });
  assert.ok(await waitFor(() => turns().length >= 2, 30_000), h.logs().slice(-2000));
  assert.ok(await idle(h, bot));
  const second = turns()[1];
  assert.equal(second.method, "thread/resume");
  assert.deepEqual(Object.keys(second.config).filter((key) => key.startsWith("mcp_servers.bloks_")), [], "a screen switched off was still mounted");
  assert.doesNotMatch(second.told, /computer tools work this person's own computer/);
});

test("a Codex agent set to the Local VM has the VM got ready for it, not a word about another engine", async (t) => {
  const home = workspace(t);
  const cli = join(home, "codex");
  const turns = fakeCodex(cli, join(home, "turns.jsonl"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli } } } }));
  const h = await startHarness({ HOME: home, BLOKS_TEST_PLATFORM: "darwin", ...NO_RUNTIME });
  t.after(() => h.stop());

  const bot = await codexAgent(h, { computer: "sandbox" });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "open the site" }) });
  assert.ok(await waitFor(() => turns().length >= 1, 30_000), h.logs().slice(-2000));
  assert.ok(await idle(h, bot));
  const told = turns()[0].told;
  assert.doesNotMatch(told, /cannot be handed/);
  // The lease was taken and the VM asked for; with no runtime here it is
  // not there, which is said, the lease given back, and the turn runs on.
  const notices = (await messagesOf(h, bot)).filter((m) => m.kind === "notice").map((m) => String(m.text));
  assert.ok(notices.some((text) => /runs this turn without a screen: the Local VM is not there/.test(text)), JSON.stringify(notices));
  assert.equal((await h.json("/api/local-vm")).inUseBy, null);
});

for (const kind of ["docker", "ssh"] as const) {
  test(`working in ${kind === "ssh" ? "an SSH host" : "a container"}, Codex reaches its browser and computer through the gate`, async (t) => {
    const root = workspace(t);
    const fake = fakePlaces(root, join(root, "unused.json"));
    const cli = join(fake.there, "codex");
    const turns = fakeCodex(cli, join(root, "turns.jsonl"), true);
    const daemon = standInCua(root);
    writeFileSync(join(root, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli } } } }));
    const h = await startHarness({ HOME: root, BLOKS_TEST_PLATFORM: "darwin", ...NO_RUNTIME, ...fake.env });
    t.after(() => h.stop());
    const project = join(root, "project");
    mkdirSync(project);
    const bot = await codexAgent(h, { cwd: project, browser: true, computer: "local" });
    const workplace = kind === "ssh"
      ? { kind: "ssh", host: "test-box", path: project, command: cli }
      : { kind: "docker", source: "image", image: "node:22-bookworm", name: "test-codex", folder: "mount", path: project, network: true, command: cli };
    const saved = await h.fetch(`/api/bots/${bot.id}/workplace`, { method: "PUT", body: JSON.stringify({ workplace }) });
    assert.equal(saved.status, 200, await saved.clone().text());

    for (let i = 0; i < 2; i++) {
      await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "look at the page" }) });
      assert.ok(await waitFor(() => turns().length > i, 30_000), h.logs().slice(-2000));
      assert.ok(await idle(h, bot));
      const turn = turns()[i];
      assert.equal(turn.method, i === 0 ? "thread/start" : "thread/resume");
      for (const name of ["bloks_browser", "bloks_computer"]) {
        const table = turn.config[`mcp_servers.${name}`];
        assert.ok(table, `${name} was not handed over: ${JSON.stringify(Object.keys(turn.config))}`);
        assert.match(table.url, /\/mcp\/bloks_(browser|computer)-\d+$/);
        // an address and the gate's token, never a program of this computer's to run there
        assert.equal("command" in table, false);
        assert.equal("env" in table, false);
      }
      // each one answered, run on this computer behind the gate
      assert.deepEqual(turn.answered, { bloks_browser: "bloks-browser", bloks_computer: "cua-stand-in" });
    }
    const argv = [...fake.dockerCalls(), ...fake.sshCalls()].flat().join("\n");
    assert.ok(!argv.includes(daemon), "this Mac's daemon was started there");
    assert.doesNotMatch(argv, /browser-proxy|blk_|blg_/);
  });
}
