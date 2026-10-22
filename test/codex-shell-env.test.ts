// GitHub 336: a Codex project with `inherit = "core"` in its
// shell_environment_policy kept BLOKS_CLI, BLOKS_URL and BLOKS_TOKEN from
// the agent's shell commands, though the app-server had all three, and
// the bloks command quietly did nothing. The thread's own config now
// states them as `set` entries on every start, resume and fork, with this
// turn's values, over stdin and nowhere else, and the credential is kept
// out of everything the driver writes down.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";

// The native copy is written for real, into a throwaway data folder, so
// what it holds is what a person's would.
const home = mkdtempSync(join(tmpdir(), "bloks-codex-shell-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
mkdirSync(join(home, ".bloks", "native"), { recursive: true });
const { CodexDriver, SHELL_REFUSED_NOTICE } = await import("../server/drivers/codex.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const CLI = "/opt/bloks/bin/bloks.mjs";
const BASE = "http://127.0.0.1:4100";
/** A credential shaped as Bloks mints them, made up for the test. */
const credential = () => `blk_${randomBytes(24).toString("base64url")}`;
const envFor = (token: string) => ({ BLOKS_CLI: CLI, BLOKS_URL: BASE, BLOKS_TOKEN: token });
const SET = "shell_environment_policy.set.";

interface Fake {
  /** The person's include_only, as config/read reports it. */
  includeOnly?: string[];
  /** An error message for a request this Codex refuses, or null. */
  refuse?: (frame: any) => string | null;
  /** Frames to send once turn/start is answered, before it completes. */
  during?: (frame: any) => any[];
}

let lanes = 0;

async function setup(t: TestContext, fake: Fake = {}) {
  const lane = `shell-lane-${++lanes}`;
  const frames: any[] = [];
  const argv: string[][] = [];
  t.mock.method(childProcess, "spawn", (_cli: string, args: string[]) => {
    argv.push([...args]);
    const stdout = new PassThrough();
    return Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined) {
            const refused = fake.refuse?.(frame) ?? null;
            let reply: Record<string, unknown> = { id: frame.id, result: {} };
            if (refused) reply = { id: frame.id, error: { code: -32600, message: refused } };
            else if (frame.method === "config/read") {
              reply = { id: frame.id, result: fake.includeOnly ? { config: { shell_environment_policy: { inherit: "core", include_only: fake.includeOnly } } } : {} };
            } else if (frame.method === "thread/start") reply = { id: frame.id, result: { thread: { id: "codex-thread" }, model: "gpt-test" } };
            else if (frame.method === "thread/resume") reply = { id: frame.id, result: { thread: { id: frame.params.threadId }, model: "gpt-test" } };
            else if (frame.method === "thread/fork") reply = { id: frame.id, result: { thread: { id: "forked-thread" } } };
            queueMicrotask(() => {
              stdout.write(JSON.stringify(reply) + "\n");
              if (frame.method === "turn/start" && !refused) {
                for (const extra of fake.during?.(frame) ?? []) stdout.write(JSON.stringify(extra) + "\n");
                stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n");
              }
            });
          }
          done();
        },
      }),
    });
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
  async function turn(extra: Record<string, unknown>) {
    const before = events.filter((e) => e.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: lane, text: "hi", cwd: home, ...extra });
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
  const completed = () => events.flatMap((e) => (e.type === "turn.completed" ? [e] : []));
  return { instance, lane, frames, argv, events, turn, sent, native, notices, completed };
}

