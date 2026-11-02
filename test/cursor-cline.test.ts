// Cursor and Cline as engines of their own: found by their CLI (never the
// Cursor editor), started with the ACP flags their docs give, signed in
// as each says, too old turned away, and a CLI from elsewhere than PATH.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

import { CLI_DRIVERS } from "../server/agent-cli.ts";
import { instanceConfigs } from "../server/config.ts";
import { ACP_SPECS, acpDriver, signInFromOutput, tooOld } from "../server/drivers/acp.ts";
import { BUILT_IN_DRIVERS } from "../server/drivers/builtIn.ts";
import { ENGINE_SETUP, checkEnginePath } from "../server/engine-setup.ts";
import { ENGINE_PACKAGES } from "../server/engine-updates.ts";
import { widenPath } from "../server/path.ts";
import { CLI_PROVIDERS } from "../server/providers.ts";
import { startHarness } from "./helpers/server.ts";

const spec = (kind: string) => ACP_SPECS.find((s) => s.kind === kind)!;

test("Cursor is the Cursor CLI in ACP mode, never the editor", () => {
  const cursor = spec("cursor");
  assert.equal(cursor.command, "cursor-agent");
  assert.deepEqual(cursor.args, ["acp"]);
  assert.equal(cursor.authMethod, "cursor_login");
  assert.equal(cursor.probeModels, true);
  assert.equal(cursor.turnArgs, undefined, "approvals go through the protocol, not a flag");
  assert.equal(ENGINE_SETUP.cursor.install, "curl https://cursor.com/install -fsS | bash");
  assert.equal(ENGINE_SETUP.cursor.signIn, "cursor-agent login");
  assert.equal(CLI_PROVIDERS.find((p) => p.kind === "cursor")?.command, "cursor-agent");
});

test("Cline is started with --acp, and auto-approves only on Full auto", () => {
  const cline = spec("cline");
  assert.equal(cline.command, "cline");
  assert.deepEqual(cline.args, ["--acp"]);
  assert.equal(cline.minVersion, "3.0.68");
  assert.deepEqual(cline.turnArgs?.({ fullAuto: true }), ["--auto-approve", "true"]);
  assert.deepEqual(cline.turnArgs?.({ fullAuto: false }), []);
  assert.equal(ENGINE_SETUP.cline.signIn, "cline auth");
  assert.match(ENGINE_SETUP.cline.install, /npm install -g --prefix "\$HOME\/\.local" cline$/);
  assert.equal(ENGINE_PACKAGES.cline.pkg, "cline");
  assert.equal(ENGINE_PACKAGES.cursor, undefined, "Cursor updates itself and is not on npm");
});

test("both are registered, in the default fleet, and get an agent credential", () => {
  for (const kind of ["cursor", "cline"]) {
    assert.ok(BUILT_IN_DRIVERS.some((d) => d.driverKind === kind), kind);
    assert.ok(CLI_PROVIDERS.some((p) => p.kind === kind), kind);
    assert.ok(CLI_DRIVERS.has(kind), kind);
    assert.ok(Object.values(instanceConfigs({})).some((e) => e.driver === kind), kind);
    // a workspace whose instances map predates them still gets them
    const saved = instanceConfigs({ instances: { claude: { driver: "claudeAgent" } } });
    assert.ok(Object.values(saved).some((e) => e.driver === kind), kind);
  }
});

test("a sign-in check reads signed out before signed in, and says unknown otherwise", () => {
  const check = spec("cursor").signInCheck!;
  assert.equal(signInFromOutput(check, "Not logged in. Run cursor-agent login."), false);
  assert.equal(signInFromOutput(check, "✓ Logged in as someone@example.com"), true);
  assert.equal(signInFromOutput(check, "Cursor Agent 2026.10.21"), undefined);
});

test("too old is a reason only for a version that can be read and is older", () => {
  const cline = spec("cline");
  assert.match(tooOld(cline, "3.0.60") ?? "", /Cline 3\.0\.60 is too old for Bloks, which needs 3\.0\.68 or newer/);
  assert.equal(tooOld(cline, "3.0.68"), null);
  assert.equal(tooOld(cline, "cline 3.1.0"), null);
  assert.equal(tooOld(cline, "dev build"), null);
  assert.equal(tooOld(spec("cursor"), "1.0.0"), null, "no floor, no reason");
});

// ── a fake CLI on PATH, speaking just enough ACP ──────────────────────

interface Fake {
  /** What --version prints. */
  version: string;
  /** What `status` prints, for a CLI that has one. */
  status?: string;
  /** What initialize offers to authenticate with. */
  authMethods?: Array<{ id: string; name: string }>;
  /** authenticate answers with an error. */
  refuseAuth?: boolean;
}

