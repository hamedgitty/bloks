import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/server.ts";
import { NoticeDelivery, noticeFor } from "../src/lib/notify.ts";

const CLI = String.raw`#!__NODE__
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
const dir=__DIR__, kind='__KIND__', slot='__SLOT__';
const out=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log(kind==='codex'?'codex-cli 9.9.9':'2.1.299 (Claude Code)');process.exit();}
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit();}
if(process.argv.includes('auth')){out({loggedIn:true});process.exit();}
const run=async(start)=>{
 const path=dir+'/plan-'+slot+'.json', plans=JSON.parse(readFileSync(path,'utf8')), p=plans.shift()??{items:[]};writeFileSync(path,JSON.stringify(plans));
 if(p.capture)writeFileSync(dir+'/token-'+slot,process.env.BLOKS_TOKEN??'');
 if(p.file){mkdirSync(dirname(p.file),{recursive:true});writeFileSync(p.file,'A real neutral deliverable');}
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
async function wait(check:()=>boolean|Promise<boolean>, why:string, ms=15000) {
 const end=Date.now()+ms; while(Date.now()<end){if(await check())return;await pause(25);} assert.fail(why+'\n'+h.logs().slice(-1000));
}
const plan=(slot:string, p:unknown[])=>{writeFileSync(join(home,`plan-${slot}.json`),JSON.stringify(p));for(const f of ['ready','release'])rmSync(join(home,`${f}-${slot}`),{force:true});};
const bot=async(kind:string, backup=false)=>{
 const {bot}=await h.json('/api/bots',{method:'POST',body:JSON.stringify({name:'Neutral helper'})});
 await h.json(`/api/bots/${bot.id}`,{method:'PATCH',body:JSON.stringify({modelSelection:{instanceId:kind,model:kind==='claudeAgent'?'claude-sonnet-5':'gpt-6.1-sol'},...(backup?{backupSelection:{instanceId:'spare',model:'gpt-6.1-sol'}}:{})})});
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
test('a turn that saves its answer and then fails still says it once',async()=>{
 plan('codex',[{items:[{text:'Saved before the failure',phase:'final_answer'}],fail:true}]);const b=await bot('codex');const since=frames.length;await send(b);
 await wait(()=>frames.slice(since).some(x=>x.kind==='runtime'&&x.event?.threadId===b.threadId&&x.event?.type==='turn.completed'&&x.event?.ok===false),'no failure');
 await idle(b);await wait(()=>outcomes(b).length===1,'a failed turn hid its saved reply');await pause(100);
 assert.equal(outcomes(b).length,1);assert.equal(outcomes(b)[0].message.text,'Saved before the failure');
});
test('a long reply is saved whole but carried only as far as a banner shows',async()=>{
 const long='A long neutral sentence. '.repeat(200).trim();
 plan('codex',[{items:[{text:long,phase:'final_answer'}]}]);const b=await bot('codex');await send(b);await idle(b);
 await wait(()=>outcomes(b).length===1,'no settled snapshot');
 const carried=outcomes(b)[0].message.text;assert.ok(carried.length<=180,`carried ${carried.length} characters`);assert.match(carried,/…$/);
 const saved=(await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).messages.find((m:any)=>m.id===outcomes(b)[0].message.id);
 assert.equal(saved.text.length,long.length,'the transcript lost the rest of the reply');
});
test('goal ownership cannot create a generic result',async()=>{
 // A goal on this lane owns its dedicated result route, even when judging changes status.
 plan('codex',[{items:[{text:'A goal attempt'}]}]);const b=await bot('codex');
 const r=await h.fetch(`/api/bots/${b.id}/tasks/${b.threadId}/goal`,{method:'PUT',body:JSON.stringify({text:'Prepare a neutral report',budget:1})});
 // Only use the actual supported goal path if it accepted this shape.
 assert.ok(r.ok,await r.text());await wait(()=>existsSync(join(home,'ready-codex')),'goal never ran');await idle(b);assert.equal(outcomes(b).length,0);
});

test('actual quiet routine: a preceding report survives an ending marker and also a later failure',async()=>{
 for(const mode of ['report','quiet','fail']){
  plan('claudeAgent',[{items:[{text:'Routine progress'},{text:mode==='quiet'?'QUIET':'Routine report'}],fail:mode==='fail'}]);
  const b=await bot('claudeAgent');
  const made=await h.json('/api/routines',{method:'POST',body:JSON.stringify({targetKind:'agent',targetId:b.id,prompt:'Inspect the neutral fixture',time:'23:59',days:[],enabled:false,quiet:true})});
  assert.ok(made.routine?.id,JSON.stringify(made));
  const r=await h.fetch(`/api/routines/${made.routine.id}/run`,{method:'POST'});assert.ok(r.ok,await r.text());
  await wait(()=>existsSync(join(home,'ready-claudeAgent')),'routine never ran');await idle(b);await pause(100);
  assert.equal(outcomes(b).length,1);assert.equal(outcomes(b)[0].message.text,mode==='quiet'?'Routine progress':'Routine report');
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

// GitHub 363: in a turn nobody asked for, the bare quiet word is silence:
// not written, not news, not unread. Anything more is something said.
const lane=async(b:any)=>(await h.json('/api/bots')).bots.find((x:any)=>x.id===b.id).tasks.find((t:any)=>t.id===b.threadId);
// only what came after the agent was hired: its greeting is not this turn's
const said=async(b:any)=>(await h.json(`/api/bots/${b.id}/messages?thread=${b.threadId}&limit=500`)).messages.filter((m:any)=>!b.messages.some((g:any)=>g.id===m.id)) as any[];
const settled=async(b:any)=>{await idle(b);await wait(async()=>!(await lane(b)).settling,'lane never settled');await pause(150);};
const spoken=(b:any)=>frames.filter(f=>f.kind==='message'&&f.threadId===b.threadId&&f.message?.role==='bot'&&f.message?.kind==='text'&&!b.messages.some((g:any)=>g.id===f.message.id));
/** Holds a Codex turn open for its credential, so a test can speak as that agent. */
async function asAgent(go:(token:string,sender:any)=>Promise<void>){
 rmSync(join(home,'token-codex'),{force:true});
 plan('codex',[{items:[],hold:true,capture:true}]);const sender=await bot('codex');await send(sender);
 await wait(()=>existsSync(join(home,'token-codex'))&&readFileSync(join(home,'token-codex'),'utf8').length>0,'no sender credential');
 try {await go(readFileSync(join(home,'token-codex'),'utf8'),sender);}
 finally {writeFileSync(join(home,'release-codex'),'yes');await idle(sender);}
}
const sayAs=async(token:string,b:any,text:string)=>{const r=await h.fetch(`/api/bots/${b.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({text})});assert.ok(r.ok,await r.text());};

