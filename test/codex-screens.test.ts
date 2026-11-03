// GitHub 482: an agent on Codex with Its own browser on, or set to the
// Local VM, this Mac or the cloud box, got neither, and was told to move
// to another engine. Codex now takes the same browser and computer
// servers Claude Code and the ACP agents do, in the thread's own config
// on every start, resume and fork, pre-allowed on the owner's own turns
// as Claude Code has them, never on anybody else's, reached through the
// gate when the agent works elsewhere, and with the box's key out of
// argv, the app-server's environment and everything written down.
//
// A stand-in app-server answers here, with spawn mocked, and writes down
// every frame Bloks sends it; the native copy is written for real into a
// throwaway data folder.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";

import type { PlaceRun, RuntimeEvent, SendTurnInput } from "../server/contracts.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-codex-screens-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
mkdirSync(join(home, ".bloks", "native"), { recursive: true });
const { CodexDriver, SCREENS_REFUSED_NOTICE, SERVERS_REFUSED_NOTICE, screenConfig } = await import("../server/drivers/codex.ts");
const { ALL_SCREENS } = await import("../server/screens.ts");
after(() => rmSync(home, { recursive: true, force: true }));

/** Made up at runtime, long enough to be taken for keys. */
const secret = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;

/** What the harness hands a turn with Its own browser on and the Local VM
 * claimed: the VM's bridge contract, as local-vm.ts writes it. */
const VM = { command: "/opt/bloks/node", args: ["/opt/bloks/local-vm-mcp.js", "docker", "bloks-vm", "/tmp/vm.sock"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const BROWSER = { profileDir: join(home, ".bloks", "browser", "agent-1") };
const BOTH: SendTurnInput["integrations"] = { browser: BROWSER, localComputer: VM };

interface Fake {
  /** An error message for a request this Codex refuses, or null. */
  refuse?: (frame: any) => string | null;
}

let lanes = 0;

async function setup(t: TestContext, fake: Fake = {}) {
  const lane = `screens-lane-${++lanes}`;
  const frames: any[] = [];
  const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  t.mock.method(childProcess, "spawn", (_cli: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
    spawned.push({ args: [...args], env: { ...(options?.env ?? {}) } });
    return appServer(frames, fake);
  });
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({
    instanceId: "codex", displayName: "Codex", enabled: true, environment: {},
    config: { cli: "fake-codex", fullAuto: false },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => {
    await instance.dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function turn(extra: Partial<SendTurnInput>) {
    const before = events.filter((e) => e.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: lane, text: "hi", system: "You are a test agent.", cwd: home, ...extra } as SendTurnInput);
    for (let i = 0; i < 100 && events.filter((e) => e.type === "turn.completed").length === before; i++) await setImmediate();
  }
  const sent = (method: string) => frames.filter((f) => f.method === method).map((f) => f.params);
  const native = () => {
    try {
      return readFileSync(join(home, ".bloks", "native", `${lane}.ndjson`), "utf8");
    } catch {
      return "";
    }
  };
  const notices = () => events.flatMap((e) => (e.type === "runtime.error" ? [e.message] : []));
  /** The thread config's server tables, by their name in Codex. */
  const mounted = (params: any): Record<string, any> =>
    Object.fromEntries(Object.entries(params?.config ?? {}).filter(([key]) => key.startsWith("mcp_servers.")).map(([key, table]) => [key.slice("mcp_servers.".length), table]));
  /** What the agent was told before the person's words, last turn. */
  const told = () => String(sent("turn/start").at(-1)?.input?.[0]?.text ?? "");
  return { instance, frames, spawned, events, turn, sent, native, notices, mounted, told };
}

/** A stand-in `codex app-server`, answering each request as one would. */
function appServer(frames: any[], fake: Fake) {
  const stdout = new PassThrough();
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    pid: undefined,
    kill() {},
    stdin: new Writable({
      write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk));
        frames.push(frame);
        if (frame.method && frame.id !== undefined) {
          const refused = fake.refuse?.(frame) ?? null;
          let reply: Record<string, unknown> = { id: frame.id, result: {} };
          if (refused) reply = { id: frame.id, error: { code: -32600, message: refused } };
          else if (frame.method === "config/read") reply = { id: frame.id, result: { config: {} } };
          else if (frame.method === "thread/start") reply = { id: frame.id, result: { thread: { id: "codex-thread" }, model: "gpt-test" } };
          else if (frame.method === "thread/resume") reply = { id: frame.id, result: { thread: { id: frame.params.threadId }, model: "gpt-test" } };
          else if (frame.method === "thread/fork") reply = { id: frame.id, result: { thread: { id: "forked-thread" } } };
          queueMicrotask(() => {
            stdout.write(JSON.stringify(reply) + "\n");
            if (frame.method === "turn/start" && !refused) stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n");
          });
        }
        done();
      },
    }),
  });
}