function fakeScript(home: string, fake: Fake): string {
  const log = join(home, "calls.ndjson");
  return [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const log = ${JSON.stringify(log)};`,
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(log, JSON.stringify({ argv: args }) + '\\n');",
    `if (args[0] === '--version') { console.log(${JSON.stringify(fake.version)}); process.exit(0); }`,
    `if (args[0] === 'status') { console.log(${JSON.stringify(fake.status ?? "")}); process.exit(0); }`,
    "const say = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
    "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
    "  let msg; try { msg = JSON.parse(line); } catch { return; }",
    "  if (msg.id === undefined || !msg.method) return;",
    "  fs.appendFileSync(log, JSON.stringify({ method: msg.method, params: msg.params }) + '\\n');",
    "  const reply = (result) => say({ jsonrpc: '2.0', id: msg.id, result });",
    `  if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: ${JSON.stringify(fake.authMethods ?? [])} });`,
    `  else if (msg.method === 'authenticate') ${fake.refuseAuth ? "say({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } })" : "reply({})"};`,
    "  else if (msg.method === 'session/new') reply({ sessionId: 's1', models: { availableModels: [",
    "    { modelId: 'model-a', name: 'Model A' }, { modelId: 'model-b', name: 'Model B' } ], currentModelId: 'model-a' } });",
    "  else if (msg.method === 'session/prompt') {",
    "    say({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1',",
    "      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } } });",
    "    reply({ stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } });",
    "  } else reply({});",
    "});",
  ].join("\n");
}

/** A home of its own with only the named CLIs on PATH, so nothing
 * installed on this machine is ever run. */
async function withFakes(
  fakes: Record<string, Fake>,
  fn: (ctx: { home: string; bin: string; calls: () => any[] }) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), "bloks-cursor-cline-"));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, fake] of Object.entries(fakes)) writeFileSync(join(bin, name), fakeScript(home, fake) + "\n", { mode: 0o755 });
  const prev = { HOME: process.env.HOME, PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, CURSOR_API_KEY: process.env.CURSOR_API_KEY, CLINE_API_KEY: process.env.CLINE_API_KEY };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PATH = bin + delimiter + dirname(process.execPath);
  delete process.env.CURSOR_API_KEY;
  delete process.env.CLINE_API_KEY;
  widenPath();
  const log = join(home, "calls.ndjson");
  try {
    await fn({
      home,
      bin,
      calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    });
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // a fake CLI the harness stopped can still be writing its last file
    // here for a moment on a slow machine; that is not this test's failure
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
}

async function create(kind: string, config: Record<string, unknown> = {}, environment: Record<string, string> = {}) {
  return acpDriver(spec(kind)).create({
    instanceId: kind,
    displayName: spec(kind).name,
    enabled: true,
    config: { cli: spec(kind).command, fullAuto: false, ...config },
    environment,
  });
}

async function turn(inst: Awaited<ReturnType<typeof create>>, untrusted = false) {
  const events: any[] = [];
  inst.adapter.onEvent((e) => events.push(e));
  await inst.adapter.sendTurn({ threadId: "t1", text: "Tidy the readme.", ...(untrusted ? { untrusted: true } : {}) });
  for (let i = 0; i < 80 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 50));
  return events;
}

test("only cursor-agent counts as Cursor: the editor's cursor command is not an engine", async () => {
  await withFakes({ cursor: { version: "1.110.0" } }, async () => {
    const inst = await create("cursor");
    const snap = await inst.snapshot();
    assert.equal(snap.state, "unavailable");
    assert.match(snap.reason ?? "", /cursor-agent/);
    await inst.dispose();
  });
});

test("Cursor's sign-in comes from cursor-agent status", async () => {
  await withFakes({ "cursor-agent": { version: "2026.10.21-abc", status: "Not logged in" } }, async () => {
    const inst = await create("cursor");
    const snap = await inst.snapshot();
    assert.equal(snap.state, "available");
    assert.equal(snap.version, "Cursor 2026.10.21-abc");
    assert.equal(snap.authenticated, false);
    await inst.dispose();
  });
  await withFakes({ "cursor-agent": { version: "2026.10.21", status: "Logged in as someone@example.com" } }, async () => {
    const inst = await create("cursor");
    assert.equal((await inst.snapshot()).authenticated, true);
    await inst.dispose();
  });
  // a key saved under Cursor's own name is a sign-in, and no process is asked
  await withFakes({ "cursor-agent": { version: "2026.10.21", status: "Not logged in" } }, async ({ calls }) => {
    const inst = await create("cursor", {}, { CURSOR_API_KEY: "test-key" });
    assert.equal((await inst.snapshot()).authenticated, true);
    assert.ok(!calls().some((c) => c.argv?.[0] === "status"));
    await inst.dispose();
  });
});

test("Cline older than 3.0.68 is turned away with the reason; a new one is unknown until it signs in", async () => {
  await withFakes({ cline: { version: "3.0.60" } }, async () => {
    const inst = await create("cline");
    const snap = await inst.snapshot();
    assert.equal(snap.state, "unavailable");
    assert.match(snap.reason ?? "", /3\.0\.68 or newer/);
    assert.equal(snap.version, "Cline 3.0.60", "the version rides along, so the row can offer an update");
    await inst.dispose();
  });
  await withFakes({ cline: { version: "3.0.68" } }, async ({ home }) => {
    const inst = await create("cline");
    let snap = await inst.snapshot();
    assert.equal(snap.state, "available");
    assert.equal(snap.authenticated, undefined, "no file is not proof of signed out");
    mkdirSync(join(home, ".cline", "data", "settings"), { recursive: true });
    writeFileSync(join(home, ".cline", "data", "settings", "providers.json"), "{}");
    snap = await inst.snapshot();
    assert.equal(snap.authenticated, true);
    await inst.dispose();
  });
});

test("a Cursor turn authenticates with cursor_login before its session, and lists the real models", async () => {
  await withFakes(
    { "cursor-agent": { version: "2026.10.21", status: "Logged in", authMethods: [{ id: "cursor_login", name: "Log in with Cursor" }] } },
    async ({ calls }) => {
      const inst = await create("cursor");
      await inst.catalogReady;
      assert.deepEqual(inst.models.options.map((m) => m.id), ["model-a", "model-b"]);
      const events = await turn(inst);
      assert.ok(events.some((e) => e.type === "turn.completed" && e.ok === true), JSON.stringify(events));
      assert.ok(events.some((e) => e.type === "thread.token-usage.updated" && e.input === 12 && e.output === 3), "usage is counted like any ACP engine");
      const turnCalls = calls().filter((c) => c.method);
      const methods = turnCalls.map((c) => c.method);
      const auth = methods.lastIndexOf("authenticate");
      assert.ok(auth > -1);
      assert.ok(auth < methods.lastIndexOf("session/new"), "authenticate comes first");
      assert.deepEqual(turnCalls.filter((c) => c.method === "authenticate").at(-1).params, { methodId: "cursor_login" });
      const launches = calls().filter((c) => c.argv && c.argv[0] !== "--version" && c.argv[0] !== "status");
      assert.ok(launches.length >= 1);
      for (const launch of launches) assert.deepEqual(launch.argv, ["acp"]);
      await inst.dispose();
    },
  );
});

test("a refused authenticate says signed out and what to run", async () => {
  await withFakes(
    { "cursor-agent": { version: "2026.10.21", authMethods: [{ id: "cursor_login", name: "Log in" }], refuseAuth: true } },
    async ({ calls }) => {
      const inst = await create("cursor");
      const events = await turn(inst);
      const error = events.find((e) => e.type === "runtime.error");
      assert.match(error?.message ?? "", /Cursor is not signed in .*run `cursor-agent login` in a terminal/);
      assert.ok(events.some((e) => e.type === "turn.completed" && e.ok === false));
      assert.ok(!calls().some((c) => c.method === "session/prompt"), "nothing is sent signed out");
      await inst.dispose();
    },
  );
});

test("an agent that does not offer the method is not asked to authenticate", async () => {
  await withFakes({ "cursor-agent": { version: "2026.10.21" } }, async ({ calls }) => {
    const inst = await create("cursor");
    await turn(inst);
    assert.ok(!calls().some((c) => c.method === "authenticate"));
    await inst.dispose();
  });
});

test("Cline's launch arguments follow Full auto, and an untrusted turn never auto-approves", async () => {
  const launchArgs = (calls: any[]) => calls.filter((c) => c.argv && c.argv[0] === "--acp").map((c) => c.argv);
  await withFakes({ cline: { version: "3.0.70" } }, async ({ calls }) => {
    const ask = await create("cline", { fullAuto: false });
    await ask.catalogReady;
    await turn(ask);
    await ask.dispose();
    const auto = await create("cline", { fullAuto: true });
    await auto.catalogReady;
    await turn(auto);
    const before = launchArgs(calls()).length;
    await turn(auto, true);
    await auto.dispose();
    const all = launchArgs(calls());
    // probes start --acp too, with no flags; the turns are the ones after
    assert.ok(all.some((argv) => argv.join(" ") === "--acp --auto-approve true"));
    assert.deepEqual(all.at(-1), ["--acp"], "the untrusted turn asks");
    assert.equal(all.length, before + 1);
  });
});

// ── a CLI from somewhere other than PATH ──────────────────────────────

test("a path is a whole path to a file that runs, and never the Cursor editor", () => {
  const home = mkdtempSync(join(tmpdir(), "bloks-engine-path-"));
  try {
    const cli = join(home, "cursor-agent");
    writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
    const plain = join(home, "notes.txt");
    writeFileSync(plain, "hello", { mode: 0o644 });
    const editor = join(home, "cursor");
    writeFileSync(editor, "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(checkEnginePath("cursor", cli, home), { path: cli });
    assert.deepEqual(checkEnginePath("cursor", "~/cursor-agent", home), { path: cli });
    assert.match((checkEnginePath("cursor", editor, home) as any).error, /Cursor editor/);
    assert.match((checkEnginePath("cline", "bin/cline", home) as any).error, /full path/);
    assert.match((checkEnginePath("cline", join(home, "missing"), home) as any).error, /Nothing is at/);
    assert.match((checkEnginePath("cline", home, home) as any).error, /folder/);
    if (process.platform !== "win32") assert.match((checkEnginePath("cline", plain, home) as any).error, /cannot be run/);
    assert.match((checkEnginePath("cline", "/x\n/y", home) as any).error, /characters/);
    assert.match((checkEnginePath("cline", "", home) as any).error, /full path/);
  } finally {
    // a fake CLI the harness stopped can still be writing its last file
    // here for a moment on a slow machine; that is not this test's failure
    try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
  }
});

test("a chosen path reaches every instance of that engine that names none of its own", () => {
  const map = instanceConfigs({
    enginePaths: { cline: "/opt/cline/bin/cline" },
    instances: { cline: { driver: "cline" }, mine: { driver: "cline", config: { cli: "/elsewhere/cline" } } },
  });
  assert.equal((map.cline.config as any).cli, "/opt/cline/bin/cline");
  assert.equal((map.mine.config as any).cli, "/elsewhere/cline", "an instance's own path wins");
  assert.equal((Object.values(map).find((e) => e.driver === "cursor")?.config as any)?.cli, undefined);
});

test("the path route keeps a good path, refuses a bad one, forgets on null, and is this machine's only", async () => {
  const h = await startHarness();
  try {
    const cli = join(h.home, "cline-dev");
    writeFileSync(cli, "#!/bin/sh\necho 3.0.70\n", { mode: 0o755 });
    const put = (body: unknown) => h.fetch("/api/engines/cline/path", { method: "PUT", body: JSON.stringify(body) });

    const bad = await put({ path: join(h.home, "nope") });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Nothing is at/);

    const ok = await put({ path: cli });
    assert.equal(ok.status, 200);
    const row = (await ok.json()).providers.find((p: any) => p.kind === "cline");
    assert.equal(row.path, cli);
    assert.equal(row.command, "cline");
    const saved = JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8"));
    assert.equal(saved.enginePaths.cline, cli);

    const instances = (await h.json("/api/instances")).instances;
    const cline = instances.find((i: any) => i.driverKind === "cline");
    assert.equal(cline.snapshot.state, "available", "started from the chosen copy, though PATH has none");

    const editor = await h.fetch("/api/engines/cursor/path", { method: "PUT", body: JSON.stringify({ path: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" }) });
    assert.equal(editor.status, 400);

    const unknown = await h.fetch("/api/engines/nothing/path", { method: "PUT", body: JSON.stringify({ path: cli }) });
    assert.equal(unknown.status, 404);

    const remote = await h.fetchRemote("/api/engines/cline/path", { method: "PUT", body: JSON.stringify({ path: null }) });
    assert.notEqual(remote.status, 200, "a window elsewhere cannot choose what runs here");

    const back = await put({ path: null });
    assert.equal(back.status, 200);
    assert.equal(JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8")).enginePaths?.cline, undefined);
  } finally {
    await h.stop();
  }
});

test("a too-old Cline shows as outdated on the engines screen, not as missing", async () => {
  const h = await startHarness();
  try {
    const bin = join(h.home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "cline"), "#!/bin/sh\necho 3.0.12\n", { mode: 0o755 });
    const { providers } = await h.json("/api/providers");
    const row = providers.find((p: any) => p.kind === "cline");
    assert.equal(row.connected, false);
    assert.equal(row.outdated, true);
    const cursor = providers.find((p: any) => p.kind === "cursor");
    assert.equal(cursor.outdated, false);
  } finally {
    await h.stop();
  }
});
