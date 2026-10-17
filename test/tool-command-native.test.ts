import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { deviceKey, open, peek } from "../server/relay-crypto.ts";
import { doubleWrapped, singleWrapped } from "./helpers/command-fixtures.ts";
// Exercise both protocol adapters, the bus log, raw SSE and the stored
// transcript together. All commands and credential values are invented.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness } from "./helpers/server.ts";

const SECRET = "stored_fixture_credential";
const PRIVATE = [SECRET, "sk-fixture_abcdefghijklmnop", "header_fixture_value", "url_fixture_password", "escaped_fixture_value", "unclosed_fixture_value", "assign_fixture_value", "flag_fixture_value", "cookie_fixture_value", "split_fixture_value"];
const MULTI = "printf 'first line'\nprintf 'second line'";
const SENSITIVE = "curl -H 'Authorization: Bearer header_fixture_value' https://demo:url_fixture_password@example.invalid -d " + SECRET + " -d sk-fixture_abcdefghijklmnop";
const SAFE = "curl -H 'Authorization: [redacted]' https://demo:[redacted]@example.invalid -d [redacted] -d [redacted]";
const calls = [
  { id: "sensitive", command: SENSITIVE },
  { id: "multi", command: MULTI },
  { id: "bare", command: "ls", failed: true },
  { id: "malformed", command: null },
  { id: "blank", command: " \n\t" },
  { id: "missing" },
  { id: "read", kind: "read", command: "not_command_detail" },
  { id: "digest", command: 'curl -H "Authorization: Digest username=\\"demo\\", response=\\"escaped_fixture_value\\"" https://example.invalid' },
  { id: "unclosed", command: 'tool Bearer "unclosed_fixture_value' },
  { id: "extra", command: "API_KEY=assign_fixture_value tool --token flag_fixture_value -H 'Cookie: session=cookie_fixture_value'" },
  { id: "zsh-wrapped", command: 'cd /fixture && GITHUB_TOKEN=assign_fixture_value tool --password=flag_fixture_value -H "Authorization:" "Basic split_fixture_value"' },
  { id: "sh-wrapped", command: "cd /fixture && export API_KEY=assign_fixture_value tool --token flag_fixture_value" },
  { id: "single-wrapped", command: SENSITIVE },
  { id: "split-header", command: 'curl -H "Authorization": "Basic split_fixture_value"' },
];
const wrap = (command: string, id: string) => id === "zsh-wrapped" ? singleWrapped(command, "/bin/zsh -lc")
  : id === "sh-wrapped" ? doubleWrapped(command, "/bin/sh -c")
  : id === "single-wrapped" ? singleWrapped(command) : doubleWrapped(command);
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await wait(50);
  }
  assert.fail("fixture did not reach its next state");
}

function fakeEngine(root: string, engine: string) {
  const common = [
    "#!" + process.execPath,
    'import { existsSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    "const root = " + JSON.stringify(root) + ";",
    "const calls = " + JSON.stringify(calls.map((call) => engine === "codex" && typeof call.command === "string" && call.command.trim() ? { ...call, command: wrap(call.command, call.id) } : call)) + ";",
    'const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");',
    "const nap = (ms) => new Promise((r) => setTimeout(r, ms));",
    'if (process.argv[2] === "--version") { console.log("9.9.9"); process.exit(0); }',
    'if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }',
    'if (process.argv[2] === "auth") { out({ loggedIn: true }); process.exit(0); }',
    'process.stdin.on("end", () => process.exit(0));',
    'const released = async () => { for (let i = 0; i < 1500 && !existsSync(root + "/release"); i++) await nap(20); };',
  ];
  const codex = [
    'let thread, turn, n = 0;',
    'const item = (c) => c.kind === "read" ? { type: "mcpToolCall", id: c.id, tool: "read_file", command: c.command } : { type: "commandExecution", id: c.id, ...(Object.hasOwn(c, "command") ? { command: c.command } : {}) };',
    'createInterface({ input: process.stdin }).on("line", async (line) => {',
    ' const m = JSON.parse(line); if (!m.method) return;',
    ' const reply = (result = {}) => out({ id: m.id, result });',
    ' if (m.method === "initialized") return;',
    ' if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Demo", isDefault: true, hidden: false }] });',
    ' if (m.method === "skills/list") return reply({ data: [{ cwd: m.params.cwds[0], skills: [], errors: [] }] });',
    ' if (m.method === "thread/start" || m.method === "thread/resume") { thread = "fixture-thread"; return reply({ thread: { id: thread }, serviceTier: m.params.serviceTier, model: "gpt-6.1-sol" }); }',
    ' if (m.method === "turn/interrupt") { reply(); out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "interrupted" } } }); return; }',
    ' if (m.method !== "turn/start") return reply();',
    ' turn = "fixture-turn-" + ++n; reply({ turn: { id: turn } });',
    ' out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });',
    ' for (const c of calls) out({ method: "item/started", params: { threadId: thread, turnId: turn, item: item(c) } });',
    ' await released();',
    ' for (const c of calls) out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { ...item(c), status: c.failed ? "failed" : "completed" } } });',
    ' out({ method: "item/completed", params: { threadId: thread, turnId: turn, item: { type: "agentMessage", id: "answer", text: "Fixture finished." } } });',
    ' out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });',
    '});',
  ];
  const claude = [
    'createInterface({ input: process.stdin }).on("line", async (line) => {',
    ' const m = JSON.parse(line); if (m.type !== "user") return;',
    ' out({ type: "system", subtype: "init", session_id: "fixture-session", model: "claude-sonnet-5" });',
    ' out({ type: "assistant", message: { content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.kind === "read" ? "Read" : "Bash", input: Object.hasOwn(c, "command") ? { command: c.command } : {} })) } });',
    ' await released();',
    ' out({ type: "user", message: { content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "", is_error: Boolean(c.failed) })) } });',
    ' out({ type: "assistant", message: { content: [{ type: "text", text: "Fixture finished." }] } });',
    ' out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "fixture-session", result: "Fixture finished." });',
    '});',
  ];
  const cli = join(root, "fixture-" + engine + ".mjs");
  writeFileSync(cli, [...common, ...(engine === "codex" ? codex : claude)].join("\n"), { mode: 0o755 });
  return cli;
}

