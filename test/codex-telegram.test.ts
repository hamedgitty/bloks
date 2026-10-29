import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";
import { fakePlaces } from "./helpers/fake-places.ts";

const preload = new URL("./helpers/telegram-fetch.mjs", import.meta.url).href;
const entry = new URL("../server/index.ts", import.meta.url);
const CHAT = 10101;

async function fixture(t: TestContext, options: { crashOn?: string; crashStage?: "joined" | "fail-dispatch" | "dismissed" | "fail-dismiss"; extraEnv?: Record<string, string> } = {}) {
  const updates: any[] = [], sends: any[] = [], edits: any[] = [];
  const polled = new Set<number>();
  const heldTranscriptions: Array<() => void> = [];
  let next = 1;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/file/")) {
      res.writeHead(200, { "content-type": "audio/ogg" });
      return void res.end("OggS-fixture");
    }
    if (req.url === "/v1/audio/transcriptions") {
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        heldTranscriptions.push(() => res.end(JSON.stringify({ text: "SLOW_VOICE" })));
      });
      return;
    }
    let raw = ""; req.on("data", (part) => raw += part);
    req.on("end", () => {
      const body = JSON.parse(raw || "{}"); res.setHeader("content-type", "application/json");
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (req.url?.endsWith("getMe")) return reply({ id: 12345, is_bot: true, username: "PlanningBot" });
      if (req.url?.endsWith("getFile")) return reply({ file_path: "voice/fixture.ogg", file_size: 12 });
      if (req.url?.endsWith("getUpdates")) return void setTimeout(() => {
        const ready = updates.filter((u) => u.update_id >= body.offset);
        for (const update of ready) polled.add(update.update_id);
        reply(ready);
      }, 30);
      if (req.url?.endsWith("sendMessage")) {
        sends.push(body);
        const id = sends.length;
        return reply({ message_id: id });
      }
      if (req.url?.endsWith("editMessageText")) edits.push(body);
      return reply(true);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { NODE_OPTIONS: `--import=${preload}`, BLOKS_TEST_TELEGRAM_URL: url, BLOKS_TEST_SPEECH_URL: url,
    ...(options.crashOn ? { BLOKS_TEST_CRASH_PREP: options.crashOn } : {}),
    ...(options.crashStage ? { BLOKS_TEST_CRASH_STAGE: options.crashStage } : {}), ...options.extraEnv };
  const s = await codexCommands(t, env);
  const push = (text: string) => {
    const id = next++;
    updates.push({ update_id: id, message: { message_id: next, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Sam" }, text } });
    return id;
  };
  const voice = () => {
    const id = next++;
    updates.push({ update_id: id, message: { message_id: next, chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "Sam" }, voice: { file_id: "voice-slow", file_size: 12 } } });
    return id;
  };
  const duplicate = (updateId: number) => {
    const original = updates.find((update) => update.update_id === updateId);
    assert.ok(original);
    const id = next++;
    updates.push({ ...original, update_id: id });
    return id;
  };
  const paired = await s.post("/api/telegram", { token: "12345:TEST_ONLY", enabled: true, botId: s.bot.id, pair: true });
  assert.ok(paired.pairing); push(paired.pairing);
  await waitFor(() => sends.some((m) => m.text.startsWith("Paired.")));
  const answers = () => sends.filter((m) => !m.text.startsWith("Paired.") && !m.text.startsWith("Your message is saved."));
  return { ...s, get h() { return s.h; }, push, voice, duplicate, polled, sends, edits, answers, heldTranscriptions,
    async queue(text: string) {
    const before = sends.length; push(text);
    await waitFor(() => sends.slice(before).some((m) => m.text.startsWith("Your message is saved.")));
  }, async stoppedBeforeRecovery() {
    await s.h.crash();
    const child = spawn(process.execPath, [fileURLToPath(entry)], { env: { ...process.env, ...env, HOME: s.root, USERPROFILE: s.root, BLOKS_PORT: "0", BLOKS_TEST_STOP_BEFORE_RECOVERY: "1", BLOKS_TEST_PARENT_PID: String(process.pid), OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "", XAI_API_KEY: "", GEMINI_API_KEY: "", COMPOSIO_KEY: "", BOX_TOKEN: "", BLOKS_LOOPBACK_ONLY: "", BLOKS_PRICES_URL: "http://127.0.0.1:9/api/v1/models", PATH: "/nonexistent", npm_config_prefix: "", PREFIX: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout?.on("data", (chunk) => output += chunk); child.stderr?.resume();
    t.after(() => child.kill("SIGKILL"));
    await waitFor(() => output.includes("bloks server on http://"));
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await gone;
  } };
}

/** The same intake with a fake container and fake Codex on its far side.
 * Capture attached-file contents as the fake engine reads its input,
 * before the place cleans the turn's files up. */
async function remoteFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bloks-preparation-place-"));
  const fake = fakePlaces(root, join(root, "seen.json"));
  let s: Awaited<ReturnType<typeof fixture>>;
  try { s = await fixture(t, { extraEnv: fake.env }); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  // A fake docker call Bloks started just before the crash can still
  // write here while the folder goes, so retry, then leave it, as the
  // harness does with its home (test/helpers/server.ts).
  t.after(async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); return; }
      catch { await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); }
    }
  });
  const localCli = join(s.root, "fake-codex.mjs");
  const remoteCli = join(fake.there, "fake-codex.mjs");
  const code = readFileSync(localCli, "utf8");
  const marker = 'log({method:m.method,params:m.params,cwd:process.cwd(),pid:process.pid});';
  assert.ok(code.includes(marker));
  const recordFiles = `\n  if(m.method==="turn/start"||m.method==="turn/steer") {\n    const text=m.params.input.filter(i=>i.type==="text").map(i=>i.text).join("");\n    const tag=text.split('<attached-file path="')[1]??text.split('<attached-image path="')[1];\n    const path=tag?.split('"')[0];\n    const bytes=path&&existsSync(path)?readFileSync(path):null;\n    log({method:"fixture/attachment",path,content:bytes?.toString("utf8")??null,base64:bytes?.toString("base64")??null});\n  }`;
  writeFileSync(remoteCli, code.replace(marker, marker + recordFiles));
  chmodSync(remoteCli, 0o755);
  const saved = await s.h.fetch(`/api/bots/${s.bot.id}/workplace`, {
    method: "PUT", body: JSON.stringify({ workplace: { kind: "docker", source: "image", image: "node:22-bookworm", name: "fake-place", folder: "mount", path: s.root, command: remoteCli, network: true } }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  return { ...s, get h() { return s.h; }, fake, root };
}

test("the owner's Telegram skill words reach turn/start as a named item", async (t) => {
  const s = await fixture(t); s.push("PHONE $selected");
  await waitFor(() => s.answers().length === 1); await s.settled();
  const input = s.calls().find((c) => c.method === "turn/start").params.input;
  assert.deepEqual(input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.answers()[0].chat_id, CHAT);
});

test("a remote file and later additions wait in order and the next turn can read the edited file", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "first.txt"), editedFile = join(s.root, "edited.txt"), withdrawnFile = join(s.root, "withdrawn-later.txt");
  writeFileSync(file, "first attachment");
  writeFileSync(editedFile, "edited attachment");
  writeFileSync(withdrawnFile, "withdrawn attachment");
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST_REMOTE");
  await s.called("thread/start", 1);
  s.push("READY_BEFORE_FILE");
  s.push(`REMOTE_FILE <attached-file path="${file}" />`);
  s.push("AFTER_FILE");
  s.push(`WITHDRAW_ME <attached-file path="${withdrawnFile}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("WITHDRAW_ME")), "the additions did not enter the queue");
  s.threadGate();
  await s.called("turn/start", 1);
  const first = s.calls().find((c) => c.method === "turn/start");
  assert.match(JSON.stringify(first.params.input), /READY_BEFORE_FILE/);
  assert.doesNotMatch(JSON.stringify(first.params.input), /REMOTE_FILE|AFTER_FILE|WITHDRAW_ME/);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("REMOTE_FILE") && m.preparation?.state === "next"), "the file did not fall back");
  const queued = await s.messages();
  const fileRow = queued.find((m) => m.text?.startsWith("REMOTE_FILE"))!;
  const after = queued.find((m) => m.text === "AFTER_FILE")!;
  const withdrawn = queued.find((m) => m.text?.startsWith("WITHDRAW_ME"))!;
  assert.equal(after.preparation?.state, "next");
  assert.equal(withdrawn.preparation?.state, "next");
  assert.equal((await s.say("ARRIVED_AFTER_BARRIER")).delivery?.route, "queued");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "ARRIVED_AFTER_BARRIER" && m.preparation?.state === "next"), "the later addition did not wait");
  const edit = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${fileRow.id}`, {
    method: "PATCH", body: JSON.stringify({ text: `REMOTE_FILE_EDITED <attached-file path="${editedFile}" />` }),
  });
  assert.equal(edit.status, 200);
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${withdrawn.id}`, { method: "DELETE" })).status, 200);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 0, "a later addition overtook the file");
  assert.equal(s.count("turn/interrupt"), 0, "the fallback stopped the original turn");
  s.gate();
  await s.called("turn/start", 2);
  const starts = s.calls().filter((c) => c.method === "turn/start");
  const second = JSON.stringify(starts[1].params.input);
  assert.match(second, /REMOTE_FILE_EDITED/);
  assert.ok(second.indexOf("REMOTE_FILE_EDITED") < second.indexOf("AFTER_FILE"));
  assert.ok(second.indexOf("AFTER_FILE") < second.indexOf("ARRIVED_AFTER_BARRIER"));
  assert.doesNotMatch(second, /WITHDRAW_ME/);
  assert.equal(starts.filter((c) => JSON.stringify(c.params.input).includes("REMOTE_FILE_EDITED")).length, 1);
  await waitFor(() => s.calls().some((c) => c.method === "fixture/attachment" && c.content === "edited attachment"));
  const captured = s.calls().filter((c) => c.method === "fixture/attachment").find((c) => c.content === "edited attachment");
  assert.ok(captured, "the next fake remote engine could not read the edited file");
  assert.ok(captured.path.startsWith(s.fake.home + "/"), "the copied file was not on the fake far side");
  assert.notEqual(captured.path, editedFile);
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start").length, 2);
});

test("an explicit Send now takes a remote file through the next turn", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "send-now.txt");
  writeFileSync(file, "send now attachment");
  s.spec({ hold: true, holdThread: true });
  await s.say("FIRST_REMOTE");
  await s.called("thread/start", 1);
  await s.say(`SEND_NOW_FILE <attached-file path="${file}" />`);
  s.threadGate();
  await s.called("turn/start", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("SEND_NOW_FILE") && m.preparation?.state === "next"));
  assert.equal(s.count("turn/interrupt"), 0, "the fallback stopped the turn before the user asked");
  const now = await s.post(`/api/bots/${s.bot.id}/queued/now`, { taskId: s.bot.threadId });
  assert.equal(now.outcome, "stopped");
  await s.called("turn/start", 2);
  assert.equal(s.count("turn/steer"), 0, "the file was steered without being copied");
  await waitFor(() => s.calls().some((c) => c.method === "fixture/attachment" && c.content === "send now attachment"), "the next turn could not read the file");
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 2);
});

test("withdrawing a remote file before commitment lets later text join", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "withdrawn.txt");
  writeFileSync(file, "withdrawn attachment");
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST_REMOTE");
  await s.called("thread/start", 1);
  s.push(`WITHDRAW_FILE <attached-file path="${file}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("WITHDRAW_FILE")));
  const row = (await s.messages()).find((m) => m.text?.startsWith("WITHDRAW_FILE"))!;
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}`, { method: "DELETE" })).status, 200);
  s.push("AFTER_WITHDRAWAL");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_WITHDRAWAL"));
  s.threadGate();
  await s.called("turn/start", 1);
  const first = JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input);
  assert.match(first, /AFTER_WITHDRAWAL/);
  assert.doesNotMatch(first, /WITHDRAW_FILE/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("editing a frozen remote addition into a file keeps its suffix for the next turn", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "edited-during-snapshot.txt");
  writeFileSync(file, "snapshot attachment");
  s.spec({ hold: true, holdThread: true, holdSkills: true });
  s.push("FIRST_REMOTE $selected");
  await s.called("thread/start", 1);
  s.push("BEFORE_FILE_EDIT");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEFORE_FILE_EDIT"));
  const row = (await s.messages()).find((m) => m.text === "BEFORE_FILE_EDIT")!;
  s.threadGate();
  await s.called("skills/list", 1);
  const edited = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}`, {
    method: "PATCH", body: JSON.stringify({ text: `EDITED_TO_FILE <attached-file path="${file}" />` }),
  });
  assert.equal(edited.status, 200);
  s.push("AFTER_FILE_EDIT");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_FILE_EDIT"));
  s.skillsGate();
  await s.called("turn/start", 1);
  assert.doesNotMatch(JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input), /BEFORE_FILE_EDIT|EDITED_TO_FILE|AFTER_FILE_EDIT/);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("EDITED_TO_FILE") && m.preparation?.state === "next"));
  s.gate();
  await s.called("turn/start", 2);
  const second = JSON.stringify(s.calls().filter((c) => c.method === "turn/start")[1].params.input);
  assert.ok(second.indexOf("EDITED_TO_FILE") < second.indexOf("AFTER_FILE_EDIT"));
  await waitFor(() => s.calls().some((c) => c.method === "fixture/attachment" && c.content === "snapshot attachment"));
  await s.settled();
});