test('a turn another agent started that answers a bare QUIET leaves no message, no unread and no notification',async()=>{
 await asAgent(async(token)=>{
  for(const kind of ['claudeAgent','spare']){
   plan(kind,[{items:[{text:'Quiet.'}]}]);const receiver=await bot(kind);
   await sayAs(token,receiver,'Save the result locally, then finish without a status message');
   await wait(()=>existsSync(join(home,'ready-'+kind)),`${kind} never ran`);await settled(receiver);
   const all=await said(receiver);
   assert.ok(all.some((m:any)=>m.agent?.dir==='in'),'the message from the other agent is gone');
   assert.ok(!all.some((m:any)=>m.role==='bot'&&m.kind==='text'),`${kind}: the quiet word was written`);
   assert.equal(spoken(receiver).length,0,`${kind}: the quiet word went out as a message`);
   assert.equal(outcomes(receiver).length,0,`${kind}: the quiet word was announced`);
   assert.ok(!(await lane(receiver)).unread,`${kind}: the quiet word marked the chat unread`);
  }
 });
});

test('a webhook turn that answers a bare QUIET is just as silent',async()=>{
 plan('claudeAgent',[{items:[{text:'QUIET'}]}]);const b=await bot('claudeAgent');
 const {webhook}=await h.json('/api/webhooks',{method:'POST',body:JSON.stringify({botId:b.id,name:'Neutral source'})});
 const r=await h.fetch(`/hook/${webhook.token}`,{method:'POST',body:JSON.stringify({event:'nothing new'})});assert.equal(r.status,202,await r.text());
 await wait(()=>existsSync(join(home,'ready-claudeAgent')),'the webhook turn never ran');await settled(b);
 const all=await said(b);
 assert.ok(all.some((m:any)=>m.via==='webhook'),'the event itself is gone');
 assert.ok(!all.some((m:any)=>m.role==='bot'&&m.kind==='text'),'the quiet word was written');
 assert.equal(outcomes(b).length,0,'the quiet word was announced');
 assert.ok(!(await lane(b)).unread,'the quiet word marked the chat unread');
});

