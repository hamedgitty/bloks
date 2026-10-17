import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/server.ts";
import { NoticeDelivery, noticeFor } from "../src/lib/notify.ts";

const CLI = String.raw`#!__NODE__
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir=__DIR__, kind='__KIND__', slot='__SLOT__';
const out=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log(kind==='codex'?'codex-cli 9.9.9':'9.9.9 (Claude Code)');process.exit();}
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit();}
if(process.argv.includes('auth')){out({loggedIn:true});process.exit();}
const run=async(start)=>{
 const path=dir+'/plan-'+slot+'.json', plans=JSON.parse(readFileSync(path,'utf8')), p=plans.shift()??{items:[]};writeFileSync(path,JSON.stringify(plans));
 if(p.capture)writeFileSync(dir+'/token-'+slot,process.env.BLOKS_TOKEN??'');
 if(kind==='codex')out({method:'turn/started',params:{threadId:'thread',turn:{id:'native',status:'inProgress'}}});
 else out({type:'system',subtype:'init',session_id:'fixture',model:'claude-sonnet-5'});
 for(const [i,item] of (p.items??[]).entries()) {
  if(kind==='codex')out({method:'item/completed',params:{threadId:'thread',item:{id:'item'+i,type:'agentMessage',...item}}});
  else out({type:'assistant',message:{id:'item'+i,model:'claude-sonnet-5',content:[{type:'text',text:item.text}],usage:{input_tokens:1,output_tokens:1}}});
 }
 writeFileSync(dir+'/ready-'+slot,'yes');
 if(p.hold){const until=Date.now()+12000;while(!existsSync(dir+'/release-'+slot)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));}
 if(p.fail&&kind==='codex')out({method:'error',params:{threadId:'thread',error:{message:'Insufficient credits'},willRetry:false}});
 if(kind==='codex')out({method:'turn/completed',params:{threadId:'thread',turn:{id:'native',status:p.fail?'failed':'completed',...(p.fail?{error:{message:'Insufficient credits'}}:{})}}});
 else out({type:'result',subtype:'success',is_error:!!p.fail,num_turns:1,duration_api_ms:1,total_cost_usd:0,result:p.fail?'Insufficient credits':'ok'});
};
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(kind==='claudeAgent'){if(m.type==='user')await run();return;}
 if(m.method==='model/list')return out({id:m.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',isDefault:true}]}});
 if(m.method==='thread/start'||m.method==='thread/resume')return out({id:m.id,result:{thread:{id:'thread'},model:'gpt-6.1-sol'}});
 if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'native',status:'inProgress'}}});await run();return;}
 if(m.id!==undefined)out({id:m.id,result:{}});
});
`;
let h: Harness, home: string, controller: AbortController;
const frames: any[] = [];
let reading: Promise<void>;
const pause = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function wait(check:()=>boolean|Promise<boolean>, why:string) {
 const end=Date.now()+15000; while(Date.now()<end){if(await check())return;await pause(25);} assert.fail(why+'\n'+h.logs().slice(-1000));
}
const plan=(slot:string, p:unknown[])=>{writeFileSync(join(home,`plan-${slot}.json`),JSON.stringify(p));for(const f of ['ready','release'])rmSync(join(home,`${f}-${slot}`),{force:true});};
const bot=async(kind:string, backup=false)=>{
 const {bot}=await h.json('/api/bots',{method:'POST',body:JSON.stringify({name:'Neutral helper'})});
 await h.json(`/api/bots/${bot.id}`,{method:'PATCH',body:JSON.stringify({modelSelection:{instanceId:kind,model:kind==='codex'?'gpt-6.1-sol':'claude-sonnet-5'},...(backup?{backupSelection:{instanceId:'spare',model:'gpt-6.1-sol'}}:{})})});
 return (await h.json("/api/bots")).bots.find((x:any)=>x.id===bot.id);
};
const send=async(b:any)=>{const r=await h.fetch(`/api/bots/${b.id}/messages`,{method:'POST',body:JSON.stringify({text:'Prepare the neutral summary'})});assert.ok(r.ok,await r.text());};
const idle=async(b:any)=>wait(async()=>!(await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).busy,'turn never settled');
const outcomes=(b:any)=>frames.filter(x=>x.kind==='reply.settled'&&x.botId===b.id);
before(async()=>{
 home=mkdtempSync(join(tmpdir(),'bloks-reply-fixture-'));mkdirSync(join(home,'.bloks'));
 const instances:Record<string,unknown>={};
 for(const [slot,kind] of [['codex','codex'],['claudeAgent','claudeAgent'],['spare','codex']]){
  const cli=join(home,slot+'.mjs');writeFileSync(cli,CLI.replaceAll('__NODE__',process.execPath).replaceAll('__DIR__',JSON.stringify(home)).replaceAll('__KIND__',kind).replaceAll('__SLOT__',slot),{mode:0o755});
  instances[slot]={driver:kind,config:{cli}};plan(slot,[]);
 }
 writeFileSync(join(home,'.bloks/config.json'),JSON.stringify({instances}));h=await startHarness({HOME:home,USERPROFILE:home});
 controller=new AbortController();const res=await h.fetch('/api/events',{signal:controller.signal});assert.ok(res.ok);
 const reader=res.body!.getReader();reading=(async()=>{let buffer='';const decoder=new TextDecoder();try{for(;;){const r=await reader.read();if(r.done)return;buffer+=decoder.decode(r.value,{stream:true});let at;while((at=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=block.split('\n').find(s=>s.startsWith('data: '));if(data)frames.push(JSON.parse(data.slice(6)));}}}catch(e){if(!controller.signal.aborted)throw e;}})();
 await wait(()=>frames.some(x=>x.kind==='hello'),'no stream hello');
});
after(async()=>{controller?.abort();await reading;await h?.stop();rmSync(home,{recursive:true,force:true});});
for(const kind of ['codex','claudeAgent'])test(`${kind}: actual HTTP/SSE holds ordinary text until settled, then snapshots saved content once`,async()=>{
 plan(kind,[{items:[{text:'Which date?'},{text:'Checking the available dates'}],hold:true}]);const b=await bot(kind);await send(b);
 await wait(()=>existsSync(join(home,'ready-'+kind)),'fixture not running');await pause(120);
 assert.equal(outcomes(b).length,0,'running text announced');
 writeFileSync(join(home,'release-'+kind),'yes');await idle(b);await wait(()=>outcomes(b).length===1,'no settled snapshot');
 assert.equal(outcomes(b)[0].message.text,'Checking the available dates');
 const saved=(await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).messages;
 assert.equal(saved.filter((m:any)=>m.id===outcomes(b)[0].message.id).length,1,'snapshot inserted history');
 assert.ok(saved.some((m:any)=>m.text==='Which date?'),'plain question hidden');
});
test('Codex final beats later commentary; marked commentary-only, partial and unknown boundaries are factual',async()=>{
 for(const [items,expected] of [
  [[{text:'The final answer',phase:'final_answer'},{text:'Tidying',phase:'commentary'}],'The final answer'],
  [[{text:'Still checking',phase:'commentary'}],null],
  [[{text:'A partial preview',phase:'partial_answer'}],'A partial preview'],
  [[{text:'Future engine text',phase:'future'}],'Future engine text'],
 ] as const){
  plan('codex',[{items}]);const b=await bot('codex');await send(b);await idle(b);
  if(expected)await wait(()=>outcomes(b).length===1,'no final preview');else await pause(100);
  assert.equal(outcomes(b).length,expected?1:0);if(expected)assert.equal(outcomes(b)[0].message.text,expected);
 }
});
test('failed primary text never leaks: only a successful backup result or no preview for empty backup',async()=>{
 for(const empty of [false,true]){
  const primary=empty?'claudeAgent':'codex';
  plan(primary,[{items:[{text:'Primary work in progress'}],fail:true}]);plan('spare',[{items:empty?[]:[{text:'Backup answer'}]}]);
  const b=await bot(primary,true);const since=frames.length;await send(b);
  await wait(()=>frames.slice(since).some(x=>x.kind==='runtime'&&x.event?.threadId===b.threadId&&x.event?.type==='turn.completed'&&x.event?.ok===false),'no primary failure');
  await wait(()=>existsSync(join(home,'ready-spare')),'backup never ran');await idle(b);await pause(100);
  assert.equal(outcomes(b).length,empty?0:1);if(!empty)assert.equal(outcomes(b)[0].message.text,'Backup answer');
 }
});
test('goal ownership cannot create a generic result',async()=>{
 // A goal on this lane owns its dedicated result route, even when judging changes status.
 plan('codex',[{items:[{text:'A goal attempt'}]}]);const b=await bot('codex');
 const r=await h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}/goal`,{method:'PUT',body:JSON.stringify({text:'Prepare a neutral report',budget:1})});
 // Only use the actual supported goal path if it accepted this shape.
 assert.ok(r.ok,await r.text());await wait(()=>existsSync(join(home,'ready-codex')),'goal never ran');await idle(b);assert.equal(outcomes(b).length,0);
});

test('actual quiet routine: nonquiet report announces only settled, QUIET and failed runs do not',async()=>{
 for(const mode of ['report','quiet','fail']){
  plan('claudeAgent',[{items:[{text:'Routine progress'},{text:mode==='quiet'?'QUIET':'Routine report'}],fail:mode==='fail'}]);
  const b=await bot('claudeAgent');
  const made=await h.json('/api/routines',{method:'POST',body:JSON.stringify({targetKind:'agent',targetId:b.id,prompt:'Inspect the neutral fixture',time:'23:59',days:[],enabled:false,quiet:true})});
  assert.ok(made.routine?.id,JSON.stringify(made));
  const r=await h.fetch(`/api/routines/${made.routine.id}/run`,{method:'POST'});assert.ok(r.ok,await r.text());
  await wait(()=>existsSync(join(home,'ready-claudeAgent')),'routine never ran');await idle(b);await pause(100);
  assert.equal(outcomes(b).length,mode==='report'?1:0);if(mode==='report')assert.equal(outcomes(b)[0].message.text,'Routine report');
 }
});

test('Stop keeps already saved text but emits no successful-completion snapshot',async()=>{
 plan('codex',[{items:[{text:'Work before a deliberate Stop',phase:'final_answer'}],hold:true}]);const b=await bot('codex');await send(b);
 await wait(()=>existsSync(join(home,'ready-codex')),'turn never reached its hold');
 const r=await h.fetch(`/api/bots/${b.id}/interrupt`,{method:'POST'});assert.ok(r.ok,await r.text());await idle(b);await pause(100);
 assert.equal(outcomes(b).length,0);
 assert.ok((await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).messages.some((m:any)=>m.text==='Work before a deliberate Stop'));
});


test('an authenticated agent-origin unmarked reply uses the same settled policy',async()=>{
 plan('codex',[{items:[],hold:true,capture:true}]);const sender=await bot('codex');await send(sender);
 await wait(()=>existsSync(join(home,'token-codex')),'no synthetic sender credential');
 try {
  plan('claudeAgent',[{items:[{text:'Internal narration at the settled boundary'}]}]);const receiver=await bot('claudeAgent');
  const token=readFileSync(join(home,'token-codex'),'utf8');assert.ok(token);
  const r=await h.fetch(`/api/bots/${receiver.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({text:'Inspect the neutral source'})});assert.ok(r.ok,await r.text());
  await wait(()=>outcomes(receiver).length===1,'no agent-origin completion');
  assert.equal(outcomes(receiver)[0].message.text,'Internal narration at the settled boundary');
  assert.ok((await h.json('/api/bots')).bots.find((b:any)=>b.id===receiver.id).messages.some((m:any)=>m.agent?.dir==='in'));
 } finally {writeFileSync(join(home,'release-codex'),'yes');await idle(sender);}
});


