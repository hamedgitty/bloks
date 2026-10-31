import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runsAProcess } from "../server/agent-cli.ts";
import { instanceConfigs } from "../server/config.ts";
import { ACP_SPECS, acpDriver, signInFromOutput } from "../server/drivers/acp.ts";
import { engineResults } from "../server/run-export.ts";
import { shippedEnv, signInThereCommand } from "../server/workplace.ts";
import { effortLevels, type Effort } from "../server/effort.ts";

const devin = () => {
  const spec = ACP_SPECS.find((entry) => entry.kind === "devin");
  assert.ok(spec, "Devin must be a built-in ACP engine");
  return spec;
};

test("Devin is offered to new and existing workspaces, with its own setup", () => {
  const spec = devin();
  assert.deepEqual([spec.command, ...spec.args], ["devin", "acp"]);
  for (const cfg of [{}, { instances: { claude: { driver: "claudeAgent" } } }]) {
    assert.ok(Object.values(instanceConfigs(cfg)).some((entry) => entry.driver === "devin"));
  }
  assert.equal(runsAProcess("devin"), true);
  assert.equal(engineResults("devin"), "partial");
});

test("Devin reads its own words for signed out, from `devin auth status`", () => {
  const check = devin().signInCheck;
  assert.ok(check);
  // what 3000.11.234 prints with no login
  assert.equal(signInFromOutput(check, "Not logged in.\n  Credentials path: /x/credentials.toml\nRun `devin auth login` to authenticate.\n"), false);
  assert.equal(signInFromOutput(check, "Logged in as someone@example.com"), true);
});

test("Devin signs in on the remote machine without shipping this machine's key", () => {
  assert.match(signInThereCommand({ kind: "ssh", host: "vm", path: "~" }, "devin", "devin") ?? "", /devin auth login/);
  assert.deepEqual(shippedEnv({ WINDSURF_API_KEY: "local-key", BLOKS_TOKEN: "agent-token" }, {}, {}), { BLOKS_TOKEN: "agent-token" });
});

/** One turn against a stand-in for `devin acp` that behaves as 3000.11.234
 * does: modes accept-edits, smart, ask, plan, bypass, and a set_mode that
 * says yes to any id at all. `startIn` is the mode a session opens in. */
