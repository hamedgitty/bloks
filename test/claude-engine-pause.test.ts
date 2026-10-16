// Run in an isolated HOME/environment. These exercise the actual Claude
// driver with an explicit fake executable, never a real CLI/account.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ClaudeDriver } from "../server/drivers/claude.ts";
import { EnginePauses, EnginePauseError, type PauseStorage } from "../server/engine-pauses.ts";
import { ProviderRegistry } from "../server/harness/registry.ts";
import type { RuntimeEvent } from "../server/contracts.ts";

const worker = { kind: "agent", agentId: "worker", laneId: "lane" } as const;
const other = { kind: "agent", agentId: "other", laneId: "other-lane" } as const;
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await delay(10); }
  assert.fail("fake driver boundary did not reach expected state");
}
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-driver-pause-")), cli = join(home, "fake-claude.cjs"), counter = join(home, "calls.jsonl");
  const launches: string[] = [], signals: Array<{ pid: number; signal: string }> = [], wireWrites: string[] = [];
  const spawn = childProcess.spawn, execFile = childProcess.execFile, kill = process.kill;
  t.mock.method(process, "kill", (...args: any[]) => {
    if (args[1] !== 0) signals.push({ pid: Math.abs(args[0]), signal: String(args[1] ?? "SIGTERM") });
    return Reflect.apply(kill, process, args);
  });
  t.mock.method(childProcess, "spawn", (...args: any[]) => {
    if (args[0] === cli) launches.push("spawn");
    const child = Reflect.apply(spawn, childProcess, args);
    if (args[0] === cli && child.stdin) {
      const write = child.stdin.write;
      t.mock.method(child.stdin, "write", (...pieces: any[]) => { wireWrites.push(String(pieces[0])); return Reflect.apply(write, child.stdin, pieces); });
    }
    return child;
  });
  t.mock.method(childProcess, "execFile", (...args: any[]) => {
    if (args[0] === cli) launches.push("probe");
    return Reflect.apply(execFile, childProcess, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  writeFileSync(cli, `#!${process.execPath}\n` + `
const fs=require('node:fs');
const args=process.argv.slice(2),counter=${JSON.stringify(counter)};
const note=phase=>fs.appendFileSync(counter,JSON.stringify({phase,args,pid:process.pid,cwd:process.cwd()})+'\\n');
if(args[0]==='--version'){note('version');console.log('9.9.9 (Claude Code)');}
else if(args[0]==='auth'){note('auth');console.log(JSON.stringify({loggedIn:true}));}
else if(args[args.indexOf('--output-format')+1]==='text'){
 let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{
  note('text');if(text==='hold'){setInterval(()=>{},1000);return;}
  console.log('A fake summary.');
 });
}else{
 let buffer='',begun=false;process.stdin.on('data',chunk=>{
  buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line)continue;const frame=JSON.parse(line);
   if(frame.type!=='user'||begun)continue;begun=true;note('turn');
   const text=frame.message.content;
   if(text==='hold'){setInterval(()=>{},1000);continue;}
   console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fake-session',model:'claude-sonnet-5'}));
   console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'A fake reply.'}],usage:{input_tokens:1,output_tokens:1}}}));
   console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'A fake reply.',session_id:'fake-session',num_turns:1}));
   if(text==='background')setInterval(()=>{},1000);
  }
 });
}
`, { mode: 0o700 });
  let saved: unknown = { version: 1, pauses: [], invocations: [] }, now = 1_000;
  const storage: PauseStorage = { load: () => structuredClone(saved), save: state => { saved = structuredClone(state); } };
  const policy = new EnginePauses(storage, () => now);
  const input = { instanceId: "claude", displayName: "Fake", enabled: true, environment: {},
    config: { cli, permissionMode: "acceptEdits" as const }, enginePauses: policy };
  const instance = await ClaudeDriver.create(input);
  const frames: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => { frames.push(event); });
  const calls = () => { try { return readFileSync(counter,"utf8").trim().split("\n").map(s=>JSON.parse(s)); } catch { return []; } };
  const pause = (options: { agents?: string[]; model?: string } = {}) => policy.activate({ kind: "agent", id: "coordinator" }, {
    id: randomUUID(), agents: options.agents ?? "all", selector: options.model ? { family: "claude", model: options.model } : { family: "claude" }, until: 2_000, timeZone: "UTC",
  });
  t.after(async () => { await instance.dispose(); rmSync(home,{recursive:true,force:true}); });
  return { policy, storage, instance, input, frames, calls, launches, signals, wireWrites, pause, setNow: (n: number) => { now=n; } };
}

test("a pending activation fences the next actual Claude input frame on an already running process", async t => {
  const f = await fixture(t), lane = "stream-lane";
  await f.instance.adapter.sendTurn({ threadId: lane, text: "hold", invocationOrigin: worker, stallMs: 0 });
  await until(() => f.calls().some(call => call.phase === "turn"));
  assert.equal(await f.instance.adapter.steerTurn!(lane, "positive continuation"), true);
  const userWrites = () => f.wireWrites.filter(text => { try { return JSON.parse(text).type === "user"; } catch { return false; } }).length;
  assert.equal(userWrites(), 2);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(r => { release = r; }), saving = new Promise<void>(r => { entered = r; });
  const save = f.storage.save;
  f.storage.save = async value => { if ((value as any).pauses.length) { entered(); await held; } save(value); };
  const activation = f.pause({ agents: ["worker"] });await saving;
  try {
    assert.equal(await f.instance.adapter.steerTurn!(lane, "forbidden continuation"), false, "stale foreground lease authorized another input frame");
    assert.equal(userWrites(), 2, "pending activation crossed an actual native input boundary");
  } finally { release(); await activation; }
});

test("actual Claude driver denies probes, foreground and one-shots before any new child; factory stays configured", async t => {
  const f = await fixture(t);
  assert.equal(await f.instance.generateText!("positive",worker),"A fake summary.");
  const baseline=f.calls().length;
  const physicalBaseline=f.launches.length;
  await f.pause();
  await assert.rejects(f.instance.generateText!("forbidden",worker), e=>e instanceof EnginePauseError);
  await assert.rejects(f.instance.adapter.sendTurn({threadId:"blocked",text:"forbidden",invocationOrigin:worker}), e=>e instanceof EnginePauseError);
  await assert.rejects(f.instance.snapshot(), e=>e instanceof EnginePauseError);
  const registry = new ProviderRegistry([ClaudeDriver],f.policy);
  await registry.load({new:{driver:"claudeAgent",config:f.input.config}});
  assert.ok(registry.get("new"),"pause turned a configured instance into a permanent shadow");
  await registry.disposeAll();
  assert.equal(f.calls().length,baseline,"paused driver spawned a probe or model child");
  assert.equal(f.launches.length,physicalBaseline,"paused driver called an actual spawn/probe boundary");
  f.setNow(2_000);
  assert.equal(await f.instance.generateText!("after expiry",worker),"A fake summary.");
  assert.equal(f.input.config.permissionMode,"acceptEdits");
});

test("an unresolved small-model alias and captured instance stay pending while a different scoped agent remains permitted", async t => {
  const f = await fixture(t), captured=f.instance.generateText!.bind(f.instance);
  assert.equal(await captured("positive",worker),"A fake summary.");
  await f.pause({agents:["worker"],model:"claude-haiku-4-5-20990101"});
  const before=f.calls().filter(c=>c.phase==="text").length;
  await assert.rejects(captured("blocked small model",worker),e=>e instanceof EnginePauseError,"unresolved small-model alias bypassed the model-specific restriction");
  assert.equal(await captured("other agent",other),"A fake summary.");
  assert.equal(f.calls().filter(c=>c.phase==="text").length,before+1);
  const run=f.calls().filter(c=>c.phase==="text").at(-1);
  assert.equal(run.args[run.args.indexOf("--model")+1],"claude-haiku-4-5");
  assert.ok(run.args.includes("--safe-mode")&&run.args.includes("--strict-mcp-config"));
});

test("actual one-shot persistence await cannot carry a stale admission across activation", async t => {
  const f = await fixture(t);
  assert.equal(await f.instance.generateText!("positive",worker),"A fake summary.");
  let release!:()=>void, entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}), writing=new Promise<void>(resolve=>{entered=resolve;});
  const save=f.storage.save;let held=false;
  f.storage.save=async state=>{
    if(!held&&(state as any).invocations.some((r:any)=>r.purpose==="claude-text")){held=true;entered();await blocked;}
    await save(state);
  };
  const baseline=f.calls().length;
  const physicalBaseline=f.launches.length;
  const pending=f.instance.generateText!("forbidden",worker);
  const rejected=assert.rejects(pending,e=>e instanceof EnginePauseError);
  await writing;
  const activation=f.pause();release();await activation;await rejected;
  assert.equal(f.calls().length,baseline,"stale one-shot admission reached actual spawn");
  assert.equal(f.launches.length,physicalBaseline,"stale admission crossed actual one-shot spawn boundary");
});

