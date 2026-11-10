// Where the permission bridge listens when the data folder is too deep.
//
// A unix socket's path has to fit in a fixed address (104 bytes on macOS,
// 108 on Linux). The bridge used to listen in ~/.bloks whatever its
// length, and past that the engine's permission requests met a refused
// connection and were denied without a card. Now a path that does not fit
// moves to a private folder in the temp folder, and when nothing fits the
// turn says so in the chat.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bridgeSocketPath, createAskBroker, socketPathFits } from "../server/harness/ask-broker.ts";
import { startHarness } from "./helpers/server.ts";

async function waitFor<T>(check: () => Promise<T | null> | T | null, timeoutMs = 15_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

describe("the bridge's socket path", () => {
  test("a path that fits is used as it is", () => {
    const preferred = "/home/someone/.bloks/perm-abc-123456.sock";
    assert.equal(bridgeSocketPath(preferred), preferred);
  });

  test("Windows gets a named pipe, never a file path it cannot listen on, under a name nobody can guess", () => {
    const preferred = "C:\\Users\\AI\\.bloks\\perm-abc-123456.sock";
    const first = bridgeSocketPath(preferred, { platform: "win32" })!;
    const second = bridgeSocketPath(preferred, { platform: "win32" })!;
    assert.match(first, /^\\\\\.\\pipe\\bloks-[0-9a-f]{24}$/);
    assert.notEqual(first, second);
  });

  test("length is counted in bytes, so an accented home that looks short still moves", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "bloks-sock-"));
    t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    // 90 characters on screen, 150 bytes in the kernel
    const preferred = `/Users/${"é".repeat(60)}/.bloks/perm-abc-1.sock`;
    assert.ok(preferred.length < 104, "the test path should look short in characters");
    assert.equal(socketPathFits(preferred, 104), false);
    const moved = bridgeSocketPath(preferred, { tempDir: temp, room: 104, platform: "darwin" });
    assert.ok(moved, "no fallback was found");
    assert.notEqual(moved, preferred);
    assert.ok(moved!.startsWith(temp), `${moved} is not in the temp folder`);
    assert.ok(Buffer.byteLength(moved!) < 104);
    assert.match(moved!, /\/p-[0-9a-f]{10}\.sock$/);
  });

  test("the fallback folder is the user's own and closed to everyone else", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "bloks-sock-"));
    t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const long = `/x/${"d".repeat(120)}/perm.sock`;
    const first = bridgeSocketPath(long, { tempDir: temp, room: 104, platform: "linux" })!;
    const second = bridgeSocketPath(long, { tempDir: temp, room: 104, platform: "linux" })!;
    assert.ok(first && second);
    assert.notEqual(first, second, "two turns must not share a socket");
    const dir = join(first, "..");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    if (process.getuid) assert.equal(statSync(dir).uid, process.getuid());
  });

  test("a loosened fallback folder is closed again, and a link in its place is refused", (t) => {
    const temp = mkdtempSync(join(tmpdir(), "bloks-sock-"));
    t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const long = `/x/${"d".repeat(120)}/perm.sock`;
    const name = `bloks-${process.getuid?.() ?? "user"}`;
    mkdirSync(join(temp, name), { mode: 0o777 });
    const moved = bridgeSocketPath(long, { tempDir: temp, room: 104, platform: "linux" });
    assert.ok(moved);
    assert.equal(statSync(join(temp, name)).mode & 0o777, 0o700);

    const other = mkdtempSync(join(tmpdir(), "bloks-sock-"));
    t.after(() => rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const elsewhere = mkdtempSync(join(tmpdir(), "bloks-sock-target-"));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    symlinkSync(elsewhere, join(other, name));
    assert.equal(bridgeSocketPath(long, { tempDir: other, room: 104, platform: "linux" }), null);
  });

  test("nothing fits when the temp folder is too deep as well", (t) => {
    const temp = join(mkdtempSync(join(tmpdir(), "bloks-sock-")), "t".repeat(110));
    mkdirSync(temp, { recursive: true });
    t.after(() => rmSync(join(temp, ".."), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    assert.equal(bridgeSocketPath(`/x/${"d".repeat(120)}/perm.sock`, { tempDir: temp, room: 104, platform: "darwin" }), null);
  });

  test("the broker listens on the fallback and removes the socket when it closes", async (t) => {
    const temp = mkdtempSync(join(tmpdir(), "bloks-sock-"));
    t.after(() => rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const path = bridgeSocketPath(`/x/${"d".repeat(120)}/perm.sock`, { tempDir: temp, room: 104, platform: "linux" })!;
    const broker = createAskBroker({ socketPath: path, onAsk: () => {}, onResolve: () => {} });
    assert.ok(await waitFor(() => existsSync(path)), "the broker never listened");
    broker.close();
    assert.equal(existsSync(path), false, "the socket outlived its broker");
  });
});

/** A Claude Code stand-in that asks one permission per turn over the
 * bridge and writes down where it asked and what came back. */
function fakeClaude(home: string, log: string): string {
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const note = (line) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(line) + "\\n");
const cfg = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
const socketPath = cfg.mcpServers.bloks.args.at(-1);
const done = () => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })); setTimeout(() => process.exit(0), 50); };
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(() => {
  const sock = connect(socketPath);
  let buf = "";
  sock.on("error", (error) => { note({ socketPath, error: error.code }); done(); });
  sock.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("\\n");
    if (i === -1) return;
    const f = JSON.parse(buf.slice(0, i));
    note({ socketPath, behavior: f.behavior });
    sock.end();
    done();
  });
  sock.on("connect", () => sock.write(JSON.stringify({ t: "ask", id: "a" + Date.now(), kind: "permission", tool: "Bash", input: { command: "echo hi" } }) + "\\n"));
});
`,
    { mode: 0o755 },
  );
  return cli;
}

describe("a home too deep for a socket", () => {
  test("approvals still reach the person, turn after turn", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bloks-deep-"));
    const home = join(root, "h".repeat(90));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    assert.ok(Buffer.byteLength(join(home, ".bloks", "perm-12345678-123456.sock")) >= 108, "the home is not deep enough to test this");
    const log = join(root, "asks.log");
    const cli = fakeClaude(root, log);
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
    const h = await startHarness({ HOME: home });
    // the server stops before its folders go: removed first, a write it
    // was still making landed as the folder went (ENOTEMPTY)
    t.after(async () => {
      await h.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Deep" }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "auto" }),
    });
    const asks = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
    const idle = () => waitFor(async () => !(await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).busy);
    for (const [i, text] of ["first", "second"].entries()) {
      await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      const seen = await waitFor(() => (asks().length > i ? asks()[i] : null));
      assert.ok(seen, `turn ${i + 1} never asked`);
      assert.equal(seen.error, undefined, `turn ${i + 1}'s ask failed with ${seen.error}`);
      assert.equal(seen.behavior, "allow");
      assert.ok(Buffer.byteLength(seen.socketPath) < 104, `turn ${i + 1} was handed ${seen.socketPath}`);
      await idle();
      assert.equal(existsSync(seen.socketPath), false, "the turn's socket was left behind");
    }
  });

  test("with nowhere to listen, the turn says so in the chat instead of denying in silence", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bloks-deeper-"));
    const home = join(root, "h".repeat(90));
    const temp = join(root, "t".repeat(110));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    mkdirSync(temp, { recursive: true });
    const log = join(root, "asks.log");
    const cli = fakeClaude(root, log);
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
    const h = await startHarness({ HOME: home, TMPDIR: temp });
    // the server stops before its folders go: removed first, a write it
    // was still making landed as the folder went (ENOTEMPTY)
    t.after(async () => {
      await h.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Deeper" }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "auto" }),
    });
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "go" }) });
    const notice = await waitFor(async () => {
      const found = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
      return found.busy ? null : found.messages.find((m: any) => m.kind === "notice" && /set up approvals/.test(m.text)) ?? null;
    });
    assert.ok(notice, "the turn ended without saying approvals could not be set up");
    assert.match(notice.text, /TMPDIR/);
    assert.equal(existsSync(log), false, "the engine ran with no way to ask");
  });
});
