// OpenCode's own setup for a workspace (GitHub 484).
//
// With the setting on, turns on this computer point OpenCode at folders
// of the workspace's own. The providers the person already connected are
// brought over once: OpenCode 2's export piped into its import (stdin,
// never argv), or 1.x's auth.json copied, private, never wider than where
// it came from. A turn in a workplace keeps the OpenCode there as it is.
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";

import type { PlaceRun, RuntimeEvent } from "../server/contracts.ts";
import { leftOutBecause } from "../server/backup.ts";
import { DATA_DIR, instanceConfigs } from "../server/config.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";
import { isolatedOpencodeEnv, isolatedOpencodePaths, isolatedOpencodeSignInCommand, seedOpencodeSignIns } from "../server/opencode-setup.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-opencode-setup-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const dir = join(scratch, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const mode = (path: string) => statSync(path).mode & 0o777;
const posix = process.platform !== "win32";

/** The person's own OpenCode: a home, its XDG data folder, and a fake
 * CLI that writes down how it was called and does what OpenCode 2's
 * `auth export` and `auth import` do. */
function person(opts: { db?: boolean; auth?: string; exported?: string; exportFails?: boolean } = {}) {
  const home = fresh("home");
  const theirs = join(home, ".local", "share", "opencode");
  mkdirSync(theirs, { recursive: true });
  if (opts.db) writeFileSync(join(theirs, "opencode.db"), "");
  if (opts.auth !== undefined) writeFileSync(join(theirs, "auth.json"), opts.auth, { mode: 0o600 });
  const log = join(home, "calls.log");
  const exportFile = join(home, "export.json");
  writeFileSync(exportFile, opts.exported ?? "[]\n");
  const cli = join(home, "opencode");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, data: process.env.XDG_DATA_HOME ?? null, config: process.env.OPENCODE_CONFIG_DIR ?? null }) + "\\n");
if (args[0] === "auth" && args[1] === "export") {
  if (process.env.FAKE_EXPORT_FAILS) { process.stderr.write("unknown command\\n"); process.exit(1); }
  process.stdout.write(readFileSync(process.env.FAKE_EXPORT, "utf8"));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "import") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const dir = join(process.env.XDG_DATA_HOME, "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "imported.json"), Buffer.concat(chunks));
  process.exit(0);
}
process.exit(2);
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    FAKE_LOG: log,
    FAKE_EXPORT: exportFile,
    ...(opts.exportFails ? { FAKE_EXPORT_FAILS: "1" } : {}),
  };
  const calls = (): Array<{ args: string[]; data: string | null; config: string | null }> =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { home, theirs, cli, env, calls, log };
}

/** A provider key shaped like a real one, made here so no key is ever
 * written in a file. */
const fakeKey = () => ["sk", "test", randomBytes(12).toString("hex")].join("-");

test("the variables point every OpenCode folder inside the workspace's, made private", () => {
  const data = fresh("data");
  const env = isolatedOpencodeEnv(data);
  const paths = isolatedOpencodePaths(data);
  assert.equal(paths.root, join(data, "opencode"));
  assert.deepEqual(env, {
    OPENCODE_CONFIG_DIR: join(data, "opencode", "config"),
    XDG_CONFIG_HOME: join(data, "opencode", "config"),
    XDG_DATA_HOME: join(data, "opencode", "data"),
    XDG_STATE_HOME: join(data, "opencode", "state"),
    XDG_CACHE_HOME: join(data, "opencode", "cache"),
  });
  assert.deepEqual(JSON.parse(readFileSync(join(paths.configDir, "service.json"), "utf8")), { disabled: true });
  assert.deepEqual(JSON.parse(readFileSync(join(paths.configDir, "service-local.json"), "utf8")), { disabled: true });
  if (posix) {
    assert.equal(mode(paths.root), 0o700);
    assert.equal(mode(paths.opencodeDataDir), 0o700);
    assert.equal(mode(join(paths.configDir, "service.json")), 0o600);
  }
  // a service file the person changed there is theirs
  writeFileSync(join(paths.configDir, "service.json"), JSON.stringify({ disabled: false, port: 4097 }));
  isolatedOpencodeEnv(data);
  assert.equal(JSON.parse(readFileSync(join(paths.configDir, "service.json"), "utf8")).port, 4097);
  // and the folder is left out of backups and moves
  assert.equal(leftOutBecause("opencode", true, false), "engine sign-ins, which stay on this computer");
  assert.equal(leftOutBecause("workspaces/opencode", true, false), null, "only the workspace's own, not a folder an agent made");
});