test("a new thread and a resumed one carry this turn's values for the shell, and nothing more", async (t) => {
  const h = await setup(t);
  const first = credential();
  const second = credential();

  await h.turn({ env: envFor(first) });
  const [start] = h.sent("thread/start");
  assert.deepEqual(start.config, { [`${SET}BLOKS_CLI`]: CLI, [`${SET}BLOKS_URL`]: BASE, [`${SET}BLOKS_TOKEN`]: first });

  // the next turn has a credential of its own, and the resumed thread
  // gets that one, not the one it started with
  await h.turn({ env: envFor(second), resumeCursor: "codex-thread" });
  const [resume] = h.sent("thread/resume");
  assert.equal(resume.threadId, "codex-thread");
  assert.deepEqual(resume.config, { [`${SET}BLOKS_CLI`]: CLI, [`${SET}BLOKS_URL`]: BASE, [`${SET}BLOKS_TOKEN`]: second });
  assert.ok(!JSON.stringify(resume).includes(first), "an old turn's credential is never handed on");

  // Dotted keys only: a `set` table of the person's own is added to, not
  // replaced, and inherit, exclude and the rest of the policy stay theirs
  for (const params of [start, resume]) {
    assert.ok(Object.keys(params.config).every((key) => key.startsWith(SET)), Object.keys(params.config).join(", "));
  }
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));

  // never in argv, where any process listing reads it
  assert.ok(h.argv.length >= 2);
  for (const args of h.argv) {
    const said = args.join(" ");
    assert.ok(!said.includes(first) && !said.includes(second), said);
    assert.doesNotMatch(said, /shell_environment_policy/);
  }

  // and never in the native copy, which keeps every other frame
  const written = h.native();
  assert.match(written, /"method":"thread\/start"/);
  assert.match(written, /"method":"thread\/resume"/);
  assert.ok(!written.includes(first) && !written.includes(second), "the credential is not written down");
  assert.match(written, /"shell_environment_policy\.set\.BLOKS_TOKEN":"\[redacted\]"/);
  // the person's Codex settings are read, and kept out of it too
  assert.equal(h.sent("config/read").length, 2);
  assert.deepEqual(h.sent("config/read")[0], { cwd: home });
  assert.doesNotMatch(written, /config\/read/);
});

test("an include_only list of the person's own is stated again with the three names added", async (t) => {
  const h = await setup(t, { includeOnly: ["PATH", "HOME", "BLOKS_URL"] });
  const token = credential();
  await h.turn({ env: envFor(token) });
  const [start] = h.sent("thread/start");
  // Codex filters by the list after `set`, so without the names the
  // values would be set and then taken away; nothing else is let in
  assert.deepEqual(start.config["shell_environment_policy.include_only"], ["PATH", "HOME", "BLOKS_URL", "BLOKS_CLI", "BLOKS_TOKEN"]);
  assert.equal(start.config[`${SET}BLOKS_TOKEN`], token);
});

test("without a list of the person's, none is sent", async (t) => {
  const h = await setup(t);
  await h.turn({ env: envFor(credential()) });
  const [start] = h.sent("thread/start");
  assert.equal("shell_environment_policy.include_only" in start.config, false);
});

test("a fork carries the config itself, since the resume after it rejoins a running thread", async (t) => {
  const h = await setup(t);
  const token = credential();
  await h.turn({ env: envFor(token), resumeCursor: "from-before", forkFrom: "from-before", handoff: "the story, then: hi" });
  const [fork] = h.sent("thread/fork");
  assert.equal(fork.threadId, "from-before");
  assert.equal(fork.config[`${SET}BLOKS_TOKEN`], token);
  const [resume] = h.sent("thread/resume");
  assert.equal(resume.threadId, "forked-thread");
  assert.equal(resume.config[`${SET}BLOKS_TOKEN`], token);
});

test("a turn without a credential sends nothing for the shell", async (t) => {
  const h = await setup(t);
  await h.turn({});
  assert.equal(h.sent("config/read").length, 0);
  assert.equal("config" in h.sent("thread/start")[0], false);
});

test("a Codex that will not take the config still gets its thread, and the conversation hears it once", async (t) => {
  // as a real app-server refuses a config: it quotes the value back
  const h = await setup(t, {
    refuse: (frame) => {
      const token = frame.params?.config?.[`${SET}BLOKS_TOKEN`];
      if (!token || (frame.method !== "thread/start" && frame.method !== "thread/resume")) return null;
      return `failed to load configuration: invalid type: string "${token}", expected a map\nin \`shell_environment_policy.set\`\n`;
    },
  });
  const first = credential();
  const second = credential();

  await h.turn({ env: envFor(first) });
  const starts = h.sent("thread/start");
  assert.equal(starts.length, 2, "asked again, once, without the config");
  assert.ok(starts[0].config);
  assert.equal("config" in starts[1], false);
  assert.equal(h.sent("turn/start").length, 1, "the words went in");
  assert.deepEqual(h.notices(), [SHELL_REFUSED_NOTICE]);

  await h.turn({ env: envFor(second), resumeCursor: "codex-thread" });
  const resumes = h.sent("thread/resume");
  assert.equal(resumes.length, 2);
  assert.equal("config" in resumes[1], false);
  assert.equal(h.sent("thread/start").length, 2, "the thread was kept, not replaced");
  assert.deepEqual(h.notices(), [SHELL_REFUSED_NOTICE], "said once, not every turn");
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));

  // the refusal quoted the credential; nothing written down does
  const told = JSON.stringify(h.events);
  const written = h.native();
  for (const token of [first, second]) {
    assert.ok(!told.includes(token), "not in any event");
    assert.ok(!written.includes(token), "not in the native copy");
  }
  assert.match(written, /invalid type: string \\"\[redacted\]\\"/);
});