async function devinTurn(options: {
  fullAuto?: boolean;
  untrusted?: boolean;
  fullAccess?: boolean;
  shared?: boolean;
  resume?: boolean;
  startIn?: string;
  withoutMode?: string;
  model?: string;
  effort?: Effort;
  withModels?: boolean;
  startModel?: string;
  startEffort?: string;
  resumeModel?: string;
  resumeEffort?: string;
  failConfig?: string;
  ignoreConfig?: string;
  notifyConfigOnly?: boolean;
  missingConfigOnLoad?: boolean;
  missingThinkingOnLoad?: boolean;
  probeModels?: boolean;
  configModesOnly?: boolean;
  next?: { model: string; effort: Effort };
}) {
  const dir = mkdtempSync(join(tmpdir(), "bloks-devin-"));
  const log = join(dir, "requests.ndjson");
  const cli = join(dir, "agent.cjs");
  writeFileSync(
    cli,
    `
const fs = require("node:fs");
const options = ${JSON.stringify(options)};
const ids = ["accept-edits", "smart", "ask", "plan", "bypass"].filter((id) => id !== options.withoutMode);
const fusion = "fusion-claude-opus-5-5-medium-sidekick-gpt-6-luna-high";
let model = options.startModel ?? fusion;
let effort = options.startEffort ?? "max";
let mode = options.startIn ?? "accept-edits";
let missingThinking = false;
const levels = () => model === "light" ? ["none", "low", "high"] : model === "fixed" ? [] : ["low", "medium", "high", "xhigh", "max"];
const configOptions = () => [
  { id: "mode", category: "mode", type: "select", currentValue: mode, options: ids.map((value) => ({ value, name: value })) },
  { id: "model", category: "model", type: "select", currentValue: model, options: [
    { value: fusion, name: "Fusion (Claude Opus 5.5 Medium + GPT-6 Luna High Thinking)" },
    { value: "light", name: "Light Medium Thinking" }, { value: "fixed", name: "Fixed" }
  ] },
  ...(levels().length && !missingThinking ? [{ id: "thought_level", category: "thought_level", type: "select", currentValue: effort, options: levels().map((value) => ({ value, name: value })) }] : []),
  { id: "speed", category: "model_config", type: "select", currentValue: "standard", options: [{ value: "standard", name: "Standard" }, { value: "fast", name: "Fast" }] }
];
const session = () => ({ sessionId: "s1", ...(!options.configModesOnly ? { modes: { currentModeId: mode, availableModes: ids.map((id) => ({ id })) } } : {}), ...(options.withModels ? { configOptions: configOptions() } : {}) });
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (msg.method === "session/new" || msg.method === "session/load") {
    if (msg.method === "session/load") { model = options.resumeModel ?? model; effort = options.resumeEffort ?? effort; }
    if (msg.method === "session/load" && options.missingThinkingOnLoad) missingThinking = true;
    const opened = session();
    send({ id: msg.id, result: msg.method === "session/load" && options.missingConfigOnLoad ? { sessionId: "s1", modes: opened.modes } : opened });
  }
  else if (msg.method === "session/set_config_option") {
    const { configId, value } = msg.params;
    if (configId === options.failConfig || (configId === "thought_level" && !levels().includes(value))) {
      send({ id: msg.id, error: { code: -32602, message: "unsupported setting" } });
    } else {
      if (configId !== options.ignoreConfig) {
        if (configId === "model") { model = value; effort = levels()[0] ?? "none"; }
        if (configId === "thought_level") effort = value;
        if (configId === "mode") mode = value;
      }
      if (options.notifyConfigOnly) send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "config_option_update", configOptions: configOptions() } } });
      send({ id: msg.id, result: options.notifyConfigOnly ? {} : { configOptions: configOptions() } });
    }
  }
  else if (msg.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: "observed", params: { model, effort } }) + "\\n");
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  } else send({ id: msg.id, result: {} });
});
`,
  );
  // node runs the stand-in on every platform; no real Devin or account
  const spec = { ...devin(), command: process.execPath, args: [cli], probeModels: options.probeModels === true, signInCheck: undefined };
  const instance = await acpDriver(spec).create({
    instanceId: "devin",
    displayName: "Devin",
    enabled: true,
    environment: {},
    config: { cli: process.execPath, fullAuto: options.fullAuto === true },
  });
  await instance.catalogReady;
  const catalog = structuredClone(instance.models);
  let error: string | undefined;
  // the test lib predates Promise.withResolvers
  let settle = (_ok: boolean) => {};
  const done = new Promise<boolean>((resolve) => (settle = resolve));
  instance.adapter.onEvent((event) => {
    if (event.type === "runtime.error") error = event.message;
    if (event.type === "turn.completed") settle(event.ok);
  });
  try {
    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "hello",
      cwd: dir,
      ...(options.resume ? { resumeCursor: "s1" } : {}),
      untrusted: options.untrusted,
      fullAccess: options.fullAccess,
      shared: options.shared ? { tools: "conversation" } : undefined,
      model: options.model,
      effort: options.effort,
    });
    const ok = await done;
    if (options.next) {
      const next = new Promise<boolean>((resolve) => (settle = resolve));
      await instance.adapter.sendTurn({ threadId: "other-bot", text: "hello", cwd: dir, ...options.next });
      await next;
    }
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { modeId?: string; configId?: string; value?: string; model?: string; effort?: string } });
    const modeAt = requests.findIndex((request) => request.method === "session/set_mode" || request.method === "session/set_config_option" && request.params.configId === "mode");
    const promptAt = requests.findIndex((request) => request.method === "session/prompt");
    return { mode: requests[modeAt]?.params.modeId ?? requests[modeAt]?.params.value, modeAt, promptAt, ok, error, requests, catalog, models: instance.models, capabilities: instance.adapter.capabilities };
  } finally {
    await instance.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("an ordinary Devin turn asks before acting, even in a session last left in bypass", { timeout: 30_000 }, async () => {
  for (const resume of [false, true]) {
    const turn = await devinTurn({ resume, startIn: "bypass" });
    assert.equal(turn.mode, "accept-edits");
    assert.ok(turn.modeAt >= 0 && turn.promptAt > turn.modeAt, "the mode is chosen before the prompt goes");
    assert.equal(turn.ok, true);
  }
});

const FUSION = "fusion-claude-opus-5-5-medium-sidekick-gpt-6-luna-high";

test("Devin advertises each model's own thinking choices without the misleading Fusion lead effort", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, probeModels: true });
  assert.deepEqual(turn.capabilities.efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(turn.catalog.options.map((model) => model.efforts), [["low", "medium", "high", "xhigh", "max"], ["none", "low", "high"], []]);
  assert.equal(turn.catalog.default, FUSION, "probing other models must preserve the account default");
  assert.equal(turn.catalog.options[0].label, "Fusion (Claude Opus 5.5 + GPT-6 Luna High Thinking)");
  assert.equal(turn.requests.filter((request) => request.method === "session/prompt").length, 1, "catalog discovery must not send prompts");
  assert.deepEqual(effortLevels({ adapter: { capabilities: turn.capabilities }, models: turn.catalog }, "fixed"), []);
});

