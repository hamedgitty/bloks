// A workspace member's turn, or one of a member's own agents, runs on the
// owner's computer, on engines signed in as the owner. What those engines
// bring of their own accord is the owner's: the connectors of their
// sign-in (claude.ai's Gmail, ChatGPT's apps), the MCP servers in the
// owner's own settings for them, and the instructions and memory they keep
// about him. A member's agents took all of it for their own and told the
// member they were signed in to the owner's mail. Each driver now keeps it
// out of a turn that is not the owner's own (SendTurnInput.forOthers), and
// the owner's own turns are as they were.
//
// Claude Code against the real server is test/household-privacy.test.ts;
// here are Codex, which is handed the names to switch off, and the
// project instructions a member's Claude turn is read back in by hand.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";

import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";

const home = mkdtempSync(join(tmpdir(), "bloks-owner-apart-"));
process.env.HOME = home;
process.env.BLOKS_DATA_DIR = "";
mkdirSync(join(home, ".bloks", "native"), { recursive: true });
const { CodexDriver, OWNERS_OFF_REFUSED, ownersOff } = await import("../server/drivers/codex.ts");
const { readMemberClaudeInstructions, readPersonClaudeInstructions } = await import("../server/person-turn.ts");
const { turnEnvironment } = await import("../server/drivers/claude.ts");
after(() => rmSync(home, { recursive: true, force: true }));

// ── Codex ──────────────────────────────────────────────────────────────

interface Fake {
  /** The owner's own mcp_servers, as config/read reports them. */
  theirs?: Record<string, unknown>;
  /** An error message for a request this Codex refuses, or null. */
  refuse?: (frame: any) => string | null;
}

let lanes = 0;