test('deleting the chosen final during a running turn cannot recover its words at settlement', async()=>{
 plan('codex',[{items:[{text:'Earlier unmarked words'},{text:'Withdrawn final answer',phase:'final_answer'}],hold:true}]);
 const b=await bot('codex');await send(b);
 await wait(()=>frames.some(x=>x.kind==='message'&&x.threadId===b.threadId&&x.message.text==='Withdrawn final answer'),'no saved final');
 const saved=frames.find(x=>x.kind==='message'&&x.threadId===b.threadId&&x.message.text==='Withdrawn final answer').message;
 const removed=await h.json(`/api/threads/${b.threadId}/messages/${saved.id}`,{method:'DELETE'});
 assert.equal(removed.message.deleted,true);assert.equal(removed.message.text,'');
 writeFileSync(join(home,'release-codex'),'yes');await idle(b);await pause(100);
 const current=(await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).messages.find((m:any)=>m.id===saved.id);
 assert.equal(current.deleted,true);assert.equal(current.text,'');
 assert.deepEqual(outcomes(b),[],'deleted final or earlier fallback text was republished');
});


test('separate approval steps in one actual workflow each remain news',async()=>{
 const b=await bot('codex');
 const {workflow}=await h.json('/api/workflows',{method:'POST',body:JSON.stringify({name:'Neutral two approvals',trigger:{kind:'manual'},steps:[{id:'one',action:'approve',text:'First choice?',targetId:b.id},{id:'two',action:'approve',text:'Second choice?',targetId:b.id}]})});
 assert.ok(workflow?.id);
 const {run}=await h.json(`/api/workflows/${workflow.id}/run`,{method:'POST',body:'{}'});assert.ok(run?.id);
 const gates=()=>frames.filter(f=>f.kind==='message'&&f.message?.card?.runId===run.id);
 await wait(()=>gates().length===1,'first approval missing');
 await h.json(`/api/workflows/runs/${run.id}/answer`,{method:'POST',body:JSON.stringify({answer:'Approve'})});
 await wait(()=>gates().length===2,'second approval missing');
 const [first,second]=gates();assert.notEqual(first.message.id,second.message.id);assert.equal(first.message.card.runId,second.message.card.runId);
 // Exercise the actual StoreProvider identity, not a copied expectation.
 const source=readFileSync(new URL('../src/state/store.tsx',import.meta.url),'utf8');
 const expression=source.match(/take\(frame\._seq,\s*(`message:[^`]+`)/)?.[1];assert.ok(expression);
 const identity=new Function('frame','msg','return '+expression);
 const d=new NoticeDelivery();d.hello(0);const notices=[];
 for(const frame of [first,second,{...first,_seq:second._seq+1},{...second,_seq:second._seq+2}]){
  if(d.take(frame._seq,identity(frame,frame.message))){
   const notice=noticeFor(frame.message,{focused:false,selectedId:'',threadId:b.threadId,bot:{id:b.id,name:'Helper',notifications:false}});
   if(notice)notices.push(notice);
  }
 }
 assert.equal(notices.length,2,'second genuine approval was mistaken for a duplicate');
 assert.ok(notices.every(n=>n.urgent),'workflow approvals keep their existing immediate attention');
});