test("an error that quotes the credential is said without it", async (t) => {
  const token = credential();
  const h = await setup(t, {
    during: () => [
      { method: "error", params: { error: { message: `stream failed near ${token}` }, willRetry: false } },
    ],
  });
  await h.turn({ env: envFor(token) });
  assert.deepEqual(h.notices(), ["stream failed near [redacted]"]);
  assert.ok(!JSON.stringify(h.events).includes(token));
  assert.ok(!h.native().includes(token));
});

test("a group reply credential reaches the shell under include_only and both credentials are redacted", async (t) => {
  const token = credential(), replyToken = credential().replace("blk_", "blr_");
  const h = await setup(t, {
    includeOnly: ["PATH"],
    during: () => [{ method: "error", params: { message: token + " and " + replyToken, willRetry: false } }],
  });
  await h.turn({ env: { ...envFor(token), BLOKS_REPLY_TOKEN: replyToken, BLOKS_REPLY_PATH: "/api/bots/sample/telegram/reply" } });
  const [start] = h.sent("thread/start");
  assert.equal(start.config[SET + "BLOKS_REPLY_TOKEN"], replyToken);
  assert.equal(start.config[SET + "BLOKS_REPLY_PATH"], "/api/bots/sample/telegram/reply");
  assert.deepEqual(start.config["shell_environment_policy.include_only"], ["PATH", "BLOKS_CLI", "BLOKS_URL", "BLOKS_TOKEN", "BLOKS_REPLY_TOKEN", "BLOKS_REPLY_PATH"]);
  const written = h.native();
  const errors = JSON.stringify(h.notices());
  for (const secret of [token, replyToken]) {
    assert.ok(!written.includes(secret), "a group credential reached the native log");
    assert.ok(!errors.includes(secret), "a group credential reached an error");
    assert.ok(!JSON.stringify(h.argv).includes(secret), "a group credential reached argv");
  }
  assert.ok(written.includes("BLOKS_REPLY_TOKEN"));
  assert.ok(errors.includes("[redacted]"));
});


test("the real targetless CLI uses both credentials carried by the current Codex shell policy", async (t) => {
  const normal = credential(), reply = credential().replace("blk_", "blr_");
  const requests: string[] = [];
  const replyPath = "/api/bots/sample/telegram/reply";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const expected = req.url === "/api/agent/whoami" ? normal : req.url === replyPath ? reply : null;
    if (!expected || req.headers.authorization !== "Bearer " + expected) { res.statusCode = 403; return res.end(JSON.stringify({ error: "wrong route credential" })); }
    requests.push(req.url!);
    if (req.url === replyPath) assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { text: "Neutral group answer" });
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cli = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const h = await setup(t, { includeOnly: ["PATH"] });
  await h.turn({ env: { BLOKS_CLI: cli, BLOKS_URL: base, BLOKS_TOKEN: normal, BLOKS_REPLY_TOKEN: reply, BLOKS_REPLY_PATH: replyPath } });
  const config = h.sent("thread/start")[0].config;
  // Apply the returned set/include_only policy to the actual child command.
  // No direct turn.env inheritance can mask a missing forwarding entry.
  const set = Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith(SET)).map(([key, value]) => [key.slice(SET.length), String(value)]));
  const included: string[] = config["shell_environment_policy.include_only"];
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH!, ...set }).filter(([key]) => included.includes(key)));
  for (const args of [["whoami"], ["reply", "Neutral group answer"]]) {
    const output = await new Promise<string>((resolve, reject) => childProcess.execFile(process.execPath, [cli, ...args], { env, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    assert.equal(JSON.parse(output).ok, true);
    assert.ok(!output.includes(normal) && !output.includes(reply));
  }
  assert.deepEqual(requests, ["/api/agent/whoami", replyPath]);
});


test("a refused group listener stops Codex before advertising the native reply tool", { skip: process.platform === "win32" }, async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "bloks-reply-start-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; rmSync(temp, { recursive: true, force: true }); });
  const create = net.createServer;
  t.mock.method(net, "createServer", ((...args: any[]) => {
    const server = (create as any)(...args);
    t.mock.method(server, "listen", () => {
      queueMicrotask(() => server.emit("error", Object.assign(new Error("synthetic listener refusal"), { code: "EACCES" })));
      return server;
    });
    return server;
  }) as any);
  syncBuiltinESMExports();
  const h = await setup(t);
  await assert.rejects(h.turn({ env: envFor(credential()), reply: { reply: async () => "must not run" } }), /group reply endpoint could not listen/);
  assert.equal(h.sent("turn/start").length, 0);
  assert.equal(h.argv.some(args => args.some(arg => arg.includes("mcp_servers.bloks_reply"))), false);
  assert.deepEqual(readdirSync(temp), [], "failed listener folder leaked");
});


