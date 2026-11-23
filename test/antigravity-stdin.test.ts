// End-to-end harness coverage for Antigravity over ACP:
// - persona and message travel over JSON-RPC stdin, never in argv
// - approval modes map to --dangerously-skip-permissions only on full access
// - stdio MCP servers (including Composio bloks_connectors) reach session/new
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";

const PERSONA = "persona_canary_5e1d";
const MESSAGE = "message_canary_83b0";

async function turnOn(
  t: TestContext,
  options: { approvals?: "ask" | "edits" | "auto" | "full"; composioKey?: string } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "bloks-agy-acp-e2e-"));
  const seen = join(home, "seen.json");
  const cli = join(home, "fake-agy.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.5.14"); process.exit(0); }
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const record = { args, requests: [] };
let model = "gemini-3.1-pro";
let mode = "default";
let thought = "high";
const configOptions = () => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "gemini-3.1-pro", name: "Gemini 3.1 Pro" }] },
  { id: "mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: thought, options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "xhigh", name: "XHigh" }] },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || !msg.method) return;
  record.requests.push({ method: msg.method, params: msg.params });
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
  } else if (msg.method === "session/new") {
    reply({ sessionId: "sess-1", configOptions: configOptions() });
  } else if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "model") model = msg.params.value;
    if (msg.params.configId === "mode") mode = msg.params.value;
    if (msg.params.configId === "thought_level") thought = msg.params.value;
    reply({ configOptions: configOptions() });
  } else if (msg.method === "session/prompt") {
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify(record));
    say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } } } });
    reply({ stopReason: "end_turn" });
  } else {
    reply({});
  }
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: { agy: { driver: "antigravity", config: { cli } } },
      profile: { about: PERSONA },
      ...(options.composioKey ? { composio: { key: options.composioKey } } : {}),
    }),
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
      modelSelection: { instanceId: "agy", model: "gemini-3.1-pro" },
      ...(options.approvals ? { approvals: options.approvals } : {}),
    }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: MESSAGE }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), `the turn never ran: ${h.logs().slice(-800)}`);
  const said = async () => ((await h.json(`/api/bots/${bot.id}/messages?limit=50`)).messages as any[]).some((m) => m.role === "bot" && m.text === "Done.");
  for (let i = 0; i < 200 && !(await said()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await said(), "the turn's answer never reached the chat");
  return JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; requests: Array<{ method: string; params: any }> };
}

test("Antigravity runs over ACP with persona and message on stdin, never in argv, and mounts Composio", async (t) => {
  const { args, requests } = await turnOn(t, { composioKey: "composio-test-key" });
  for (const secret of [PERSONA, MESSAGE]) {
    assert.ok(!args.some((arg) => arg.includes(secret)), `${secret} is in argv`);
  }
  assert.deepEqual(args, ["acp"]);
  const opened = requests.find((r) => r.method === "session/new");
  assert.ok(opened, "session/new was not called");
  const connectors = (opened.params.mcpServers ?? []).find((s: any) => s.name === "bloks_connectors");
  assert.ok(connectors, "bloks_connectors stdio MCP server was not mounted");
  assert.equal(connectors.command, process.execPath);
  const prompt = requests.find((r) => r.method === "session/prompt");
  const text = String(prompt?.params?.prompt?.[0]?.text ?? "");
  assert.ok(text.includes(PERSONA), "persona did not arrive in session/prompt");
  assert.ok(text.endsWith(MESSAGE), "message did not arrive in session/prompt");
});

test("Antigravity passes --dangerously-skip-permissions only for full access, and selects default mode otherwise", async (t) => {
  const full = await turnOn(t, { approvals: "full" });
  assert.deepEqual(full.args, ["acp", "--dangerously-skip-permissions"]);
  assert.equal(
    full.requests.some((r) => r.method === "session/set_config_option" && r.params?.configId === "mode"),
    false,
    "full access should not override mode back to default",
  );

  for (const approvals of ["ask", "edits", "auto"] as const) {
    const run = await turnOn(t, { approvals });
    assert.deepEqual(run.args, ["acp"], `${approvals} should not skip permissions`);
    assert.ok(
      run.requests.some((r) => r.method === "session/set_config_option" && r.params?.configId === "mode" && r.params?.value === "default"),
      `${approvals} should enforce default mode`,
    );
  }
});
