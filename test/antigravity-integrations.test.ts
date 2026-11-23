// An Antigravity agent's connected apps and MCP servers (GitHub 546). Print
// mode takes no MCP servers of the turn's own, so a turn that carries them
// runs over `agy acp`, which takes them in session/new. They arrive there
// as the harness granted them, their keys over stdin and never in argv,
// agy's environment or the native copy, and an agent without the grant
// stays in print mode with none of them.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AGY_ACP, agyIntegrations } from "../server/drivers/antigravity.ts";
import { startHarness } from "./helpers/server.ts";

const COMPOSIO_KEY = "ck_composio_canary_4f1e9a";
const ENV_SECRET = "env_secret_canary_7b2d51";
const HEADER_SECRET = "header_secret_canary_c83e07";
const SECRETS = [COMPOSIO_KEY, ENV_SECRET, HEADER_SECRET];

const SERVERS = [
  { id: "notes", name: "Notes", transport: "stdio", command: process.execPath, args: ["-e", "1"], env: { NOTES_TOKEN: ENV_SECRET, NOT_YET: "" } },
  { id: "tracker", name: "Tracker", transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: `Bearer ${HEADER_SECRET}` } },
];

interface Seen {
  mode: "print" | "acp";
  args: string[];
  env: Record<string, string>;
  requests: Array<{ method: string; params: any }>;
}

/** Every file under a folder, as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? allText(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

async function turnOn(t: TestContext, grant: { composio: boolean; mcp: string[] }, approvals?: "ask" | "full", http = true) {
  const home = mkdtempSync(join(tmpdir(), "bloks-agy-integrations-"));
  const seen = join(home, "seen.json");
  const cli = join(home, "fake-agy.mjs");
  // a stand-in for agy: print mode answers the way its stream-json does,
  // and `agy acp` the way an ACP agent does, each writing down how it was
  // started, what of its environment matters here, and what it was asked
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.5.14"); process.exit(0); }
if (args[0] === "models") process.exit(0);
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string" && ${JSON.stringify(SECRETS)}.some((secret) => value.includes(secret))));
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
if (args[0] === "acp") {
  const requests = [];
  createInterface({ input: process.stdin }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || !msg.method) return;
    requests.push({ method: msg.method, params: msg.params });
    const reply = (result) => out({ jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: ${http} } } });
    else if (msg.method === "session/new") reply({ sessionId: "agy-s1", modes: { currentModeId: "auto", availableModes: [{ id: "default" }, { id: "accept-edits" }, { id: "plan" }, { id: "auto" }] } });
    else if (msg.method === "session/prompt") {
      writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ mode: "acp", args, env, requests }));
      out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "agy-s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } });
      reply({ stopReason: "end_turn" });
    } else reply({});
  });
} else {
  process.stdin.resume();
  process.stdin.on("end", () => {
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ mode: "print", args, env, requests: [] }));
    out({ event: "init", conversation_id: "conv-1", init: {} });
    out({ event: "result", conversation_id: "conv-1", result: { status: "SUCCESS", response: "Done." } });
  });
}
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { agy: { driver: "antigravity", config: { cli } } }, composio: { key: COMPOSIO_KEY }, mcpServers: SERVERS }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Gemma" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      modelSelection: { instanceId: "agy", model: "gemini-3.1-pro-high" },
      composio: grant.composio,
      mcpServers: grant.mcp,
      ...(approvals ? { approvals } : {}),
    }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "use the tracker" }) });
  if (!http) {
    // the turn is refused before anything is sent, and the chat says why
    const told = async () => ((await h.json(`/api/bots/${bot.id}/messages?limit=50`)).messages as any[]).find((m) => /Tracker/.test(String(m.text ?? "")));
    for (let i = 0; i < 200 && !(await told()); i++) await new Promise((r) => setTimeout(r, 50));
    return { told: (await told())?.text as string | undefined, ran: existsSync(seen) };
  }
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), `the turn never ran: ${h.logs().slice(-800)}`);
  const said = async () => ((await h.json(`/api/bots/${bot.id}/messages?limit=50`)).messages as any[]).some((m) => m.role === "bot" && m.text === "Done.");
  for (let i = 0; i < 200 && !(await said()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await said(), "the turn's answer never reached the chat");
  const result = JSON.parse(readFileSync(seen, "utf8")) as Seen;
  return { ...result, native: allText(join(home, ".bloks", "native")), logs: h.logs() };
}

/** A turn that answers, as the tests below expect of it. */
async function answered(t: TestContext, grant: { composio: boolean; mcp: string[] }, approvals?: "ask" | "full") {
  const seen = await turnOn(t, grant, approvals);
  assert.ok("mode" in seen);
  return seen;
}

