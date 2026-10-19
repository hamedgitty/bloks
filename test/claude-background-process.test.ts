// Real HTTP/store/SSE coverage of the Claude turn's process ownership.
// Only synthetic node processes run; the helper deliberately retains stdout
// after its group leader exits, as a native background task can do.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OWN_GROUP } from "../server/no-console.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

async function until<T>(read: () => T | null | undefined | Promise<T | null | undefined>, why: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.fail(why);
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    }
    return true;
  } catch { return false; }
}

const json = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const rows = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });

async function agent(h: Harness, name: string) {
  const { bot } = await h.json("/api/bots", post({ name }));
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  return bot;
}

test("Claude seals late frames and waits for a resistant owned helper before the same-session successor, while another lane proceeds", { skip: !OWN_GROUP, timeout: 40_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-boundary-"));
  const log = join(home, "timeline.jsonl");
  const ownerFile = join(home, "owner.json");
  const cli = join(home, "fake-claude.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const helper = `
    const { appendFileSync } = require("node:fs");
    const record = (kind) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({kind,pid:process.pid,at:Date.now()})+"\\n");
    process.on("SIGTERM", () => record("helper-term"));
    process.send("ready");
    setTimeout(() => {
      record("helper-late");
      const frames = [
        {type:"assistant",message:{content:[{type:"text",text:"SEALED_LATE_ROOT"}],usage:{input_tokens:9001,output_tokens:9001}}},
        {type:"assistant",parent_tool_use_id:"background-child",message:{content:[{type:"text",text:"SEALED_LATE_CHILD"}]}},
        {type:"system",subtype:"init",session_id:"SEALED_LATE_SESSION",model:"SEALED_LATE_MODEL"},
        {type:"assistant",error:"rate_limit",message:{content:[{type:"text",text:"SEALED_LATE_ERROR limit exceeded"}]}},
        {type:"control_request",request_id:"SEALED_LATE_ASK",request:{subtype:"can_use_tool",tool_name:"Bash",input:{command:"echo SEALED_LATE_TOOL"}}}
      ];
      process.stdout.write(frames.map(f=>JSON.stringify(f)+"\\n").join(""));
    },150);
    setInterval(() => {},1000);
  `;
  writeFileSync(cli, `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if(args[0]==="--version"){console.log("2.1.300 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const log=${JSON.stringify(log)}, ownerFile=${JSON.stringify(ownerFile)};
const alive = (pid) => {try {process.kill(pid,0); if(process.platform==="linux"){const stat=readFileSync("/proc/"+pid+"/stat","utf8");return !["Z","X"].includes(stat.slice(stat.lastIndexOf(")")+2).split(" ")[0]);}return true;}catch{return false;}};
const previous=existsSync(ownerFile)?JSON.parse(readFileSync(ownerFile,"utf8")):null;
const record=(kind,extra={})=>appendFileSync(log,JSON.stringify({kind,pid:process.pid,at:Date.now(),...extra})+"\\n");
record("spawn",{args,oldLeader:previous?alive(previous.leader):null,oldHelper:previous?alive(previous.helper):null});
process.on("SIGTERM",()=>{record("leader-term");process.exit(0);});
const out=f=>process.stdout.write(JSON.stringify(f)+"\\n");
let buffer="", taken=false;
process.stdin.on("data",async chunk=>{
  buffer+=chunk;
  for(let i=buffer.indexOf("\\n");i>=0;i=buffer.indexOf("\\n")){
    const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
    const frame=JSON.parse(line);if(frame.type!=="user"||taken)continue;taken=true;
    const text=String(frame.message.content), id=frame.uuid;
    record("input",{text,id});
    out({type:"system",subtype:"init",session_id:"sess-boundary",model:"claude-sonnet-5"});
    out({type:"command_lifecycle",command_uuid:id,state:"started"});
    out({type:"system",subtype:"status",status:"requesting",uuid:"request-"+id,user_message_uuids:[id]});
    if(text==="FIRST"){
      const helper=spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:["ignore","inherit","inherit","ipc"]});
      await new Promise(resolve=>helper.once("message",resolve));
      writeFileSync(ownerFile,JSON.stringify({leader:process.pid,helper:helper.pid}));
    }
    const answer=text+" ANSWER";
    const frames=[
      {type:"assistant",message:{content:[{type:"text",text:answer}],usage:{input_tokens:1,output_tokens:1}}},
      {type:"result",uuid:"result-"+id,user_message_uuids:[id],subtype:"success",is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"sess-boundary",result:answer},
      {type:"command_lifecycle",command_uuid:id,state:"completed"},
      {type:"assistant",message:{content:[{type:"text",text:"SEALED_BUFFERED_ROOT"}]}},
      {type:"system",subtype:"commands_changed",commands:[{name:"SEALED_BUFFERED_COMMAND",description:"late",argumentHint:""}]}
    ];
    process.stdout.write(frames.map(f=>JSON.stringify(f)+"\\n").join(""));
  }
});
setInterval(()=>{},1000);
`, { mode: 0o755 });

  let h: Harness | undefined;
  const stopStream = new AbortController();
  let pump: Promise<void> | undefined;
  let streamText = "";
  t.after(async () => {
    stopStream.abort();
    await pump;
    await h?.stop();
    const ids = rows(log).filter((row) => row.kind === "spawn").map((row) => row.pid);
    const owned = json(ownerFile);
    if (owned) ids.push(owned.helper);
    for (const pid of ids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
    const end = Date.now() + 2_000;
    while (ids.some(running) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ids.some(running), false, "fixture processes were not cleaned up");
    rmSync(home, { recursive: true, force: true });
  });
  h = await startHarness({ HOME: home, USERPROFILE: home });
  const stream = await h.fetch("/api/events", { signal: stopStream.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  pump = (async () => {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        streamText += decoder.decode(value, { stream: true });
      }
    } catch (error) { if (!stopStream.signal.aborted) throw error; }
  })();
  const first = await agent(h, "Runner");
  const other = await agent(h, "Parallel");
  const messages = async (bot: any) => (await h!.json(`/api/bots/${bot.id}/messages?limit=100`)).messages as any[];
  const busy = async (bot: any) => Boolean((await h!.json("/api/bots?messages=0")).bots.find((row: any) => row.id === bot.id)?.busy);
  await h.json(`/api/bots/${first.id}/messages`, post({ text: "FIRST" }));
  const owned = await until(() => json(ownerFile), "first process never started its helper");
  await until(() => rows(log).find((row) => row.kind === "leader-term" && row.pid === owned.leader), "leader was not asked to stop");
  await until(() => !running(owned.leader) ? true : null, "polite leader did not exit on TERM");
  assert.equal(running(owned.helper), true, "helper should keep running after TERM");
  assert.equal(await busy(first), true, "session was released before helper cleanup");
  const queued = await h.json(`/api/bots/${first.id}/messages`, post({ text: "SECOND" }));
  assert.equal(queued.queued, true, "a successor should wait behind the old process barrier");
  assert.notEqual(queued.steered, true, "sealed process still accepted a steer");
  await h.json(`/api/bots/${other.id}/messages`, post({ text: "UNRELATED" }));
  await until(async () => (await messages(other)).find((row) => row.text === "UNRELATED ANSWER") && !(await busy(other)), "unrelated lane waited behind the old group");
  assert.equal(running(owned.helper), true, "other lane did not complete during the resistant helper's cleanup wait");
  await until(() => rows(log).find((row) => row.kind === "helper-late"), "helper did not exercise late frames");
  await until(async () => (await messages(first)).find((row) => row.text === "SECOND ANSWER") && !(await busy(first)), "queued successor did not complete after old helper cleanup");
  const timeline = rows(log);
  const secondInput = timeline.find((row) => row.kind === "input" && row.text === "SECOND");
  const secondSpawn = timeline.find((row) => row.kind === "spawn" && row.pid === secondInput?.pid);
  assert.ok(secondSpawn, "successor spawn was not recorded");
  assert.equal(secondSpawn.oldLeader, false, "successor started alongside old leader");
  assert.equal(secondSpawn.oldHelper, false, "successor started alongside resistant old helper");
  const resume = secondSpawn.args.indexOf("--resume");
  assert.ok(resume >= 0, "successor did not resume the original session");
  assert.equal(secondSpawn.args[resume + 1], "sess-boundary", "late init changed the saved session");
  assert.equal(running(owned.helper), false);
  const stored = await messages(first);
  assert.equal(stored.filter((row) => row.text === "FIRST ANSWER").length, 1);
  assert.equal(stored.filter((row) => row.text === "SECOND ANSWER").length, 1);
  assert.doesNotMatch(JSON.stringify(stored), /SEALED_/);
  assert.doesNotMatch(streamText, /SEALED_/, "postterminal frames reached the actual event stream");
  assert.ok(streamText.includes("FIRST ANSWER") && streamText.includes("SECOND ANSWER"), "SSE assertion did not observe legitimate answers");
});

test("server disposal cleans a resistant helper whose turn leader already exited, without signalling an unrelated process", { skip: !OWN_GROUP, timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-disposal-"));
  const ownerFile = join(home, "owner.json");
  const cli = join(home, "fake-claude.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const helper = 'process.on("SIGTERM",()=>{});process.send("ready");setInterval(()=>{},1000);';
  writeFileSync(cli, `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args=process.argv.slice(2);
if(args[0]==="--version"){console.log("2.1.300 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
process.on("SIGTERM",()=>process.exit(0));
let buffer="",taken=false;
process.stdin.on("data",async chunk=>{
  buffer+=chunk;
  for(let i=buffer.indexOf("\\n");i>=0;i=buffer.indexOf("\\n")){
    const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;
    const input=JSON.parse(line);if(input.type!=="user"||taken)continue;taken=true;
    const child=spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:["ignore","inherit","inherit","ipc"]});
    await new Promise(resolve=>child.once("message",resolve));
    writeFileSync(${JSON.stringify(ownerFile)},JSON.stringify({leader:process.pid,helper:child.pid}));
    for(const frame of [
      {type:"system",subtype:"init",session_id:"sess-disposal",model:"claude-sonnet-5"},
      {type:"assistant",message:{content:[{type:"text",text:"Disposal fixture answer."}]}},
      {type:"result",uuid:"disposal-result",user_message_uuids:[input.uuid],subtype:"success",is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,result:"Disposal fixture answer."},
      {type:"command_lifecycle",command_uuid:input.uuid,state:"completed"}
    ])process.stdout.write(JSON.stringify(frame)+"\\n");
  }
});
setInterval(()=>{},1000);
`, { mode: 0o755 });
  const unrelated = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000);'], {
    detached: OWN_GROUP, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  });
  let h: Harness | undefined;
  let stopped = false;
  t.after(async () => {
    if (!stopped) await h?.stop();
    const owned = json(ownerFile);
    const ids = [unrelated.pid!, ...(owned ? [owned.leader, owned.helper] : [])];
    for (const pid of ids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (unrelated.exitCode === null && unrelated.signalCode === null) await new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
    const end = Date.now() + 2_000;
    while (ids.some(running) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    unrelated.stdout?.destroy();
    assert.equal(ids.some(running), false, "disposal fixture process survived teardown");
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.stdout!.once("data", () => resolve());
  });
  h = await startHarness({ HOME: home, USERPROFILE: home });
  const bot = await agent(h, "Disposal");
  await h.json(`/api/bots/${bot.id}/messages`, post({ text: "Finish before disposal." }));
  const owned = await until(() => json(ownerFile), "disposal fixture did not spawn its helper");
  await until(() => !running(owned.leader) ? true : null, "fixture leader did not exit on TERM");
  assert.equal(running(owned.helper), true, "fixture helper did not resist TERM");
  await h.stop();
  stopped = true;
  assert.equal(running(owned.helper), false, "server disposal returned while the exited leader's helper still ran");
  assert.equal(running(unrelated.pid!), true, "disposal signalled a process outside its ownership");
});
