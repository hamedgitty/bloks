// Actual Codex app-server driver with an explicit local fake executable.
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test,type TestContext } from 'node:test';
import { CodexDriver } from '../server/drivers/codex.ts';
import { EnginePauses,EnginePauseError,type PauseStorage } from '../server/engine-pauses.ts';
import type { RuntimeEvent } from '../server/contracts.ts';
const worker={kind:'agent',agentId:'worker',laneId:'lane'} as const;
const other={kind:'agent',agentId:'other',laneId:'other'} as const;
async function until(check:()=>boolean){for(let i=0;i<500;i++){if(check())return;await delay(10);}assert.fail('fake Codex boundary did not reach expected state');}
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'bloks-codex-pause-')),cli=join(home,'fake-codex.cjs'),log=join(home,'calls.jsonl');
 writeFileSync(cli,`#!${process.execPath}\n`+`
const fs=require('node:fs'),readline=require('node:readline'),args=process.argv.slice(2),log=${JSON.stringify(log)};
const note=x=>fs.appendFileSync(log,JSON.stringify({...x,pid:process.pid})+'\\n');note({args});
if(args[0]==='--version'){console.log('codex-cli 9.9.9');process.exit(0);}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
let thread='fake-thread-'+process.pid;
const out=m=>console.log(JSON.stringify(m));
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;note({method:m.method,params:m.params});const reply=(result={})=>out({id:m.id,result:{...result,_fixtureMethod:m.method}});
if(m.method==='initialize')return reply();if(m.method==='initialized')return;
if(m.method==='model/list')return reply({data:[{id:'gpt-6-sol',model:'gpt-6-sol',isDefault:true,displayName:'GPT 6 Sol'}]});
if(m.method==='skills/list')return reply({data:[]});
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId??thread;return reply({thread:{id:thread},model:m.params.model});}
if(m.method==='thread/compact/start'){reply();out({method:'turn/started',params:{threadId:thread,turn:{id:'compact'}}});out({method:'turn/completed',params:{threadId:thread,turn:{id:'compact',status:'completed'}},_fixtureMarker:'compact-done'});return;}
if(m.method==='turn/start'){reply({turn:{id:'actual-turn'}});out({method:'turn/started',params:{threadId:thread,turn:{id:'actual-turn'}}});const text=m.params.input.map(x=>x.text??'').join(' ');if(text.includes('hold'))return;out({method:'item/completed',params:{threadId:thread,turnId:'actual-turn',item:{type:'agentMessage',id:'answer',text:'Fake Codex reply.'}}});out({method:'turn/completed',params:{threadId:thread,turn:{id:'actual-turn',status:'completed'}}});return;}
return reply();});
`,{mode:0o700});
 let saved:unknown={version:1,pauses:[],invocations:[]},now=1000;
 const storage:PauseStorage={load:()=>structuredClone(saved),save:state=>{saved=structuredClone(state);}};
 const policy=new EnginePauses(storage,()=>now),physical:Array<{kind:string;method?:string;pid?:number}>=[];
 let hook:((frame:any)=>void)|null=null;
 const spawn=childProcess.spawn,execFile=childProcess.execFile;
 t.mock.method(childProcess,'spawn',(...args:any[])=>{const child=Reflect.apply(spawn,childProcess,args);if(args[0]===cli){physical.push({kind:'spawn',pid:child.pid});const write=child.stdin!.write;(child.stdin as any).write=function(chunk:any,...rest:any[]){try{const frame=JSON.parse(String(chunk));if(frame.method)physical.push({kind:'rpc',method:frame.method,pid:child.pid});}catch{}return Reflect.apply(write,this,[chunk,...rest]);};child.stdout!.prependListener('data',(chunk:Buffer)=>{for(const line of String(chunk).split('\n').filter(Boolean)){try{hook?.(JSON.parse(line));}catch(error){throw error;}}});}return child;});
 t.mock.method(childProcess,'execFile',(...args:any[])=>{if(args[0]===cli)physical.push({kind:'probe'});return Reflect.apply(execFile,childProcess,args);});syncBuiltinESMExports();
 const input={instanceId:'codex',displayName:'Fake Codex',enabled:true,environment:{},config:{cli,fullAuto:false},enginePauses:policy};
 const instance=await CodexDriver.create(input);await instance.catalogReady;await until(()=>policy.status().invocations.length===0);
 const events:RuntimeEvent[]=[];instance.adapter.onEvent(event=>events.push(event));
 const calls=()=>{try{return readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));}catch{return [];}};
 const pause=(agents:'all'|string[]='all',selector:any={driverKind:'codex'})=>policy.activate({kind:'agent',id:'coordinator'},{id:randomUUID(),agents,selector,until:2000,timeZone:'UTC'});
 t.after(async()=>{await instance.dispose();t.mock.restoreAll();syncBuiltinESMExports();rmSync(home,{recursive:true,force:true});});
 return {home,instance,input,policy,storage,physical,events,calls,pause,setHook:(fn:typeof hook)=>hook=fn,setNow:(n:number)=>now=n};
}

test('actual Codex driver retains configuration and denies foreground/probes/skills before physical launch',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'positive',text:'positive',model:'gpt-6-luna',invocationOrigin:worker});await until(()=>f.events.some(e=>e.type==='turn.completed'&&e.threadId==='positive'));
 assert.equal(f.calls().find(c=>c.method==='thread/start').params.model,'gpt-6-luna');
 await f.pause();const before=f.physical.length;
 await assert.rejects(f.instance.adapter.sendTurn({threadId:'blocked',text:'forbidden',invocationOrigin:worker}),e=>e instanceof EnginePauseError);
 await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);
 await assert.rejects(f.instance.skills!(f.home),e=>e instanceof EnginePauseError);
 const next=await CodexDriver.create({...f.input,instanceId:'new'});await next.catalogReady;await next.dispose();
 assert.equal(f.physical.length,before,'paused Codex crossed an actual process or RPC boundary');
 f.setNow(2000);assert.equal((await f.instance.snapshot()).state,'available');
});