test('an agent-started turn that talks about QUIET, or says something before it, is still heard',async()=>{
 await asAgent(async(token)=>{
  for(const [items,heard] of [
   [[{text:'QUIET is the word a quiet routine answers with.'}],'QUIET is the word a quiet routine answers with.'],
   [[{text:'Saved the summary to notes.md.'},{text:'QUIET'}],'Saved the summary to notes.md.'],
  ] as const){
   plan('claudeAgent',[{items}]);const receiver=await bot('claudeAgent');
   await sayAs(token,receiver,'Write the neutral summary');
   await wait(()=>existsSync(join(home,'ready-claudeAgent')),'the receiver never ran');await settled(receiver);
   const texts=(await said(receiver)).filter((m:any)=>m.role==='bot'&&m.kind==='text').map((m:any)=>m.text);
   assert.deepEqual(texts,[heard]);
   assert.equal(outcomes(receiver).length,1);assert.equal(outcomes(receiver)[0].message.text,heard);
   assert.equal((await lane(receiver)).unread,true,'a reply with something in it is something to read');
  }
 });
});

test('a person-requested marker-only turn gets one honest notice instead of a marker or stale reply',async()=>{
 plan('claudeAgent',[{items:[{text:'Older useful answer'}]},{items:[{text:'QUIET'}]}]);const b=await bot('claudeAgent');await send(b);await settled(b);
 const before=frames.length;await send(b);await settled(b);
 const added=frames.slice(before);
 assert.ok(!added.some(f=>f.kind==='message'&&f.message?.text==='QUIET'));
 assert.ok(!added.some(f=>f.kind==='runtime'&&(f.event?.delta==='QUIET'||f.event?.text==='QUIET')));
 assert.equal(added.filter(f=>f.kind==='message'&&f.message?.text==='The agent ended this turn without an answer.').length,1);
 assert.equal(added.filter(f=>f.kind==='reply.settled').length,0,'an older reply was reused');
 assert.equal((await lane(b)).unread,true);
});


test('a failed primary followed by a marker-only backup gives one honest logical outcome',async()=>{
 plan('codex',[{items:[],fail:true}]);plan('spare',[{items:[{text:'QUIET'}]}]);
 const b=await bot('codex',true), at=frames.length;await send(b);
 await wait(()=>existsSync(join(home,'ready-spare')),'backup never ran');await settled(b);
 const added=frames.slice(at);
 assert.equal(added.filter(x=>x.kind==='message'&&x.message?.text==='The agent ended this turn without an answer.').length,1);
 assert.equal(added.filter(x=>x.kind==='reply.settled').length,0);
 assert.ok(!added.some(x=>x.message?.text==='QUIET'||x.event?.delta==='QUIET'||x.event?.text==='QUIET'));
});

test('an authenticated agent room handoff stays silent on its marker, while the explicit post is preserved',async()=>{
 await asAgent(async(token,sender)=>{
  plan('claudeAgent',[{items:[{text:'QUIET'}]}]);const receiver=await bot('claudeAgent');
  await h.json(`/api/bots/${receiver.id}`,{method:'PATCH',body:JSON.stringify({name:'Receiver'})});
  const other=sender;const {blok}=await h.json('/api/bloks',{method:'POST',body:JSON.stringify({name:'Fixture room',memberIds:[receiver.id,other.id]})});
  const at=frames.length;const r=await h.fetch(`/api/bloks/${blok.id}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({text:'@Receiver inspect fixture'})});assert.ok(r.ok,await r.text());
  await wait(()=>existsSync(join(home,'ready-claudeAgent')),'room receiver never ran');await settled(receiver);
  const rows=(await h.json('/api/bloks')).bloks.find((x:any)=>x.id===blok.id).messages;
  assert.ok(rows.some((x:any)=>x.text==='@Receiver inspect fixture'));
  assert.ok(!rows.some((x:any)=>x.text==='QUIET'||x.text==='The agent ended this turn without an answer.'));
  assert.ok(!frames.slice(at).some(x=>x.kind==='reply.settled'&&x.botId===receiver.id));
 });
});


test('a marker after a terminal artifact or checkpoint card does not claim there was no deliverable',async()=>{
 for(const kind of ['artifact','changes']){
  const b=await bot('claudeAgent');
  const file=join(home,'.bloks',kind==='artifact'?'artifacts':'workspaces',b.id,'neutral-result.md');
  plan('claudeAgent',[{items:[{text:'QUIET'}],file}]);const at=frames.length;await send(b);await settled(b);
  const added=frames.slice(at).filter(x=>x.threadId===b.threadId);
  assert.ok(added.some(x=>x.kind==='message'&&x.message?.kind===kind),`${kind}: no actual terminal deliverable`);
  assert.ok(!added.some(x=>x.message?.text==='The agent ended this turn without an answer.'),`${kind}: false no-answer claim`);
  assert.equal((await lane(b)).unread,true,`${kind}: deliverable was not marked unread`);
 }
});