test("a remote file arriving during a preparation steer follows the confirmed input", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "late.txt");
  writeFileSync(file, "late attachment");
  s.spec({ hold: true, holdSkills: true, holdSteerSkills: true });
  s.push("FIRST_REMOTE $selected");
  await s.called("skills/list", 1);
  s.push("EARLIER_STEER $selected");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "EARLIER_STEER $selected"));
  s.skillsGate();
  await s.called("skills/list", 2);
  s.push(`LATE_REMOTE_FILE <attached-file path="${file}" />`);
  s.push("AFTER_LATE_FILE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_LATE_FILE"));
  s.steerSkillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("LATE_REMOTE_FILE") && m.preparation?.state === "next"));
  const steers = s.calls().filter((c) => c.method === "turn/steer");
  assert.equal(steers.length, 1);
  assert.match(JSON.stringify(steers[0].params.input), /EARLIER_STEER/);
  assert.doesNotMatch(JSON.stringify(steers[0].params.input), /LATE_REMOTE_FILE|AFTER_LATE_FILE/);
  s.gate();
  await s.called("turn/start", 2);
  const second = JSON.stringify(s.calls().filter((c) => c.method === "turn/start")[1].params.input);
  assert.ok(second.indexOf("LATE_REMOTE_FILE") < second.indexOf("AFTER_LATE_FILE"));
  await waitFor(() => s.calls().some((c) => c.method === "fixture/attachment" && c.content === "late attachment"), "the next remote turn did not read the file");
  await s.settled();
});