test("the setting reaches every OpenCode engine, unless one's own config says otherwise", () => {
  assert.equal((instanceConfigs({}).opencode?.config as { isolated?: boolean } | undefined)?.isolated, undefined);
  assert.equal((instanceConfigs({ opencode: { isolated: true } }).opencode?.config as { isolated?: boolean }).isolated, true);
  const own = instanceConfigs({ opencode: { isolated: true }, instances: { opencode: { driver: "opencode", config: { isolated: false } } } });
  assert.equal((own.opencode?.config as { isolated?: boolean }).isolated, false);
  assert.equal((instanceConfigs({ opencode: { isolated: true } }).codex?.config as { isolated?: boolean } | undefined)?.isolated, undefined);
});

test("OpenCode 2's sign-ins come over through its own export and import, once, never through argv", { skip: !posix }, async () => {
  const key = fakeKey();
  const exported = JSON.stringify([{ id: "cred_1", integrationID: "anthropic", label: "Work", active: true, value: { type: "api", key } }], null, 2) + "\n";
  const p = person({ db: true, auth: JSON.stringify({ anthropic: { type: "api", key: "stale" } }), exported });
  const data = fresh("data");
  const paths = isolatedOpencodePaths(data);

  assert.equal(await seedOpencodeSignIns(p.cli, data, p.env, p.home), "imported");
  assert.equal(readFileSync(join(paths.opencodeDataDir, "imported.json"), "utf8"), exported, "the export went to the import's stdin as it was");
  const calls = p.calls();
  assert.deepEqual(calls.map((c) => c.args), [["auth", "export", "--standalone"], ["auth", "import", "--standalone"]]);
  assert.equal(calls[0].data, null, "the export read the person's own OpenCode");
  assert.equal(calls[1].data, paths.dataDir, "the import wrote the workspace's");
  assert.equal(calls[1].config, paths.configDir);
  assert.ok(!readFileSync(p.log, "utf8").includes(key), "the key was on a command line");
  assert.equal(existsSync(join(paths.opencodeDataDir, "auth.json")), false, "the old 1.x file came too, beside what OpenCode 2 said");

  // once: what is connected or signed out of later is the person's doing
  rmSync(join(paths.opencodeDataDir, "imported.json"));
  assert.equal(await seedOpencodeSignIns(p.cli, data, p.env, p.home), "none");
  assert.equal(p.calls().length, 2);
  assert.equal(existsSync(join(paths.opencodeDataDir, "imported.json")), false);
});

test("an OpenCode 2 with nothing connected brings nothing, not an old 1.x file", { skip: !posix }, async () => {
  const p = person({ db: true, auth: JSON.stringify({ openai: { type: "api", key: fakeKey() } }), exported: "[]\n" });
  const data = fresh("data");
  assert.equal(await seedOpencodeSignIns(p.cli, data, p.env, p.home), "none");
  assert.deepEqual(p.calls().map((c) => c.args), [["auth", "export", "--standalone"]], "an empty export was imported");
  assert.equal(existsSync(join(isolatedOpencodePaths(data).opencodeDataDir, "auth.json")), false);
});

