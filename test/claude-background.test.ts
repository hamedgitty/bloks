// Attributed Claude protocol through the actual HTTP, store and SSE path.
// The peer is a synthetic node process. No installed Claude or provider runs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";

async function until<T>(read: () => T | null | undefined | Promise<T | null | undefined>, why: string, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(why);
}
const post = (body: object) => ({ method: "POST", body: JSON.stringify(body) });
const rows = (path: string): any[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function fixture(t: TestContext, script: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-attributed-"));
  const cli = join(home, "peer.mjs");
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const home=${JSON.stringify(home)}, args=process.argv.slice(2);
if(args[0]==="--version"){console.log("2.1.300 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const n=(existsSync(home+"/spawns")?Number(readFileSync(home+"/spawns","utf8")):0)+1;
writeFileSync(home+"/spawns",String(n));
appendFileSync(home+"/argv.jsonl",JSON.stringify(args)+"\\n");
const out=f=>process.stdout.write(JSON.stringify(f)+"\\n");
const nap=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const marker=name=>writeFileSync(home+"/"+name,"yes");
const queue=[];let buffer="", wake;
process.stdin.on("data",chunk=>{buffer+=chunk;for(let i=buffer.indexOf("\\n");i>=0;i=buffer.indexOf("\\n")){
 const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!line.trim())continue;const frame=JSON.parse(line);
 if(frame.type!=="user")continue;
 appendFileSync(home+"/inputs.jsonl",JSON.stringify({id:frame.uuid,text:String(frame.message.content),n})+"\\n");queue.push(frame);
}wake?.();});
process.stdin.on("end",()=>marker("eof-"+n));
process.on("SIGTERM",()=>{marker("term-"+n);process.exit(0);});
const next=async()=>{while(!queue.length)await new Promise(resolve=>{wake=resolve;});return queue.shift();};
const say=text=>out({type:"assistant",message:{content:[{type:"text",text}]}});
let resultSequence=0;
const result=(id,text,extra={})=>({type:"result",uuid:"result-"+(++resultSequence)+"-"+id,user_message_uuid:id,user_message_uuids:[id],subtype:"success",is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"sess-attributed",result:text,...extra});
const complete=id=>({type:"command_lifecycle",command_uuid:id,state:"completed"});
const request=id=>out({type:"system",subtype:"status",status:"requesting",uuid:"request-"+id,user_message_uuids:[id]});
const input=await next(), id=input.uuid, words=String(input.message.content);
out({type:"system",subtype:"init",session_id:"sess-attributed",model:"claude-sonnet-5"});
${script}
setInterval(()=>{},1000);
`, { mode: 0o755 });
  let h: Harness | undefined;
  const abort = new AbortController();
  let pump: Promise<void> | undefined;
  const events: any[] = [];
  t.after(async () => {
    abort.abort();
    await pump;
    await h?.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  h = await startHarness({ HOME: home, USERPROFILE: home });
  const response = await h.fetch("/api/events", { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  pump = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        for (let i = pending.indexOf("\n\n"); i >= 0; i = pending.indexOf("\n\n")) {
          const chunk = pending.slice(0, i); pending = pending.slice(i + 2);
          const data = chunk.split("\n").find(line => line.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  const { bot } = await h.json("/api/bots", post({ name: "Worker" }));
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const messages = async (): Promise<any[]> => (await h!.json(`/api/bots/${bot.id}/messages?limit=100`)).messages;
  const busy = async () => Boolean((await h!.json("/api/bots?messages=0")).bots.find((row: any) => row.id === bot.id)?.busy);
  const send = (text: string) => h!.json(`/api/bots/${bot.id}/messages`, post({ text }));
  const native = () => rows(join(home, ".bloks", "native", `${bot.threadId}.ndjson`));
  return { home, h, bot, events, messages, busy, send, native };
}

test("resumed housekeeping leaves stdin open for Enter, and each accepted input completes in the same process", { timeout: 60_000 }, async t => {
  const f = await fixture(t, `
if(words==="SEED"){
 request(id);say("Seed answer");out(result(id,"Seed answer"));out(complete(id));
}else{
 out(result(id,"",{num_turns:0,duration_api_ms:0}));marker("housekeeping");
 const second=await next();marker("steer-heard");
 request(id);request(second.uuid);
 say("Ordinary answer");out(result(id,"Ordinary answer"));out(complete(id));
 await nap(150);say("Steered answer");out(result(second.uuid,"Steered answer"));out(complete(second.uuid));
}`);
  await f.send("SEED");
  await until(async () => (await f.messages()).some(row => row.text === "Seed answer") && !(await f.busy()), "seed did not finish");
  await f.send("ORDINARY");
  await until(() => existsSync(join(f.home, "housekeeping")), "resumed housekeeping did not arrive");
  assert.equal(await f.busy(), true, "housekeeping ended the real turn");
  assert.equal(existsSync(join(f.home, "eof-2")), false, "housekeeping shut input before Enter");
  const admission = await f.send("ENTER STEER");
  assert.equal(admission.steered, true);
  assert.notEqual(admission.queued, true);
  await until(() => existsSync(join(f.home, "steer-heard")), "accepted steer did not reach the process");
  await until(async () => (await f.messages()).some(row => row.text === "Steered answer") && !(await f.busy()), "attributed turn did not finish");
  const inputs = rows(join(f.home, "inputs.jsonl"));
  assert.deepEqual(inputs.map(row => [row.text, row.n]), [["SEED", 1], ["ORDINARY", 2], ["ENTER STEER", 2]]);
  assert.equal(new Set(inputs.map(row => row.id)).size, 3, "inputs did not have independent UUIDs");
  assert.ok(inputs.every(row => typeof row.id === "string" && row.id.length > 0));
  const stored = await f.messages();
  assert.equal(stored.find(row => row.text === "ENTER STEER")?.midTurn, true);
  for (const text of ["Ordinary answer", "Steered answer"]) {
    assert.equal(stored.filter(row => row.text === text).length, 1);
    assert.equal(f.events.filter(event => event.kind === "message" && event.message?.text === text).length, 1);
  }
  assert.ok(rows(join(f.home, "argv.jsonl")).every(args => args.includes("--include-partial-messages")));
  const secondArgs = rows(join(f.home, "argv.jsonl"))[1];
  assert.equal(secondArgs[secondArgs.indexOf("--resume") + 1], "sess-attributed");
});

test("a real no-query command finishes through its own lifecycle while stdin stays open", async t => {
  const f = await fixture(t, `
 out(result(id,"",{num_turns:0,duration_api_ms:0}));
 out(result(id,"",{uuid:"local-"+id,num_turns:0,duration_api_ms:0,local_command:"cost",total_cost_usd:0.25}));
 out(complete(id));marker("completed-command");`);
  await f.send("/cost");
  await until(async () => existsSync(join(f.home, "completed-command")) && !(await f.busy()), "zero-query command did not finish without EOF");
  assert.equal(readFileSync(join(f.home, "spawns"), "utf8"), "1");
  assert.ok(existsSync(join(f.home, "term-1")), "the owned process was not torn down at completion");
  const stored = await f.messages();
  assert.doesNotMatch(JSON.stringify(stored), /before it answered|900 seconds|could not|error:/i);
  assert.equal((await f.h.json("/api/usage?days=1")).total.cost, 0.25);
});

test("child frames stay out of live chat while parent TaskStop and notifications survive; terminal output is sealed", async t => {
  const f = await fixture(t, `
 request(id);
 const hidden=[
 {type:"assistant",parent_tool_use_id:"child",message:{content:[{type:"text",text:"HIDDEN_CHILD_TEXT"}],usage:{input_tokens:2,output_tokens:3}}},
 {type:"assistant",parent_tool_use_id:"child",error:"authentication_failed",message:{content:[{type:"text",text:"HIDDEN_CHILD_ERROR"}]}},
 {type:"assistant",parent_tool_use_id:"child",message:{content:[{type:"tool_use",id:"child-tool",name:"HIDDEN_CHILD_TOOL",input:{}}]}},
 {type:"user",parent_tool_use_id:"child",message:{content:[{type:"tool_result",tool_use_id:"child-tool",is_error:true,content:"HIDDEN_CHILD_RESULT"}]}},
 {type:"stream_event",event:{type:"content_block_delta",delta:{text:"HIDDEN_PARTIAL"}}}
 ];
 for(const frame of hidden)out(frame);
 out({type:"assistant",message:{content:[{type:"text",text:"Parent is working"},{type:"tool_use",id:"stop-child",name:"TaskStop",input:{task_id:"background-1"}}]}});
 out({type:"user",message:{content:[{type:"tool_result",tool_use_id:"stop-child",is_error:false,content:"Successfully stopped background-1"}]}});
 out({type:"system",subtype:"task_notification",task_id:"background-1",status:"completed",summary:"Parent received completion"});
 marker("live-child-replayed");await nap(700);
 const frames=[
 {type:"assistant",message:{content:[{type:"text",text:"Parent reviewed the child's work"}],usage:{input_tokens:5,output_tokens:7}}},
 result(id,"Parent reviewed the child's work",{total_cost_usd:0.5,usage:{input_tokens:100,output_tokens:100}}),complete(id),
 {type:"assistant",message:{content:[{type:"text",text:"HIDDEN_LATE_ROOT"}],usage:{input_tokens:9000,output_tokens:9000}}},
 {type:"assistant",parent_tool_use_id:"child",message:{content:[{type:"text",text:"HIDDEN_LATE_CHILD"}]}},
 {type:"assistant",error:"rate_limit",message:{content:[{type:"text",text:"HIDDEN_LATE_ERROR limit exceeded"}]}},
 result(id,"HIDDEN_LATE_RESULT",{uuid:"late-result",total_cost_usd:90})
 ];process.stdout.write(frames.map(frame=>JSON.stringify(frame)+"\\n").join(""));`);
  await f.send("WORK");
  await until(() => existsSync(join(f.home, "live-child-replayed")), "live child sequence never ran");
  assert.equal(await f.busy(), true);
  const live = await f.messages();
  assert.ok(live.some(row => row.text === "Parent is working"));
  assert.doesNotMatch(JSON.stringify(live), /HIDDEN_/);
  await until(async () => (await f.messages()).some(row => row.text === "Parent reviewed the child's work") && !(await f.busy()), "parent did not finish");
  const stored = await f.messages();
  assert.equal(stored.filter(row => row.text === "Parent reviewed the child's work").length, 1);
  assert.ok(stored.some(row => row.kind === "activity" && row.tool?.name === "TaskStop" && row.tool.ok === true), "parent's TaskStop result disappeared");
  assert.doesNotMatch(JSON.stringify(stored), /HIDDEN_/);
  assert.doesNotMatch(JSON.stringify(f.events), /HIDDEN_/);
  assert.ok(f.events.some(event => event.kind === "message" && event.message?.text === "Parent reviewed the child's work"));
  const native = f.native();
  assert.ok(native.some(row => row.msg?.type === "system" && row.msg.subtype === "task_notification" && row.msg.task_id === "background-1"), "parent completion notification was lost");
  assert.equal(native.filter(row => row.msg?.type === "stream_event").length, 0, "discarded partial frames reached native logging");
  assert.doesNotMatch(JSON.stringify(native), /HIDDEN_LATE_/);
  const usage = await f.h.json("/api/usage?days=1");
  assert.equal(usage.total.cost, 0.5, "late or duplicate terminal accounting was charged");
  assert.ok(native.some(row => row.msg?.parent_tool_use_id === "child" && row.msg.message?.usage?.input_tokens === 2), "child accounting frame was lost");
  assert.equal(usage.total.input, 5, "the existing per-turn high-water accounting must exclude result fallback and late usage");
  assert.equal(usage.total.output, 7);
});
