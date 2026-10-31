// A Claude Code the test drives step by step, for `bloks quiet`
// (server/quiet-finish.ts): each turn waits for the test to say what it
// writes, which requests it makes with its own credential, what it asks
// through the bridge Bloks mounted for it, and when it ends. The real
// server, driver, transcript and event stream are used throughout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";
import { deviceKey, open, peek } from "../../server/relay-crypto.ts";
import { startHarness, type Harness } from "./server.ts";
import { waitFor } from "./turns.ts";

export interface QuietTurn { pid: number; text: string; token: string; n: number }
export interface QuietBot { id: string; threadId: string; name: string }

const engine = (home: string) => `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const write = (name, value) => { writeFileSync(home + "/" + name + ".tmp", JSON.stringify(value)); renameSync(home + "/" + name + ".tmp", home + "/" + name); };
let input = "", started = false, done = 0, busy = false, bridge = null;
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (let i = input.indexOf("\\n"); i >= 0; i = input.indexOf("\\n")) {
    const line = input.slice(0, i); input = input.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    const text = typeof frame.message?.content === "string" ? frame.message.content : JSON.stringify(frame.message?.content ?? "");
    if (started) { appendFileSync(home + "/steers.jsonl", JSON.stringify({ pid: process.pid, text }) + "\\n"); continue; }
    started = true;
    out({ type: "system", subtype: "init", session_id: "quiet-session", model: "claude-sonnet-5" });
    appendFileSync(home + "/turns.jsonl", JSON.stringify({ pid: process.pid, text, token: process.env.BLOKS_TOKEN }) + "\\n", { mode: 0o600 });
  }
});
const ask = async (question) => {
  const { command, args: bridgeArgs, env } = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.bloks;
  bridge = spawn(command, bridgeArgs, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let got = "";
  bridge.stdout.on("data", (c) => {
    got += c;
    for (let end = got.indexOf("\\n"); end >= 0; end = got.indexOf("\\n")) {
      const reply = JSON.parse(got.slice(0, end)); got = got.slice(end + 1);
      replies.get(reply.id)?.(reply.result);
    }
  });
  const call = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n"); });
  await call(0, "initialize", {});
  await new Promise((r) => setTimeout(r, 300));
  void call(1, "tools/call", { name: "ask_user", arguments: { question, choices: ["Yes", "No"] } });
};
setInterval(async () => {
  const file = home + "/cmd-" + process.pid + ".jsonl";
  if (!started || busy || !existsSync(file)) return;
  busy = true;
  try {
    const lines = readFileSync(file, "utf8").split("\\n").filter(Boolean);
    for (; done < lines.length; done++) {
      const cmd = JSON.parse(lines[done]);
      if (cmd.frame) out(cmd.frame);
      else if (cmd.call) {
        const headers = { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": cmd.call.raw === undefined ? "application/json" : "application/octet-stream" };
        const body = cmd.call.raw !== undefined ? cmd.call.raw : cmd.call.body !== undefined ? JSON.stringify(cmd.call.body) : undefined;
        try {
          const res = await fetch(process.env.BLOKS_URL + cmd.call.path, { method: cmd.call.method, headers, ...(body !== undefined ? { body } : {}) });
          write("res-" + cmd.id + ".json", { status: res.status, body: await res.json().catch(() => null) });
        } catch (error) { write("res-" + cmd.id + ".json", { status: 0, error: String(error) }); }
      } else if (cmd.ask) { await ask(cmd.ask); write("res-" + cmd.id + ".json", { asked: true }); }
      else if (cmd.end !== undefined) {
        out(cmd.fail
          ? { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: "quiet-session", result: cmd.end }
          : { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "quiet-session", result: cmd.end });
        bridge?.kill();
        setTimeout(() => process.exit(0), 20);
      }
    }
  } finally { busy = false; }
}, 20);
`;

