// The real server and native drivers, with synthetic local CLIs only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const claude = { instanceId: "claude", model: "claude-sonnet-5" };
const codex = { instanceId: "codex", model: "gpt-6.1-sol" };
const used = 90_000, window = 150_000;

async function fixture(t: TestContext, answer: "claude" | "codex" = "codex") {
  const f = await codexCommands(t);
  await f.h.crash();
  const file = join(f.root, ".bloks", "bots.json");
  const config = join(f.root, ".bloks", "config.json");
  const cli = join(f.root, "fake-claude.mjs");
  const specFile = join(f.root, "claude-spec.json");
  const spec = { used, window, hold: false, defer: false, noReading: false };
  writeFileSync(specFile, JSON.stringify(spec));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const root = ${JSON.stringify(f.root)};
const args = process.argv.slice(2);
if(args[0]==="--version"){console.log("9.9.9 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const out=f=>console.log(JSON.stringify(f));
const wait=gate=>new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(root+"/"+gate)){clearInterval(timer);resolve();}},20);});
let input="";
process.stdin.on("data",async function take(c){
 input+=c; const frame=input.split("\\n").slice(0,-1).filter(Boolean).map(JSON.parse).find(f=>f.type==="user");
 if(!frame)return; process.stdin.off("data",take);
 const spec=JSON.parse(readFileSync(root+"/claude-spec.json","utf8"));
 appendFileSync(root+"/claude-calls.jsonl",JSON.stringify({text:frame.message.content})+"\\n");
 out({type:"system",subtype:"init",session_id:"fixture-session",model:"claude-sonnet-5"});
 if(existsSync(root+"/claude-limited")){
  const message="You've hit your session limit. Try again in 2 hours.";
  out({type:"result",subtype:"error_during_execution",is_error:true,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:message});return;
 }
 if(spec.defer)await wait("reading-gate");
 if(!spec.noReading)out({type:"assistant",session_id:"fixture-session",message:{model:"claude-sonnet-5",content:[{type:"text",text:"Synthetic answer"}],usage:{input_tokens:spec.used,output_tokens:1}}});
 if(spec.hold)await wait("gate");
 out({type:"result",subtype:"success",is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:"Synthetic answer",
  ...(!spec.noReading?{modelUsage:{"claude-sonnet-5":{contextWindow:spec.window}}}:{})});
});
`, { mode: 0o755 });
  const codexFile = join(f.root, "fake-codex.mjs");
  let fake = readFileSync(codexFile, "utf8");
  assert.ok(fake.includes("if(spec.auto){"));
  fake = fake.replace("if(spec.auto){", 'if(spec.defer)await new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(root+"/reading-gate")){clearInterval(timer);resolve();}},20);});\n  if(spec.auto){');
  const turnText = 'const text=m.params.input.filter(i=>i.type==="text").map(i=>i.text).join("");';
  assert.ok(fake.includes(turnText));
  fake = fake.replace(turnText, turnText + `
  if(existsSync(root+"/codex-limited")){
    out({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:"failed",error:{message:"You've hit your usage limit. Try again in 2 hours.",codexErrorInfo:"usageLimitExceeded"}}}});return;
  }`);
  writeFileSync(codexFile, fake);
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  cfg.instances.claude = { driver: "claudeAgent", config: { cli } };
  cfg.compaction = { idle: false, beforeTurn: 0 };
  writeFileSync(config, JSON.stringify(cfg));
  const primary = answer === "codex" ? claude : codex;
  const backup = answer === "codex" ? codex : claude;
  writeFileSync(join(f.root, primary.instanceId + "-limited"), "");
  const bots = JSON.parse(readFileSync(file, "utf8"));
  const bot = bots.find((b: any) => b.id === f.bot.id);
  bot.modelSelection = primary;
  bot.backupSelection = backup;
  writeFileSync(file, JSON.stringify(bots));
  f.spec({ used, window });
  await f.reboot();
  const lane = async (id = f.bot.threadId) => (await f.current()).tasks.find((task: any) => task.id === id);
  const activity = async (id = f.bot.threadId) => (await f.h.json("/api/activity")).running.find((row: any) => row.threadId === id);
  const edit = async (change: (bot: any, cfg: any) => void) => {
    await f.h.crash();
    const bots = JSON.parse(readFileSync(file, "utf8"));
    const cfg = JSON.parse(readFileSync(config, "utf8"));
    change(bots.find((b: any) => b.id === f.bot.id), cfg);
    writeFileSync(file, JSON.stringify(bots));
    writeFileSync(config, JSON.stringify(cfg));
    await f.reboot();
  };
  const calls = () => f.calls().filter(c => c.method === "turn/start").length +
    (existsSync(join(f.root, "claude-calls.jsonl")) ? readFileSync(join(f.root, "claude-calls.jsonl"), "utf8").split("\n").slice(0, -1).length : 0);
  const say = async (text = "A synthetic message", extra = {}) => {
    const n = calls();
    const bot = await f.current();
    const expected = bot.backupSelection?.instanceId ?? bot.modelSelection.instanceId;
    await f.say(text, extra);
    await waitFor(() => calls() > n && f.stored().tasks.find((task: any) => task.id === f.bot.threadId).lastInstanceId === expected, f.h.logs());
  };
  const turn = async () => { await say(); await f.settled(); };
  const settings = async (beforeTurn: number, beforeTurnAt = 0.6) => {
    const res = await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurn, beforeTurnAt } }) });
    assert.equal(res.status, 200);
  };
  const seed = (bot: any, by = backup) => {
    const task = bot.tasks.find((task: any) => task.id === f.bot.threadId);
    task.reading = { ...by, used, window, at: 1 };
    task.lastInstanceId = by.instanceId;
    task.resumeCursors = { [by.instanceId]: "fixture-session" };
    return task;
  };
  return { ...f, get h() { return f.h; }, lane, activity, edit, calls, nativeCalls: f.calls, say, turn, settings, seed, primary, backup,
    claudeSpec: (change: Record<string, unknown>) => writeFileSync(specFile, JSON.stringify({ ...spec, ...change })),
    readingGate: () => writeFileSync(join(f.root, "reading-gate"), ""),
    async drop(instanceId: string) {
      await f.h.crash();
      execFileSync(process.execPath, ["--input-type=module", "-e",
        `const {Store}=await import(${JSON.stringify(new URL("../server/store.ts", import.meta.url).href)});const s=new Store(()=>(${JSON.stringify(primary)}));s.dropSession(${JSON.stringify(f.bot.threadId)},${JSON.stringify(instanceId)});`],
      { env: { ...process.env, HOME: f.root, USERPROFILE: f.root } });
      await f.reboot();
    },
  };
}

async function laneEvents(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const abort = new AbortController();
  const frames: any[] = [];
  const stream = await f.h.fetch("/api/events", { signal: abort.signal });
  assert.ok(stream.ok && stream.body);
  const reading = (async () => {
    let buffer = "";
    const reader = stream.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString();
      for (let split = buffer.indexOf("\n\n"); split >= 0; split = buffer.indexOf("\n\n")) {
        const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (event.startsWith("data: ")) {
          const frame = JSON.parse(event.slice(6));
          if (frame.kind === "bot" && frame.bot?.id === f.bot.id) {
            const lane = frame.bot.tasks.find((task: any) => task.id === f.bot.threadId);
            if (lane) frames.push(lane);
          }
        }
      }
    }
  })();
  // The harness after-hook can close the socket before this hook runs.
  void reading.catch(() => {});
  t.after(async () => { abort.abort(); await reading.catch(() => {}); });
  return frames;
}

for (const answer of ["codex", "claude"] as const) {
  test(`${answer} backup keeps its own first reading while busy, idle and reloaded`, async t => {
    const f = await fixture(t, answer);
    f.spec({ used, window, hold: true });
    f.claudeSpec({ hold: true });
    await f.say();
    await waitFor(() => {
      const reading = f.stored().tasks.find((task: any) => task.id === f.bot.threadId).reading;
      return reading?.instanceId === f.backup.instanceId && reading.used === used;
    });
    assert.equal((await f.lane()).context.used, used, "the first backup reading must reach the display");
    assert.equal((await f.lane()).state, "working");
    assert.equal((await f.lane()).context.measured, true);
    const busyWindow = answer === "claude" ? 200_000 : window;
    assert.equal((await f.lane()).context.limit, busyWindow);
    assert.equal((await f.activity()).context.fraction, used / busyWindow);
    assert.equal(f.stored().tasks[0].lastInstanceId, f.backup.instanceId);
    f.gate();
    await f.settled();
    assert.equal((await f.lane()).context.used, used);
    await f.reboot();
    assert.equal((await f.lane()).context.used, used);
    assert.equal((await f.lane()).context.limit, window);
  });
}

test("a backup turn hides a primary reading until its own reading arrives, without reload", async t => {
  const f = await fixture(t);
  await f.edit(bot => f.seed(bot, f.primary));
  const frames = await laneEvents(t, f);
  f.spec({ used, window, hold: true, defer: true });
  await f.say();
  assert.equal((await f.lane()).context.measured, false);
  assert.equal((await f.activity()).context.used, 0);
  await assert.doesNotReject(waitFor(() => frames.some(task => task.state === "working" && task.context.measured === false)),
  "the selected engine's unmeasured snapshot must reach clients before its first reading");
  const readingFrom = frames.length;
  f.readingGate();
  await waitFor(async () => (await f.lane()).context.used === used);
  await assert.doesNotReject(waitFor(() => frames.slice(readingFrom).some(task => task.context.used === used && task.context.limit === window)),
  "the first measured snapshot must reach clients while the answer is held");
  assert.equal((await f.activity()).context.limit, window);
  f.gate();
  await f.settled();
});

test("the event stream orders busy, selection and first usage frames through settle", async t => {
  const f = await fixture(t);
  await f.edit(bot => {
    bot.modelSelection = codex;
    bot.backupSelection = { ...codex, instanceId: "other" };
    f.seed(bot, bot.backupSelection).reading.used = 12_000;
  });
  const frames = await laneEvents(t, f);
  f.spec({ used, window, hold: true, defer: true });
  const response = await f.h.fetch(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "A synthetic message", taskId: f.bot.threadId }) });
  assert.ok(response.ok);
  await waitFor(() => f.nativeCalls().some(call => call.method === "turn/start"));
  // HTTP is independent of the client stream: omitting the selection frame
  // must leave these assertions passing and fail only the event assertion.
  assert.equal((await f.lane()).state, "working");
  assert.equal((await f.lane()).context.measured, false);
  assert.equal((await f.activity()).context.measured, false);
  t.diagnostic("HTTP selection assertions passed before checking the event stream");
  await assert.doesNotReject(waitFor(() => frames.some(task => task.state === "working" && !task.context.measured)),
    "the event stream must publish the selected origin before usage");
  const beforeUsage = frames.filter(task => task.state === "working");
  assert.equal(beforeUsage.length, 2, "exactly one selection frame must follow the busy frame before usage");
  assert.equal(beforeUsage[0].context.used, 12_000, "the busy frame still holds the preceding engine's reading");
  assert.equal(beforeUsage[0].context.measured, true);
  assert.equal(beforeUsage[1].context.measured, false);
  const readingFrom = frames.length;
  f.readingGate();
  await assert.doesNotReject(waitFor(() => frames.slice(readingFrom).some(task => task.state === "working" && task.context.used === used)),
    "the first usage frame must follow the selection frame without reload");
  const firstUsage = frames.slice(readingFrom).find(task => task.context.used === used);
  assert.equal(firstUsage.context.limit, window);
  assert.equal(firstUsage.context.measured, true);
  const settleFrom = frames.length;
  f.gate();
  await f.settled();
  await assert.doesNotReject(waitFor(() => frames.slice(settleFrom).some(task => task.state === "idle")),
    "the settled bot frame must reach clients");
  const settled = frames.slice(settleFrom).find(task => task.state === "idle");
  assert.equal(settled.context.measured, true, "after the running selection is removed, the answering engine's reading stays visible");
  assert.equal(settled.context.used, used);
  assert.equal(settled.context.limit, window);
  assert.equal(f.stored().tasks[0].lastInstanceId, codex.instanceId);
});

test("a return to primary hides the old backup reading even when the model reports none", async t => {
  const f = await fixture(t);
  await f.edit(bot => { f.seed(bot); bot.backupSelection = null; });
  unlinkSync(join(f.root, f.primary.instanceId + "-limited"));
  f.claudeSpec({ hold: true, noReading: true });
  await f.say();
  assert.equal((await f.lane()).context.measured, false);
  assert.equal((await f.activity()).context.measured, false);
  f.gate();
  await f.settled();
  assert.equal((await f.lane()).context.measured, false);
  f.claudeSpec({});
  await f.turn();
  assert.equal((await f.lane()).context.used, used);
  assert.equal(f.stored().tasks[0].reading.instanceId, f.primary.instanceId);
});

test("dropSession on either engine preserves the strict primary fallback and the next first reading", async t => {
  const f = await fixture(t);
  await f.edit(bot => { const task = f.seed(bot, f.primary); task.resumeCursors.codex = "backup-session"; });
  await f.drop(f.backup.instanceId);
  assert.equal(f.stored().tasks[0].lastInstanceId, "");
  assert.equal((await f.lane()).context.used, used, "dropping backup hid the intact primary reading");
  await f.turn();
  assert.equal(f.stored().tasks[0].reading.instanceId, f.backup.instanceId);
  assert.equal((await f.lane()).context.used, used);
  await f.edit(bot => { f.seed(bot, f.primary); bot.backupSelection = null; });
  unlinkSync(join(f.root, f.primary.instanceId + "-limited"));
  await f.drop(f.primary.instanceId);
  assert.equal((await f.lane()).context.measured, false);
  await f.turn();
  assert.equal(f.stored().tasks[0].reading.instanceId, f.primary.instanceId);
  assert.equal((await f.lane()).context.used, used);
});

test("persisted identity cannot adopt a removed backup or a changed model", async t => {
  const f = await fixture(t);
  for (const change of [
    (bot: any) => { f.seed(bot); bot.tasks[0].lastInstanceId = "retired"; },
    (bot: any) => { f.seed(bot); bot.backupSelection = null; },
    (bot: any) => { f.seed(bot); bot.backupSelection = { ...f.backup, model: "gpt-6-astra" }; },
  ]) {
    await f.edit(bot => { bot.backupSelection = f.backup; change(bot); });
    const fill = (await f.lane()).context;
    assert.deepEqual([fill.used, fill.limit, fill.fraction, fill.measured], [0, 0, 0, false]);
  }
});

test("an identical shared selection displays but two models stay absent until the running model is known", async t => {
  const f = await fixture(t);
  await f.edit(bot => { f.seed(bot); bot.modelSelection = f.backup; });
  assert.equal((await f.lane()).context.used, used);
  await f.edit(bot => { bot.modelSelection = { ...f.backup, model: "gpt-6-astra" }; });
  assert.equal((await f.lane()).context.measured, false, "the saved reading must not break the idle tie");
  f.spec({ used, window, hold: true, defer: true });
  await f.say();
  assert.equal((await f.lane()).context.measured, false, "old model was accepted during the other model turn");
  f.readingGate();
  await waitFor(async () => (await f.lane()).context.used === used);
  assert.equal(f.stored().tasks[0].reading.model, "gpt-6-astra");
  f.gate();
  await f.settled();
  assert.equal((await f.lane()).context.measured, false, "idle tie was guessed from the fresh reading");
});

test("the displayed budget uses only the chosen engine's cursor and capabilities", async t => {
  const f = await fixture(t);
  await f.edit((bot, cfg) => {
    const task = f.seed(bot);
    task.resumeCursors = { claude: "primary-session" };
    cfg.compaction.beforeTurn = 60_000;
  });
  assert.equal((await f.lane()).context.limit, window, "primary cursor gave backup a line");
  await f.edit(bot => { bot.tasks[0].resumeCursors = { codex: "backup-session" }; });
  assert.equal((await f.lane()).context.limit, 60_000, "backup's own cursor did not give it a line");
  assert.equal((await f.lane()).context.modelLimit, window);
  await f.edit(bot => { bot.tasks[0].guestMail = true; });
  assert.equal((await f.lane()).context.limit, window);
  await f.edit(bot => { bot.tasks[0].guestMail = false; bot.tasks[0].resumeCursors.codex = 123; });
  assert.equal((await f.lane()).context.limit, window);
});

test("saved ceiling and share edits refresh the same backup reading and Activity without model calls", async t => {
  const f = await fixture(t);
  f.spec({ used, window, hold: true });
  await f.say();
  await waitFor(async () => (await f.lane()).context.used === used);
  const saved = f.stored().tasks[0].reading;
  const count = f.calls();
  await f.settings(60_000);
  assert.equal((await f.lane()).context.limit, 60_000);
  assert.equal((await f.activity()).context.limit, 60_000);
  await f.settings(200_000, 0.8);
  assert.equal((await f.lane()).context.limit, 120_000);
  assert.equal((await f.activity()).context.limit, 120_000);
  const response = await f.h.fetch("/api/config", { method: "PUT", body: JSON.stringify({ compaction: { beforeTurnAt: 0.2 } }) });
  assert.equal(response.status, 200);
  assert.equal((await f.lane()).context.limit, 30_000);
  assert.equal((await f.activity()).context.limit, 30_000);
  await f.settings(0);
  assert.equal((await f.lane()).context.limit, window);
  assert.deepEqual(f.stored().tasks[0].reading, saved);
  assert.equal(f.calls(), count);
  f.gate();
  await f.settled();
});

test("a room's answering lane uses its own dispatch identity and reading", async t => {
  // Shared rooms permit Claude's tool-free turn, while Codex sits out.
  const f = await fixture(t, "claude");
  await f.edit(bot => { f.seed(bot, f.primary).reading.used = 12_000; });
  const other = await f.hire("Other");
  const { blok } = await f.post("/api/bloks", { name: "Shared fixture", memberIds: [f.bot.id, other.id] });
  // Shared rooms have a lane per member; private rooms use General.
  await f.edit(() => {
    const file = join(f.root, ".bloks", "bloks.json");
    const rooms = JSON.parse(readFileSync(file, "utf8"));
    rooms.find((room: any) => room.id === blok.id).sharing = { since: 0, history: "all", tools: "conversation", spendCap: 0 };
    writeFileSync(file, JSON.stringify(rooms));
  });
  await f.h.json(`/api/bots/${other.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: f.primary, backupSelection: f.backup }) });
  await f.post(`/api/bots/${other.id}/messages`, { text: "A synthetic priming message" });
  await waitFor(async () => (await f.h.json("/api/bots?messages=0")).bots.find((bot: any) => bot.id === other.id)?.tasks.every((task: any) => task.state === "idle"));
  f.spec({ used, window, hold: true });
  f.claudeSpec({ hold: true });
  const response = await f.h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Rex A synthetic room message" }) });
  assert.ok(response.ok);
  const roomLane = async () => (await f.h.json("/api/bloks")).bloks.find((room: any) => room.id === blok.id).lanes[f.bot.id];
  let room: any;
  try {
    await waitFor(async () => {
      const id = await roomLane();
      room = (await f.current()).tasks.find((task: any) => task.id === id);
      return room?.context.used === used;
    });
  } catch (error) {
    throw new Error(JSON.stringify({ bot: await f.current(), room: await f.h.json("/api/bloks"), calls: f.calls(), logs: f.h.logs() }), { cause: error });
  }
  assert.equal(room.context.measured, true);
  assert.equal((await f.activity(room.id)).context.limit, room.context.limit);
  assert.equal((await f.activity(room.id)).context.used, used);
  assert.equal((await f.lane()).context.used, 12_000);
  f.gate();
  await f.settled();
  assert.equal((await f.lane(room.id)).context.used, used);
  assert.equal((await f.lane(room.id)).context.limit, window);
  assert.equal((await f.lane()).context.used, 12_000);
});