test("an uncertain earlier input does not replay a later remote file", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "unknown.txt");
  writeFileSync(file, "unknown attachment");
  s.spec({ hold: true, holdThread: true, holdSkills: true, startedBeforeReply: true, wrongStartId: true });
  s.push("FIRST_REMOTE $selected");
  await s.called("thread/start", 1);
  s.push("EARLIER_UNKNOWN");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "EARLIER_UNKNOWN"));
  s.threadGate();
  await s.called("skills/list", 1);
  s.push(`FILE_AFTER_UNKNOWN <attached-file path="${file}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("FILE_AFTER_UNKNOWN")));
  s.skillsGate();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "EARLIER_UNKNOWN" && m.preparation?.state === "uncertain"));
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("FILE_AFTER_UNKNOWN") && m.preparation?.state === "not-sent"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 0);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params ?? {}).includes("FILE_AFTER_UNKNOWN")));
});

test("a remote file is not delivered after its Telegram binding is revoked", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "revoked.txt");
  writeFileSync(file, "revoked attachment");
  s.spec({ hold: true, holdThread: true });
  await s.say("FIRST_FROM_APP");
  await s.called("thread/start", 1);
  s.push(`REVOKED_FILE <attached-file path="${file}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("REVOKED_FILE")));
  s.threadGate();
  await s.called("turn/start", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("REVOKED_FILE") && m.preparation?.state === "next"));
  await s.post("/api/telegram", { botId: s.bot.id, unpair: true });
  const now = await s.post(`/api/bots/${s.bot.id}/queued/now`, { taskId: s.bot.threadId });
  assert.equal(now.outcome, "nothing", "a revoked source cannot stop this turn or send its file");
  assert.equal(s.count("turn/interrupt"), 0);
  s.gate();
  await s.settled();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(s.count("turn/start"), 1);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params ?? {}).includes("REVOKED_FILE")));
  assert.ok(s.calls().every((c) => c.content !== "revoked attachment"));
});