for (const engine of ["codex", "claude"]) {
  test(engine + " commands are sanitized before every new-field sink and survive completion, stop and reload", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bloks-command-"));
    mkdirSync(join(root, ".bloks"), { recursive: true });
    writeFileSync(join(root, ".bloks", "config.json"), JSON.stringify({
      instances: { [engine]: { driver: engine === "claude" ? "claudeAgent" : "codex", config: { cli: fakeEngine(root, engine) } } },
      secrets: { DEMO_CREDENTIAL: SECRET },
    }));
    let h = await startHarness({ HOME: root, USERPROFILE: root });
    t.after(async () => { await h.stop(); rmSync(root, { recursive: true, force: true }); });
    const { bot } = await h.json("/api/bots", post({ name: "Runner" }));
    await h.json("/api/bots/" + bot.id, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: engine, model: engine === "claude" ? "claude-sonnet-5" : "gpt-6.1-sol" } }) });
    const response = await h.fetch("/api/events");
    const reader = response.body!.getReader();
    let sse = "";
    const decoder = new TextDecoder();
    const reading = (async () => {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          sse += decoder.decode(part.value, { stream: true });
        }
      } catch { /* a stopped fixture closes its connection */ }
    })();
    t.after(async () => { await reader.cancel().catch(() => {}); await reading; });
    const messages = async () => (await h.json("/api/bots/" + bot.id + "/messages?limit=100")).messages;
    await h.json("/api/bots/" + bot.id + "/messages", post({ text: "Show the fixture activity." }));
    const rows: any[] = await until(async () => {
      const rows = (await messages()).filter((m: any) => m.tool);
      return rows.length === calls.length ? rows : null;
    });
    const name = engine === "claude" ? "Bash" : "shell";
    const shown = (command: string, id = "") => engine === "codex" ? wrap(command, id) : command;
    assert.deepEqual(rows[0].tool, { name, command: shown(SAFE) });
    assert.equal(rows[1].tool.command, shown(MULTI));
    assert.deepEqual(rows[2].tool, { name, command: shown("ls") });
    for (const row of rows.slice(3, 6)) assert.deepEqual(row.tool, { name });
    assert.deepEqual(rows[6].tool, { name: engine === "claude" ? "Read" : "read_file" });
    assert.equal(rows[7].tool.command, shown('curl -H "Authorization: [redacted]" https://example.invalid'));
    assert.equal(rows[8].tool.command, shown('tool Bearer "[redacted]'));
    assert.equal(rows[9].tool.command, shown("API_KEY=[redacted] tool --token [redacted] -H 'Cookie: [redacted]'"));
    assert.equal(rows[10].tool.command, shown('cd /fixture && GITHUB_TOKEN=[redacted] tool --password=[redacted] -H "Authorization:" "[redacted]"', "zsh-wrapped"));
    assert.equal(rows[11].tool.command, shown("cd /fixture && export API_KEY=[redacted] tool --token [redacted]", "sh-wrapped"));
    assert.equal(rows[12].tool.command, shown(SAFE, "single-wrapped"));
    assert.equal(rows[13].tool.command, shown('curl -H "Authorization": "[redacted]"'));
    const inFlight = JSON.parse(readFileSync(join(root, ".bloks", "turns-in-flight.json"), "utf8"));
    assert.equal(inFlight.find((turn: any) => turn.laneId === bot.threadId).tool, engine === "codex" ? shown('curl -H "Authorization": "[redacted]"').slice(0, 80) : "Bash", "pickup lost the legacy tool title");
    await until(() => sse.includes('"kind":"message"') && sse.includes('"command":') ? true : null);
    const frames = () => sse.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    const event = frames().find((f) => f.kind === "runtime" && f.event.itemId === "sensitive").event;
    assert.equal(event.title, name);
    assert.equal(event.command, shown(SAFE), "raw runtime SSE leaked before transcript folding");
    for (const [id, row] of [["zsh-wrapped", rows[10]], ["sh-wrapped", rows[11]]] as const) {
      await until(() => sse.includes('"itemId":"' + id + '"') ? true : null);
      const wrapped = frames().find((f) => f.kind === "runtime" && f.event.itemId === id).event;
      assert.equal(wrapped.command, row.tool.command, id + " runtime SSE lost the sanitized command");
    }
    const eventLog = join(root, ".bloks", "events", bot.threadId + ".ndjson");
    const messageFile = join(root, ".bloks", "messages-" + bot.threadId + ".json");
    for (const [sink, text] of [["SSE", sse], ["event log", readFileSync(eventLog, "utf8")], ["message store", readFileSync(messageFile, "utf8")], ["HTTP", JSON.stringify(rows)], ["server output", h.logs()]]) {
      for (const secret of PRIVATE) assert.ok(!text.includes(secret), sink + " leaked " + secret);
    }
    const logged = readFileSync(eventLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(logged.find((e) => e.itemId === "sensitive").command, shown(SAFE), "sanitization ran after EventBus.record");
    writeFileSync(join(root, "release"), "1");
    const complete: any[] = await until(async () => {
      const rows = (await messages()).filter((m: any) => m.tool);
      return rows.length === calls.length && rows.every((m: any) => m.tool.ok !== undefined) ? rows : null;
    });
    assert.deepEqual(complete[0].tool, { name, command: shown(SAFE), ok: true });
    assert.deepEqual(complete[2].tool, { name, command: shown("ls"), ok: false });
    await until(() => frames().some((f) => f.kind === "message.patch" && f.message.id === rows[0].id) ? true : null);
    assert.deepEqual(frames().find((f) => f.kind === "message.patch" && f.message.id === rows[0].id).message.tool, complete[0].tool);
    await reader.cancel(); await reading;
    await h.stop();
    h = await startHarness({ HOME: root, USERPROFILE: root });
    assert.deepEqual((await messages()).find((m: any) => m.id === rows[0].id).tool, complete[0].tool);
    rmSync(join(root, "release"));
    await h.json("/api/bots/" + bot.id + "/messages", post({ text: "Show another fixture, then hold." }));
    const open: any[] = await until(async () => {
      const rows = (await messages()).filter((m: any) => m.tool && m.tool.ok === undefined && !m.tool.stopped);
      return rows.length === calls.length ? rows : null;
    });
    const stopped = await h.fetch("/api/bots/" + bot.id + "/interrupt", post({}));
    assert.equal(stopped.status, 200);
    const settled: any = await until(async () => (await messages()).find((m: any) => m.id === open[0].id && m.tool.stopped) ?? null);
    assert.equal(settled.tool.command, shown(SAFE));
  });
}

