// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { ACP_SPECS, acpDriver, permissionInput } from "../server/drivers/acp.ts";
import { SHUTDOWN_GRACE_MS } from "../server/drivers/engine-processes.ts";
import { OWN_GROUP } from "../server/no-console.ts";
import { targetOf } from "../server/policy.ts";
import { dangerous } from "../server/safety-floor.ts";
import { engineResults } from "../server/run-export.ts";
import { signedInThere } from "../server/workplace.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-agy-acp-"));
after(() => rmSync(home, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const agySpec = ACP_SPECS.find((s) => s.kind === "antigravity")!;

async function within(done: Promise<void>, ms = 8_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("agy did not finish")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 200 && !ready(); i++) await wait(25);
  assert.ok(ready(), what);
}

/** Whether a process can still run: kill(0) also finds a Linux zombie. */
function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

interface FakeAgyOptions {
  version?: string;
  onPrompt?: string;
  onResume?: string;
  onCancel?: string;
  models?: Array<{ value: string; name: string; efforts?: string[] }>;
  fullAuto?: boolean;
  probeModels?: boolean;
}

async function createFakeAgy(opts: FakeAgyOptions = {}) {
  const dir = mkdtempSync(join(home, "cli-"));
  const cli = join(dir, "agy.mjs");
  const log = join(dir, "requests.jsonl");
  const argvFile = join(dir, "argv.json");
  const models = opts.models ?? [
    { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro", efforts: ["low", "medium", "high", "xhigh"] },
    { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"] },
    { value: "fixed-model", name: "Fixed Model", efforts: [] },
  ];
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(opts.version ?? "1.5.14")}); process.exit(0); }
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(args));
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS = ${JSON.stringify(models)};
let currentModel = MODELS[0].value;
let currentMode = "default";
let currentThought = (MODELS[0].efforts ?? [])[0] ?? "";
const configOptions = () => {
  const entry = MODELS.find((m) => m.value === currentModel) ?? MODELS[0];
  const opts = [
    { id: "model", category: "model", type: "select", currentValue: currentModel, options: MODELS.map((m) => ({ value: m.value, name: m.name })) },
    { id: "mode", category: "mode", type: "select", currentValue: currentMode, options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }] },
  ];
  if (entry.efforts && entry.efforts.length) {
    if (!entry.efforts.includes(currentThought)) currentThought = entry.efforts[0];
    opts.push({ id: "thought_level", category: "thought_level", type: "select", currentValue: currentThought, options: entry.efforts.map((e) => ({ value: e, name: e })) });
  }
  return opts;
};
let nextReq = 1000;
const pendingClient = new Map();
const askClient = (method, params) => new Promise((resolve, reject) => {
  const id = nextReq++;
  pendingClient.set(id, { resolve, reject });
  say({ jsonrpc: "2.0", id, method, params });
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && !msg.method && pendingClient.has(msg.id)) {
    const p = pendingClient.get(msg.id);
    pendingClient.delete(msg.id);
    if (msg.error) p.reject(msg.error); else p.resolve(msg.result);
    return;
  }
  if (msg.id === undefined && msg.method === "session/cancel") {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
    ${opts.onCancel ?? ""}
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (message) => say({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message } });
  if (msg.method === "initialize") {
    reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
  } else if (msg.method === "session/new") {
    reply({ sessionId: "sess-new", configOptions: configOptions() });
  } else if (msg.method === "session/resume") {
    ${opts.onResume ?? 'reply({ sessionId: msg.params.sessionId, configOptions: configOptions() });'}
  } else if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "model") currentModel = msg.params.value;
    if (msg.params.configId === "mode") currentMode = msg.params.value;
    if (msg.params.configId === "thought_level") currentThought = msg.params.value;
    reply({ configOptions: configOptions() });
  } else if (msg.method === "session/prompt") {
    const sessionId = msg.params.sessionId;
    const update = (u) => say({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
    ${opts.onPrompt ?? 'update({ sessionUpdate: "usage_update", used: 13478, size: 1048576 }); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } }); reply({ stopReason: "end_turn", usage: { inputTokens: 2284, cachedReadTokens: 11184, outputTokens: 10 } });'}
  } else {
    reply({});
  }
});
`,
    { mode: 0o755 },
  );
  const instance = await acpDriver({ ...agySpec, probeModels: opts.probeModels ?? false }).create({
    instanceId: "agy",
    displayName: undefined,
    environment: {},
    enabled: true,
    config: { cli, fullAuto: opts.fullAuto ?? false },
  });
  const events: RuntimeEvent[] = [];
  let resolveDone!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  instance.adapter.onEvent((e) => {
    events.push(e);
    if (e.type === "turn.completed") resolveDone();
  });
  const requests = (): Array<{ method: string; params: any }> =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const argv = (): string[] => (existsSync(argvFile) ? JSON.parse(readFileSync(argvFile, "utf8")) : []);
  const send = (more: Partial<SendTurnInput> = {}) =>
    instance.adapter.sendTurn({ threadId: "t1", text: "hi", cwd: dir, ...more });
  return { instance, dir, events, completed, requests, argv, send };
}

test("Antigravity uses session/resume (never session/load), works with no explicit effort, and falls back with handoff", async (t) => {
  // No explicit effort + probeModels off (simulating failed startup probe or remote workplace)
  const ok = await createFakeAgy();
  t.after(() => ok.instance.dispose());
  await ok.send({ resumeCursor: "sess-old" });
  await within(ok.completed);
  assert.ok(ok.requests().some((r) => r.method === "session/resume" && r.params.sessionId === "sess-old"));
  assert.equal(ok.requests().some((r) => r.method === "session/load"), false);
  assert.equal(ok.events.find((e) => e.type === "turn.completed")?.ok, true);

  // Token usage includes cachedReadTokens, and usage_update emits context.reading
  const usage = ok.events.find((e) => e.type === "thread.token-usage.updated");
  assert.equal(usage?.type === "thread.token-usage.updated" ? usage.input : 0, 13468);
  assert.equal(usage?.type === "thread.token-usage.updated" ? usage.output : 0, 10);
  const reading = ok.events.find((e) => e.type === "context.reading");
  assert.equal(reading?.type === "context.reading" ? reading.used : 0, 13478);
  assert.equal(reading?.type === "context.reading" ? reading.window : 0, 1048576);

  const missed = await createFakeAgy({ onResume: 'fail("not found");' });
  t.after(() => missed.instance.dispose());
  await missed.send({ resumeCursor: "sess-gone", handoff: "prior context\n\nhi" });
  await within(missed.completed);
  assert.ok(missed.requests().some((r) => r.method === "session/resume"));
  assert.equal(missed.requests().some((r) => r.method === "session/load"), false);
  assert.ok(missed.requests().some((r) => r.method === "session/new"));
  const prompt = missed.requests().find((r) => r.method === "session/prompt");
  assert.match(String(prompt?.params?.prompt?.[0]?.text ?? ""), /prior context/);
});

test("Antigravity probes its catalog on startup and supports effort-less resume without duplicate broadcasts", async (t) => {
  const probed = await createFakeAgy({
    probeModels: true,
    models: [
      { value: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"] },
      { value: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "high"] },
    ],
  });
  t.after(() => probed.instance.dispose());
  let changeCount = 0;
  probed.instance.onCatalogChange?.(() => changeCount++);
  await probed.instance.catalogReady;
  assert.deepEqual(
    probed.instance.models.options.map((o) => o.id),
    ["gemini-4-neon", "claude-opus-5-5"],
  );
  assert.equal(changeCount, 0, "startup probe should not double-broadcast alongside catalogReady");
  await probed.send({ resumeCursor: "sess-probed" });
  await within(probed.completed);
  assert.equal(probed.events.find((e) => e.type === "turn.completed")?.ok, true);
});

test("Antigravity mounts Composio and stdio MCP servers and refuses HTTP MCP when unsupported", async (t) => {
  const ok = await createFakeAgy();
  t.after(() => ok.instance.dispose());
  await ok.send({
    integrations: {
      composio: { key: "comp-key" },
      mcpServers: [{ name: "local_mcp", transport: "stdio", command: "/bin/echo", args: ["hi"], env: { SECRET: "s" } }],
    },
  });
  await within(ok.completed);
  const opened = ok.requests().find((r) => r.method === "session/new");
  const names = (opened?.params?.mcpServers ?? []).map((s: any) => s.name);
  assert.ok(names.includes("bloks_connectors"));
  assert.ok(names.includes("local_mcp"));

  const refused = await createFakeAgy();
  t.after(() => refused.instance.dispose());
  await refused.send({
    integrations: {
      mcpServers: [{ name: "remote_http", transport: "http", url: "https://example.com/mcp" }],
    },
  });
  await within(refused.completed);
  const err = refused.events.find((e) => e.type === "runtime.error");
  assert.match(err?.type === "runtime.error" ? err.message : "", /does not support the selected HTTP MCP app remote_http/);
  assert.equal(refused.events.find((e) => e.type === "turn.completed")?.ok, false);
});

test("Antigravity raises permission cards in default mode and enforces default mode on untrusted/shared turns", async (t) => {
  const asked = await createFakeAgy({
    onPrompt: `
      const ans = await askClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tc1", kind: "execute", title: "run ls", rawInput: { command: "ls" } },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
      });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "outcome:" + ans.outcome.optionId } });
      reply({ stopReason: "end_turn" });
    `,
  });
  t.after(() => asked.instance.dispose());
  await asked.send();
  await until(() => asked.events.some((e) => e.type === "request.opened"), "permission card never opened");
  const req = asked.events.find((e) => e.type === "request.opened")!;
  assert.equal(req.type, "request.opened");
  assert.ok(req.requestId);
  await asked.instance.adapter.respondToRequest("t1", req.requestId, { behavior: "allow", message: "Allow once" });
  await within(asked.completed);
  assert.deepEqual(asked.argv(), ["acp"]);
  const text = asked.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text");
  assert.equal(text?.type === "item.completed" && text.itemType === "assistant_text" ? text.text : "", "outcome:allow");

  // Security negative controls: untrusted or shared turns never get --dangerously-skip-permissions and always pin mode=default
  for (const scenario of [
    { fullAuto: true, turn: { untrusted: true } },
    { fullAuto: false, turn: { fullAccess: true, shared: { tools: "conversation" as const } } },
    { fullAuto: false, turn: { fullAccess: true, untrusted: true } },
  ]) {
    const guarded = await createFakeAgy({ fullAuto: scenario.fullAuto });
    t.after(() => guarded.instance.dispose());
    await guarded.send(scenario.turn);
    await within(guarded.completed);
    assert.deepEqual(guarded.argv(), ["acp"], JSON.stringify(scenario));
    assert.ok(
      guarded.requests().some((r) => r.method === "session/set_config_option" && r.params?.configId === "mode" && r.params?.value === "default"),
      `mode=default was not pinned for ${JSON.stringify(scenario)}`,
    );
  }
});

test("legacy suffixed models (-high, -thinking) map to base + thought_level; retired/fixed models handle effort safely", async (t) => {
  const legacy = await createFakeAgy();
  t.after(() => legacy.instance.dispose());
  await legacy.send({ model: "gemini-3.8-flash-high" });
  await within(legacy.completed);
  assert.ok(legacy.requests().some((r) => r.method === "session/set_config_option" && r.params.configId === "model" && r.params.value === "gemini-3.8-flash"));
  assert.ok(legacy.requests().some((r) => r.method === "session/set_config_option" && r.params.configId === "thought_level" && r.params.value === "high"));
  assert.equal(legacy.events.some((e) => e.type === "runtime.error"), false);

  // Legacy -thinking suffix on a fixed base model with inherited turn.effort drops unsupported effort cleanly
  const thinkingFixed = await createFakeAgy();
  t.after(() => thinkingFixed.instance.dispose());
  await thinkingFixed.send({ model: "fixed-model-thinking", effort: "high" });
  await within(thinkingFixed.completed);
  assert.ok(thinkingFixed.requests().some((r) => r.method === "session/set_config_option" && r.params.configId === "model" && r.params.value === "fixed-model"));
  assert.equal(thinkingFixed.events.some((e) => e.type === "runtime.error"), false);
  assert.equal(thinkingFixed.events.find((e) => e.type === "turn.completed")?.ok, true);

  // Retired model swapped to a default model without thought_level tolerates inherited turn.effort
  const retired = await createFakeAgy({
    models: [{ value: "fixed-model", name: "Fixed Model", efforts: [] }],
  });
  t.after(() => retired.instance.dispose());
  await retired.send({ model: "gemini-3.7-flash-medium", effort: "high" });
  await within(retired.completed);
  const notice = retired.events.find((e) => e.type === "runtime.error");
  assert.match(notice?.type === "runtime.error" ? notice.message : "", /no longer offers gemini-3\.7-flash-medium on this account, so this turn runs on Fixed Model/);
  assert.equal(retired.events.find((e) => e.type === "turn.completed")?.ok, true);

  // Person turns suppress the swap notice
  const personTurn = await createFakeAgy({
    models: [{ value: "fixed-model", name: "Fixed Model", efforts: [] }],
  });
  t.after(() => personTurn.instance.dispose());
  await personTurn.send({ model: "gemini-3.7-flash-medium", person: { reply: async () => "ok" } });
  await within(personTurn.completed);
  assert.equal(personTurn.events.some((e) => e.type === "runtime.error"), false);
  assert.equal(personTurn.events.find((e) => e.type === "turn.completed")?.ok, true);
});

test("stall watchdog allows active progress, already-completed tool_call, and long permission waits with lastSign reset", async (t) => {
  // Already-completed tool_call must not stay open and trigger a false stall during quiet thinking
  const alreadyDone = await createFakeAgy({
    onPrompt: `
      update({ sessionUpdate: "tool_call", toolCallId: "c-done", kind: "read", title: "read_file", status: "completed" });
      await wait(700);
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      reply({ stopReason: "end_turn" });
    `,
  });
  t.after(() => alreadyDone.instance.dispose());
  await alreadyDone.send({ stallMs: 400 });
  await within(alreadyDone.completed);
  assert.equal(alreadyDone.events.some((e) => e.type === "runtime.error"), false);
  assert.equal(alreadyDone.events.find((e) => e.type === "turn.completed")?.ok, true);

  // Open tool + permission card waiting longer than stallMs must NOT stall; answering resets lastSign
  // Wait 350ms (> 250ms tick) after answer while tc-perm stays open so a missing reset deterministically stalls
  const perm = await createFakeAgy({
    onPrompt: `
      update({ sessionUpdate: "tool_call", toolCallId: "tc-perm", kind: "execute", title: "deploy" });
      await askClient("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "tc-perm", kind: "execute", title: "deploy" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      });
      await wait(350);
      update({ sessionUpdate: "tool_call_update", toolCallId: "tc-perm", status: "completed" });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
      reply({ stopReason: "end_turn" });
    `,
  });
  t.after(() => perm.instance.dispose());
  await perm.send({ stallMs: 600 });
  await until(() => perm.events.some((e) => e.type === "request.opened"), "permission card never opened");
  await wait(750);
  assert.equal(perm.events.some((e) => e.type === "runtime.error"), false, "stalled while waiting on user permission");
  const req = perm.events.find((e) => e.type === "request.opened")!;
  assert.equal(req.type, "request.opened");
  assert.ok(req.requestId);
  await perm.instance.adapter.respondToRequest("t1", req.requestId, { behavior: "allow" });
  await within(perm.completed);
  assert.equal(perm.events.some((e) => e.type === "runtime.error"), false, "stalled right after permission answered");
  assert.equal(perm.events.find((e) => e.type === "turn.completed")?.ok, true);
});

const silentWithDeafHelper = (onTerm = "") => `
  const { spawn } = await import("node:child_process");
  const cmd = spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 60_000)"],
    { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => cmd.stdout.once("data", r));
  writeFileSync("pids", JSON.stringify([process.pid, cmd.pid]));
  ${onTerm}
  update({ sessionUpdate: "tool_call", toolCallId: "tc-stuck", kind: "execute", title: "run_command", rawInput: { command: "sleep 60" } });
  await new Promise(() => {});