async function codex(t: TestContext, fake: Fake = {}) {
  const lane = `apart-lane-${++lanes}`;
  const frames: any[] = [];
  t.mock.method(childProcess, "spawn", () => {
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
  const notices = () => events.flatMap((e) => (e.type === "runtime.error" ? [e.message] : []));
  const completed = () => events.flatMap((e) => (e.type === "turn.completed" ? [e] : []));
  return { turn, sent, notices, completed };
}

const OWNERS = { gmail: { command: "/opt/gmail-mcp" }, calendar: { url: "https://calendar.example.test/mcp" } };

test("Codex: a member's turn has the owner's own servers and ChatGPT's apps switched off, on a new thread and a resumed one", async (t) => {
  const h = await codex(t, { theirs: { ...OWNERS, bloks_connectors: { command: "node" } } });
  const memberKey = ["ck", "member", "k".repeat(16)].join("_");
  await h.turn({ forOthers: true, untrusted: true, integrations: { composio: { key: memberKey } } });
  const [start] = h.sent("thread/start");
  assert.equal(start.config["mcp_servers.gmail.enabled"], false, "the owner's Gmail server was left on");
  assert.equal(start.config["mcp_servers.calendar.enabled"], false);
  assert.equal(start.config["features.apps"], false, "the apps of the owner's ChatGPT sign-in were left on");
  // the member's own apps, through Bloks' own bridge, stay
  assert.equal("mcp_servers.bloks_connectors.enabled" in start.config, false, "Bloks' own bridge was switched off");
  assert.ok(h.completed().every((e) => e.type === "turn.completed" && e.ok));

  await h.turn({ forOthers: true, untrusted: true, resumeCursor: "codex-thread" });
  const [resume] = h.sent("thread/resume");
  assert.equal(resume.config["mcp_servers.gmail.enabled"], false, "a resumed thread got the owner's servers back");
  assert.equal(resume.config["features.apps"], false);
});

test("Codex: the owner's own turn keeps his servers and apps as they were", async (t) => {
  const h = await codex(t, { theirs: OWNERS });
  await h.turn({});
  const [start] = h.sent("thread/start");
  const keys = Object.keys(start?.config ?? {});
  assert.ok(!keys.some((key) => key.endsWith(".enabled") || key === "features.apps"), keys.join(", "));
  // and nothing was read to find them
  assert.equal(h.sent("config/read").length, 0);
});

test("Codex: a member's turn does not run when Codex will not say or take what is to be switched off", async (t) => {
  // it cannot say what the owner's settings hold
  const blind = await codex(t, { theirs: OWNERS, refuse: (frame) => (frame.method === "config/read" ? "method not found" : null) });
  await blind.turn({ forOthers: true, untrusted: true });
  assert.equal(blind.sent("thread/start").length, 0, "a thread was started with the owner's servers unknown");
  assert.deepEqual(blind.notices(), [OWNERS_OFF_REFUSED]);
  assert.equal(blind.completed()[0]?.type === "turn.completed" && blind.completed()[0].ok, false);
});

test("Codex: a refusal of the switch is the turn failing, never a thread without it", async (t) => {
  const h = await codex(t, {
    theirs: OWNERS,
    refuse: (frame) => (Object.keys(frame.params?.config ?? {}).some((key) => key.endsWith(".enabled")) ? "unknown field `enabled`\nin `mcp_servers.gmail`" : null),
  });
  await h.turn({ forOthers: true, untrusted: true });
  assert.equal(h.sent("thread/start").length, 1, "asked again without the switch");
  assert.equal(h.sent("turn/start").length, 0, "the member's words reached a thread with the owner's servers on");
  assert.deepEqual(h.notices(), [OWNERS_OFF_REFUSED]);
});

test("Codex: a server name a config key cannot carry keeps the turn from running", async (t) => {
  assert.deepEqual(ownersOff(["gmail", "bloks_reply", "u_files"], ["u_files"]).config, { "features.apps": false, "mcp_servers.gmail.enabled": false });
  assert.deepEqual(ownersOff(["my.mail"], []).unreachable, ["my.mail"]);
  const h = await codex(t, { theirs: { "my.mail": { command: "x" } } });
  await h.turn({ forOthers: true, untrusted: true });
  assert.equal(h.sent("thread/start").length, 0);
  assert.deepEqual(h.notices(), [OWNERS_OFF_REFUSED]);
});

// ── Claude Code ────────────────────────────────────────────────────────

test("Claude Code: a member's turn starts with the owner's connectors, CLAUDE.md and memory off; his own does not", () => {
  const base = { PATH: "/bin" };
  const theirs = turnEnvironment(base, { forOthers: true });
  assert.equal(theirs.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(theirs.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal(theirs.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  const his = turnEnvironment(base, {});
  assert.equal(his.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
  assert.equal(his.CLAUDE_CODE_DISABLE_CLAUDE_MDS, undefined);
  assert.equal(his.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
  // nothing in the turn's own environment turns them back on
  const pushed = turnEnvironment(base, { forOthers: true, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "true" } });
  assert.equal(pushed.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("Claude Code: a member's turn is read the working folder's CLAUDE.md back, never the owner's own, and a bad file is left out", (t) => {
  // the owner's own, in his home folder
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "I am Hamed. My Gmail is connected.");
  const project = mkdtempSync(join(tmpdir(), "bloks-owner-apart-project-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, "CLAUDE.md"), "Recipes live in recipes/.");
  const read = readMemberClaudeInstructions(project);
  assert.match(read, /Recipes live in recipes/);
  assert.match(read, /whoever you are working with now/);
  assert.doesNotMatch(read, /Hamed|Gmail/);
  // run from the home folder itself, the owner's own is still not read
  assert.doesNotMatch(readMemberClaudeInstructions(home), /Hamed|Gmail/);
  // a CLAUDE.md that is a folder is passed over, where a Telegram
  // person's turn is refused over it
  const odd = mkdtempSync(join(tmpdir(), "bloks-owner-apart-odd-"));
  t.after(() => rmSync(odd, { recursive: true, force: true }));
  mkdirSync(join(odd, "CLAUDE.md"));
  assert.equal(readMemberClaudeInstructions(odd), "");
  assert.throws(() => readPersonClaudeInstructions(odd));
  // too long is cut, not refused
  const long = mkdtempSync(join(tmpdir(), "bloks-owner-apart-long-"));
  t.after(() => rmSync(long, { recursive: true, force: true }));
  writeFileSync(join(long, "CLAUDE.md"), "x".repeat(150_000));
  const cut = readMemberClaudeInstructions(long);
  assert.ok(cut.length > 90_000 && cut.length < 101_000, String(cut.length));
});