test("an export that fails falls back to 1.x's auth.json, private, and to nothing when there is none", { skip: !posix }, async () => {
  const auth = JSON.stringify({ anthropic: { type: "api", key: fakeKey() } });
  const p = person({ db: true, auth, exportFails: true });
  const data = fresh("data");
  const paths = isolatedOpencodePaths(data);
  assert.equal(await seedOpencodeSignIns(p.cli, data, p.env, p.home), "copied");
  const copy = join(paths.opencodeDataDir, "auth.json");
  assert.equal(readFileSync(copy, "utf8"), auth);
  assert.equal(mode(copy), 0o600);
  assert.equal(mode(paths.root), 0o700);
  assert.deepEqual(p.calls().map((c) => c.args), [["auth", "export", "--standalone"]], "a failed export went on to an import");

  const none = person({ db: true, exportFails: true });
  const empty = fresh("data");
  assert.equal(await seedOpencodeSignIns(none.cli, empty, none.env, none.home), "none");
  assert.equal(existsSync(join(isolatedOpencodePaths(empty).opencodeDataDir, "auth.json")), false);
});

test("1.x's auth.json is copied without running anything, and a person with no OpenCode sign-in gets none, for good", { skip: !posix }, async () => {
  const auth = JSON.stringify({ openrouter: { type: "api", key: fakeKey() } });
  const p = person({ auth });
  const data = fresh("data");
  assert.equal(await seedOpencodeSignIns(p.cli, data, p.env, p.home), "copied");
  assert.equal(readFileSync(join(isolatedOpencodePaths(data).opencodeDataDir, "auth.json"), "utf8"), auth);
  assert.equal(p.calls().length, 0, "no database, so no OpenCode 2 to ask");

  const bare = person();
  const later = fresh("data");
  assert.equal(await seedOpencodeSignIns(bare.cli, later, bare.env, bare.home), "none");
  // a provider the person connects in their own OpenCode afterwards stays theirs
  writeFileSync(join(bare.theirs, "auth.json"), auth, { mode: 0o600 });
  assert.equal(await seedOpencodeSignIns(bare.cli, later, bare.env, bare.home), "none");
  assert.equal(existsSync(join(isolatedOpencodePaths(later).opencodeDataDir, "auth.json")), false);
});

test("an XDG data folder the person moved is where their sign-ins are read from", async () => {
  const p = person();
  const moved = join(fresh("xdg"), "opencode");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "auth.json"), "{}", { mode: 0o600 });
  const data = fresh("data");
  assert.equal(await seedOpencodeSignIns(p.cli, data, { ...p.env, XDG_DATA_HOME: join(moved, "..") }, p.home), "copied");
});

test("Connect a provider signs in to the workspace's setup, quoted for the shell it runs in", { skip: !posix }, () => {
  const data = join(fresh("it's here"), "data dir");
  const command = isolatedOpencodeSignInCommand("opencode", data, "darwin");
  assert.match(command, /^OPENCODE_CONFIG_DIR='.*' XDG_CONFIG_HOME='.*' XDG_DATA_HOME='.*' XDG_STATE_HOME='.*' XDG_CACHE_HOME='.*' opencode auth login$/);
  // the shell reads back the same paths, quote and space and all
  const echo = join(fresh("bin"), "echo-env");
  writeFileSync(echo, `#!${process.execPath}\nconsole.log(JSON.stringify({ data: process.env.XDG_DATA_HOME, config: process.env.OPENCODE_CONFIG_DIR, args: process.argv.slice(2) }));\n`, { mode: 0o755 });
  const said = JSON.parse(execFileSync("/bin/sh", ["-c", isolatedOpencodeSignInCommand(echo, data, "linux")], { encoding: "utf8" }));
  assert.deepEqual(said, { data: isolatedOpencodePaths(data).dataDir, config: isolatedOpencodePaths(data).configDir, args: ["auth", "login"] });

  const windows = isolatedOpencodeSignInCommand("C:\\Program Files\\opencode.cmd", "C:\\Users\\a\\.bloks", "win32");
  assert.match(windows, /^\$env:OPENCODE_CONFIG_DIR=".*"; \$env:XDG_CONFIG_HOME=".*"; .*; "C:\\Program Files\\opencode\.cmd" auth login$/);
});

// ── the driver ───────────────────────────────────────────────────────────

/** An OpenCode that answers every request, and what each process it was
 * started as was handed. */