test('Codex rechecks after initialize while activation persistence is still blocked',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'positive',text:'positive',invocationOrigin:worker});await until(()=>f.events.some(e=>e.type==='turn.completed'));
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;let held=false;let activation:Promise<unknown>|undefined;
 f.storage.save=async state=>{if(!held&&(state as any).pauses.length){held=true;entered();await gate;}await save(state);};
 f.setHook(frame=>{if(frame.result?._fixtureMethod==='initialize'){f.setHook(null);activation=f.pause();}});
 const before=f.physical.filter(x=>x.method==='turn/start'||x.method==='thread/start').length;
 await f.instance.adapter.sendTurn({threadId:'race',text:'forbidden',invocationOrigin:worker});await writing;
 await until(()=>f.events.some(e=>e.type==='turn.completed'&&e.threadId==='race'));
 assert.equal(f.physical.filter(x=>x.method==='turn/start'||x.method==='thread/start').length,before,'stale Codex lease crossed an actual model RPC boundary');
 assert.equal((f.events.find(e=>e.type==='turn.completed'&&e.threadId==='race') as any).stopReason,'engine_paused');
 release();await activation;
});

test('Codex native compaction completion cannot authorize the following ordinary turn under a pause',async t=>{
 const f=await fixture(t);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;let held=false;let activation:Promise<unknown>|undefined;
 f.storage.save=async state=>{if(!held&&(state as any).pauses.length){held=true;entered();await gate;}await save(state);};
 f.setHook(frame=>{if(frame._fixtureMarker==='compact-done'){f.setHook(null);activation=f.pause();}});
 await f.instance.adapter.sendTurn({threadId:'compact',text:'never sent',resumeCursor:'kept-thread',model:'gpt-6-sol',compactFirst:true,invocationOrigin:worker});await writing;
 await until(()=>f.events.some(e=>e.type==='turn.completed'&&e.threadId==='compact'));
 assert.equal(f.physical.filter(x=>x.method==='thread/compact/start').length,1,'fixture did not run real native compaction');
 assert.equal(f.physical.filter(x=>x.method==='turn/start').length,0,'compaction reused admission for the following model RPC');
 release();await activation;
});

test('scoped Codex cancellation retains a residual without stopping a permitted agent sharing its instance',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'a',text:'hold a',invocationOrigin:worker});await f.instance.adapter.sendTurn({threadId:'b',text:'hold b',invocationOrigin:other});
 await until(()=>f.calls().filter(c=>c.method==='turn/start').length===2);
 await f.pause(['worker']);await until(()=>f.policy.status().invocations.some(r=>r.origin.kind==='agent'&&r.origin.agentId==='worker'&&r.state==='residual'));
 assert.ok(f.policy.status().invocations.some(r=>r.origin.kind==='agent'&&r.origin.agentId==='other'&&r.state==='running'));
 assert.equal(await f.instance.adapter.steerTurn!('b','permitted steer'),true);
 assert.equal(f.calls().filter(c=>c.method==='turn/start').length,2);
 await f.pause(['other']);
});

test('normal stop and dispose during durable Codex preparation cannot start a later child',async t=>{
 const f=await fixture(t);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;let held=false;
 f.storage.save=async state=>{if(!held&&(state as any).invocations.some((r:any)=>r.purpose==='codex-turn')){held=true;entered();await gate;}await save(state);};
 const before=f.physical.length,pending=f.instance.adapter.sendTurn({threadId:'stopped',text:'forbidden',invocationOrigin:worker}),rejected=assert.rejects(pending,e=>e instanceof EnginePauseError);
 await writing;await f.instance.adapter.interruptTurn!('stopped');await f.instance.dispose();release();await rejected;
 assert.equal(f.physical.length,before,'disposed/normal-stopped Codex preparation spawned a child');
 await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);
});

test('Codex activation during durable preparation rechecks at actual spawn',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'positive',text:'positive',invocationOrigin:worker});await until(()=>f.events.some(e=>e.type==='turn.completed'));
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;let held=false;
 f.storage.save=async state=>{if(!held&&(state as any).invocations.some((r:any)=>r.purpose==='codex-turn')){held=true;entered();await gate;}await save(state);};
 const before=f.physical.filter(x=>x.kind==='spawn').length,pending=f.instance.adapter.sendTurn({threadId:'race',text:'forbidden',invocationOrigin:worker}),rejected=assert.rejects(pending,e=>e instanceof EnginePauseError);
 await writing;const activation=f.pause();release();await activation;await rejected;
 assert.equal(f.physical.filter(x=>x.kind==='spawn').length,before,'stale Codex admission crossed actual spawn boundary');
});


test('a GPT label does not exempt unresolved native provider routing from a Claude family pause',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'positive',text:'positive',model:'gpt-6-sol',invocationOrigin:worker});await until(()=>f.events.some(e=>e.type==='turn.completed'));
 await f.pause('all',{family:'claude'});const before=f.physical.length;
 await assert.rejects(f.instance.adapter.sendTurn({threadId:'unknown',text:'never sent',model:'gpt-6-sol',invocationOrigin:worker}),e=>e instanceof EnginePauseError);
 await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);
 assert.equal(f.physical.length,before,'native model label guessed a permitted provider route');
});