test("every supported Devin level reaches fresh and resumed sessions without changing the Fusion sidekick", { timeout: 30_000 }, async () => {
  for (const resume of [false, true]) {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const turn = await devinTurn({ withModels: true, model: FUSION, effort, resume });
      assert.equal(turn.ok, true);
      const thinking = turn.requests.find((request) => request.method === "session/set_config_option" && request.params.configId === "thought_level");
      assert.ok(thinking, `${effort} is sent explicitly rather than inherited from the global default`);
      assert.equal(thinking.params.value, effort);
      assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: FUSION, effort });
      assert.ok(turn.requests.indexOf(thinking) < turn.promptAt);
      assert.ok(!turn.requests.some((request) => request.params.configId === "speed"), "reasoning must not enable paid Fast mode");
    }
  }
});

test("a Devin model switch reads refreshed levels, clamps to a supported one, and supports no thinking", { timeout: 30_000 }, async () => {
  for (const [wanted, actual] of [["max", "high"], ["none", "none"]] as const) {
    const turn = await devinTurn({ withModels: true, model: "light", effort: wanted });
    assert.equal(turn.ok, true);
    assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: "light", effort: actual });
    assert.deepEqual(turn.models.options.find((model) => model.id === "light")?.efforts, ["none", "low", "high"]);
    assert.equal(turn.models.default, FUSION, "a bot's selected model must not become the engine default for other bots");
  }
});

test("different Devin bots keep separate reasoning choices on the same engine", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, model: FUSION, effort: "low", next: { model: FUSION, effort: "max" } });
  assert.deepEqual(turn.requests.filter((request) => request.method === "observed").map((request) => request.params.effort), ["low", "max"]);
});

test("Devin sends no prompt when the selected model or required configuration is unavailable", { timeout: 30_000 }, async () => {
  for (const options of [
    { model: "removed-model", effort: "high" as const },
    { model: FUSION, effort: "high" as const, resume: true, missingConfigOnLoad: true },
    { model: "light", effort: "high" as const, failConfig: "model" },
    { model: FUSION, effort: "high" as const, failConfig: "thought_level" },
    { model: "light", effort: "high" as const, ignoreConfig: "model" },
    { model: FUSION, effort: "high" as const, ignoreConfig: "thought_level" },
  ]) {
    const turn = await devinTurn({ withModels: true, ...options });
    assert.equal(turn.ok, false, JSON.stringify(options));
    assert.equal(turn.promptAt, -1, "an unavailable setting must not spend on a default");
    assert.ok(turn.error);
  }
});