test("a file addition on a local turn can still join the initial input", async (t) => {
  const s = await fixture(t);
  const file = join(s.root, "local.txt");
  writeFileSync(file, "local attachment");
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST_LOCAL");
  await s.called("thread/start", 1);
  s.push(`LOCAL_FILE <attached-file path="${file}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("LOCAL_FILE")));
  s.threadGate();
  await s.called("turn/start", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("LOCAL_FILE") && m.preparation?.state === "joined"));
  assert.match(JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input), /LOCAL_FILE/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a remote image addition is copied for the next turn", async (t) => {
  const s = await remoteFixture(t);
  const file = join(s.root, "image.png");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/jR1sAAAAASUVORK5CYII=", "base64");
  writeFileSync(file, image);
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST_REMOTE");
  await s.called("thread/start", 1);
  s.push(`REMOTE_IMAGE <attached-image path="${file}" />`);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("REMOTE_IMAGE")));
  s.threadGate();
  await s.called("turn/start", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("REMOTE_IMAGE") && m.preparation?.state === "next"));
  assert.doesNotMatch(JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input), /REMOTE_IMAGE/);
  s.gate();
  await s.called("turn/start", 2);
  await waitFor(() => s.calls().some((c) => c.method === "fixture/attachment" && c.base64 === image.toString("base64")), "the next remote turn did not read the image");
  await s.settled();
});

test("a Telegram follow-up ready while Codex is preparing reaches the first turn once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const followup = s.push("READY_FOLLOWUP");
  await waitFor(() => s.polled.has(followup), "the fake Telegram update was not polled");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_FOLLOWUP"), "the ready follow-up was not retained during preparation");
  s.skillsGate();
  await s.called("turn/start", 1);
  await waitFor(() => s.calls().some((c) =>
    (c.method === "turn/start" && JSON.stringify(c.params.input).includes("READY_FOLLOWUP")) ||
    (c.method === "turn/steer" && JSON.stringify(c.params.input).includes("READY_FOLLOWUP")),
  ), "the follow-up did not reach the starting turn");
  const effects = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("READY_FOLLOWUP"));
  assert.equal(effects.length, 1, "the follow-up was delivered more than once");
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1, "the follow-up also started a later turn");
});

test("the initial snapshot and the first steer preserve ready order", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true, holdSteerSkills: true });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  const first = s.push("READY_A $other-skill");
  await waitFor(() => s.polled.has(first));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_A $other-skill"));
  s.threadGate();
  await s.called("skills/list", 1);
  const second = s.push("READY_B $selected");
  await waitFor(() => s.polled.has(second));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_B $selected"));
  s.skillsGate();
  await s.called("turn/start", 1);
  await s.called("skills/list", 2);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_B $selected" && m.delivery?.line === "Waiting to join this turn"));
  s.steerSkillsGate();
  await s.called("turn/steer", 1);
  const effects = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method));
  assert.match(JSON.stringify(effects[0].params.input), /READY_A/);
  assert.doesNotMatch(JSON.stringify(effects[0].params.input), /READY_B/);
  assert.ok(effects[0].params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  assert.match(JSON.stringify(effects[1].params.input), /READY_B/);
  assert.equal(effects.filter((c) => JSON.stringify(c.params.input).includes("READY_A")).length, 1);
  assert.equal(effects.filter((c) => JSON.stringify(c.params.input).includes("READY_B")).length, 1);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("an app edit during skill lookup is sent as saved and a taken-back addition is not sent", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("thread/start", 1);
  await s.say("OLD_WORDS $selected");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "OLD_WORDS $selected"));
  const before = (await s.messages()).find((m) => m.text === "OLD_WORDS $selected")!;
  s.threadGate();
  await s.called("skills/list", 1);
  const edited = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${before.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "NEW_WORDS $other-skill" }),
  });
  assert.equal(edited.status, 200);
  await s.say("TAKE_BACK");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "TAKE_BACK"));
  const taken = (await s.messages()).find((m) => m.text === "TAKE_BACK")!;
  const removed = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${taken.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  s.skillsGate();
  await s.called("turn/start", 1);
  const start = s.calls().find((c) => c.method === "turn/start");
  assert.match(JSON.stringify(start.params.input), /NEW_WORDS/);
  assert.doesNotMatch(JSON.stringify(start.params.input), /OLD_WORDS|TAKE_BACK/);
  assert.ok(start.params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a deliberate later app message stays behind preparation additions", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("READY_A");
  await s.say("AFTER_TURN", { delivery: "wait" });
  await s.say("READY_B");
  s.skillsGate();
  await s.called("turn/steer", 2);
  const steering = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(steering[0].params.input), /READY_A/);
  assert.match(JSON.stringify(steering[1].params.input), /READY_B/);
  assert.ok(steering.every((c) => !JSON.stringify(c.params.input).includes("AFTER_TURN")));
  s.gate();
  await s.called("turn/start", 2);
  await s.settled();
  const later = s.calls().filter((c) => c.method === "turn/start")[1];
  assert.match(JSON.stringify(later.params.input), /AFTER_TURN/);
});

test("a preparation burst beyond the input limit is kept as not sent", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true });
  await s.say("FIRST");
  await s.called("thread/start", 1);
  for (let i = 0; i < 20; i++) await s.say(`BURST_${i}`);
  const overflow = await s.say("BURST_OVERFLOW");
  assert.equal(overflow.ok, false);
  assert.equal(overflow.delivery.route, "not-sent");
  const row = (await s.messages()).find((m) => m.text === "BURST_OVERFLOW");
  assert.equal(row?.unsent, true);
  s.threadGate();
  await s.called("turn/start", 1);
  const input = JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input);
  for (let i = 0; i < 20; i++) assert.ok(input.includes(`BURST_${i}`));
  assert.doesNotMatch(input, /BURST_OVERFLOW/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a Telegram burst marks excess input not sent without receipt posts", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true });
  s.push("FIRST");
  await s.called("thread/start", 1);
  for (let i = 0; i < 21; i++) s.push(`TELEGRAM_BURST_${i}`);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "TELEGRAM_BURST_20" && m.preparation?.state === "not-sent"));
  s.threadGate();
  await s.called("turn/start", 1);
  const input = JSON.stringify(s.calls().find((c) => c.method === "turn/start").params.input);
  assert.doesNotMatch(input, /TELEGRAM_BURST_20/);
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("an edit during steering setup sends the saved version once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteerSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("OLD_DURING_STEER $selected");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "OLD_DURING_STEER $selected"));
  const waiting = (await s.messages()).find((m) => m.text === "OLD_DURING_STEER $selected")!;
  s.skillsGate();
  await s.called("skills/list", 2);
  const edited = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${waiting.id}`, {
    method: "PATCH", body: JSON.stringify({ text: "NEW_DURING_STEER $other-skill" }),
  });
  assert.equal(edited.status, 200);
  s.steerSkillsGate();
  await s.called("turn/steer", 1);
  const sent = s.calls().filter((c) => c.method === "turn/steer");
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].params.input), /NEW_DURING_STEER/);
  assert.doesNotMatch(JSON.stringify(sent[0].params.input), /OLD_DURING_STEER/);
  assert.ok(sent[0].params.input.some((item: any) => item.type === "skill" && item.name === "other-skill"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a stale edit cannot release a newer hold or overwrite its words", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("EDIT_ORIGINAL");
  const row = (await s.messages()).find((m) => m.text === "EDIT_ORIGINAL")!;
  const path = `/api/threads/${s.bot.threadId}/messages/${row.id}`;
  const edit = (body: object) => s.h.json(`${path}/editing`, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await edit({ editing: true, editId: "first" })).holding, true);
  const staleSave = await slowSave(t, s, row.id, "STALE_WORDS", "first");
  assert.equal((await edit({ editing: true, editId: "second" })).holding, true);
  staleSave.finish();
  assert.equal(await staleSave.status, 409);
  await edit({ editing: false, editId: "first" });
  await edit({ editing: false }); // an older client cannot release a newer identified hold
  assert.equal((await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "STALE_LEGACY" }) })).status, 409);
  s.skillsGate();
  await s.called("turn/start", 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(s.count("turn/steer"), 0, "stale release must not close the current hold");
  assert.equal((await s.messages()).find((m) => m.id === row.id)?.text, "EDIT_ORIGINAL");
  const current = await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "CURRENT_WORDS", editId: "second" }) });
  assert.equal(current.status, 200);
  await s.called("turn/steer", 1);
  const sent = JSON.stringify(s.calls().find((c) => c.method === "turn/steer").params.input);
  assert.match(sent, /CURRENT_WORDS/);
  assert.doesNotMatch(sent, /STALE_WORDS|EDIT_ORIGINAL/);
  s.gate();
  await s.settled();
});

/** A save whose headers have arrived and whose body is still coming:
 * the server holds it at the body read until finish(). */
async function slowSave(t: TestContext, s: any, id: string, text: string, editId?: string) {
  const body = JSON.stringify({ text, ...(editId ? { editId } : {}) });
  let answered = false;
  let finish!: () => void;
  const status = new Promise<number>((resolve, reject) => {
    const req = request(`${s.h.url}/api/threads/${s.bot.threadId}/messages/${id}`, {
      method: "PATCH",
      headers: { origin: "http://localhost:5199", "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => { answered = true; res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject);
    t.after(() => req.destroy());
    req.write(body.slice(0, 8));
    finish = () => req.end(body.slice(8));
  });
  // Past the first checks and waiting for the rest of the body.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(answered, false, "the save was answered before its body arrived");
  return { status, finish };
}

test("a slow save still edits words that are waiting", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("SLOW_OLD");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "SLOW_OLD"));
  const row = (await s.messages()).find((m) => m.text === "SLOW_OLD")!;
  const save = await slowSave(t, s, row.id, "SLOW_NEW");
  save.finish();
  assert.equal(await save.status, 200);
  s.skillsGate();
  await s.called("turn/steer", 1);
  const sent = s.calls().filter((c) => c.method === "turn/steer");
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].params.input), /SLOW_NEW/);
  assert.doesNotMatch(JSON.stringify(sent[0].params.input), /SLOW_OLD/);
  s.gate();
  await s.settled();
});