test("member history, live messages, patches, replay and sealed relay omit command detail", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-command-member-"));
  mkdirSync(join(root, ".bloks"), { recursive: true });
  const configFile = join(root, ".bloks", "config.json");
  writeFileSync(configFile, JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: fakeEngine(root, "claude") } } } }));
  let h = await startHarness({ HOME: root, USERPROFILE: root, BLOKS_LOOPBACK_ONLY: "1" });
  const streams: Array<ReturnType<typeof httpRequest>> = [];
  const pushed: string[] = [];
  let connected = false;
  const relay = createServer((req, res) => {
    if (req.url === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","spaceId":"fixture-space"}\n\n');
      connected = true;
      return;
    }
    let text = "";
    req.on("data", (chunk) => text += chunk);
    req.on("end", () => {
      if (req.url === "/space/agent/events") pushed.push(...(JSON.parse(text).frames ?? []));
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const req of streams) req.destroy();
    await h.stop();
    relay.closeAllConnections();
    await new Promise<void>((r) => relay.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", post({ name: "Runner" }));
  await h.json("/api/bots/" + bot.id, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { bot: observer } = await h.json("/api/bots", post({ name: "Observer" }));
  const { blok } = await h.json("/api/bloks", post({ name: "Workshop", memberIds: [bot.id, observer.id] }));
  assert.ok(blok?.id, "fixture room was not created");
  await h.stop();
  const token = "fixture-member-device-token";
  const digest = createHash("sha256").update(token).digest("hex");
  const cfg = JSON.parse(readFileSync(configFile, "utf8"));
  cfg.remote = { enabled: true, memberDevices: [{ id: "fixture-device", personId: "fixture-person", name: "Viewer", hash: digest, pairedAt: 1 }] };
  cfg.relay = { enabled: true, url: "http://127.0.0.1:" + (relay.address() as any).port, agentToken: "fixture-agent" };
  writeFileSync(configFile, JSON.stringify(cfg));
  const roomsFile = join(root, ".bloks", "bloks.json");
  const rooms = JSON.parse(readFileSync(roomsFile, "utf8"));
  rooms.find((r: any) => r.id === blok.id).sharing = { since: 1, history: "all", activityDetail: false, collaboratorsInvite: false, tools: "desk", spendCap: 0 };
  writeFileSync(roomsFile, JSON.stringify(rooms));
  writeFileSync(join(root, ".bloks", "people.json"), JSON.stringify({
    people: [{ id: "fixture-person", name: "Viewer", createdAt: 1 }],
    memberships: [{ personId: "fixture-person", roomId: blok.id, role: "viewer", joinedAt: 1, invitedBy: "owner" }],
    invites: [], knocks: [],
  }));
  h = await startHarness({ HOME: root, USERPROFILE: root, BLOKS_LOOPBACK_ONLY: "1" });
  await until(() => connected ? true : null);
  const frames = (s: { text: string }) => s.text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
  async function stream(since?: number) {
    const capture = { text: "" };
    const req = httpRequest(new URL("/api/events" + (since === undefined ? "" : "?since=" + since), h.url), {
      headers: { host: "192.168.1.20", authorization: "Bearer " + token },
    }, (res) => res.on("data", (chunk) => capture.text += chunk));
    req.on("error", () => {}); req.end(); streams.push(req);
    await until(() => frames(capture).some((f) => f.kind === "hello" && f.member) ? true : null);
    return capture;
  }
  const live = await stream();
  const since = frames(live)[0]._seq;
  await h.json("/api/bloks/" + blok.id + "/messages", post({ text: "@Runner Show the invented activity." }));
  const ownerRows: any[] = await until(async () => {
    const rows = (await h.json("/api/bloks/" + blok.id + "/messages")).messages.filter((m: any) => m.tool);
    return rows.length === calls.length ? rows : null;
  }).catch(async (error) => { t.diagnostic(h.logs()); t.diagnostic(JSON.stringify(await h.json("/api/bots"))); t.diagnostic(JSON.stringify(await h.json("/api/bloks/" + blok.id + "/messages"))); throw error; });
  const target = ownerRows[0].id;
  const hidden = (row: any, path: string) => {
    assert.ok(row?.tool, path + ": missing activity");
    assert.equal("command" in row.tool, false, path + ": command detail leaked");
    assert.equal(row.tool.name, "Ran a command", path);
  };
  const history = await h.fetchRemote("/api/member/rooms/" + blok.id, { token });
  assert.equal(history.status, 200);
  hidden(history.body.messages.find((m: any) => m.id === target), "history");
  await until(() => frames(live).some((f) => f.kind === "message" && f.message?.id === target) ? true : null);
  hidden(frames(live).find((f) => f.kind === "message" && f.message?.id === target).message, "live");
  writeFileSync(join(root, "release"), "1");
  await until(() => frames(live).some((f) => f.kind === "message.patch" && f.message?.id === target) ? true : null);
  hidden(frames(live).find((f) => f.kind === "message.patch" && f.message?.id === target).message, "patch");
  const replay = await stream(since);
  await until(() => frames(replay).some((f) => f.kind === "message.patch" && f.message?.id === target) ? true : null);
  for (const frame of frames(replay).filter((f) => f.message?.id === target)) hidden(frame.message, "replay");
  const key = deviceKey(digest, "mac-to-phone");
  const relayed = () => pushed.map((f) => open(key, peek(f)!) as any).filter(Boolean);
  await until(() => relayed().some((f) => f.kind === "message.patch" && f.message?.id === target) ? true : null);
  for (const frame of relayed().filter((f) => f.message?.id === target)) hidden(frame.message, "sealed relay");
  assert.ok(ownerRows[0].tool.command, "owner lost command detail");
  const setting = await h.fetch("/api/bloks/" + blok.id + "/share", { method: "PATCH", body: JSON.stringify({ activityDetail: true }) });
  assert.equal(setting.status, 200);
  const detailed = await h.fetchRemote("/api/member/rooms/" + blok.id, { token });
  // activity detail shares what kind of tool ran, never the command
  const shared = detailed.body.messages.find((m: any) => m.id === target).tool;
  assert.equal("command" in shared, false, "activity detail sent a member the command");
  assert.equal(shared.name, ownerRows[0].tool.name);
});
