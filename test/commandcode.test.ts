import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runsAProcess } from "../server/agent-cli.ts";
import { instanceConfigs, NATIVE_DIR } from "../server/config.ts";
import type { SendTurnInput } from "../server/contracts.ts";
import type { Effort } from "../server/effort.ts";
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
  config?: boolean;
  effort?: Effort;
  resumeModel?: string;
  resumeEffort?: string;
  defaultEffort?: string;
  probeModels?: boolean;
  failConfig?: string;
  ignoreConfig?: string;
  notifyOnly?: boolean;
  missingConfig?: boolean;
  handoff?: string;
  question?: boolean;
  answer?: string;
  cancelQuestion?: boolean;
  integrations?: SendTurnInput["integrations"];
  remote?: boolean;
  noHttp?: boolean;
  providerKey?: string;
  env?: Record<string, string>;
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
let model = "flash", effort = options.defaultEffort ?? "default", mode = "bypass", sessionId = "s1", opened = 0, pending;
const levels = () => model === "flash" ? ["off", "high", "max"] : model === "fixed" ? [] : ["low", "medium", "high", "xhigh", "max"];
const config = () => [
  {id:"model",category:"model",type:"select",currentValue:model,options:[{value:"flash",name:"Flash"},{value:"pro",name:"GLM 5.3 Max"},{value:"fixed",name:"Fixed"}]},
  ...(levels().length ? [{id:"effort",category:"thought_level",type:"select",currentValue:effort,options:[...(effort === "default" ? ["default"] : []),...levels()].map(value=>({value,name:value}))}] : [])
];
const session = () => ({ sessionId, models: { currentModelId: model, availableModels: [{ modelId: "flash", name: "Flash" }, { modelId: "pro", name: "GLM 5.3 Max" }, { modelId:"fixed",name:"Fixed" }] }, modes: { currentModeId: mode, availableModes: options.missingMode ? [{ id: "bypass" }] : [{ id: "default" }, { id: "bypass" }] }, ...(options.config ? {configOptions:config()} : {}) });
const complete = (id) => {
  fs.appendFileSync(log,JSON.stringify({method:"observed",params:{model,effort}})+"\\n");
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ANSWER" } } } }) + "\\n");
  reply(id, { stopReason: "end_turn" });
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "question" && !msg.method) { fs.appendFileSync(log,JSON.stringify({method:"answer",params:msg.result})+"\\n"); complete(pending); return; }
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(log, JSON.stringify(msg) + "\\n");
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities:{http:!options.noHttp} }, ...(options.providerKey ? {fixtureKey:process.env.COMMAND_CODE_API_KEY} : {}), ...(options.env ? {fixtureToken:process.env.BLOKS_TOKEN} : {}) });
  else if (msg.method === "session/new" || msg.method === "session/load") {
    if(msg.method === "session/load") { opened=1; model=options.resumeModel ?? model; effort=options.resumeEffort ?? effort; }
    else { sessionId="s"+(++opened); model="flash"; effort=options.defaultEffort ?? "default"; }
    const state=session(); if(options.missingConfig && msg.method === "session/load") { delete state.configOptions; delete state.models; }
    reply(msg.id,state);
  }
  else if (msg.method === "session/set_mode" && options.refuseMode) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Mode refused" } }) + "\\n");
  else if (msg.method === "session/set_mode") { mode=msg.params.modeId; reply(msg.id,{}); }
  else if (msg.method === "session/set_model") { model=msg.params.modelId; reply(msg.id,{}); }
  else if (msg.method === "session/set_config_option") {
    const {configId,value}=msg.params;
    if(configId===options.failConfig || configId==="effort" && ![...(effort==="default" ? ["default"] : []),...levels()].includes(value)) {
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,error:{code:-32602,message:"Setting refused"}})+"\\n"); return;
    }
    if(configId!==options.ignoreConfig) {
      if(configId==="model") { if(model!==value) effort="default"; model=value; }
      if(configId==="effort") effort=value;
    }
    if(options.notifyOnly) process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"config_option_update",configOptions:config()}}})+"\\n");
    reply(msg.id,options.notifyOnly ? {} : {configOptions:config()});
  }
  else if (msg.method === "session/prompt") {
    if(options.question) {
      pending=msg.id;
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"question",method:"session/request_permission",params:{sessionId,toolCall:{kind:"other",title:"Language: Which language?",rawInput:{question:"Which language?",options:["Rust","TypeScript"]}},options:[{optionId:"option_0",kind:"allow_once",name:"Rust: native code"},{optionId:"option_1",kind:"allow_once",name:"TypeScript: web code"}]}})+"\\n");
    } else complete(msg.id);
  } else reply(msg.id, {});
});
`);
  // Node launches the fixture on Windows too; no shell or real model is involved.
  const spec = { ...source, command: process.execPath, args: [cli], probeModels: options.probeModels === true };
  mkdirSync(NATIVE_DIR, { recursive: true });
  const instance = await acpDriver(spec).create({ instanceId: "commandcode", displayName: "Command Code", enabled: true, environment: options.providerKey ? { COMMAND_CODE_API_KEY: options.providerKey } : {}, config: { cli: process.execPath, fullAuto: options.fullAuto === true } });
  await instance.catalogReady;
  const catalog = structuredClone(instance.models);
  const events: any[] = [];
  instance.adapter.onEvent((event) => {
    events.push(event);
    if (event.type === "request.opened" && options.question) void instance.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: options.cancelQuestion ? "deny" : "answer", message: options.answer ?? "TypeScript" });
  });
  const bridges: Array<{ name: string; server: unknown }> = [];
  try {
    await instance.adapter.sendTurn({
      threadId: "thread", text: "hello", cwd: dir,
      ...(options.resume ? { resumeCursor: "s1" } : {}),
      model: options.model,
      effort: options.effort,
      handoff: options.handoff,
      integrations: options.integrations,
      env: options.env,
      ...(options.remote ? { place: { label: "test host", cwd: dir, spawn: (command: string, args: string[], input?: { env?: Record<string, string | undefined> }) => spawn(command, args, { cwd: dir, env: input?.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true }), file: () => { throw Error("No file expected"); }, mcp: (name: string, server: unknown) => { bridges.push({ name, server }); return { url: "http://127.0.0.1:9/" + name, headers: { Authorization: "Bearer gate-token-" + name } }; } } } : {}),
      untrusted: options.untrusted,
      fullAccess: options.fullAccess,
      shared: options.shared ? { tools: "conversation" } : undefined,
    });
    for (let attempt = 0; attempt < 50 && !events.some((event) => event.type === "turn.completed"); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(events.some((event) => event.type === "turn.completed"), "the turn must settle");
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { requests, events, catalog, models: instance.models, capabilities: instance.adapter.capabilities, bridges, native: readFileSync(join(NATIVE_DIR, "thread.ndjson"), "utf8") };
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

const observed = (turn: Awaited<ReturnType<typeof commandTurn>>) => turn.requests.find((request) => request.method === "observed")?.params;
const completed = (turn: Awaited<ReturnType<typeof commandTurn>>) => turn.events.find((event) => event.type === "turn.completed")?.ok;

test("Command Code discovers native effort choices per model and keeps Max model names intact", async () => {
  const turn = await commandTurn({ config: true, probeModels: true });
  assert.deepEqual(turn.capabilities.efforts, ["off", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(turn.catalog.options.map((entry) => entry.efforts), [["off", "high", "max"], ["low", "medium", "high", "xhigh", "max"], []]);
  assert.equal(turn.catalog.options[1].label, "GLM 5.3 Max");
  assert.equal(turn.catalog.default, "flash");
  assert.equal(turn.requests.filter((request) => request.method === "session/prompt").length, 1, "catalog discovery sends no prompts");
});

test("all supported Command Code efforts reach new and resumed turns after selecting the model", { timeout: 30_000 }, async () => {
  for (const resume of [false, true]) {
    for (const [model, levels] of [["flash", ["off", "high", "max"]], ["pro", ["low", "medium", "high", "xhigh", "max"]]] as const) {
      for (const effort of levels) {
        const turn = await commandTurn({ config: true, model, effort, resume });
        assert.equal(completed(turn), true);
        assert.deepEqual(observed(turn), { model, effort });
        const selected = turn.requests.findIndex((request) => request.method === "session/set_config_option" && request.params.configId === "effort");
        assert.ok(selected >= 0 && selected < turn.requests.findIndex((request) => request.method === "session/prompt"));
      }
    }
  }
});

test("Command Code refreshes thinking after a model switch without changing other bots' default", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "pro", effort: "max", notifyOnly: true });
  assert.equal(completed(turn), true);
  assert.deepEqual(observed(turn), { model: "pro", effort: "max" });
  assert.equal(turn.models.default, "flash");
  assert.deepEqual(turn.models.options.find((entry) => entry.id === "pro")?.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("Command Code refuses missing models and unconfirmed settings before any prompt", async () => {
  for (const input of [{ model: "removed" }, { model: "pro", ignoreConfig: "model" }, { model: "pro", failConfig: "model" }, { model: "pro", effort: "high" as const, failConfig: "effort" }, { model: "pro", effort: "high" as const, ignoreConfig: "effort" }, { model: "pro", resume: true, missingConfig: true }]) {
    const turn = await commandTurn({ config: true, ...input });
    assert.equal(completed(turn), false, JSON.stringify(input));
    assert.ok(!turn.requests.some((request) => request.method === "session/prompt"));
  }
});

test("Command Code Auto uses the native default, including after another model was resumed", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "auto", resume: true, resumeModel: "pro", effort: "high" });
  assert.equal(completed(turn), true);
  assert.deepEqual(observed(turn), { model: "flash", effort: "high" });
  assert.equal(turn.events.find((event) => event.type === "session.started")?.model, "flash");
});

test("untouched Command Code provider defaults are left untouched", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "flash", resume: true, resumeEffort: "default" });
  assert.equal(completed(turn), true);
  assert.equal(observed(turn)?.effort, "default");
  assert.ok(!turn.requests.some((request) => request.method === "session/set_config_option" && request.params.configId === "effort"));
});

test("clearing Command Code effort restores a configured native level without replacing the session", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "flash", resume: true, resumeEffort: "off", defaultEffort: "high" });
  assert.equal(completed(turn), true);
  assert.equal(observed(turn)?.effort, "high");
  assert.equal(turn.events.find((event) => event.type === "session.started")?.sessionId, "s1");
  assert.equal(turn.requests.filter((request) => request.method === "session/new").length, 1, "only the catalog probe opens a session");
});

test("clearing Command Code effort uses a fresh native session with the conversation handoff", async () => {
  const handoff = "Earlier conversation: keep the agreed TypeScript plan.\nNow continue.";
  const turn = await commandTurn({ config: true, probeModels: true, model: "flash", resume: true, resumeEffort: "max", handoff });
  assert.equal(completed(turn), true);
  assert.equal(observed(turn)?.effort, "default");
  assert.equal(turn.events.find((event) => event.type === "session.started")?.sessionId, "s2");
  assert.equal(turn.requests.find((request) => request.method === "session/prompt")?.params.prompt[0].text, handoff);
});

test("clearing Command Code effort cannot silently lose a resumed conversation without a handoff", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "flash", resume: true, resumeEffort: "max" });
  assert.equal(completed(turn), false);
  assert.ok(!turn.requests.some((request) => request.method === "session/prompt"));
  assert.match(turn.events.find((event) => event.type === "runtime.error")?.message ?? "", /handoff|conversation/i);
});

test("Command Code fixed models run without a reasoning selector", async () => {
  const turn = await commandTurn({ config: true, probeModels: true, model: "fixed" });
  assert.equal(completed(turn), true);
  assert.deepEqual(turn.models.options.find((entry) => entry.id === "fixed")?.efforts, []);
});

test("Command Code questions stay human decisions in full-auto mode and accept either choice label", async () => {
  for (const input of [{ fullAuto: true, answer: "TypeScript" }, { answer: "Rust" }, { answer: "Rust: native code" }]) {
    const turn = await commandTurn({ question: true, ...input });
    const opened = turn.events.find((event) => event.type === "request.opened");
    assert.equal(opened?.requestType, "question");
    assert.equal(opened?.tool, "ask_user_question");
    assert.deepEqual(opened?.choices, ["Rust: native code", "TypeScript: web code"]);
    assert.equal(turn.requests.find((request) => request.method === "answer")?.params.outcome.optionId, input.answer.startsWith("Rust") ? "option_0" : "option_1");
  }
});

test("cancelled or unsupported Command Code answers never invent a listed answer", async () => {
  for (const input of [{ cancelQuestion: true }, { answer: "unlisted free text" }]) {
    const turn = await commandTurn({ question: true, ...input });
    assert.deepEqual(turn.requests.find((request) => request.method === "answer")?.params.outcome, { outcome: "cancelled" });
  }
});

const mcpKey = "mcp-fixture-secret-b83c";
const apps: NonNullable<SendTurnInput["integrations"]>["mcpServers"] = [
  { name: "local_docs", transport: "stdio", command: "local-mcp", args: ["--stdio"], env: { API_KEY: mcpKey, EMPTY: "" } },
  { name: "cloud_docs", transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer " + mcpKey } },
];

test("Command Code receives selected stdio and HTTP MCP apps on fresh and resumed turns", async () => {
  for (const resume of [false, true]) {
    const turn = await commandTurn({ resume, integrations: { mcpServers: apps } });
    const request = turn.requests.find((request) => request.method === (resume ? "session/load" : "session/new"));
    assert.deepEqual(request.params.mcpServers, [
      { name: "local_docs", command: "local-mcp", args: ["--stdio"], env: [{ name: "API_KEY", value: mcpKey }] },
      { name: "cloud_docs", type: "http", url: "http://127.0.0.1:9/mcp", headers: [{ name: "Authorization", value: "Bearer " + mcpKey }] },
    ]);
  }
});

test("remote Command Code reaches selected MCP apps only through the local gate", async () => {
  const turn = await commandTurn({ remote: true, integrations: { mcpServers: apps } });
  assert.deepEqual(turn.bridges.map((entry) => entry.name), ["local_docs", "cloud_docs"]);
  const servers = turn.requests.find((request) => request.method === "session/new").params.mcpServers;
  assert.equal(servers.length, 2);
  assert.ok(servers.every((entry: any) => entry.type === "http" && !entry.command && !entry.env));
  assert.ok(!JSON.stringify(servers).includes(mcpKey));
});

test("an ACP agent without HTTP support cannot silently discard a selected HTTP app", async () => {
  const turn = await commandTurn({ noHttp: true, integrations: { mcpServers: [apps![1]] } });
  assert.equal(completed(turn), false);
  assert.ok(!turn.requests.some((request) => request.method === "session/prompt"));
});

test("ACP native logs redact provider, connector, MCP and per-turn credentials", async () => {
  const connector = "connector-fixture-secret-29fa", provider = "provider-fixture-secret-18fe", token = "turn-fixture-secret-02a9";
  const turn = await commandTurn({ providerKey: provider, env: { BLOKS_TOKEN: token }, integrations: { composio: { key: connector }, mcpServers: apps } });
  assert.ok(turn.native.length > 0);
  for (const secret of [connector, provider, token, mcpKey]) assert.ok(!turn.native.includes(secret), "credential present in native log");
  assert.ok(turn.native.includes("[redacted]"));
  const remote = await commandTurn({ remote: true, integrations: { mcpServers: apps } });
  assert.ok(!remote.native.includes("gate-token-local_docs"));
});
