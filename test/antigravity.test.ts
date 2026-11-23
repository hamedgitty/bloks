// Antigravity over `agy acp` (GitHub 546, 542): registration, version gate,
// interactive permission cards, Composio and workspace MCP servers, browser
// and computer screens, per-model thought_level probing, legacy combined
// model-id compatibility, catalog refresh, and /compact. No real CLI or
// model is called: a stand-in Node script speaks agy 1.5.14's ACP wire shapes.
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runsAProcess } from "../server/agent-cli.ts";
import { instanceConfigs, NATIVE_DIR } from "../server/config.ts";
import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { ACP_SPECS, acpDriver, tooOld } from "../server/drivers/acp.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { effortLevels, type Effort } from "../server/effort.ts";
import { CLI_PROVIDERS } from "../server/providers.ts";
import { engineName, engineResults } from "../server/run-export.ts";
import { ALL_SCREENS } from "../server/screens.ts";
import { signInThereCommand } from "../server/workplace.ts";

const antigravity = () => {
  const spec = ACP_SPECS.find((entry) => entry.kind === "antigravity");
  assert.ok(spec, "Antigravity must be a built-in ACP engine");
  return spec;
};

test("Antigravity is a built-in ACP engine with its own version floor and setup", () => {
  const spec = antigravity();
  assert.deepEqual([spec.command, ...spec.args], ["agy", "acp"]);
  assert.equal(spec.minVersion, "1.5.0");
  assert.equal(spec.effortOption, "thought_level");
  assert.equal(spec.probeModels, true);
  assert.ok(CLI_PROVIDERS.some((entry) => entry.kind === "antigravity"));
  assert.ok(BUILT_IN_DRIVERS.some((entry) => entry.driverKind === "antigravity"));
  for (const cfg of [{}, { instances: { claude: { driver: "claudeAgent" } } }]) {
    assert.ok(Object.values(instanceConfigs(cfg)).some((entry) => entry.driver === "antigravity"));
  }
  assert.equal(runsAProcess("antigravity"), true);
  assert.equal(engineName("antigravity"), "Antigravity");
  assert.equal(engineResults("antigravity"), "partial");
  assert.match(signInThereCommand({ kind: "ssh", host: "vm", path: "~" }, "antigravity", "agy") ?? "", /\bagy\b/);
  assert.match(tooOld(spec, "1.4.10") ?? "", /Antigravity 1\.4\.10 is too old for Bloks, which needs 1\.5\.0 or newer/);
  assert.equal(tooOld(spec, "1.5.0"), null);
  assert.equal(tooOld(spec, "1.5.14"), null);
});

/** Stand-in for `agy acp` 1.5.14, returning its real configOptions shape
 * (base models + per-model thought_level + mode) and recording every argv
 * and JSON-RPC frame it receives. */