test("selected one-shot cancellation does not stop another agent sharing its instance", async t => {
  const f=await fixture(t);
  const a=f.instance.generateText!("hold",worker), rejected=assert.rejects(a,e=>e instanceof EnginePauseError);
  const b=f.instance.generateText!("hold",other);
  // Always observe both promises before cancellation can reject one.
  const otherStopped=assert.rejects(b,e=>e instanceof EnginePauseError);
  await until(()=>f.calls().filter(c=>c.phase==="text").length===2);
  await f.pause({agents:["worker"]});await rejected;
  await until(()=>f.policy.status().invocations.some(r=>r.origin.kind==="agent"&&r.origin.agentId==="worker"&&r.state==="residual"));
  const remaining=f.policy.status().invocations.find(r=>r.origin.kind==="agent"&&r.origin.agentId==="other");
  assert.equal(remaining?.state,"running","scoped cancellation stopped unrelated invocation");
  await f.pause({agents:["other"]});await otherStopped;
});

test("pause cancels physical Claude work after its parent turn already completed", async t => {
  const f=await fixture(t), lane="background-lane";
  await f.instance.adapter.sendTurn({threadId:lane,text:"background",model:"claude-sonnet-5",invocationOrigin:worker,stallMs:0});
  await until(()=>f.frames.some(e=>e.type==="turn.completed"));
  assert.equal(f.instance.adapter.hasSession?.(lane),false);
  assert.equal(f.policy.status().invocations.some(r=>r.purpose==="claude-turn"&&r.state==="running"),true);
  await f.pause({agents:["worker"]});
  const pid=f.calls().find(c=>c.phase==="turn").pid;
  assert.ok(f.signals.some(s=>s.pid===pid&&s.signal==="SIGTERM"),"completed parent discarded physical invocation cancellation");
  await until(()=>f.policy.status().invocations.some(r=>r.purpose==="claude-turn"&&r.state==="residual"));
  assert.equal(f.calls().filter(c=>c.phase==="turn").length,1);
});