for (const outcome of ["dispatching", "joined", "uncertain"] as const) {
  test(`a slow save that ends after the words went (${outcome}) keeps the submitted version`, async (t) => {
    const s = await fixture(t);
    s.spec({ hold: true, holdSkills: true, holdSteer: outcome === "dispatching", wrongSteerId: outcome === "uncertain" });
    await s.say("FIRST $selected");
    await s.called("skills/list", 1);
    await s.say("SUBMITTED_WORDS");
    await waitFor(async () => (await s.messages()).some((m) => m.text === "SUBMITTED_WORDS"));
    const row = (await s.messages()).find((m) => m.text === "SUBMITTED_WORDS")!;
    assert.equal(row.preparation?.state, "pending");
    const save = await slowSave(t, s, row.id, "REWRITTEN_LATE");
    s.skillsGate();
    await s.called("turn/steer", 1);
    await waitFor(async () => (await s.messages()).find((m) => m.id === row.id)?.preparation?.state === outcome);
    save.finish();
    assert.equal(await save.status, 409);
    const after = (await s.messages()).find((m) => m.id === row.id)!;
    assert.equal(after.text, "SUBMITTED_WORDS");
    assert.equal(after.preparation.state, outcome);
    const sent = s.calls().filter((c) => c.method === "turn/steer");
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].params.input), /SUBMITTED_WORDS/);
    assert.doesNotMatch(JSON.stringify(sent[0].params.input), /REWRITTEN_LATE/);
    s.steerGate();
    s.gate();
    await s.settled();
  });
}

test("a later Telegram text waits for the preceding voice transcription", async (t) => {
  const s = await fixture(t);
  await s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ speech: { openaiKey: "fixture-only" } }) });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.voice();
  await waitFor(() => s.heldTranscriptions.length === 1, "voice did not reach the synthetic transcriber");
  s.push("READY_TEXT");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await s.messages()).some((m) => m.text === "READY_TEXT"), false);
  s.heldTranscriptions[0]();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "READY_TEXT"));
  const messages = await s.messages();
  assert.ok(messages.findIndex((m) => m.text?.includes("SLOW_VOICE")) < messages.findIndex((m) => m.text === "READY_TEXT"));
  s.skillsGate();
  await s.called("turn/steer", 2);
  const steers = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(steers[0].params.input), /SLOW_VOICE/);
  assert.match(JSON.stringify(steers[1].params.input), /READY_TEXT/);
  s.gate();
  await s.settled();
});

test("a mismatched Codex receipt stays unresolved across restart without replay", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("UNCERTAIN_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP"));
  s.push("BEHIND_UNCERTAIN");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEHIND_UNCERTAIN"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP" && m.delivery?.route === "uncertain"));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEHIND_UNCERTAIN" && m.preparation?.state === "not-sent"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
  await s.reboot();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params).includes("BEHIND_UNCERTAIN")));
  assert.ok((await s.messages()).some((m) => m.text === "UNCERTAIN_FOLLOWUP" && m.delivery?.route === "uncertain"));
});

for (const missing of [true, false]) test(`a ${missing ? "missing" : "mismatched"} Codex start identity does not confirm additions`, async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdThread: true, holdSkills: true, startedBeforeReply: true, duplicateStarted: true,
    ...(missing ? { missingStartId: true } : { wrongStartId: true }) });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  s.push("INITIAL_UNCONFIRMED");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INITIAL_UNCONFIRMED"));
  s.threadGate();
  await s.called("skills/list", 1);
  s.push("LATER_UNCONFIRMED");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "LATER_UNCONFIRMED"));
  s.skillsGate();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INITIAL_UNCONFIRMED" && m.preparation?.state === "uncertain"));
  await waitFor(async () => (await s.messages()).some((m) => m.text === "LATER_UNCONFIRMED" && m.preparation?.state === "not-sent"));
  assert.equal(s.count("turn/steer"), 0);
  s.gate();
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("INITIAL_UNCONFIRMED")).length, 1);
  assert.ok(s.calls().every((c) => !JSON.stringify(c.params).includes("LATER_UNCONFIRMED")));
});

for (const mismatched of [false, true]) test(`an addition arriving during a ${mismatched ? "unconfirmed" : "confirmed"} preparation steer stays in order`, async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, wrongSteerId: mismatched });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("STEER_FIRST");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_FIRST"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  s.push("STEER_SECOND");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "pending"));
  assert.equal((await s.messages()).find((m) => m.text === "STEER_SECOND")?.delivery?.line, "Waiting for an earlier input's receipt");
  s.steerGate();
  if (mismatched) {
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_FIRST" && m.preparation?.state === "uncertain"));
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "not-sent"));
    assert.equal(s.count("turn/steer"), 1);
  } else {
    await s.called("turn/steer", 2);
    await waitFor(async () => (await s.messages()).some((m) => m.text === "STEER_SECOND" && m.preparation?.state === "joined"));
    const calls = s.calls().filter((c) => c.method === "turn/steer");
    assert.match(JSON.stringify(calls[0].params.input), /STEER_FIRST/);
    assert.match(JSON.stringify(calls[1].params.input), /STEER_SECOND/);
  }
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
});

test("a completed turn's delayed steer continuation cannot alter the next attempt", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, completeWithSteer: true });
  await s.say("TURN_A $selected");
  await s.called("skills/list", 1);
  await s.say("PREP_A");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await s.say("TURN_B", { delivery: "wait" });
  s.spec({ hold: true, holdThread: true });
  s.steerGate();
  await waitFor(() => s.calls().filter((c) => ["thread/start", "thread/resume"].includes(c.method)).length >= 2, "the next conversation did not open");
  await s.say("PREP_B");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "PREP_B" && m.preparation?.state === "pending"));
  s.threadGate();
  await s.called("turn/start", 2);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "PREP_B" && m.preparation?.state === "joined"));
  const rows = await s.messages();
  const a = rows.find((m) => m.text === "PREP_A");
  const b = rows.find((m) => m.text === "PREP_B");
  assert.equal(a?.preparation?.state, "joined");
  assert.notEqual(a?.preparation?.attempt, b?.preparation?.attempt);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("PREP_A")).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("PREP_B")).length, 1);
  s.gate();
  await s.settled();
});