function fakeAgent(t: TestContext) {
  const envs: Array<Record<string, string | undefined>> = [];
  const proc = (env: Record<string, string | undefined> | undefined) => {
    envs.push(env ?? {});
    const out = new PassThrough();
    const send = (msg: unknown) => out.write(JSON.stringify(msg) + "\n");
    const child: EventEmitter = Object.assign(new EventEmitter(), {
      stdout: out,
      stderr: new PassThrough(),
      pid: undefined,
      kill() {
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      },
      stdin: new Writable({
        write(chunk, _encoding, done) {
          for (const line of String(chunk).split("\n").filter(Boolean)) {
            const frame = JSON.parse(line);
            if (frame.method && frame.id !== undefined) {
              queueMicrotask(() => {
                if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
                if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "s1" } });
                if (frame.method === "session/prompt") {
                  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
                  return send({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "end_turn" } });
                }
                send({ jsonrpc: "2.0", id: frame.id, result: {} });
              });
            }
          }
          done();
        },
      }),
    });
    return child;
  };
  t.mock.method(childProcess, "spawn", (_command: string, _args: string[], options?: { env?: Record<string, string | undefined> }) => proc(options?.env));
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  // the person's own OpenCode is nowhere here, so there is nothing to
  // bring over and nothing real is read
  const prev = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.HOME = fresh("home");
  process.env.XDG_DATA_HOME = fresh("xdg");
  t.after(() => {
    process.env.HOME = prev.HOME;
    if (prev.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev.XDG_DATA_HOME;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { envs, proc };
}

async function opencode(t: TestContext, isolated: boolean) {
  const spec = ACP_SPECS.find((s) => s.kind === "opencode")!;
  const instance = await acpDriver(spec).create({
    instanceId: "opencode", displayName: "OpenCode", enabled: true, environment: {},
    config: { cli: "fake-opencode", fullAuto: false, ...(isolated ? { isolated: true } : {}) },
  });
  t.after(() => instance.dispose());
  await instance.catalogReady;
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event: RuntimeEvent) => events.push(event));
  const ended = async () => {
    for (let i = 0; i < 400 && !events.some((e) => e.type === "turn.completed"); i++) await setImmediate();
    assert.ok(events.some((e) => e.type === "turn.completed"), "the turn did not end");
    events.length = 0;
  };
  return { instance, ended };
}

test("a local OpenCode turn runs on the workspace's setup; one in a workplace runs on the setup there", async (t) => {
  const agent = fakeAgent(t);
  const { instance, ended } = await opencode(t, true);
  const ours = isolatedOpencodeEnv(DATA_DIR);
  assert.equal(agent.envs[0]?.XDG_DATA_HOME, ours.XDG_DATA_HOME, "the model probe read the person's own setup");

  await instance.adapter.sendTurn({ threadId: "here", text: "hello" });
  await ended();
  const local = agent.envs.at(-1)!;
  for (const [name, value] of Object.entries(ours)) assert.equal(local[name], value, name);

  let there: Record<string, string | undefined> | undefined;
  const place: PlaceRun = {
    label: "container scout",
    cwd: "/work",
    spawn: (_command, _args, options) => {
      there = options?.env;
      return agent.proc(options?.env) as unknown as ReturnType<PlaceRun["spawn"]>;
    },
    file: (name) => `/tmp/${name}`,
    mcp: () => null,
  };
  await instance.adapter.sendTurn({ threadId: "there", text: "hello", place });
  await ended();
  assert.ok(there, "the turn did not start in the workplace");
  assert.equal(there.OPENCODE_CONFIG_DIR, undefined, "this computer's folders went to the workplace");
  assert.notEqual(there.XDG_DATA_HOME, ours.XDG_DATA_HOME);
});

test("with the setting off, OpenCode runs on the person's own setup as before", async (t) => {
  const agent = fakeAgent(t);
  const { instance, ended } = await opencode(t, false);
  await instance.adapter.sendTurn({ threadId: "here", text: "hello" });
  await ended();
  const env = agent.envs.at(-1)!;
  assert.equal(env.OPENCODE_CONFIG_DIR, process.env.OPENCODE_CONFIG_DIR);
  assert.equal(env.XDG_DATA_HOME, process.env.XDG_DATA_HOME);
});