test("concurrent foreground dispatch owns its lane before the new persistence await", async t => {
  const f=await fixture(t), lane="concurrent-lane";
  const requests=await Promise.allSettled([
    f.instance.adapter.sendTurn({threadId:lane,text:"hold",invocationOrigin:worker,stallMs:0}),
    f.instance.adapter.sendTurn({threadId:lane,text:"hold",invocationOrigin:worker,stallMs:0}),
  ]);
  assert.equal(requests.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(requests.filter(r=>r.status==="rejected"&&String(r.reason).includes("already running")).length,1);
  await until(()=>f.calls().filter(c=>c.phase==="turn").length===1);
  await f.pause();
  await until(()=>f.frames.some(e=>e.type==="turn.completed"&&e.stopReason==="engine_paused"));
  assert.equal(f.calls().filter(c=>c.phase==="turn").length,1);
});

test("a pause after version response rechecks before the actual auth probe", async t => {
  const f=await fixture(t);
  assert.equal((await f.instance.snapshot()).state,"available");
  assert.equal(f.calls().filter(c=>c.phase==="auth").length,1);
  let release!:()=>void, entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});
  const save=f.storage.save;let held=false;
  f.storage.save=async state=>{
    if(!held&&f.calls().filter(c=>c.phase==="version").length>=3&&(state as any).invocations.some((r:any)=>r.purpose==="claude-probe")){
      held=true;entered();await blocked;
    }
    await save(state);
  };
  const snapshot=f.instance.snapshot(),rejected=assert.rejects(snapshot,e=>e instanceof EnginePauseError);
  await writing;
  const before=f.launches.length;
  const activation=f.pause();release();await activation;await rejected;
  assert.equal(f.calls().filter(c=>c.phase==="auth").length,1);
  assert.equal(f.launches.length,before,"auth reused a pre-pause version/health admission");
});