`;

test("stalled tool ends the turn only after process group dies, ignoring late frames", { skip: !OWN_GROUP }, async (t) => {
  const agy = await createFakeAgy({
    onPrompt: silentWithDeafHelper(`
      process.on("SIGTERM", () => {
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
        reply({ stopReason: "end_turn" });
        process.exit(0);
      });
    `),
  });
  let pids: number[] = [];
  t.after(async () => {
    await agy.instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await agy.send({ stallMs: 300 });
  await until(() => agy.events.some((e) => e.type === "runtime.error"), "stall was never declared");
  pids = JSON.parse(readFileSync(join(agy.dir, "pids"), "utf8"));
  await assert.rejects(agy.send({ text: "next" }), /already running/);
  await within(agy.completed);
  assert.deepEqual(pids.filter(running), [], "turn completed before agy and its helper exited");
  await wait(100);
  const errors = agy.events.filter((e) => e.type === "runtime.error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].type === "runtime.error" ? errors[0].message : "", /run_command/);
  assert.equal(agy.events.some((e) => e.type === "content.delta"), false, "late frame reached harness");
  const end = agy.events.at(-1);
  assert.equal(end?.type === "turn.completed" && end.ok, false);
  assert.equal(end?.type === "turn.completed" && end.stopReason, "tool_stalled");
});

test("Stop kills a SIGTERM-deaf agy even when stallMs is 0", async (t) => {
  const agy = await createFakeAgy({
    onPrompt: `
      process.on("SIGTERM", () => {});
      writeFileSync("pids", JSON.stringify([process.pid]));
      update({ sessionUpdate: "tool_call", toolCallId: "tc1", kind: "execute", title: "wait" });
      await new Promise(() => {});
    `,
  });
  let pids: number[] = [];
  t.after(async () => {
    await agy.instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await agy.send({ stallMs: 0 });
  await until(() => agy.events.some((e) => e.type === "item.started"), "tool never started");
  pids = JSON.parse(readFileSync(join(agy.dir, "pids"), "utf8"));
  await agy.instance.adapter.interruptTurn("t1");
  await within(agy.completed);
  assert.deepEqual(pids.filter(running), [], "agy outlived Stop");
  assert.equal(agy.events.some((e) => e.type === "runtime.error"), false);
  const end = agy.events.at(-1);
  assert.equal(end?.type === "turn.completed" && end.stopReason, "interrupted");
});

test("dispose during stall grace SIGKILLs orphaned helper without waiting out grace", { skip: !OWN_GROUP }, async (t) => {
  const agy = await createFakeAgy({ onPrompt: silentWithDeafHelper() });
  let pids: number[] = [];
  t.after(async () => {
    await agy.instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await agy.send({ stallMs: 300 });
  await until(() => agy.events.some((e) => e.type === "runtime.error"), "stall was never declared");
  pids = JSON.parse(readFileSync(join(agy.dir, "pids"), "utf8"));
  const [leader, helper] = pids;
  await until(() => !running(leader), "agy leader did not exit on SIGTERM");
  assert.ok(running(helper), "helper should still be alive before dispose");
  const began = Date.now();
  await agy.instance.dispose();
  assert.equal(running(helper), false, "dispose returned while helper was still running");
  assert.ok(Date.now() - began < SHUTDOWN_GRACE_MS, "dispose waited out the grace period");
});

test("minVersion rejects agy < 1.5.13, accepts 1.5.13+, keeps remote sign-in unknown, and run-export is partial", async (t) => {
  const old = await createFakeAgy({ version: "1.5.12" });
  t.after(() => old.instance.dispose());
  const oldSnap = await old.instance.snapshot();
  assert.equal(oldSnap.state, "unavailable");
  assert.match(oldSnap.reason ?? "", /1\.5\.13 or newer/);

  const current = await createFakeAgy({ version: "1.5.13" });
  t.after(() => current.instance.dispose());
  const curSnap = await current.instance.snapshot();
  assert.equal(curSnap.state, "available");
  assert.equal(curSnap.authenticated, undefined);

  // Remote workplace sign-in check must return null (unknown), not falsely true
  const remoteAuth = await signedInThere("antigravity", {
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as any);
  assert.equal(remoteAuth, null);

  assert.equal(engineResults("antigravity"), "partial");
});

test("permissionInput normalizes PascalCase Antigravity rawInput fields for policy and safety floor", () => {
  const cmdInput = permissionInput({
    kind: "execute",
    title: "rm -rf /",
    rawInput: { CommandLine: "rm -rf /", WaitMsBeforeAsync: 5000 },
  });
  assert.equal(cmdInput.command, "rm -rf /");
  const cmdTarget = targetOf("execute", cmdInput, { botId: "b1", agent: "agy" });
  assert.equal(cmdTarget.command, "rm -rf /");
  assert.ok(dangerous(cmdTarget), "safety floor must catch dangerous CommandLine");

  const fileInput = permissionInput({
    kind: "edit",
    rawInput: { Path: "/work/secret.env", Content: "x" },
  });
  assert.equal(fileInput.path, "/work/secret.env");
  assert.equal(targetOf("edit", fileInput, { botId: "b1", agent: "agy" }).path, "/work/secret.env");

  // Empty canonical key must not mask a non-empty PascalCase alias
  const masked = permissionInput({ rawInput: { command: "  ", CommandLine: "echo hi" } });
  assert.equal(masked.command, "echo hi");
});

test("Stop gives agy time to handle session/cancel so detached tool helpers are cleaned up before SIGTERM", { skip: !OWN_GROUP }, async (t) => {
  const agy = await createFakeAgy({
    onPrompt: `
      const { spawn } = await import("node:child_process");
      const helper = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 60_000)"], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      await new Promise((r) => helper.stdout.once("data", r));
      globalThis.__detachedHelper = helper;
      globalThis.__cancelReply = () => reply({ stopReason: "cancelled" });
      writeFileSync("pids", JSON.stringify([process.pid, helper.pid]));
      update({ sessionUpdate: "tool_call", toolCallId: "tc-pty", kind: "execute", title: "sleep 60" });
      await new Promise(() => {});
    `,
    onCancel: `
      if (globalThis.__detachedHelper) {
        try { process.kill(-globalThis.__detachedHelper.pid, "SIGKILL"); } catch {}
        try { globalThis.__detachedHelper.kill("SIGKILL"); } catch {}
      }
      setTimeout(() => globalThis.__cancelReply?.(), 60);
    `,
  });
  let pids: number[] = [];
  t.after(async () => {
    await agy.instance.dispose();
    for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  });
  await agy.send({ stallMs: 0 });
  await until(() => agy.events.some((e) => e.type === "item.started"), "tool never started");
  pids = JSON.parse(readFileSync(join(agy.dir, "pids"), "utf8"));
  const [leader, helper] = pids;
  assert.ok(running(helper), "detached helper should be running before Stop");
  await agy.instance.adapter.interruptTurn("t1");
  await within(agy.completed);
  assert.equal(running(leader), false, "agy leader outlived Stop");
  assert.equal(running(helper), false, "detached helper outlived Stop");
  assert.ok(agy.requests().some((r) => r.method === "session/cancel"));
  const end = agy.events.at(-1);
  assert.equal(end?.type === "turn.completed" && end.stopReason, "interrupted");
});