/** A workplace that writes down every server it is asked to carry through
 * its gate, and starts the engine as the mocked spawn does. */
function placeHere(frames: any[], gate: string, carries = true) {
  const carried: Array<{ name: string; server: any }> = [];
  const place: PlaceRun = {
    label: "container scout",
    cwd: "/work",
    spawn: () => appServer(frames, {}) as any,
    file: (name) => `/work/.bloks-run/${name}`,
    mcp(name, server) {
      carried.push({ name, server });
      return carries ? { url: `http://host.docker.internal:4300/mcp/${name}-${carried.length}`, headers: { Authorization: `Bearer ${gate}` } } : null;
    },
  };
  return { place, carried };
}

test("Codex says it takes the browser and every computer, so the harness gets them ready for it", async (t) => {
  const h = await setup(t);
  assert.deepEqual(h.instance.adapter.capabilities.screens, ALL_SCREENS);
});

test("the browser and the Local VM reach a new thread and a resumed one, pre-allowed as Claude Code has them", async (t) => {
  const h = await setup(t);
  await h.turn({ integrations: BOTH });
  const [start] = h.sent("thread/start");
  const tables = h.mounted(start);
  assert.deepEqual(Object.keys(tables).sort(), ["bloks_browser", "bloks_computer"]);
  // the VM's bridge, as the harness was handed it
  assert.deepEqual(tables.bloks_computer, {
    command: VM.command, args: VM.args, env: VM.env,
    default_tools_approval_mode: "approve", startup_timeout_sec: 30, tool_timeout_sec: 300,
  });
  // the browser proxy, run as node, in the agent's own profile
  assert.equal(tables.bloks_browser.command, process.execPath);
  assert.match(tables.bloks_browser.args[0], /browser-proxy\.(ts|js)$/);
  assert.equal(tables.bloks_browser.env.BLOKS_BROWSER_PROFILE, BROWSER.profileDir);
  assert.equal(tables.bloks_browser.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(tables.bloks_browser.default_tools_approval_mode, "approve");

  // a resume is a new process, and Codex keeps no thread config across one
  await h.turn({ integrations: BOTH, resumeCursor: "codex-thread" });
  const [resume] = h.sent("thread/resume");
  assert.deepEqual(h.mounted(resume), tables);
  assert.equal(h.sent("thread/start").length, 1, "the thread was carried on, not replaced");
  assert.deepEqual(h.notices(), []);
  assert.doesNotMatch(h.told(), /correction/i);
});

test("switching either off takes it away on the next turn", async (t) => {
  const h = await setup(t);
  await h.turn({ integrations: BOTH });
  await h.turn({ integrations: { localComputer: VM }, resumeCursor: "codex-thread" });
  await h.turn({ integrations: { browser: BROWSER }, resumeCursor: "codex-thread" });
  await h.turn({ resumeCursor: "codex-thread" });
  const [, second, third] = [h.sent("thread/start")[0], ...h.sent("thread/resume")];
  assert.deepEqual(Object.keys(h.mounted(second)), ["bloks_computer"]);
  assert.deepEqual(Object.keys(h.mounted(third)), ["bloks_browser"]);
  assert.deepEqual(h.mounted(h.sent("thread/resume")[2]), {});
});

test("this Mac's daemon goes as given, and the cloud box comes first when there is one", async (t) => {
  const h = await setup(t);
  const cua = { command: "/Applications/Bloks.app/Contents/Resources/cua-driver", args: ["mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } };
  await h.turn({ integrations: { localComputer: cua } });
  const mac = h.mounted(h.sent("thread/start")[0]).bloks_computer;
  assert.equal(mac.command, cua.command);
  assert.deepEqual(mac.args, cua.args);
  assert.deepEqual(mac.env, cua.env);

  await h.turn({ integrations: { localComputer: cua, computer: { boxId: "box-7", token: secret("box") } }, resumeCursor: "codex-thread" });
  const box = h.mounted(h.sent("thread/resume")[0]).bloks_computer;
  assert.match(box.args[0], /computer-proxy\.(ts|js)$/);
  assert.equal(box.env.BLOKS_BOX_ID, "box-7");
});

test("a fork carries them itself, since the resume after it rejoins a running thread", async (t) => {
  const h = await setup(t);
  await h.turn({ integrations: BOTH, resumeCursor: "from-before", forkFrom: "from-before", handoff: "the story, then: hi" });
  assert.deepEqual(Object.keys(h.mounted(h.sent("thread/fork")[0])).sort(), ["bloks_browser", "bloks_computer"]);
  assert.deepEqual(Object.keys(h.mounted(h.sent("thread/resume")[0])).sort(), ["bloks_browser", "bloks_computer"]);
});

test("beside the agent's own servers and the shell's entries, not instead of them", async (t) => {
  const h = await setup(t);
  const token = secret("blk");
  await h.turn({
    env: { BLOKS_TOKEN: token },
    integrations: { ...BOTH, mcpServers: [{ name: "Files", transport: "stdio", command: "/opt/tools/files-mcp" }] },
  });
  const [start] = h.sent("thread/start");
  assert.deepEqual(Object.keys(h.mounted(start)).sort(), ["bloks_browser", "bloks_computer", "u_files"]);
  assert.equal(start.config["shell_environment_policy.set.BLOKS_TOKEN"], token);
});

test("nobody else's turn is handed either, whatever it carries", async (t) => {
  for (const whose of [{ forOthers: true, untrusted: true }, { forOthers: true, shared: { tools: "desk" as const } }, { untrusted: true }]) {
    assert.deepEqual(screenConfig({ ...whose, integrations: BOTH }), { config: {}, secrets: [], unreached: [] }, JSON.stringify(whose));
  }
  const h = await setup(t);
  await h.turn({ forOthers: true, untrusted: true, integrations: { ...BOTH, computer: { boxId: "box-7", token: secret("box") } } });
  const [start] = h.sent("thread/start");
  assert.deepEqual(Object.keys(h.mounted(start)).filter((name) => name.startsWith("bloks_")), [], "a screen was mounted for somebody else");
  // and the owner's own servers are switched off around it, as before
  assert.equal(start.config["features.apps"], false);
});

test("the box's key is never in argv, the app-server's environment, an event or the native copy", async (t) => {
  const h = await setup(t);
  const boxToken = secret("box");
  const integrations = { ...BOTH, computer: { boxId: "box-7", token: boxToken } };
  await h.turn({ integrations });
  await h.turn({ integrations, resumeCursor: "codex-thread" });
  // it rides the thread config over stdin, which is where it belongs
  assert.equal(h.mounted(h.sent("thread/start")[0]).bloks_computer.env.BLOKS_BOX_TOKEN, boxToken);
  for (const { args, env } of h.spawned) {
    assert.ok(!args.join(" ").includes(boxToken), "the key reached argv");
    assert.doesNotMatch(args.join(" "), /bloks_computer|bloks_browser/);
    assert.ok(!JSON.stringify(env).includes(boxToken), "the key reached the environment the shell inherits");
  }
  const written = h.native();
  assert.match(written, /"method":"thread\/resume"/);
  assert.ok(!written.includes(boxToken), "the native copy kept the box's key");
  assert.ok(!written.includes(BROWSER.profileDir), "the native copy kept the tables' values");
  assert.match(written, /"mcp_servers\.bloks_computer":\{"command":"\[redacted\]"/);
  assert.ok(!JSON.stringify(h.events).includes(boxToken));
});

test("working elsewhere, both run here and Codex there reaches them through the gate", async (t) => {
  const h = await setup(t);
  const gate = secret("gate");
  const boxToken = secret("box");
  const { place, carried } = placeHere(h.frames, gate);
  await h.turn({ place, integrations: { browser: BROWSER, computer: { boxId: "box-7", token: boxToken } } });
  await h.turn({ place, integrations: { browser: BROWSER, localComputer: VM }, resumeCursor: "codex-thread" });

  // carried as the stdio servers they are, to run on this computer
  assert.deepEqual(carried.map((c) => c.name), ["bloks_computer", "bloks_browser", "bloks_computer", "bloks_browser"]);
  assert.equal(carried[0].server.transport, "stdio");
  assert.equal(carried[0].server.env.BLOKS_BOX_TOKEN, boxToken, "the box's key stays here, with the server");
  assert.deepEqual({ command: carried[2].server.command, args: carried[2].server.args }, { command: VM.command, args: VM.args });

  for (const params of [h.sent("thread/start")[0], h.sent("thread/resume")[0]]) {
    const tables = h.mounted(params);
    for (const name of ["bloks_browser", "bloks_computer"]) {
      const table = tables[name];
      assert.match(table.url, new RegExp(`/mcp/${name}-\\d+$`));
      assert.deepEqual(table.http_headers, { Authorization: `Bearer ${gate}` });
      // nothing of this Mac's is run there
      assert.equal("command" in table, false);
      assert.equal("env" in table, false);
      assert.equal(table.default_tools_approval_mode, "approve");
    }
  }
  const everything = JSON.stringify(h.frames.filter((f) => f.method === "thread/start" || f.method === "thread/resume"));
  assert.ok(!everything.includes(boxToken), "the box's key went there");
  assert.ok(!everything.includes(VM.command), "a path on this computer went there to be run");
  assert.ok(!h.native().includes(gate), "the native copy kept the gate's token");
  assert.doesNotMatch(h.told(), /correction/i);
});

test("a screen the workplace cannot carry is said to the agent, and the other still goes", async (t) => {
  const h = await setup(t);
  let calls = 0;
  const { place } = placeHere(h.frames, secret("gate"));
  const mcp = place.mcp;
  place.mcp = (name, server) => (++calls === 1 ? null : mcp(name, server));
  await h.turn({ place, integrations: BOTH });
  assert.deepEqual(Object.keys(h.mounted(h.sent("thread/start")[0])), ["bloks_browser"]);
  assert.match(h.told(), /A correction to the above: working on container scout, Codex could not reach your computer from there, so you have no computer tools this turn\./);
  assert.match(h.told(), /Your commands and files are not affected/);
  assert.ok(h.told().endsWith("say so plainly.\n\nhi"), h.told());
});

test("a Codex that will not take the servers says so, and the agent is told it has no browser or computer", async (t) => {
  const h = await setup(t, {
    refuse: (frame) => (Object.keys(frame.params?.config ?? {}).some((key) => key.startsWith("mcp_servers.")) ? "failed to load configuration\nin `mcp_servers.bloks_browser`\n" : null),
  });
  await h.turn({ integrations: BOTH });
  const starts = h.sent("thread/start");
  assert.equal(starts.length, 2, "asked again, once, without the servers");
  assert.deepEqual(h.mounted(starts[1]), {});
  assert.deepEqual(h.notices(), [SCREENS_REFUSED_NOTICE]);
  assert.notEqual(SCREENS_REFUSED_NOTICE, SERVERS_REFUSED_NOTICE);
  assert.match(h.told(), /would not take the servers Bloks gives it, your browser and computer among them, so you have no browser or computer tools this turn/);
  // the person hears it once; the agent every turn it is so
  await h.turn({ integrations: BOTH, resumeCursor: "codex-thread" });
  assert.equal(h.notices().length, 1);
  assert.match(h.told(), /no browser or computer tools/);
});

test("the words to the agent never carry a dash Bloks does not write", async (t) => {
  const h = await setup(t, { refuse: (frame) => (frame.params?.config?.["mcp_servers.bloks_browser"] ? "failed in `mcp_servers`" : null) });
  await h.turn({ integrations: BOTH });
  for (const said of [h.told(), SCREENS_REFUSED_NOTICE]) assert.doesNotMatch(said, /[\u2013\u2014]/);
});
