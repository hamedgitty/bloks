// GitHub 358: the MCP servers attached to an agent reached Claude Code
// and never Codex. The Codex driver mounted its reply helper and the
// connectors bridge and nothing else, so an agent moved to Codex lost the
// tools with no word about it. They now go in the thread's own config on
// every start, resume and fork, over stdin, with their keys kept out of
// argv, the app-server's environment and everything written down; and a
// server Codex cannot be handed is said, not dropped.
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

import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";

// The native copy is written for real, into a throwaway data folder, so
// what it holds is what a person's would.
const home = mkdtempSync(join(tmpdir(), "bloks-codex-mcp-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
mkdirSync(join(home, ".bloks", "native"), { recursive: true });
const { CodexDriver, SERVERS_REFUSED_NOTICE, SHELL_REFUSED_NOTICE, leftOutNotice, serverConfig } = await import("../server/drivers/codex.ts");
after(() => rmSync(home, { recursive: true, force: true }));

type Servers = NonNullable<NonNullable<SendTurnInput["integrations"]>["mcpServers"]>;

/** Keys made up for the test, long enough to be taken for keys. */
const secret = (prefix: string) => `${prefix}_${randomBytes(18).toString("base64url")}`;
const credential = () => secret("blk");
const SET = "shell_environment_policy.set.";

/** One server of each transport, as the harness resolves them, with a
 * name of each kind still waiting for the person. */
function attached() {
  const bearer = `Bearer ${secret("ha")}`;
  const filesKey = secret("files");
  const servers: Servers = [
    {
      name: "Home Assistant",
      transport: "http",
      url: "https://ha.example.test/api/mcp?ticket=never-in-argv",
      headers: { Authorization: bearer, "X-Not-Yet": "" },
    },
    {
      name: "Files",
      transport: "stdio",
      command: "/opt/tools/files-mcp",
      args: ["--root", "/srv/shared files"],
      env: { FILES_KEY: filesKey, FILES_REGION: "" },
    },
  ];
  return { servers, bearer, filesKey };
}

interface Fake {
  /** The person's own mcp_servers, as config/read reports them. */
  theirs?: Record<string, unknown>;
  /** An error message for a request this Codex refuses, or null. */
  refuse?: (frame: any) => string | null;
}

let lanes = 0;

async function setup(t: TestContext, fake: Fake = {}) {
  const lane = `mcp-lane-${++lanes}`;
  const frames: any[] = [];
  const spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
  t.mock.method(childProcess, "spawn", (_cli: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
    spawned.push({ args: [...args], env: { ...(options?.env ?? {}) } });
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
            else if (frame.method === "config/read") reply = { id: frame.id, result: { config: fake.theirs ? { mcp_servers: fake.theirs } : {} } };
            else if (frame.method === "thread/start") reply = { id: frame.id, result: { thread: { id: "codex-thread" }, model: "gpt-test" } };
            else if (frame.method === "thread/resume") reply = { id: frame.id, result: { thread: { id: frame.params.threadId }, model: "gpt-test" } };
            else if (frame.method === "thread/fork") reply = { id: frame.id, result: { thread: { id: "forked-thread" } } };
            queueMicrotask(() => {
              stdout.write(JSON.stringify(reply) + "\n");
              if (frame.method === "turn/start" && !refused) {
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
  async function turn(extra: Partial<SendTurnInput>) {
    const before = events.filter((e) => e.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: lane, text: "hi", cwd: home, ...extra } as SendTurnInput);
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
  /** The thread config's server tables, by their name in Codex. */
  const mounted = (params: any) =>
    Object.fromEntries(Object.entries(params?.config ?? {}).filter(([key]) => key.startsWith("mcp_servers.")).map(([key, table]) => [key.slice("mcp_servers.".length), table]));
  return { lane, frames, spawned, events, turn, sent, native, notices, completed, mounted };
}

test("an agent's HTTP and stdio servers reach a new thread and a resumed one", async (t) => {
  const h = await setup(t);
  const { servers, bearer, filesKey } = attached();
  const token = credential();
  const env = { BLOKS_CLI: "/opt/bloks/bin/bloks.mjs", BLOKS_URL: "http://127.0.0.1:4100", BLOKS_TOKEN: token };

  await h.turn({ env, integrations: { mcpServers: servers } });
  // under Claude Code's names, every tool pre-allowed as Claude Code has
  // them, and the names nobody has filled in yet left out
  const expected = {
    u_home_assistant: {
      url: "https://ha.example.test/api/mcp?ticket=never-in-argv",
      http_headers: { Authorization: bearer },
      default_tools_approval_mode: "approve",
    },
    u_files: {
      command: "/opt/tools/files-mcp",
      args: ["--root", "/srv/shared files"],
      env: { FILES_KEY: filesKey },
      default_tools_approval_mode: "approve",
    },
  };
  const [start] = h.sent("thread/start");
  assert.deepEqual(h.mounted(start), expected);
  // beside the shell's own entries, not instead of them
  assert.equal(start.config[`${SET}BLOKS_TOKEN`], token);

  // A resume is a new process each turn, and Codex keeps no thread config
  // across one, so the resumed thread is handed them again.
  await h.turn({ env, integrations: { mcpServers: servers }, resumeCursor: "codex-thread" });
  const [resume] = h.sent("thread/resume");
  assert.equal(resume.threadId, "codex-thread");
  assert.deepEqual(h.mounted(resume), expected);
  assert.equal(resume.config[`${SET}BLOKS_TOKEN`], token);
  assert.equal(h.sent("thread/start").length, 1, "the thread was carried on, not replaced");
  assert.deepEqual(h.notices(), []);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("without a credential for the shell the servers still go, alone", async (t) => {
  const h = await setup(t);
  const { servers } = attached();
  await h.turn({ integrations: { mcpServers: servers } });
  const [start] = h.sent("thread/start");
  assert.deepEqual(Object.keys(start.config).sort(), ["features.goals", "mcp_servers.u_files", "mcp_servers.u_home_assistant"]);
  // read for the person's own server names, which these keep clear of
  assert.equal(h.sent("config/read").length, 1);
});

test("a fork carries the servers itself, since the resume after it rejoins a running thread", async (t) => {
  const h = await setup(t);
  const { servers } = attached();
  await h.turn({ integrations: { mcpServers: servers }, resumeCursor: "from-before", forkFrom: "from-before", handoff: "the story, then: hi" });
  const [fork] = h.sent("thread/fork");
  assert.equal(fork.threadId, "from-before");
  assert.deepEqual(Object.keys(h.mounted(fork)).sort(), ["u_files", "u_home_assistant"]);
  const [resume] = h.sent("thread/resume");
  assert.equal(resume.threadId, "forked-thread");
  assert.deepEqual(Object.keys(h.mounted(resume)).sort(), ["u_files", "u_home_assistant"]);
});

test("the servers' keys are never in argv, the app-server's environment, an event or the native copy", async (t) => {
  const h = await setup(t);
  const { servers, bearer, filesKey } = attached();
  const token = credential();
  await h.turn({ env: { BLOKS_TOKEN: token }, integrations: { mcpServers: servers } });
  await h.turn({ env: { BLOKS_TOKEN: token }, integrations: { mcpServers: servers }, resumeCursor: "codex-thread" });
  assert.equal(h.sent("thread/start").length, 1);
  assert.equal(h.sent("thread/resume").length, 1);

  // argv is readable by every user on the machine through ps; neither the
  // keys nor anything else of the servers', the address included, is there
  assert.ok(h.spawned.length >= 3, "the catalog probe and both turns");
  for (const { args, env } of h.spawned) {
    const said = args.join(" ");
    for (const value of [bearer, filesKey, "ha.example.test", "files-mcp"]) assert.ok(!said.includes(value), said);
    assert.doesNotMatch(said, /mcp_servers\.u_/);
    // nor in the environment, which the agent's shell commands inherit
    const environment = JSON.stringify(env);
    assert.ok(!environment.includes(bearer) && !environment.includes(filesKey), "a server's key reached the app-server's environment");
  }

  // The native copy keeps the frames and the servers' shape, by name, and
  // none of their values: an address or a command line can carry a key.
  const written = h.native();
  assert.match(written, /"method":"thread\/start"/);
  assert.match(written, /"method":"thread\/resume"/);
  for (const value of [bearer, filesKey, "ha.example.test", "/opt/tools/files-mcp", "/srv/shared files"]) {
    assert.ok(!written.includes(value), `the native copy kept ${value}`);
  }
  assert.match(written, /"mcp_servers\.u_home_assistant":\{"url":"\[redacted\]","http_headers":\{"Authorization":"\[redacted\]"\}/);
  assert.match(written, /"mcp_servers\.u_files":\{"command":"\[redacted\]","args":\["\[redacted\]","\[redacted\]"\],"env":\{"FILES_KEY":"\[redacted\]"\}/);
  const told = JSON.stringify(h.events);
  assert.ok(!told.includes(bearer) && !told.includes(filesKey));
});

test("a turn the owner did not vouch for mounts the servers and asks before every tool", async (t) => {
  const h = await setup(t);
  const { servers } = attached();
  await h.turn({ untrusted: true, integrations: { mcpServers: servers } });
  const tables = Object.values(h.mounted(h.sent("thread/start")[0])) as Array<Record<string, unknown>>;
  assert.equal(tables.length, 2);
  // Codex asks, and its question reaches the owner as a card, as Claude
  // Code's does when it pre-allows nothing of the owner's
  for (const table of tables) assert.equal("default_tools_approval_mode" in table, false);
});

test("names are Claude Code's slugs, safe as TOML keys, kept clear of each other and of the person's own", async (t) => {
  const h = await setup(t, { theirs: { u_home_assistant: { url: "https://their.example.test/mcp" }, github: { command: "gh-mcp" } } });
  const servers: Servers = [
    { name: "Home Assistant", transport: "http", url: "https://one.example.test/mcp" },
    { name: "home-assistant", transport: "http", url: "https://two.example.test/mcp" },
    { name: "Tools.v2 [beta]", transport: "stdio", command: "tools" },
    { name: "日本語", transport: "stdio", command: "nihongo" },
  ];
  await h.turn({ integrations: { mcpServers: servers } });
  const names = Object.keys(h.mounted(h.sent("thread/start")[0]));
  // Codex merges a table into the person's own of the same name, and a
  // stdio table merged into an HTTP one refuses the whole thread
  assert.deepEqual(names, ["u_home_assistant_2", "u_home_assistant_3", "u_tools_v2_beta_", "u__"]);
  for (const name of names) assert.match(name, /^u_[a-z0-9_]+$/);
  assert.deepEqual(h.notices(), []);
});

test("a server Codex cannot be handed is said, once, and the rest still go", async (t) => {
  const h = await setup(t);
  const { servers } = attached();
  const odd = [
    { name: "Legacy feed", transport: "sse", url: "https://feed.example.test/sse" },
    { name: "Half set up", transport: "stdio", command: "" },
    { name: "No address", transport: "http", url: "" },
    { name: "Odd header", transport: "http", url: "https://odd.example.test/mcp", headers: { "X Api Key": secret("odd") } },
    { name: "Two lines", transport: "http", url: "https://lines.example.test/mcp", headers: { "X-Key": "first\nsecond" } },
  ] as unknown as Servers;
  const why = [
    "Legacy feed: Codex speaks stdio and streamable HTTP, not sse",
    "Half set up: it has no command to run",
    "No address: it has no http or https address",
    `Odd header: "X Api Key" is not a header name HTTP allows`,
    "Two lines: its X-Key header has a line break in it",
  ];

  await h.turn({ integrations: { mcpServers: [...servers, ...odd] } });
  assert.deepEqual(Object.keys(h.mounted(h.sent("thread/start")[0])).sort(), ["u_files", "u_home_assistant"]);
  assert.deepEqual(h.notices(), [leftOutNotice(why)]);
  assert.match(h.notices()[0], /^Codex cannot use 5 of the MCP servers attached to this agent, so they are left out\. Legacy feed: /);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok), "the turn still ran");

  // the same again is not said again
  await h.turn({ integrations: { mcpServers: [...servers, ...odd] }, resumeCursor: "codex-thread" });
  assert.equal(h.notices().length, 1);

  // what is left out changing is
  await h.turn({ integrations: { mcpServers: [...servers, odd[0]] }, resumeCursor: "codex-thread" });
  assert.deepEqual(h.notices().slice(1), [leftOutNotice([why[0]])]);
  assert.match(h.notices()[1], /^Codex cannot use one of the MCP servers attached to this agent, so it is left out\./);
});

test("a Codex that will not take the servers still gets its thread and the shell's config, and hears it once", async (t) => {
  // as a real app-server refuses a server table it cannot load
  const h = await setup(t, {
    refuse: (frame) => {
      const config = frame.params?.config ?? {};
      if (!Object.keys(config).some((key) => key.startsWith("mcp_servers."))) return null;
      return "failed to load configuration: url is not supported for stdio\nin `mcp_servers.u_files`\n";
    },
  });
  const { servers } = attached();
  const token = credential();

  await h.turn({ env: { BLOKS_TOKEN: token }, integrations: { mcpServers: servers } });
  const starts = h.sent("thread/start");
  assert.equal(starts.length, 2, "asked again, once, without the servers");
  assert.deepEqual(Object.keys(starts[1].config), ["features.goals", `${SET}BLOKS_TOKEN`], "the shell's part is kept");
  assert.equal(h.sent("turn/start").length, 1, "the words went in");
  assert.deepEqual(h.notices(), [SERVERS_REFUSED_NOTICE]);

  await h.turn({ env: { BLOKS_TOKEN: token }, integrations: { mcpServers: servers }, resumeCursor: "codex-thread" });
  const resumes = h.sent("thread/resume");
  assert.equal(resumes.length, 2);
  assert.deepEqual(h.mounted(resumes[1]), {});
  assert.equal(h.sent("thread/start").length, 2, "the thread was kept, not replaced");
  assert.deepEqual(h.notices(), [SERVERS_REFUSED_NOTICE], "said once, not every turn");
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("a Codex that knows no thread config at all loses both parts, and says both", async (t) => {
  const h = await setup(t, { refuse: (frame) => (frame.params?.config ? "Invalid request: unknown field `config`" : null) });
  const { servers } = attached();
  await h.turn({ env: { BLOKS_TOKEN: credential() }, integrations: { mcpServers: servers } });
  const starts = h.sent("thread/start");
  assert.equal(starts.length, 2);
  assert.equal("config" in starts[1], false);
  assert.deepEqual(h.notices(), [SHELL_REFUSED_NOTICE, SERVERS_REFUSED_NOTICE]);
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));
});

test("a refusal about something else is still the turn failing", async (t) => {
  const h = await setup(t, { refuse: (frame) => (frame.method === "thread/start" ? "model not found" : null) });
  const { servers } = attached();
  await h.turn({ integrations: { mcpServers: servers } });
  assert.equal(h.sent("thread/start").length, 1, "not asked again without the servers");
  assert.deepEqual(h.notices(), ["model not found"]);
  assert.equal(h.completed()[0]?.type === "turn.completed" && h.completed()[0].ok, false);
});

test("a server whose address, arguments or environment Codex could not use is left out and named, never mounted half right (GitHub 372)", () => {
  const key = credential();
  const read = (server: Record<string, unknown>) => serverConfig([{ name: "Home", ...server } as Servers[number]], { approve: false });
  // the report's three controls
  for (const [server, why] of [
    [{ transport: "http", url: "https://" }, /no http or https address/],
    [{ transport: "http", url: "https://exa mple.com/mcp" }, /no http or https address/],
    [{ transport: "stdio", command: "run", args: ["first", 7, "last"] }, /arguments must each be plain text/],
    [{ transport: "stdio", command: "run", args: "first last" }, /arguments must each be plain text/],
    [{ transport: "stdio", command: "run", args: ["a\0b"] }, /arguments must each be plain text/],
    [{ transport: "stdio", command: "run", env: { "BAD=NAME": key } }, /is not a name an environment variable can have/],
    [{ transport: "stdio", command: "run", env: { TOKEN: `value\0${key}` } }, /the value of TOKEN has a character no environment can carry/],
    [{ transport: "stdio", command: "run\0x" }, /command has a character/],
  ] as const) {
    const got = read(server);
    assert.deepEqual(got.config, {}, `${JSON.stringify(server)} was mounted`);
    assert.equal(got.leftOut.length, 1);
    assert.match(got.leftOut[0], why);
    // the reason names the field, never what is in it
    assert.equal(got.leftOut[0].includes(key), false);
  }
  // and good ones still mount as they were given
  const http = read({ transport: "http", url: "https://ha.local:8123/mcp", headers: { Authorization: `Bearer ${key}` } });
  assert.deepEqual(http.leftOut, []);
  assert.deepEqual(Object.values(http.config), [{ url: "https://ha.local:8123/mcp", http_headers: { Authorization: `Bearer ${key}` } }]);
  const stdio = read({ transport: "stdio", command: "npx", args: ["-y", "server"], env: { HA_TOKEN: key } });
  assert.deepEqual(stdio.leftOut, []);
  assert.deepEqual(Object.values(stdio.config), [{ command: "npx", args: ["-y", "server"], env: { HA_TOKEN: key } }]);
  assert.deepEqual(Object.values(read({ transport: "stdio", command: "npx" }).config), [{ command: "npx", args: [] }]);
});