test("a replay backup keeps its table window even when the primary could show a budget", async t => {
  const f = await fixture(t);
  const provider = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "deepseek-chat" }] })); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { provider.closeAllConnections(); provider.close(); });
  await f.edit((bot, cfg) => {
    cfg.instances.replay = { driver: "deepseek", config: { apiKeyEnv: "LOCAL_FIXTURE_KEY", url: `http://127.0.0.1:${(provider.address() as any).port}` }, environment: { LOCAL_FIXTURE_KEY: "local-fixture" } };
    cfg.compaction.beforeTurn = 60_000;
    bot.backupSelection = { instanceId: "replay", model: "deepseek-chat" };
    const task = f.seed(bot, bot.backupSelection);
    task.reading.used = 20_000;
    task.reading.window = null;
    task.resumeCursors.claude = "primary-session";
  });
  const instances = (await f.h.json("/api/instances")).instances;
  assert.notEqual(instances.find((i: any) => i.instanceId === "replay").snapshot.state, "unavailable");
  const fill = (await f.lane()).context;
  assert.equal(fill.limit, 65_536);
  assert.equal(fill.window, "table");
  assert.equal(fill.modelLimit, undefined);
});

test("a running native command keeps the preceding model's selection", async t => {
  const f = await fixture(t);
  await f.edit(bot => {
    bot.modelSelection = codex;
    bot.backupSelection = { ...codex, instanceId: "other" };
    f.seed(bot, bot.backupSelection).resumeCursors.codex = "primary-session";
  });
  const frames = await laneEvents(t, f);
  f.spec({ compact: "hold" });
  const response = await f.h.fetch(`/api/bots/${f.bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "/compact", taskId: f.bot.threadId }) });
  assert.ok(response.ok);
  await waitFor(() => f.nativeCalls().some(call => call.method === "thread/compact/start"));
  assert.equal((await f.lane()).state, "working");
  assert.equal(f.stored().tasks[0].lastInstanceId, "other");
  assert.equal((await f.lane()).context.used, used);
  assert.equal((await f.activity()).context.limit, window);
  await assert.doesNotReject(waitFor(() => frames.filter(task => task.state === "working").length >= 2),
    "a command must also publish its selection frame");
  const busy = frames.filter(task => task.state === "working");
  assert.equal(busy.length, 2, "a command has one busy frame and exactly one selection frame before native compaction");
  for (const task of busy) {
    assert.equal(task.context.measured, true);
    assert.equal(task.context.used, used);
    assert.equal(task.context.limit, window);
  }
  const settleFrom = frames.length;
  const stopped = await f.h.fetch(`/api/bots/${f.bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: f.bot.threadId }) });
  assert.ok(stopped.ok);
  await f.settled();
  assert.equal(f.stored().tasks[0].lastInstanceId, "other", "a settled command must not replace the last answering engine");
  await assert.doesNotReject(waitFor(() => frames.slice(settleFrom).some(task => task.state === "idle")),
    "a command's settled frame must reach clients");
  const settled = frames.slice(settleFrom).find(task => task.state === "idle");
  assert.equal(settled.context.measured, true);
  assert.equal(settled.context.used, used);
  assert.equal(settled.context.limit, window);
});