test("preparation additions wait for an existing agent steer and keep their order", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, captureCredential: true });
  await s.say("SENDER_HOLD");
  await s.called("turn/start", 1);
  const credentials = join(s.root, "credentials.jsonl");
  await waitFor(() => existsSync(credentials));
  const token = JSON.parse(readFileSync(credentials, "utf8").trim().split("\n")[0]).token;
  const hired = await s.h.json("/api/bots", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: "Fixture target" }) });
  const target = hired.bot;
  assert.ok(target?.id);
  await s.h.json(`/api/bots/${target.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
  s.spec({ hold: true, holdStartReply: true, holdSteer: true });
  await s.post(`/api/bots/${target.id}/messages`, { text: "TARGET_FIRST" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("TARGET_FIRST")));
  const agent = s.h.fetch(`/api/bots/${target.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "AGENT_FIRST", now: true }) });
  await waitFor(() => s.calls().some((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("AGENT_FIRST")));
  await s.post(`/api/bots/${target.id}/messages`, { text: "PERSON_A" });
  await s.post(`/api/bots/${target.id}/messages`, { text: "PERSON_B" });
  await waitFor(async () => (await s.h.json(`/api/bots/${target.id}/messages?thread=${target.threadId}&limit=500`)).messages.filter((m: any) => ["PERSON_A", "PERSON_B"].includes(m.text) && m.preparation?.state === "pending").length === 2);
  s.startReplyGate();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 1);
  s.steerGate();
  assert.equal((await agent).status, 202);
  await waitFor(() => s.calls().filter((c) => c.method === "turn/steer").length === 3);
  const calls = s.calls().filter((c) => c.method === "turn/steer");
  assert.match(JSON.stringify(calls[0].params.input), /AGENT_FIRST/);
  assert.match(JSON.stringify(calls[1].params.input), /PERSON_A/);
  assert.match(JSON.stringify(calls[2].params.input), /PERSON_B/);
  s.gate();
  await s.settled();
});

test("a refusal arriving with turn completion starts the fallback once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, completeWithSteer: true, refuseSteer: true });
  await s.say("TURN_A $selected");
  await s.called("skills/list", 1);
  await s.say("LATE_REFUSAL");
  s.skillsGate();
  await s.called("turn/steer", 1);
  s.spec({ hold: false });
  s.steerGate();
  await s.called("turn/start", 2);
  await s.settled();
  const starts = s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("LATE_REFUSAL"));
  assert.equal(starts.length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("LATE_REFUSAL")).length, 1);
});

test("a duplicate Telegram source has one row and engine input without a receipt", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const source = s.push("DUPLICATE_SOURCE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DUPLICATE_SOURCE"));
  const repeated = s.duplicate(source);
  await waitFor(() => s.polled.has(repeated));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DUPLICATE_SOURCE" && m.preparation?.state === "joined"));
  assert.equal((await s.messages()).filter((m) => m.text === "DUPLICATE_SOURCE").length, 1);
  assert.equal(s.sends.filter((m) => m.reply_parameters?.message_id === source + 1).length, 0);
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("DUPLICATE_SOURCE")).length, 1);
  s.gate();
  await s.settled();
});

test("a dismissed Telegram source remains deduplicated after restart", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  const source = s.push("DISMISSED_DUPLICATE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DISMISSED_DUPLICATE"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DISMISSED_DUPLICATE" && m.preparation?.state === "uncertain"));
  const row = (await s.messages()).find((m) => m.text === "DISMISSED_DUPLICATE")!;
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  s.gate();
  await s.settled();
  await s.reboot();
  const repeated = s.duplicate(source);
  await waitFor(() => s.polled.has(repeated));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const rows = (await s.messages()).filter((m) => m.text === "DISMISSED_DUPLICATE");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].preparation?.dismissed, true);
  assert.equal(s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("DISMISSED_DUPLICATE")).length, 1);
});

test("a definite steering refusal runs and answers the next turn once", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, refuseSteer: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("NEXT_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "NEXT_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "NEXT_FOLLOWUP" && m.preparation?.state === "next"));
  s.gate();
  await s.called("turn/start", 2);
  await waitFor(() => s.sends.filter((m) => m.text === "ANSWER").length === 2, "both turns should return their own answer");
  await s.settled();
  const starts = s.calls().filter((c) => c.method === "turn/start");
  assert.doesNotMatch(JSON.stringify(starts[0].params.input), /NEXT_FOLLOWUP/);
  assert.match(JSON.stringify(starts[1].params.input), /NEXT_FOLLOWUP/);
  assert.equal(s.count("turn/start"), 2);
  assert.equal(s.count("turn/steer"), 1);
});

test("a Codex internal error after dispatch stays uncertain", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, steerInternalError: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("INTERNAL_ERROR_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INTERNAL_ERROR_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "INTERNAL_ERROR_FOLLOWUP" && m.preparation?.state === "uncertain"));
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
});

test("restart after a steer write retains uncertainty without replay", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("CRASH_FOLLOWUP");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP" && m.preparation?.state === "dispatching"));
  const message = (await s.messages()).find((m) => m.text === "CRASH_FOLLOWUP")!;
  const path = `/api/threads/${s.bot.threadId}/messages/${message.id}`;
  assert.equal((await s.h.fetch(path, { method: "PATCH", body: JSON.stringify({ text: "CHANGED_AFTER_WRITE" }) })).status, 409);
  assert.equal((await s.h.fetch(path, { method: "DELETE" })).status, 409);
  assert.equal((await s.h.json(`${path}/editing`, { method: "POST", body: JSON.stringify({ editing: true }) })).holding, false);
  await s.h.crash();
  s.gate();
  s.spec({ hold: false });
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "CRASH_FOLLOWUP" && m.preparation?.state === "uncertain"));
  assert.equal((await s.h.fetch(path, { method: "DELETE" })).status, 409);
  const other = await s.hire("Other lane");
  await s.post(`/api/bots/${other.id}/messages`, { text: "OTHER_LANE" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("OTHER_LANE")));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("CRASH_FOLLOWUP"));
  assert.equal(copies.length, 1);
});

test("restart after the durable marker but before native dispatch never replays it", async (t) => {
  const s = await fixture(t, { crashOn: "BEFORE_WRITE" });
  s.spec({ hold: true, holdThread: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("thread/start", 1);
  s.push("BEFORE_WRITE");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEFORE_WRITE"));
  s.threadGate();
  await s.called("skills/list", 1);
  s.skillsGate();
  await waitFor(() => existsSync(join(s.root, "prep-crash")), "the synthetic crash point did not fire");
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "BEFORE_WRITE" && m.preparation?.state === "uncertain"));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("BEFORE_WRITE"));
  assert.equal(copies.length, 0);
});