export async function quietFixture(t: TestContext, holdSteer = false) {
  const home = mkdtempSync(join(tmpdir(), "bloks-quiet-finish-"));
  const cli = join(home, "claude.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli } }, spare: { driver: "claudeAgent", config: { cli } },
  } }));
  writeFileSync(cli, engine(home), { mode: 0o755 });
  const preload = join(home, "steer-preload.mjs");
  if (holdSteer) writeFileSync(preload, `
import { ClaudeDriver } from ${JSON.stringify(new URL("../../server/drivers/claude.ts", import.meta.url).href)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const home = ${JSON.stringify(home)}, create = ClaudeDriver.create;
ClaudeDriver.create = async function(input) {
  const instance = await create.call(this, input), steer = instance.adapter.steerTurn;
  instance.adapter.steerTurn = async (...args) => {
    writeFileSync(home + "/steer-entered", "");
    while (!existsSync(home + "/steer-release")) await new Promise((r) => setTimeout(r, 10));
    const took = await steer.apply(instance.adapter, args);
    if (readFileSync(home + "/steer-release", "utf8") === "uncertain") throw new Error("fixture lost the steer receipt after dispatch");
    return took;
  };
  return instance;
};
`);
  const h = await startHarness({ HOME: home, ...(holdSteer ? { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } : {}) });
  const streams: Array<() => Promise<void>> = [];
  t.after(async () => {
    await Promise.all(streams.map((close) => close()));
    for (const turn of turns()) end(turn, "Stopped by the test.");
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  let ids = 0;
  const turns = (): QuietTurn[] => existsSync(join(home, "turns.jsonl"))
    ? readFileSync(join(home, "turns.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line, n) => ({ ...JSON.parse(line), n })) : [];
  const turn = async (n: number) => {
    const found = await waitFor(() => turns()[n] ?? null, 15_000);
    assert.ok(found, `turn ${n} never reached the engine: ${h.logs()}`);
    return found;
  };
  const command = (at: QuietTurn, cmd: Record<string, unknown>) => appendFileSync(join(home, `cmd-${at.pid}.jsonl`), JSON.stringify(cmd) + "\n");
  const result = async (id: number) => {
    const file = join(home, `res-${id}.json`);
    assert.ok(await waitFor(() => existsSync(file), 15_000), `engine request ${id} never answered`);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  /** A request the engine makes as itself, and what Bloks answered. */
  const call = async (at: QuietTurn, method: string, path: string, body?: unknown, raw?: string) => {
    const id = ++ids;
    command(at, { id, call: { method, path, ...(body !== undefined ? { body } : {}), ...(raw !== undefined ? { raw } : {}) } });
    return result(id);
  };
  const quiet = (at: QuietTurn, bot: QuietBot) => call(at, "POST", `/api/bots/${bot.id}/tasks/${bot.threadId}/quiet`);
  const text = (at: QuietTurn, words: string) => command(at, { frame: { type: "assistant", message: { content: [{ type: "text", text: words }] } } });
  /** The engine running a shell command, as its tool call and result. */
  const tool = (at: QuietTurn, command_: string) => {
    const id = `tool-${++ids}`;
    command(at, { frame: { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: command_ } }] } } });
    return () => command(at, { frame: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } } });
  };
  const ask = async (at: QuietTurn, question: string) => {
    const id = ++ids;
    command(at, { id, ask: question });
    return result(id);
  };
  function end(at: QuietTurn, words = "Done.", fail = false) { command(at, { end: words, ...(fail ? { fail: true } : {}) }); }
  const bots = async () => (await h.json("/api/bots?messages=0")).bots as any[];
  const idle = async (bot: QuietBot) => Boolean(await waitFor(async () => ((await bots()).find((b) => b.id === bot.id)?.tasks.find((x: any) => x.id === bot.threadId)?.busy ? null : true), 15_000));
  const lane = async (bot: QuietBot) => (await bots()).find((b) => b.id === bot.id).tasks.find((x: any) => x.id === bot.threadId);
  const hire = async (name: string): Promise<QuietBot> => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "full" }) });
    return bot;
  };
  const messages = async (bot: QuietBot) => (await h.json(`/api/bots/${bot.id}/messages?limit=200&taskId=${bot.threadId}`)).messages as any[];
  async function stream() {
    const frames: any[] = [];
    const abort = new AbortController();
    const response = await h.fetch("/api/events", { signal: abort.signal });
    assert.ok(response.ok);
    const reading = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          buffer += decoder.decode(next.value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
            const data = block.split("\n").find((line) => line.startsWith("data: "));
            if (data) frames.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    streams.push(async () => { abort.abort(); await reading; });
    assert.ok(await waitFor(() => frames.some((frame) => frame.kind === "hello")), "SSE hello absent");
    return frames;
  }
  return { home, h, turns, turn, call, quiet, text, tool, ask, end, idle, lane, hire, messages, stream };
}

/** What the event stream showed of a lane's assistant text before it was saved. */
export const previewOf = (frames: any[], lane: string) => frames
  .filter((f) => f.event?.threadId === lane && f.event?.type === "content.delta" && f.event?.streamKind === "assistant_text")
  .map((f) => f.event.delta).join("");
export const settledIn = (frames: any[], lane: string) => frames.filter((f) => f.kind === "reply.settled" && f.threadId === lane);

/** A loopback relay and one paired synthetic phone, as in
 * test/answer-ready.test.ts: every wake the server asks the relay for. */
export async function phoneRelay(t: TestContext, h: Harness) {
  await h.json("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Example phone" }) });
  const digest = createHash("sha256").update(claimed.token).digest("hex");
  const key = deviceKey(digest, "mac-to-phone");
  const wakes: Array<{ reason?: string; preview?: any }> = [];
  let connected = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/space/agent/stream")) {
      connected = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "example-space" })}\n\n`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const wake = JSON.parse(body || "{}").wake;
      if (wake && typeof wake === "object") {
        const sealed = wake.sealed?.[claimed.device.id];
        wakes.push({ reason: wake.reason, ...(sealed ? { preview: open(key, peek(sealed)!) } : {}) });
      } else if (typeof wake === "string") wakes.push({ reason: wake });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await h.json("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, agentToken: "example-agent-token", clientToken: claimed.token, enabled: true }),
  });
  assert.ok(await waitFor(() => (connected ? true : null)), "the isolated server did not connect to its relay");
  return { token: claimed.token as string, wakes, replies: () => wakes.filter((w) => w.reason === "reply") };
}