test("pre-spawn cleanup failure preserves the actual policy refusal and starts no child", async t => {
  const f=await fixture(t);assert.equal(await f.instance.generateText!("positive",worker),"A fake summary.");
  await f.pause();const before=f.launches.length;
  const remove=fs.rmSync, leftovers=new Set<string>();
  t.mock.method(fs,"rmSync",(...args:any[])=>{
    if(String(args[0]).startsWith(join(tmpdir(),"bloks-turn-"))){leftovers.add(String(args[0]));throw new Error("PLANTED_CLEANUP_SECRET");}
    return Reflect.apply(remove,fs,args);
  });
  syncBuiltinESMExports();
  try{
    await assert.rejects(f.instance.adapter.sendTurn({threadId:"cleanup-lane",text:"forbidden",system:"Synthetic persona",invocationOrigin:worker}),
      e=>e instanceof EnginePauseError&&!String(e).includes("PLANTED"));
    assert.equal(f.launches.length,before);
    assert.equal(leftovers.size,1,"fixture did not exercise private-file cleanup");
  }finally{
    t.mock.restoreAll();syncBuiltinESMExports();
    for(const path of leftovers)remove(path,{recursive:true,force:true});
  }
});

test("normal stop during durable foreground preparation prevents the later spawn", async t => {
  const f=await fixture(t), lane="stop-before-spawn";
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});
  const save=f.storage.save;let held=false;
  f.storage.save=async state=>{
    if(!held&&(state as any).invocations.some((r:any)=>r.purpose==="claude-turn")){held=true;entered();await blocked;}
    await save(state);
  };
  const baseline=f.launches.length;
  const starting=f.instance.adapter.sendTurn({threadId:lane,text:"positive",invocationOrigin:worker,stallMs:0});
  const refused=assert.rejects(starting,e=>e instanceof EnginePauseError);
  await writing;await f.instance.adapter.interruptTurn(lane);release();await refused;
  assert.equal(f.launches.length,baseline,"normal stop during preparation still launched the provider");
});

test("disposed captured instance cannot start a prepared or later one-shot", async t => {
  const f=await fixture(t), captured=f.instance.generateText!.bind(f.instance);
  let release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;}),writing=new Promise<void>(resolve=>{entered=resolve;});
  const save=f.storage.save;let held=false;
  f.storage.save=async state=>{
    if(!held&&(state as any).invocations.some((r:any)=>r.purpose==="claude-text")){held=true;entered();await blocked;}
    await save(state);
  };
  const baseline=f.launches.length;
  const pending=captured("positive",worker), refused=assert.rejects(pending,e=>e instanceof EnginePauseError);
  await writing;await f.instance.dispose();release();await refused;
  await assert.rejects(captured("after reload",worker),e=>e instanceof EnginePauseError);
  assert.equal(f.launches.length,baseline,"disposed generation launched captured work");
});


test("unverified native backend provenance cannot use the CLI label to bypass a family restriction", async t => {
  const f=await fixture(t);
  assert.equal(await f.instance.generateText!("positive native route",worker),"A fake summary.");
  const before=f.launches.length;
  await f.policy.activate({kind:"owner"},{id:"unknown-native-family",agents:["worker"],selector:{family:"gemini"},until:2000,timeZone:"UTC"});
  await assert.rejects(f.instance.generateText!("unknown native route",worker),e=>e instanceof EnginePauseError,"CLI label exempted an unverified native route");
  assert.equal(f.launches.length,before,"unknown native backend crossed the real spawn boundary");
  assert.equal(await f.instance.generateText!("unaffected scoped agent",other),"A fake summary.");
});