test("a granted agent's connected apps and MCP servers reach agy acp's session/new", async (t) => {
  const seen = await answered(t, { composio: true, mcp: ["notes", "tracker"] });
  assert.equal(seen.mode, "acp", "the turn stayed in print mode, which takes no servers of its own");
  assert.deepEqual(seen.args, ["acp"]);
  const opened = seen.requests.find((r) => r.method === "session/new");
  assert.ok(opened, "no session was opened");
  const servers = opened.params.mcpServers as any[];
  const byName = Object.fromEntries(servers.map((server) => [server.name, server]));
  assert.deepEqual(Object.keys(byName).sort(), ["Notes", "Tracker", "bloks_connectors"]);

  // the connectors bridge, a stdio server run by this computer's node
  const bridge = byName.bloks_connectors;
  assert.equal(bridge.command, process.execPath);
  assert.ok(bridge.env.some((e: any) => e.name === "BLOKS_COMPOSIO_KEY" && e.value === COMPOSIO_KEY), "the connectors bridge has no key");

  // a stdio server with its own environment, a name still waiting left out
  assert.equal(byName.Notes.command, process.execPath);
  assert.deepEqual(byName.Notes.args, ["-e", "1"]);
  assert.deepEqual(byName.Notes.env, [{ name: "NOTES_TOKEN", value: ENV_SECRET }]);

  // an HTTP server with its headers
  assert.equal(byName.Tracker.type, "http");
  assert.equal(byName.Tracker.url, "https://mcp.example.test/mcp");
  assert.deepEqual(byName.Tracker.headers, [{ name: "Authorization", value: `Bearer ${HEADER_SECRET}` }]);

  // agy's saved default may be its Auto mode; an agent that asks is asked
  const mode = seen.requests.find((r) => r.method === "session/set_mode");
  assert.equal(mode?.params.modeId, "default");
});

test("no key, header or server environment is in agy's argv, its environment, the native copy or the logs", async (t) => {
  const seen = await answered(t, { composio: true, mcp: ["notes", "tracker"] });
  assert.equal(seen.mode, "acp");
  for (const secret of SECRETS) {
    assert.ok(!seen.args.some((arg) => arg.includes(secret)), `${secret} is in argv`);
    assert.ok(!seen.native.includes(secret), `${secret} is in the native copy`);
    assert.ok(!seen.logs.includes(secret), `${secret} is in the logs`);
  }
  assert.deepEqual(seen.env, {}, "a secret is in agy's own environment, where its commands would inherit it");
  assert.ok(seen.native.includes("session/new"), "the native copy was not written at all");
});

test("an agent without the grant gets none of them, and stays in print mode", async (t) => {
  const seen = await answered(t, { composio: false, mcp: [] });
  assert.equal(seen.mode, "print");
  for (const secret of SECRETS) assert.ok(!seen.args.some((arg) => arg.includes(secret)), `${secret} is in argv`);
  assert.deepEqual(seen.env, {});
  assert.ok(!seen.args.includes("acp"));
});

test("only the servers granted to the agent go, without its connected apps when those are off", async (t) => {
  const seen = await answered(t, { composio: false, mcp: ["tracker"] });
  assert.equal(seen.mode, "acp");
  const opened = seen.requests.find((r) => r.method === "session/new");
  assert.deepEqual((opened!.params.mcpServers as any[]).map((server) => server.name), ["Tracker"]);
  assert.ok(!JSON.stringify(seen.requests).includes(COMPOSIO_KEY), "the Composio key reached agy anyway");
  assert.ok(!JSON.stringify(seen.requests).includes(ENV_SECRET), "a server it was not granted reached agy");
});

test("full access is agy's own flag over ACP, as in print mode", async (t) => {
  const seen = await answered(t, { composio: false, mcp: ["tracker"] }, "full");
  assert.equal(seen.mode, "acp");
  assert.deepEqual(seen.args, ["acp", "--dangerously-skip-permissions"]);
});

test("agy is handed the connected apps and MCP servers, and none of the screens", () => {
  assert.equal(agyIntegrations({}), null);
  assert.equal(agyIntegrations({ integrations: { mcpServers: [] } }), null);
  assert.equal(agyIntegrations({ integrations: { browser: { profileDir: "/x" }, computer: { boxId: "b", token: "t" } } }), null);
  const mcpServers = [{ name: "Tracker", transport: "http" as const, url: "https://mcp.example.test/mcp" }];
  assert.deepEqual(
    agyIntegrations({ integrations: { composio: { key: "k" }, mcpServers, browser: { profileDir: "/x" }, sandbox: { runtime: "docker", name: "s" } } }),
    { composio: { key: "k" }, mcpServers },
  );
  // a turn the owner did not vouch for asks, however the engine is set
  assert.deepEqual(AGY_ACP.turnArgs!({ fullAuto: false, fullAccess: false }), []);
  assert.deepEqual(AGY_ACP.turnArgs!({ fullAuto: true }), ["--dangerously-skip-permissions"]);
});

test("an HTTP server agy cannot take is said plainly, and the message is not sent", async (t) => {
  const seen = await turnOn(t, { composio: false, mcp: ["tracker"] }, undefined, false);
  assert.ok(!("mode" in seen));
  assert.ok(!seen.ran, "the prompt went to agy without its server");
  assert.match(seen.told ?? "", /Antigravity does not support the selected HTTP MCP app Tracker, so the message was not sent/);
});
