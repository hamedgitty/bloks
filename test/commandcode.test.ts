import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runsAProcess } from "../server/agent-cli.ts";
import { instanceConfigs } from "../server/config.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { ENGINE_SETUP } from "../server/engine-setup.ts";
import { ENGINE_PACKAGES } from "../server/engine-updates.ts";
import { CLI_PROVIDERS } from "../server/providers.ts";
import { engineName, engineResults } from "../server/run-export.ts";
import { shippedEnv, signInThereCommand } from "../server/workplace.ts";

test("Command Code is available as a built-in CLI engine, including existing workspaces", () => {
  const spec = ACP_SPECS.find((entry) => entry.kind === "commandcode");
  assert.ok(spec);
  assert.equal(spec.command, "command-code", "cmd is the Windows shell, not this engine");
  assert.deepEqual(spec.args, ["acp"]);
  assert.deepEqual(spec.keyEnv, ["COMMAND_CODE_API_KEY"]);
  assert.ok(CLI_PROVIDERS.some((entry) => entry.kind === spec.kind));
  assert.ok(BUILT_IN_DRIVERS.some((entry) => entry.driverKind === spec.kind));
  for (const cfg of [{}, { instances: { claude: { driver: "claudeAgent" } } }]) {
    assert.ok(Object.values(instanceConfigs(cfg)).some((entry) => entry.driver === spec.kind));
  }
  assert.equal(runsAProcess(spec.kind), true);
  assert.match(ENGINE_SETUP.commandcode?.install ?? "", /command-code/);
  assert.equal(ENGINE_SETUP.commandcode?.signIn, "command-code login");
  assert.equal(ENGINE_PACKAGES.commandcode?.pkg, "command-code");
  assert.equal(ENGINE_PACKAGES.commandcode?.cli, "command-code");
  assert.equal(engineName(spec.kind), "Command Code");
  assert.equal(engineResults(spec.kind), "partial");
});

test("Command Code signs in on its remote machine without shipping this machine's key", () => {
  assert.match(signInThereCommand({ kind: "ssh", host: "vm", path: "~" }, "commandcode", "command-code") ?? "", /command-code login/);
  assert.deepEqual(shippedEnv({ COMMAND_CODE_API_KEY: "local-key", BLOKS_TOKEN: "agent-token" }, {}, {}), { BLOKS_TOKEN: "agent-token" });
});

test("adding Command Code preserves saved instances that already use its name", () => {
  const saved = { driver: "codex", displayName: "My engine", config: { cli: "/custom/codex" } };
  const instances = instanceConfigs({ instances: { commandcode: saved, commandcode_2: { driver: "pi" } } });
  assert.deepEqual(instances.commandcode, { ...saved, environment: {} });
  assert.equal(instances.commandcode_2.driver, "pi");
  assert.equal(instances.commandcode_3.driver, "commandcode");
});

async function commandTurn(options: {
  fullAuto?: boolean;
  untrusted?: boolean;
  fullAccess?: boolean;
  shared?: boolean;
  resume?: boolean;
  refuseMode?: boolean;
  missingMode?: boolean;
  model?: string;
}) {
  const source = ACP_SPECS.find((entry) => entry.kind === "commandcode");
  assert.ok(source, "Command Code must be registered before it can run");
  const dir = mkdtempSync(join(tmpdir(), "bloks-commandcode-"));
  const log = join(dir, "requests.ndjson");
  const cli = join(dir, "agent.cjs");
  writeFileSync(cli, `
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const options = ${JSON.stringify(options)};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const session = { sessionId: "s1", models: { currentModelId: "flash", availableModels: [{ modelId: "flash", name: "Flash" }, { modelId: "pro", name: "Pro" }] }, modes: { currentModeId: "bypass", availableModes: options.missingMode ? [{ id: "bypass" }] : [{ id: "default" }, { id: "bypass" }] } };
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(log, JSON.stringify(msg) + "\\n");
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (msg.method === "session/new" || msg.method === "session/load") reply(msg.id, session);
  else if (msg.method === "session/set_mode" && options.refuseMode) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Mode refused" } }) + "\\n");
  else if (msg.method === "session/prompt") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } } }) + "\\n");
    reply(msg.id, { stopReason: "end_turn" });
  } else reply(msg.id, {});
});
`);
  // Node launches the fixture on Windows too; no shell or real model is involved.
  const spec = { ...source, command: process.execPath, args: [cli], probeModels: false };
  const instance = await acpDriver(spec).create({ instanceId: "commandcode", displayName: "Command Code", enabled: true, environment: {}, config: { cli: process.execPath, fullAuto: options.fullAuto === true } });
  const events: any[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  try {
    await instance.adapter.sendTurn({
      threadId: "thread", text: "hello", cwd: dir,
      ...(options.resume ? { resumeCursor: "s1" } : {}),
      model: options.model,
      untrusted: options.untrusted,
      fullAccess: options.fullAccess,
      shared: options.shared ? { tools: "conversation" } : undefined,
    });
    for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === "turn.completed"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(events.some((event) => event.type === "turn.completed"), "the turn must settle");
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { requests, events };
  } finally {
    await instance.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("Command Code restores ordinary approvals before both fresh and resumed turns", async () => {
  for (const resume of [false, true]) {
    const { requests, events } = await commandTurn({ resume, model: "pro" });
    const mode = requests.findIndex((request) => request.method === "session/set_mode");
    const prompt = requests.findIndex((request) => request.method === "session/prompt");
    assert.equal(requests[mode]?.params.modeId, "default");
    assert.ok(mode >= 0 && prompt > mode, "the approval mode must be restored before sending the prompt");
    assert.ok(requests.some((request) => request.method === (resume ? "session/load" : "session/new")));
    assert.equal(requests.find((request) => request.method === "session/set_model")?.params.modelId, "pro");
    assert.equal(events.find((event) => event.type === "turn.completed")?.ok, true);
  }
});

test("Command Code selects bypass only for an authorized full-auto or full-access turn", async () => {
  for (const options of [{ fullAuto: true }, { fullAccess: true }]) {
    const { requests } = await commandTurn(options);
    assert.equal(requests.find((request) => request.method === "session/set_mode")?.params.modeId, "bypass");
  }
  for (const options of [{ fullAuto: true, untrusted: true }, { fullAccess: true, shared: true }]) {
    const { requests } = await commandTurn(options);
    assert.equal(requests.find((request) => request.method === "session/set_mode")?.params.modeId, "default");
  }
});

test("Command Code sends no prompt when the required approval mode is missing or refused", async () => {
  for (const options of [{ missingMode: true }, { refuseMode: true }]) {
    const { requests, events } = await commandTurn(options);
    assert.ok(!requests.some((request) => request.method === "session/prompt"));
    assert.equal(events.find((event) => event.type === "turn.completed")?.ok, false);
    assert.match(events.find((event) => event.type === "runtime.error")?.message ?? "", /permission|approval|mode/i);
  }
});
