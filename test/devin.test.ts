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
const session = { sessionId: "s1", modes: { currentModeId: options.startIn ?? "accept-edits", availableModes: ids.map((id) => ({ id })) } };
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  else if (msg.method === "session/new" || msg.method === "session/load") send({ id: msg.id, result: session });
  else if (msg.method === "session/prompt") {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  } else send({ id: msg.id, result: {} });
});
`,
  );
  // node runs the stand-in on every platform; no real Devin or account
  const spec = { ...devin(), command: process.execPath, args: [cli], probeModels: false, signInCheck: undefined };
  const instance = await acpDriver(spec).create({
    instanceId: "devin",
    displayName: "Devin",
    enabled: true,
    environment: {},
    config: { cli: process.execPath, fullAuto: options.fullAuto === true },
  });
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
    });
    const ok = await done;
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { modeId?: string } });
    const modeAt = requests.findIndex((request) => request.method === "session/set_mode");
    const promptAt = requests.findIndex((request) => request.method === "session/prompt");
    return { mode: requests[modeAt]?.params.modeId, modeAt, promptAt, ok, error };
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
