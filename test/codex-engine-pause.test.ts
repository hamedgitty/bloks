// Actual Codex app-server driver with an explicit local fake executable.
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { test,after,type TestContext } from 'node:test';
import { EnginePauses,EnginePauseError,type PauseStorage } from '../server/engine-pauses.ts';
import type { RuntimeEvent } from '../server/contracts.ts';
const suiteHome=mkdtempSync(join(tmpdir(),'bloks-native-unit-'));
const inheritedHome=process.env.HOME,inheritedProfile=process.env.USERPROFILE;
process.env.HOME=suiteHome;process.env.USERPROFILE=suiteHome;
after(()=>{if(inheritedHome===undefined)delete process.env.HOME;else process.env.HOME=inheritedHome;if(inheritedProfile===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=inheritedProfile;rmSync(suiteHome,{recursive:true,force:true});});
const {CodexDriver}=await import('../server/drivers/codex.ts');
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
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method){note({reply:m});return;}note({method:m.method,params:m.params});const reply=(result={})=>out({id:m.id,result:{...result,_fixtureMethod:m.method}});
if(m.method==='initialize')return reply();if(m.method==='initialized')return;
if(m.method==='model/list')return reply({data:[{id:'gpt-6-sol',model:'gpt-6-sol',isDefault:true,displayName:'GPT 6 Sol'}]});
if(m.method==='skills/list')return reply({data:[]});
if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId??thread;return reply({thread:{id:thread},model:m.params.model});}
if(m.method==='thread/compact/start'){reply();out({method:'turn/started',params:{threadId:thread,turn:{id:'compact'}}});out({method:'turn/completed',params:{threadId:thread,turn:{id:'compact',status:'completed'}},_fixtureMarker:'compact-done'});return;}
if(m.method==='turn/start'){reply({turn:{id:'actual-turn'}});out({method:'turn/started',params:{threadId:thread,turn:{id:'actual-turn'}}});const text=m.params.input.map(x=>x.text??'').join(' ');if(text.includes('descendant')){const beat=log+'.'+process.pid+'.heartbeat';const c=require('node:child_process').spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);",beat],{stdio:'ignore',env:{}});c.unref();note({method:'descendant',text,descendant:c.pid,beat});if(text.includes('closed'))setTimeout(()=>process.exit(0),50);return;}if(text.includes('question')){process.on('SIGTERM',()=>{});out({id:999,method:'item/tool/requestUserInput',params:{threadId:thread,turnId:'actual-turn',questions:[{id:'q1',question:'Synthetic choice'}]}});return;}if(text.includes('late-approval')){process.on('SIGTERM',()=>{});note({method:'approval-ready'});setTimeout(()=>out({id:888,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'actual-turn',command:'synthetic operation'}}),350);return;}if(text.includes('approval')){out({id:777,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'actual-turn',command:'synthetic operation'}});return;}if(text.includes('hold'))return;out({method:'item/completed',params:{threadId:thread,turnId:'actual-turn',item:{type:'agentMessage',id:'answer',text:'Fake Codex reply.'}}});out({method:'turn/completed',params:{threadId:thread,turn:{id:'actual-turn',status:'completed'}}});return;}
return reply();});
`,{mode:0o700});
 let saved:unknown={version:1,pauses:[],invocations:[]},now=1000;
 const storage:PauseStorage={load:()=>structuredClone(saved),save:state=>{saved=structuredClone(state);}};
 const policy=new EnginePauses(storage,()=>now),physical:Array<{kind:string;method?:string;pid?:number}>=[];
 let hook:((frame:any)=>void)|null=null;let probeHook:(()=>void)|null=null;
 const spawn=childProcess.spawn,execFile=childProcess.execFile;
 t.mock.method(childProcess,'spawn',(...args:any[])=>{if(args[0]===cli)args[2]={...args[2],env:{HOME:suiteHome,USERPROFILE:suiteHome,PATH:''}};const child=Reflect.apply(spawn,childProcess,args);if(args[0]===cli){physical.push({kind:'spawn',pid:child.pid});const write=child.stdin!.write;(child.stdin as any).write=function(chunk:any,...rest:any[]){try{const frame=JSON.parse(String(chunk));if(frame.method)physical.push({kind:'rpc',method:frame.method,pid:child.pid});}catch{}return Reflect.apply(write,this,[chunk,...rest]);};child.stdout!.prependListener('data',(chunk:Buffer)=>{for(const line of String(chunk).split('\n').filter(Boolean)){try{hook?.(JSON.parse(line));}catch(error){throw error;}}});}return child;});
 t.mock.method(childProcess,'execFile',(...args:any[])=>{if(args[0]===cli){physical.push({kind:'probe'});args[2]={...args[2],env:{HOME:suiteHome,USERPROFILE:suiteHome,PATH:''}};}const child=Reflect.apply(execFile,childProcess,args);if(args[0]===cli&&args[1]?.[0]==='login')child.stdout?.prependListener('data',()=>probeHook?.());return child;});syncBuiltinESMExports();
 const input={instanceId:'codex',displayName:'Fake Codex',enabled:true,environment:{},config:{cli,fullAuto:false},enginePauses:policy};
 const instance=await CodexDriver.create(input);await instance.catalogReady;await until(()=>policy.status().invocations.length===0);
 const events:RuntimeEvent[]=[];instance.adapter.onEvent(event=>events.push(event));
 const calls=()=>{try{return readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));}catch{return [];}};
 const pause=(agents:'all'|string[]='all',selector:any={driverKind:'codex'})=>policy.activate({kind:'agent',id:'coordinator'},{id:randomUUID(),agents,selector,until:2000,timeZone:'UTC'});
 t.after(async()=>{await instance.dispose();t.mock.restoreAll();syncBuiltinESMExports();rmSync(home,{recursive:true,force:true});});
 return {home,instance,input,policy,storage,physical,events,calls,pause,setProbeHook:(fn:(()=>void)|null)=>probeHook=fn,setHook:(fn:typeof hook)=>hook=fn,setNow:(n:number)=>now=n};
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

test('pending activation fences a native approval reply',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'permission',text:'approval',invocationOrigin:worker});
 await until(()=>f.events.some(e=>e.type==='request.opened'));
 const ask=f.events.find(e=>e.type==='request.opened') as any;
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;
 f.storage.save=async state=>{if((state as any).pauses.length){entered();await gate;}await save(state);};
 const activation=f.pause();await writing;
 try{
  await f.instance.adapter.respondToRequest!('permission',ask.requestId,{behavior:'allow'});
  await delay(150);
  const accepted=f.calls().filter(c=>c.reply?.id===777&&c.reply.result?.decision==='accept');
  console.log(JSON.stringify({probe:'approval-during-activation',activating:f.policy.status().activating,accepted:accepted.length}));
  assert.equal(accepted.length,0,'pending pause permitted a native approval reply that resumes affected work');
 }finally{release();await activation;}
});

test('committed activation fences auto approval from a child still shutting down',async t=>{
 const f=await fixture(t);await f.instance.adapter.sendTurn({threadId:'late',text:'late-approval',fullAccess:true,invocationOrigin:worker});
 await until(()=>f.calls().some(c=>c.method==='approval-ready'));
 await f.pause();
 try{
  await delay(500);const accepted=f.calls().filter(c=>c.reply?.id===888&&c.reply.result?.decision==='accept');
  console.log(JSON.stringify({probe:'approval-after-committed-pause',pauses:f.policy.status().pauses.map(p=>p.state),accepted:accepted.length}));
  assert.equal(accepted.length,0,'committed pause auto-approved a new native request while its process was still alive');
 }finally{await f.instance.dispose();}
});


test('manual replies and delayed automatic approvals are fenced in committed/activating policy, with unaffected/no-pause controls',async t=>{
 for(const mode of ['committed','activating','unaffected','none']) for(const auto of [false,true]){
  const f=await fixture(t),lane=mode+'-'+auto;
  await f.instance.adapter.sendTurn({threadId:lane,text:auto?'late-approval':'approval',fullAccess:auto,invocationOrigin:worker});
  await until(()=>auto?f.calls().some(c=>c.method==='approval-ready'):f.events.some(e=>e.type==='request.opened'));
  let release=()=>{},activation:Promise<unknown>|undefined;
  if(mode==='activating'){
   let entered!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{entered=r;}),save=f.storage.save;
   f.storage.save=async value=>{if((value as any).pauses.length){entered();await blocked;}await save(value);};activation=f.pause();await writing;
  }else if(mode!=='none')await f.pause(mode==='unaffected'?['other']:'all');
  try{
   if(!auto){const ask=f.events.find(e=>e.type==='request.opened') as any;const reply=f.instance.adapter.respondToRequest!(lane,ask.requestId,{behavior:'allow'});if(mode==='committed')await assert.rejects(reply,/no such pending request/);else await reply;}
   await delay(500);
   const accepted=f.calls().filter(c=>[777,888].includes(c.reply?.id)&&c.reply.result?.decision==='accept');
   assert.equal(accepted.length,mode==='none'||mode==='unaffected'?1:0,'policy allowed a permissive physical reply');
   assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1,'denial replayed or retried the native turn');
  }finally{release();await activation;}
 }
});


test('actual Codex descendant cancellation handles leader-close before/during activation without stopping another agent',async t=>{
 for(const closed of [false,true]){
  const f=await fixture(t);const seen:number[]=[];t.after(()=>{for(const pid of seen){try{process.kill(pid,'SIGKILL');}catch{}}});
  await f.instance.adapter.sendTurn({threadId:'target',text:closed?'descendant-target-closed':'descendant-target',invocationOrigin:worker});
  await f.instance.adapter.sendTurn({threadId:'permitted',text:'descendant-other',invocationOrigin:other});
  await until(()=>f.calls().filter(c=>c.method==='descendant').length===2);
  const a=f.calls().find(c=>c.method==='descendant'&&c.text.includes('target')),b=f.calls().find(c=>c.method==='descendant'&&c.text.includes('other'));seen.push(a.descendant,b.descendant);
  await until(()=>{try{return readFileSync(a.beat).length>0&&readFileSync(b.beat).length>0;}catch{return false;}});
  if(closed)await until(()=>f.events.some(e=>e.type==='turn.completed'&&e.threadId==='target'));
  await f.pause(['worker']);await delay(3300);
  const stopped=readFileSync(a.beat).length,permitted=readFileSync(b.beat).length;await delay(150);
  assert.equal(readFileSync(a.beat).length,stopped,'native Codex local descendant continued after bounded escalation');
  assert.ok(readFileSync(b.beat).length>permitted,'scoped cancellation killed the unaffected native group');
  assert.ok(f.policy.status().invocations.some(r=>r.origin.kind==='agent'&&r.origin.agentId==='worker'&&r.state==='residual'),'local cancellation erased remote uncertainty');
 }
});


test('actual question replies and timeout continuations obey the same physical pause fence',async t=>{
 for(const timeout of [false,true])for(const mode of ['activating','committed','unaffected','none']){
  const f=await fixture(t),lane=mode+'-question-'+timeout;
  let fire:(()=>void)|undefined;
  if(timeout){const original=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',((fn:any,ms:any,...args:any[])=>{if(ms===900000){fire=()=>fn(...args);return original(()=>{},900000);}return original(fn,ms,...args);}) as any);}
  await f.instance.adapter.sendTurn({threadId:lane,text:'question',invocationOrigin:worker});await until(()=>f.events.some(e=>e.type==='request.opened'));
  const ask=f.events.find(e=>e.type==='request.opened') as any;
  let release=()=>{},activation:Promise<unknown>|undefined;
  if(mode==='activating'){
   let entered!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),writing=new Promise<void>(r=>{entered=r;}),save=f.storage.save;
   f.storage.save=async value=>{if((value as any).pauses.length){entered();await blocked;}await save(value);};activation=f.pause();await writing;
  }else if(mode!=='none')await f.pause(mode==='unaffected'?['other']:'all');
  try{
   if(timeout){assert.ok(fire);fire();}
   else{const response=f.instance.adapter.respondToRequest!(lane,ask.requestId,{behavior:'answer',message:'Synthetic answer'});if(mode==='committed')await assert.rejects(response,/no such pending request/);else await response;}
   await delay(100);const replies=f.calls().filter(c=>c.reply?.id===999&&Object.keys(c.reply.result?.answers??{}).length>0);
   assert.equal(replies.length,mode==='none'||mode==='unaffected'?1:0,'paused Codex question resumed through manual/timeout reply');
   assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1,'question refusal caused replay');
  }finally{release();await activation;}
 }
});


test('cancelled Codex auth probe callback retains remote residual without replay',async t=>{
 const f=await fixture(t);assert.equal((await f.instance.snapshot()).state,'available');let activation:Promise<unknown>|undefined;
 f.setProbeHook(()=>{f.setProbeHook(null);activation=f.pause();});await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);await activation;
 assert.ok(f.policy.status().invocations.some(r=>r.purpose==='codex-auth'&&r.state==='residual'),'cancelled auth probe callback erased uncertainty');
});