test("restart after acceptance but before saving it does not replay the input", async (t) => {
  const s = await fixture(t, { crashOn: "AFTER_ACCEPT", crashStage: "joined" });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("AFTER_ACCEPT");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_ACCEPT"));
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(() => existsSync(join(s.root, "prep-crash")), "the post-acceptance crash point did not fire");
  s.gate();
  await s.reboot();
  await waitFor(async () => (await s.messages()).some((m) => m.text === "AFTER_ACCEPT" && m.preparation?.state === "uncertain"));
  const copies = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("AFTER_ACCEPT"));
  assert.equal(copies.length, 1);
});

test("a failed durable marker prevents the native steer", async (t) => {
  const s = await fixture(t, { crashOn: "FAIL_BEFORE_STEER", crashStage: "fail-dispatch" });
  s.spec({ hold: true, holdSkills: true });
  s.push("FIRST $selected");
  await s.called("skills/list", 1);
  s.push("FAIL_BEFORE_STEER");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "FAIL_BEFORE_STEER"));
  s.skillsGate();
  await waitFor(() => existsSync(join(s.root, "prep-write-failed")), "the synthetic write failure did not fire");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "FAIL_BEFORE_STEER" && m.preparation?.state === "next"));
  assert.equal(s.calls().filter((c) => c.method === "turn/steer" && JSON.stringify(c.params.input).includes("FAIL_BEFORE_STEER")).length, 0);
  s.gate();
  await s.called("turn/start", 2);
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("FAIL_BEFORE_STEER")).length, 1);
});

test("a held startup does not block another lane and stopped input falls back", async (t) => {
  const s = await fixture(t);
  s.spec({ holdThread: true });
  await s.say("HELD_START");
  await s.called("thread/start", 1);
  await s.say("HELD_ADDITION");
  await waitFor(async () => (await s.messages()).some((m) => m.text === "HELD_ADDITION" && m.preparation?.state === "pending"));
  s.spec({ hold: false });
  const other = await s.hire("Independent fixture");
  await s.post(`/api/bots/${other.id}/messages`, { text: "INDEPENDENT" });
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("INDEPENDENT")));
  assert.ok((await s.post(`/api/bots/${s.bot.id}/interrupt`, { taskId: s.bot.threadId })).ok);
  s.threadGate();
  await waitFor(() => s.calls().some((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("HELD_ADDITION")));
  await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/start" && JSON.stringify(c.params.input).includes("HELD_ADDITION")).length, 1);
});

test("drain holds words and compact through restart with one return each", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("DRAIN $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.ok(s.answers().every((m) => m.chat_id === CHAT));
  await s.reboot(); await s.settled();
  assert.equal(s.answers().length, 2);
});

test("a second startup before dispatch retains the native command return", { skip: process.platform === "win32" }, async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.post("/api/maintenance/drain", { seconds: 60 }); await s.queue("/compact");
  await s.stoppedBeforeRecovery(); assert.equal(s.answers().length, 0);
  await s.reboot(); await waitFor(() => s.answers().length === 1); await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal(s.calls().filter((c) => c.method === "turn/start").length, 1);
});

test("a cut-off pickup takes only its ordinary Telegram segment before compact's own return", async (t) => {
  const s = await fixture(t); await s.turn("warm session");
  await s.say("HOLD"); await waitFor(() => s.calls().filter((c) => c.method === "turn/start").length === 2);
  await s.post("/api/maintenance/drain", { seconds: 60 });
  await s.queue("PICKUP $selected"); await s.queue("/compact");
  await s.reboot(); await waitFor(() => s.answers().length === 2); await s.settled();
  const turns = s.calls().filter((c) => c.method === "turn/start");
  assert.equal(turns.length, 3);
  assert.deepEqual(turns[2].params.input.filter((i: any) => i.type === "skill").map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.equal((await s.messages()).filter((m) => m.telegramReply?.state === "sent").length, 2);
});

test("dismissing an uncertain preparation retains it without replay across restart", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("UNCERTAIN_DISMISS");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNCERTAIN_DISMISS" && m.preparation?.state === "uncertain"));
  const row = (await s.messages()).find((m) => m.text === "UNCERTAIN_DISMISS")!;
  const response = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" });
  assert.equal(response.status, 200);
  const dismissed = (await s.messages()).find((m) => m.id === row.id)!;
  assert.equal(dismissed.queued, false);
  assert.equal(dismissed.preparation?.dismissed, true);
  assert.equal(dismissed.preparation?.state, "uncertain");
  assert.equal(dismissed.text, "UNCERTAIN_DISMISS");
  s.spec({ hold: true });
  await s.say("DISTINCT_AFTER_DISMISS");
  await s.called("turn/steer", 2);
  s.gate();
  await s.settled();
  await s.reboot();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = (await s.messages()).find((m) => m.id === row.id)!;
  assert.equal(after.preparation?.state, "uncertain");
  assert.equal(after.preparation?.dismissed, true);
  assert.equal(after.queued, false);
  // If the old native session is gone, the handoff reconstructs context
  // from the transcript and still must not replay the uncertain input.
  s.spec({ forgotten: true });
  await s.say("NEXT_AFTER_RESTART");
  await s.called("turn/start", 2);
  await s.settled();
  const occurrences = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("UNCERTAIN_DISMISS"));
  assert.equal(occurrences.length, 1);
});

test("a new input does not overtake an unresolved preparation before dismissal", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("UNRESOLVED_BARRIER");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "UNRESOLVED_BARRIER" && m.preparation?.state === "uncertain"));
  await s.say("AFTER_UNRESOLVED");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(s.count("turn/steer"), 1, "later input must not pass the unresolved input");
  const row = (await s.messages()).find((m) => m.text === "UNRESOLVED_BARRIER")!;
  s.spec({ hold: false });
  s.gate();
  await s.settled();
  assert.equal(s.count("turn/start"), 1);
  await s.reboot();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(s.count("turn/start"), 1, "restart must retain the unresolved barrier");
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  await s.called("turn/start", 2);
  await s.settled();
  const starts = s.calls().filter((c) => c.method === "turn/start");
  assert.match(JSON.stringify(starts[1].params.input), /AFTER_UNRESOLVED/);
  assert.doesNotMatch(JSON.stringify(starts[1].params.input), /UNRESOLVED_BARRIER/);
});