for (const action of ["interrupt", "stopAll", "dispose"] as const) {
  test(`pending group readiness is owned by ${action} and cannot resume over a replacement`, { skip: process.platform === "win32" }, async (t) => {
    const h = await setup(t);
    await h.instance.catalogReady;
    let reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void, socket!: net.Socket, endpoint = "";
    let closed = false, brokerClosed = false;
    const createServer = net.createServer;
    t.mock.method(net, "createServer", ((...args: any[]) => {
      const server = (createServer as any)(...args) as net.Server;
      server.once("close", () => { brokerClosed = true; });
      return server;
    }) as any);
    const connect = net.createConnection;
    t.mock.method(net, "createConnection", ((...args: any[]) => {
      const client = (connect as any)(...args) as net.Socket;
      if (typeof args[0] === "string" && args[0].includes("bloks-turn-reply-")) {
        socket = client; endpoint = args[0];
        client.once("close", () => { closed = true; });
        const emit = client.emit.bind(client);
        t.mock.method(client, "emit", ((event: string, ...values: any[]) => {
          if (event === "connect") { release = () => { emit(event, ...values); }; reached(); return true; }
          return emit(event, ...values);
        }) as any);
      }
      return client;
    }) as any);
    syncBuiltinESMExports();
    let settled = 0;
    const sending = h.instance.adapter.sendTurn({
      threadId: h.lane, text: "STOP_BEFORE_ENGINE", cwd: home,
      reply: { reply: async () => { assert.fail("pending readiness replied"); } },
    }).then(() => { settled++; return null; }, error => { settled++; return error as Error; });
    await ready;
    assert.equal(h.instance.adapter.hasSession(h.lane), true);
    assert.equal(h.argv.some(args => args.some(arg => arg.includes("mcp_servers.bloks_reply"))), false);
    assert.equal(h.sent("turn/start").length, 0);
    if (action === "interrupt") await h.instance.adapter.interruptTurn(h.lane);
    else if (action === "stopAll") await h.instance.adapter.stopAll();
    else await h.instance.dispose();
    assert.match((await sending)?.message ?? "", /Stopped before Codex started/);
    for (let i = 0; i < 100 && (!closed || !brokerClosed); i++) await setImmediate();
    assert.equal(closed, true, "pending probe socket survived cancellation");
    assert.equal(socket.destroyed, true);
    assert.equal(brokerClosed, true, "pending broker listener survived cancellation");
    assert.equal(existsSync(dirname(endpoint)), false, "pending broker folder survived cancellation");
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const client = connect(endpoint);
      client.once("connect", () => { client.destroy(); resolve(); });
      client.once("error", reject);
    }), /ENOENT|ECONNREFUSED/);
    assert.equal(h.instance.adapter.hasSession(h.lane), false);
    assert.equal(settled, 1);
    if (action !== "dispose") await h.turn({ text: "REPLACEMENT_WORDS" });
    const before = h.frames.length, events = h.events.length, processes = h.argv.length;
    release(); // Deliver the held connect notification after the owner retired.
    await setImmediate();
    assert.equal(settled, 1);
    assert.equal(h.frames.length, before);
    assert.equal(h.events.length, events);
    assert.equal(h.argv.length, processes, "cancelled readiness spawned a process");
    assert.equal(h.sent("turn/start").some(p => JSON.stringify(p).includes("STOP_BEFORE_ENGINE")), false);
    assert.equal(h.completed().length, action === "dispose" ? 0 : 1, "preflight added a second terminal result");
  });
}