async function agyTurn(options: {
  version?: string;
  fullAuto?: boolean;
  untrusted?: boolean;
  fullAccess?: boolean;
  shared?: boolean;
  resume?: boolean;
  startIn?: string;
  model?: string;
  effort?: Effort;
  startModel?: string;
  startEffort?: string;
  resumeModel?: string;
  resumeEffort?: string;
  probeModels?: boolean;
  system?: string;
  text?: string;
  askPermission?: boolean;
  permissionAnswer?: "allow" | "deny";
  integrations?: SendTurnInput["integrations"];
  env?: Record<string, string>;
  remote?: boolean;
  compactFirst?: boolean;
  listCompact?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "bloks-agy-acp-"));
  const log = join(dir, "requests.ndjson");
  const cli = join(dir, "agy.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
const options = ${JSON.stringify(options)};
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(options.version ?? "1.5.14"); process.exit(0); }
fs.appendFileSync(log, JSON.stringify({ argv: args }) + "\\n");
let model = options.startModel ?? "gemini-4-neon";
let effort = options.startEffort ?? "high";
let mode = options.startIn ?? "default";
const levels = () => {
  if (model === "gemini-4-neon" || model === "gemini-4-hydrogen") return ["low", "medium", "high", "xhigh"];
  if (model === "claude-opus-5-5") return ["low", "medium", "high"];
  return [];
};
const configOptions = () => [
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: [
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ],
  },
  ...(levels().length ? [{
    id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: effort,
    options: levels().map((value) => ({ value, name: value })),
  }] : []),
  {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: mode,
    options: [
      { value: "default", name: "Default" },
      { value: "accept-edits", name: "Accept edits" },
      { value: "auto", name: "Auto" },
      { value: "plan", name: "Plan" },
    ],
  },
];
const session = () => ({
  sessionId: "s1",
  modes: { currentModeId: mode, availableModes: ["default", "accept-edits", "auto", "plan"].map((id) => ({ id, name: id })) },
  configOptions: configOptions(),
});
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
let pendingPromptId = null;
const finishPrompt = (id, text = "Done.") => {
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "usage_update", used: 9566, size: 1048576 } } });
  send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  fs.appendFileSync(log, JSON.stringify({ method: "observed", params: { model, effort, mode } }) + "\\n");
  send({ id, result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 25 } } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === "perm-1" && !msg.method) {
    fs.appendFileSync(log, JSON.stringify({ method: "permission_reply", params: msg.result }) + "\\n");
    finishPrompt(pendingPromptId, msg.result?.outcome?.optionId === "allow" ? "Allowed." : "Denied.");
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(log, line + "\\n");
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    if (msg.method === "session/load") {
      model = options.resumeModel ?? model;
      effort = options.resumeEffort ?? effort;
    }
    send({ id: msg.id, result: session() });
    if (options.listCompact) {
      send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] } } });
    }
  } else if (msg.method === "session/set_config_option") {
    const { configId, value } = msg.params;
    if (configId === "thought_level" && !levels().includes(value)) {
      send({ id: msg.id, error: { code: -32602, message: "unsupported thought_level" } });
      return;
    }
    if (configId === "model") { model = value; effort = levels()[0] ?? "high"; }
    if (configId === "thought_level") effort = value;
    if (configId === "mode") mode = value;
    send({ id: msg.id, result: { configOptions: configOptions() } });
  } else if (msg.method === "session/prompt") {
    const text = msg.params?.prompt?.[0]?.text ?? "";
    if (text === "/compact") {
      send({ id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (options.askPermission) {
      pendingPromptId = msg.id;
      send({
        id: "perm-1",
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall: {
            toolCallId: "call-1",
            name: "run_command",
            kind: "execute",
            title: "cat hello.txt",
            rawInput: { CommandLine: "cat hello.txt", WaitMsBeforeAsync: 5000 },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    finishPrompt(msg.id);
  } else {
    send({ id: msg.id, result: {} });
  }
});
`,
    { mode: 0o755 },
  );

  mkdirSync(NATIVE_DIR, { recursive: true });
  const spec = { ...antigravity(), command: cli, probeModels: options.probeModels === true };
  const instance = await acpDriver(spec).create({
    instanceId: "antigravity",
    displayName: "Antigravity",
    enabled: true,
    environment: {},
    config: { cli, fullAuto: options.fullAuto === true },
  });
  await instance.catalogReady;
  const catalog = structuredClone(instance.models);
  const events: RuntimeEvent[] = [];
  let settle = (_ok: boolean) => {};
  const done = new Promise<boolean>((resolve) => (settle = resolve));
  const threadId = `agy-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  instance.adapter.onEvent((event) => {
    events.push(event);
    if (event.type === "request.opened" && options.askPermission && event.requestId) {
      void instance.adapter.respondToRequest(event.threadId, event.requestId, {
        behavior: options.permissionAnswer ?? "allow",
      });
    }
    if (event.type === "turn.completed") settle(event.ok);
  });

  try {
    await instance.adapter.sendTurn({
      threadId,
      text: options.text ?? "hello",
      system: options.system,
      cwd: dir,
      ...(options.resume ? { resumeCursor: "s1" } : {}),
      untrusted: options.untrusted,
      fullAccess: options.fullAccess,
      shared: options.shared ? { tools: "conversation" } : undefined,
      model: options.model,
      effort: options.effort,
      integrations: options.integrations,
      env: options.env,
      compactFirst: options.compactFirst,
      ...(options.remote
        ? {
            place: {
              label: "remote box",
              cwd: dir,
              spawn: (command: string, args: string[], input?: { env?: Record<string, string | undefined> }) =>
                spawn(command, args, { cwd: dir, env: input?.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
              file: () => {
                throw new Error("No file expected");
              },
              mcp: () => null,
            },
          }
        : {}),
    });
    const ok = await done;
    const entries = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as any)
      : [];
    const nativePath = join(NATIVE_DIR, `${threadId}.ndjson`);
    const nativeLog = existsSync(nativePath) ? readFileSync(nativePath, "utf8") : "";
    return {
      ok,
      events,
      entries,
      argv: entries.filter((entry) => Array.isArray(entry.argv)).map((entry) => entry.argv as string[]),
      catalog,
      models: instance.models,
      capabilities: instance.adapter.capabilities,
      snapshot: await instance.snapshot(),
      nativeLog,
    };
  } finally {
    await instance.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("Antigravity snapshot rejects agy older than 1.5.0 and leaves current keyring auth unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-agy-snap-"));
  const oldCli = join(dir, "old-agy.mjs");
  const newCli = join(dir, "new-agy.mjs");
  writeFileSync(oldCli, `#!${process.execPath}\nconsole.log("1.4.10");\n`, { mode: 0o755 });
  writeFileSync(newCli, `#!${process.execPath}\nconsole.log("1.5.14");\n`, { mode: 0o755 });
  const spec = { ...antigravity(), probeModels: false };
  const oldInst = await acpDriver(spec).create({ instanceId: "old", displayName: "Antigravity", enabled: true, environment: {}, config: { cli: oldCli, fullAuto: false } });
  const newInst = await acpDriver(spec).create({ instanceId: "new", displayName: "Antigravity", enabled: true, environment: {}, config: { cli: newCli, fullAuto: false } });
  try {
    const oldSnap = await oldInst.snapshot();
    assert.equal(oldSnap.state, "unavailable");
    assert.match(oldSnap.reason ?? "", /1\.5\.0 or newer/);
    assert.equal(oldSnap.version, "Antigravity 1.4.10");

    const newSnap = await newInst.snapshot();
    assert.equal(newSnap.state, "available");
    assert.equal(newSnap.version, "Antigravity 1.5.14");
    // agy keeps its Google sign-in in the system keyring, so no local file is not signed out
    assert.equal(newSnap.authenticated, undefined);
  } finally {
    await oldInst.dispose();
    await newInst.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persona and message travel over ACP stdin, never in argv", async () => {
  const persona = "persona_canary_acp_9a1b";
  const message = "message_canary_acp_4f2e";
  const turn = await agyTurn({ system: persona, text: message });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.argv, [["acp"]]);
  for (const secret of [persona, message]) {
    assert.ok(!turn.argv.flat().some((arg) => arg.includes(secret)), `${secret} leaked into argv`);
  }
  const prompt = turn.entries.find((entry) => entry.method === "session/prompt");
  assert.match(prompt?.params?.prompt?.[0]?.text ?? "", new RegExp(`${persona}[\\s\\S]*${message}`));
});

test("ordinary turns stay in default mode without skipping permissions, and full access skips only when safe", async () => {
  for (const resume of [false, true]) {
    const ordinary = await agyTurn({ resume, startIn: "accept-edits", probeModels: resume });
    assert.equal(ordinary.ok, true);
    assert.deepEqual(ordinary.argv.at(-1), ["acp"]);
    assert.deepEqual(ordinary.entries.find((e) => e.method === "observed")?.params?.mode, "default");
  }
  for (const opts of [{ fullAuto: true }, { fullAccess: true }]) {
    const skip = await agyTurn(opts);
    assert.equal(skip.ok, true);
    assert.deepEqual(skip.argv, [["acp", "--dangerously-skip-permissions"]], JSON.stringify(opts));
  }
  for (const opts of [{ fullAuto: true, untrusted: true }, { fullAccess: true, shared: true }]) {
    const guarded = await agyTurn(opts);
    assert.equal(guarded.ok, true);
    assert.deepEqual(guarded.argv, [["acp"]], `must not skip permissions for ${JSON.stringify(opts)}`);
  }
});

test("interactive permission requests pause for Bloks approval and deliver allow or deny", async () => {
  for (const answer of ["allow", "deny"] as const) {
    const turn = await agyTurn({ askPermission: true, permissionAnswer: answer });
    assert.equal(turn.ok, true);
    const opened = turn.events.find((e) => e.type === "request.opened");
    assert.ok(opened && opened.type === "request.opened");
    assert.equal(opened.requestType, "permission");
    assert.equal(opened.tool, "execute");
    assert.equal(opened.summary, "cat hello.txt");
    const resolved = turn.events.find((e) => e.type === "request.resolved");
    assert.ok(resolved && resolved.type === "request.resolved");
    assert.equal(resolved.behavior, answer);
    const reply = turn.entries.find((e) => e.method === "permission_reply");
    assert.equal(reply?.params?.outcome?.optionId, answer);
  }
});

test("Composio, workspace MCP servers, and browser/computer screens mount over stdio with secrets kept out of argv and native logs", async () => {
  // Built at runtime so nothing token-shaped sits in the source.
  const composioKey = ["composio", "secret", String(Date.now())].join("-");
  const mcpToken = ["mcp", "secret", String(Date.now())].join("-");
  const boxToken = ["box", "secret", String(Date.now())].join("-");
  const bloksToken = ["bloks", "turn", "secret", String(Date.now())].join("-");

  const turn = await agyTurn({
    env: { BLOKS_TOKEN: bloksToken },
    integrations: {
      composio: { key: composioKey },
      mcpServers: [{ name: "docs", transport: "stdio", command: "docs-mcp", args: ["--stdio"], env: { DOCS_TOKEN: mcpToken } }],
      browser: { profileDir: "/tmp/bloks-browser-profile" },
      computer: { boxId: "box-1", token: boxToken },
    },
  });
  assert.equal(turn.ok, true);
  assert.deepEqual(turn.capabilities.screens, ALL_SCREENS);

  const opened = turn.entries.find((e) => e.method === "session/new");
  const servers: Array<{ name: string; command?: string; args?: string[]; env?: Array<{ name: string; value: string }> }> =
    opened?.params?.mcpServers ?? [];
  assert.deepEqual(servers.map((s) => s.name), ["bloks_connectors", "docs", "bloks_computer", "bloks_browser"]);
  assert.ok(servers[0].env?.some((e) => e.name === "BLOKS_COMPOSIO_KEY" && e.value === composioKey));
  assert.ok(servers[1].env?.some((e) => e.name === "DOCS_TOKEN" && e.value === mcpToken));
  assert.ok(servers[2].env?.some((e) => e.name === "BLOKS_BOX_TOKEN" && e.value === boxToken));

  for (const secret of [composioKey, mcpToken, boxToken, bloksToken]) {
    assert.ok(!turn.argv.flat().some((arg) => arg.includes(secret)), "secret leaked into argv");
    assert.ok(!turn.nativeLog.includes(secret), "secret leaked into native log");
  }
});

test("working elsewhere without HTTP MCP tells the agent plainly that screens cannot reach it", async () => {
  const turn = await agyTurn({
    remote: true,
    system: "You have your own browser.",
    integrations: { browser: { profileDir: "/tmp/p" } },
  });
  assert.equal(turn.ok, true);
  const opened = turn.entries.find((e) => e.method === "session/new");
  assert.deepEqual(opened?.params?.mcpServers, []);
  const prompt = turn.entries.find((e) => e.method === "session/prompt");
  assert.match(prompt?.params?.prompt?.[0]?.text ?? "", /cannot reach your browser/);
});

test("per-model thought_level probing discovers each model's own levels and preserves fixed models", async () => {
  const turn = await agyTurn({ probeModels: true, model: "claude-opus-5-5", effort: "xhigh" });
  assert.equal(turn.ok, true);
  assert.equal(turn.catalog.default, "gemini-4-neon");
  assert.deepEqual(
    turn.catalog.options.map((m) => [m.id, m.efforts]),
    [
      ["gemini-4-neon", ["low", "medium", "high", "xhigh"]],
      ["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
      ["gemini-pro-orchestrator-neon", []],
      ["claude-opus-5-5", ["low", "medium", "high"]],
      ["gpt-oss-120b-medium", []],
    ],
  );
  // xhigh clamps to Claude Opus 5.5's highest supported level (high)
  assert.deepEqual(turn.entries.find((e) => e.method === "observed")?.params, {
    model: "claude-opus-5-5",
    effort: "high",
    mode: "default",
  });
  assert.deepEqual(effortLevels({ adapter: { capabilities: turn.capabilities }, models: turn.catalog }, "gemini-pro-orchestrator-neon"), []);
});

test("legacy combined model ids from before ACP resolve to base model and effort without breaking saved agents", async () => {
  // Existing agents saved on print-mode ids such as gemini-4-hydrogen-xhigh
  // must keep working after upgrading to ACP.
  for (const resume of [false, true]) {
    const migrated = await agyTurn({ model: "gemini-4-hydrogen-xhigh", resume });
    assert.equal(migrated.ok, true);
    assert.deepEqual(migrated.entries.find((e) => e.method === "observed")?.params, {
      model: "gemini-4-hydrogen",
      effort: "xhigh",
      mode: "default",
    });
  }
  // An explicit Bloks effort dial overrides the suffix in a legacy id.
  const explicit = await agyTurn({ model: "gemini-4-hydrogen-xhigh", effort: "low" });
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.entries.find((e) => e.method === "observed")?.params, {
    model: "gemini-4-hydrogen",
    effort: "low",
    mode: "default",
  });
  // A listed id that ends in a level word (gpt-oss-120b-medium) stays exact.
  const fixed = await agyTurn({ model: "gpt-oss-120b-medium" });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.entries.find((e) => e.method === "observed")?.params?.model, "gpt-oss-120b-medium");
  assert.ok(!fixed.entries.some((e) => e.method === "session/set_config_option" && e.params?.configId === "thought_level"));
  // A retired model that is no longer offered stops safely without spending.
  const retired = await agyTurn({ model: "gemini-3.1-pro-high" });
  assert.equal(retired.ok, false);
  assert.ok(!retired.entries.some((e) => e.method === "session/prompt"));
  assert.ok(retired.events.some((e) => e.type === "runtime.error" && /does not offer gemini-3\.1-pro-high/.test(e.message)));
});

test("context readings and /compact work on resumed sessions", async () => {
  const turn = await agyTurn({ resume: true, probeModels: true, compactFirst: true, listCompact: true });
  assert.equal(turn.ok, true);
  assert.ok(turn.events.some((e) => e.type === "context.compacted" && e.trigger === "manual"));
  const reading = turn.events.find((e) => e.type === "context.reading");
  assert.ok(reading && reading.type === "context.reading");
  assert.equal(reading.used, 9566);
  assert.equal(reading.window, 1048576);
});

test("probed Antigravity catalog refreshes after sign-in or plan upgrade and notifies listeners", async (t) => {
  // Keeps GitHub 542 working after the ACP move: signing in or upgrading a plan
  // updates the picker when Settings checks the engine or refreshCatalog runs.
  const dir = mkdtempSync(join(tmpdir(), "bloks-agy-refresh-"));
  const stateFile = join(dir, "models.json");
  const cli = join(dir, "agy.mjs");
  writeFileSync(stateFile, JSON.stringify([]));
  writeFileSync(
    cli,
    `#!${process.execPath}
import fs from "node:fs";
import readline from "node:readline";
if (process.argv[2] === "--version") { console.log("1.5.14"); process.exit(0); }
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (msg.method === "session/new") {
    const models = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
    if (!models.length) send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
    else send({ id: msg.id, result: { sessionId: "s1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: models[0].value, options: models }] } });
  } else send({ id: msg.id, result: {} });
});
`,
    { mode: 0o755 },
  );
  const spec = { ...antigravity(), command: cli, probeModels: true };
  const instance = await acpDriver(spec).create({ instanceId: "antigravity", displayName: "Antigravity", enabled: true, environment: {}, config: { cli, fullAuto: false } });
  t.after(async () => {
    await instance.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  await instance.catalogReady;
  assert.deepEqual(instance.models.options.map((o) => o.id), ["auto"]);

  writeFileSync(stateFile, JSON.stringify([{ value: "gemini-4-neon", name: "Gemini 4 Neon" }]));
  let notified = 0;
  const unsub = instance.onCatalogChange!(() => {
    notified++;
  });
  await instance.refreshCatalog!();
  unsub();
  assert.equal(notified, 1);
  assert.deepEqual(instance.models.options.map((o) => o.id), ["gemini-4-neon"]);
});