test("Devin configuration notifications before the prompt update the selected model's levels", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, model: "light", effort: "high", notifyConfigOnly: true });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: "light", effort: "high" });
});

test("a rejected Devin catalog probe keeps the models already discovered", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, probeModels: true, failConfig: "model" });
  assert.deepEqual(turn.catalog.options.map((model) => model.id), [FUSION, "light", "fixed"]);
  assert.deepEqual(turn.catalog.options[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(turn.catalog.options[1].label, "Light");
});

test("a bot saved on Devin's startup Auto placeholder uses the native default", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, model: "auto", effort: "high" });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: FUSION, effort: "high" });
});

test("Devin's Auto restores the engine default after resuming another model", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, probeModels: true, model: "auto", effort: "max", resume: true, resumeModel: "light" });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: FUSION, effort: "max" });
});

test("clearing Devin's effort restores its native default on a resumed session", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, probeModels: true, model: FUSION, resume: true, resumeEffort: "low" });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.requests.find((request) => request.method === "observed")?.params, { model: FUSION, effort: "max" });
});

test("a resumed Devin session cannot guess an unavailable engine reasoning default", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, model: FUSION, resume: true, resumeEffort: "low" });
  assert.equal(turn.ok, false);
  assert.equal(turn.promptAt, -1);
  assert.match(turn.error ?? "", /default reasoning effort is not known/);
});

test("missing reasoning metadata on resume cannot silently discard a bot's effort", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, probeModels: true, model: FUSION, effort: "high", resume: true, missingThinkingOnLoad: true });
  assert.equal(turn.ok, false);
  assert.equal(turn.promptAt, -1);
  assert.deepEqual(turn.models.options[0].efforts, ["low", "medium", "high", "xhigh", "max"], "a transient missing option must not erase known reasoning support for the next retry");
});

test("a fixed Devin model still runs without a reasoning selector", { timeout: 30_000 }, async () => {
  const turn = await devinTurn({ withModels: true, model: "fixed" });
  assert.equal(turn.ok, true);
  assert.ok(!turn.requests.some((request) => request.params.configId === "thought_level"));
});

test("Devin accepts native mode config options without requiring deprecated modes metadata", { timeout: 30_000 }, async () => {
  for (const resume of [false, true]) {
    const turn = await devinTurn({ withModels: true, configModesOnly: true, fullAuto: true, model: FUSION, effort: "high", resume });
    assert.equal(turn.ok, true);
    assert.equal(turn.mode, "bypass");
    assert.ok(turn.modeAt < turn.promptAt);
  }
  for (const failure of [{ failConfig: "mode" }, { ignoreConfig: "mode" }]) {
    const turn = await devinTurn({ withModels: true, configModesOnly: true, fullAuto: true, model: FUSION, ...failure });
    assert.equal(turn.ok, false);
    assert.equal(turn.promptAt, -1);
  }
});

test("Devin skips approvals only on a full-auto or full-access turn its owner vouched for", { timeout: 30_000 }, async () => {
  for (const options of [{ fullAuto: true }, { fullAccess: true }]) {
    assert.equal((await devinTurn(options)).mode, "bypass");
  }
  for (const options of [{ fullAuto: true, untrusted: true }, { fullAccess: true, shared: true }]) {
    assert.equal((await devinTurn(options)).mode, "accept-edits");
  }
});

test("a Devin that does not list the mode gets no prompt, though set_mode would have said yes", { timeout: 30_000 }, async () => {
  for (const options of [{ withoutMode: "accept-edits" }, { fullAuto: true, withoutMode: "bypass" }]) {
    const turn = await devinTurn(options);
    assert.equal(turn.promptAt, -1);
    assert.equal(turn.ok, false);
    assert.match(turn.error ?? "", /mode/);
  }
});