for (const mode of ["dismissed", "fail-dismiss"] as const) test(`${mode}: dismissal is durable before the waiting row is released`, async (t) => {
  const s = await fixture(t, { crashOn: "DURABLE_DISMISS", crashStage: mode });
  s.spec({ hold: true, holdSkills: true, wrongSteerId: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("DURABLE_DISMISS");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DURABLE_DISMISS" && m.preparation?.state === "uncertain"));
  const row = (await s.messages()).find((m) => m.text === "DURABLE_DISMISS")!;
  const response = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" }).catch(() => null);
  if (mode === "fail-dismiss") {
    assert.equal(response?.status, 500);
    const unchanged = (await s.messages()).find((m) => m.id === row.id)!;
    assert.equal(unchanged.queued, true);
    assert.notEqual(unchanged.preparation?.dismissed, true);
    assert.equal(unchanged.preparation?.state, "uncertain");
    s.gate();
    await s.settled();
  } else {
    assert.equal(response, null, "the simulated crash precedes the HTTP acknowledgement");
    // the restart carries on the cut-off first turn by itself, so that
    // pickup must not find the fixture still holding turns
    s.spec({ hold: false, forgotten: true });
    await s.reboot();
    const after = (await s.messages()).find((m) => m.id === row.id)!;
    assert.equal(after.queued, false);
    assert.equal(after.preparation?.dismissed, true);
    assert.equal(after.preparation?.state, "uncertain");
    await s.say("AFTER_RESTART");
    await waitFor(() => s.calls().some((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("AFTER_RESTART")), "the later input never reached the engine");
    await s.settled();
    assert.equal(s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("DURABLE_DISMISS")).length, 1);
  }
});

test("a dismissed dispatch still records a late native confirmation", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("DISMISSED_THEN_CONFIRMED");
  s.skillsGate();
  await s.called("turn/steer", 1);
  const row = (await s.messages()).find((m) => m.text === "DISMISSED_THEN_CONFIRMED")!;
  assert.equal(row.preparation?.state, "dispatching");
  const response = await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" });
  assert.equal(response.status, 200);
  s.steerGate();
  await waitFor(async () => (await s.messages()).some((m) => m.id === row.id && m.preparation?.state === "joined"));
  const confirmed = (await s.messages()).find((m) => m.id === row.id)!;
  assert.equal(confirmed.queued, false);
  assert.equal(confirmed.delivery?.route, "steered");
  assert.equal(confirmed.text, "DISMISSED_THEN_CONFIRMED");
  s.gate();
  await s.settled();
  assert.equal(s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("DISMISSED_THEN_CONFIRMED")).length, 1);
});

test("a late refusal does not requeue a dismissed dispatch", async (t) => {
  const s = await fixture(t);
  s.spec({ hold: true, holdSkills: true, holdSteer: true, refuseSteer: true, completeWithSteer: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("DISMISSED_THEN_REFUSED");
  s.skillsGate();
  await s.called("turn/steer", 1);
  const row = (await s.messages()).find((m) => m.text === "DISMISSED_THEN_REFUSED")!;
  assert.equal(row.preparation?.state, "dispatching");
  assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  s.steerGate();
  await waitFor(async () => (await s.messages()).some((m) => m.id === row.id && m.preparation?.state === "not-sent"));
  await s.settled();
  const refused = (await s.messages()).find((m) => m.id === row.id)!;
  assert.equal(refused.preparation?.dismissed, true);
  assert.equal(refused.queued, false);
  assert.equal(refused.text, "DISMISSED_THEN_REFUSED");
  assert.equal(s.count("turn/start"), 1);
  assert.equal(s.count("turn/steer"), 1);
});

for (const dismiss of [false, true]) test(`a named refusal after the preparation deadline settles the original row${dismiss ? " after dismissal" : ""}`, async (t) => {
  const s = await fixture(t, { extraEnv: { BLOKS_PREPARATION_WAIT_MS: "250" } });
  s.spec({ hold: true, holdSkills: true, holdSteer: true, refuseSteer: true });
  await s.say("FIRST $selected");
  await s.called("skills/list", 1);
  await s.say("DEADLINE_REFUSAL");
  s.skillsGate();
  await s.called("turn/steer", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text === "DEADLINE_REFUSAL" && m.preparation?.state === "uncertain"), "the real deadline did not expire");
  const row = (await s.messages()).find((m) => m.text === "DEADLINE_REFUSAL")!;
  await s.say("AFTER_DEADLINE");
  if (dismiss) {
    assert.equal((await s.h.fetch(`/api/threads/${s.bot.threadId}/messages/${row.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  } else {
    assert.equal(s.count("turn/steer"), 1, "the unresolved input must block later work");
  }
  // The fake RPC returns the real named non-submission error only now,
  // after the server's deadline and while the first turn is still active.
  s.steerGate();
  const expected = dismiss ? "not-sent" : "next";
  await waitFor(async () => (await s.messages()).some((m) => m.id === row.id && m.preparation?.state === expected), "the late refusal did not settle its original row");
  const settled = (await s.messages()).find((m) => m.id === row.id)!;
  assert.equal(Boolean(settled.preparation?.dismissed), dismiss);
  assert.equal(settled.queued, !dismiss);
  assert.equal(settled.delivery?.route, dismiss ? "not-sent" : "queued");
  s.spec({ hold: false });
  s.gate();
  await waitFor(() => s.calls().some((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("AFTER_DEADLINE")), "later work did not proceed");
  await s.settled();
  const sent = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method) && JSON.stringify(c.params.input).includes("DEADLINE_REFUSAL"));
  assert.equal(sent.filter((c) => c.method === "turn/steer").length, 1);
  assert.equal(sent.filter((c) => c.method === "turn/start").length, dismiss ? 0 : 1);
});

for (const boundary of ["initial", "late"] as const) test(`a path-only engine keeps image paths together at the ${boundary} boundary`, async (t) => {
  const s = await fixture(t);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const paths: string[] = [];
  for (let i = 0; i < 9; i++) {
    const res = await s.h.fetch("/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: png });
    assert.equal(res.status, 200);
    paths.push((await res.json()).path);
  }
  const tags = (selected: string[]) => selected.map((path) => `<attached-image path="${path}" />`).join("\n");
  s.spec({ hold: true, holdThread: boundary === "initial", holdSkills: boundary === "late" });
  await s.say(`FIRST $selected\n${tags(paths.slice(0, 7))}`);
  await s.called(boundary === "initial" ? "thread/start" : "skills/list", 1);
  await s.say(`PATHS_TWO\n${tags(paths.slice(7))}`);
  await s.say("AFTER_TWO");
  if (boundary === "initial") s.threadGate(); else s.skillsGate();
  await s.called("turn/start", 1);
  await waitFor(async () => (await s.messages()).some((m) => m.text?.startsWith("PATHS_TWO") && m.preparation?.state === "joined"));
  s.gate();
  await s.settled();
  const calls = s.calls().filter((c) => ["turn/start", "turn/steer"].includes(c.method));
  assert.equal(s.count("turn/start"), 1);
  const sent = calls.map((c) => JSON.stringify(c.params.input)).join("\n");
  assert.ok(sent.indexOf("PATHS_TWO") < sent.indexOf("AFTER_TWO"));
  for (const path of paths) assert.ok(sent.includes(path));
});
