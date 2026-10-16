// Real source owners and HTTP driver, redirected to one explicit fake server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test,type TestContext } from 'node:test';
import { startHarness } from './helpers/server.ts';
import { waitFor } from './helpers/turns.ts';
async function fixture(t:TestContext,scheduler=false,crash=false){
 const home=mkdtempSync(join(tmpdir(),'bloks-engine-pending-')),data=join(home,'.bloks');mkdirSync(data);
 const calls:any[]=[];
 const fake=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;
  if(req.url!.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'gemini-3.8-flash'},{id:'gemini-3.1-pro-preview'}]}));return;}
  assert.ok(req.url!.endsWith('/chat/completions'));const body=JSON.parse(raw);calls.push(body);
  if(String(body.messages.at(-1)?.content).includes('CRASH_HOLD_SOURCE'))return;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'A synthetic finished answer.'}}],usage:{prompt_tokens:1,completion_tokens:1}}));
 });await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(fake.address() as any).port}`;
 const preload=join(home,'fake-transport.mjs');
 writeFileSync(preload,`const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(String(input));if(url.origin==='https://generativelanguage.googleapis.com')return original(${JSON.stringify(origin)}+url.pathname+url.search,init);if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return original(input,init);throw new Error('Non-fixture network is unavailable.');};`);
 writeFileSync(join(data,'config.json'),JSON.stringify({instances:{gemini:{driver:'gemini',environment:{GEMINI_API_KEY:'SYNTHETIC_ONLY_KEY'},config:{}}},agentDefaults:{modelSelection:{instanceId:'gemini',model:'gemini-3.8-flash'}}}));
 const clock=join(home,'clock');writeFileSync(clock,'0');
 const arm=join(home,'crash-arm'),crashPreload=join(home,'crash-commit.mjs');
 writeFileSync(crashPreload,`import fs from 'node:fs';import {syncBuiltinESMExports}from 'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{rename(from,to);if(String(to)===${JSON.stringify(join(data,'engine-pauses.json'))}&&fs.existsSync(${JSON.stringify(arm)})){const saved=JSON.parse(fs.readFileSync(to,'utf8'));if(saved.pauses.some(p=>p.id==='crash-restriction'))process.kill(process.pid,'SIGKILL');}};syncBuiltinESMExports();`);
 const env={HOME:home,USERPROFILE:home,NODE_OPTIONS:'--import='+preload+(scheduler?' --import='+new URL('./helpers/scheduler-clock.mjs',import.meta.url).href:'')+(crash?' --import='+crashPreload:''),...(scheduler?{BLOKS_TEST_CLOCK_FILE:clock}:{})};let h=await startHarness(env);
 t.after(async()=>{await h.stop();fake.closeAllConnections();await new Promise<void>(r=>fake.close(()=>r()));rmSync(home,{recursive:true,force:true});});
 const {bot}=await h.json('/api/bots',{method:'POST',body:JSON.stringify({name:'Synthetic worker'})});
 const request=async(method:string,path:string,body?:unknown)=>{const res=await h.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};};
 const pause=async(id:string,selector:any={family:'gemini'},until=Date.now()+120000)=>request('POST','/api/engine-pauses',{id,agents:[bot.id],selector,until,timeZone:'UTC'});
 const say=(text:string)=>request('POST',`/api/bots/${bot.id}/messages`,{text});
 const messages=async()=>(await h.json(`/api/bots/${bot.id}/messages?limit=200`)).messages as any[];
 const done=()=>waitFor(async()=>{const stored=JSON.parse(readFileSync(join(data,'bots.json'),'utf8'));const current=stored.find((b:any)=>b.id===bot.id);return !current.busy?true:null;});
 return {home,data,arm,get h(){return h;},bot,calls,request,pause,say,messages,done,restart:async(edit?:()=>void)=>{await h.stop();edit?.();h=await startHarness(env);}};
}

test('a model-only pause selects the permitted configured backup on the same API instance without preference writes',async t=>{
 const f=await fixture(t);
 await f.request('PATCH',`/api/bots/${f.bot.id}`,{modelSelection:{instanceId:'gemini',model:'gemini-3.8-flash'},backupSelection:{instanceId:'gemini',model:'gemini-3.1-pro-preview'}});
 await f.pause('primary-only',{model:'gemini-3.8-flash'});const before=f.calls.length;
 const sent=await f.say('Synthetic request on permitted backup.');assert.equal(sent.status,202);assert.notEqual(sent.body.pending,true,'same-instance configured backup was left pending');
 assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
 assert.equal(f.calls[before].model,'gemini-3.1-pro-preview','same-instance backup was excluded by the native policy preflight');
 const bot=JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find((b:any)=>b.id===f.bot.id);
 assert.equal(bot.modelSelection.model,'gemini-3.8-flash');assert.equal(bot.backupSelection.model,'gemini-3.1-pro-preview');
 assert.equal(f.calls.slice(before).some(call=>call.model==='gemini-3.8-flash'),false);
});

test('unstarted messages stay in the existing queue and expire into current edits rather than duplicate stored words',async t=>{
 const f=await fixture(t);await f.say('Positive before restriction');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());await f.pause('first');await f.pause('overlap');const before=f.calls.length;
 const posted=await f.say('ORIGINAL_QUEUED_TEXT');assert.equal(posted.status,202);assert.equal(posted.body.pending,true);assert.equal(posted.body.queued,true);
 const queued=(await f.messages()).find(m=>m.text==='ORIGINAL_QUEUED_TEXT');assert.ok(queued?.queued);
 assert.equal((await f.request('PATCH',`/api/threads/${f.bot.threadId}/messages/${queued.id}`,{text:'CURRENT_EDITED_TEXT'})).status,200);
 await f.request('DELETE','/api/engine-pauses/first');assert.equal(f.calls.length,before,'one cancelled overlap released queued work early');assert.equal((await f.messages()).find(m=>m.id===queued.id)?.queued,true,'paused queue consumed its source message before dispatch');
 const held=(await f.request('GET','/api/engine-pauses')).body;assert.ok(held.holds.some((h:any)=>h.agentId===f.bot.id&&h.phase==='pending'));
 await f.request('DELETE','/api/engine-pauses/overlap');assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
 const matching=f.calls.slice(before).filter(call=>JSON.stringify(call.messages).includes('CURRENT_EDITED_TEXT'));
 assert.equal(matching.length,1);assert.equal(f.calls.slice(before).some(call=>JSON.stringify(call.messages).includes('ORIGINAL_QUEUED_TEXT')),false);
 const after=await f.messages();assert.equal(after.filter(m=>m.id===queued.id).length,1);assert.equal(after.find(m=>m.id===queued.id)?.queued,false);
});

test('expiry uses the existing source sweep and preserves a newer saved model choice',async t=>{
 const f=await fixture(t,true);await f.pause('expires',{family:'gemini'},Date.now()+1500);const before=f.calls.length;
 assert.equal((await f.say('AFTER_EXPIRY_CURRENT_CHOICE')).body.pending,true);
 await f.request('PATCH',`/api/bots/${f.bot.id}`,{modelSelection:{instanceId:'gemini',model:'gemini-3.1-pro-preview'}});
 assert.ok(await waitFor(()=>Date.now()>((JSON.parse(readFileSync(join(f.data,'engine-pauses.json'),'utf8')).pauses[0].until))));
 // The existing scheduler callback runs on the isolated accelerated clock.
 assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
 assert.equal(f.calls[before].model,'gemini-3.1-pro-preview');
 const bot=JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find((b:any)=>b.id===f.bot.id);assert.equal(bot.modelSelection.model,'gemini-3.1-pro-preview');
});

test('activation during preparation keeps the same edited queue record until a real invocation starts',async t=>{
 const f=await fixture(t);await f.say('POSITIVE_BEFORE_PREPARATION');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());
 await f.pause('hold-before');await f.say('QUEUED_BEFORE_PREPARATION');const queued=(await f.messages()).find(m=>m.text==='QUEUED_BEFORE_PREPARATION');assert.ok(queued?.queued);
 const asked=join(f.home,'version-asked'),gate=join(f.home,'version-release'),cli=join(f.home,'fake-version.cjs');
 writeFileSync(cli,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version'){fs.writeFileSync(${JSON.stringify(asked)},'');const until=Date.now()+15000;const tick=()=>{if(fs.existsSync(${JSON.stringify(gate)})||Date.now()>until){console.log('2.1.300 (Claude Code)');process.exit(0);}setTimeout(tick,20);};tick();}else if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true}));}else process.exit(99);\n`,{mode:0o755});
 const file=join(f.data,'config.json'),config=JSON.parse(readFileSync(file,'utf8'));config.instances.slow={driver:'claudeAgent',config:{cli}};writeFileSync(file,JSON.stringify(config));
 const reload=f.h.fetch('/api/providers/grok/connect',{method:'POST',body:JSON.stringify({key:'SYNTHETIC_UNUSED_KEY',url:'http://127.0.0.1:1'})});
 assert.ok(await waitFor(()=>existsSync(asked)),'explicit fake preparation did not start');
 await f.request('DELETE','/api/engine-pauses/hold-before');
 assert.ok(await waitFor(()=>JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find((b:any)=>b.id===f.bot.id).busy),'queued source never entered preparation');
 await f.pause('during-preparation');
 assert.equal((await f.request('PATCH',`/api/threads/${f.bot.threadId}/messages/${queued.id}`,{text:'EDITED_DURING_PREPARATION'})).status,200);
 const before=f.calls.length;writeFileSync(gate,'');await reload;assert.ok(await f.done());
 assert.equal(f.calls.length,before,'paused preparation reached the actual provider');
 const held=(await f.messages()).find(m=>m.id===queued.id);assert.equal(held?.queued,true,'preparation consumed an unstarted source');assert.equal(held?.text,'EDITED_DURING_PREPARATION');
 assert.ok((await f.request('GET','/api/engine-pauses')).body.holds.some((h:any)=>h.agentId===f.bot.id&&h.phase==='pending'));
 await f.request('DELETE','/api/engine-pauses/during-preparation');assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
 assert.equal(f.calls.slice(before).filter(c=>JSON.stringify(c.messages).includes('EDITED_DURING_PREPARATION')).length,1);
 assert.equal(f.calls.slice(before).some(c=>JSON.stringify(c.messages).includes('QUEUED_BEFORE_PREPARATION')),false);
 assert.equal((await f.messages()).filter(m=>m.id===queued.id).length,1);
});

test('scheduled once and repeated slots stay unconsumed across restart, while old/manual work does not replay',async t=>{
 const f=await fixture(t,true);await f.say('POSITIVE_SCHEDULE_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());await f.pause('scheduled-pause');
 const date=(at:Date)=>`${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')}`;
 const slot=(id:string,minutes:number,repeat:string)=>{const at=new Date(Date.now()-minutes*60000);return {id,targetKind:'agent',targetId:f.bot.id,prompt:id,time:`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`,days:[],repeat,...(repeat==='once'?{date:date(at)}:{}),...(id==='SCHEDULE_REPEAT'?{lastReport:{at:at.getTime()-60000,summary:'PRESERVED_PRIOR_ROUTINE_REPORT'}}:{}),enabled:true,createdAt:at.getTime()-60000,scheduledAt:at.getTime()-60000};};
 await f.restart(()=>writeFileSync(join(f.data,'routines.json'),JSON.stringify([slot('SCHEDULE_ONCE',2,'once'),slot('SCHEDULE_REPEAT',2,'weekly'),slot('OBSOLETE_MANUAL',180,'once')])));
 const rows=async()=>(await f.request('GET','/api/routines')).body.routines as any[];
 await f.request('POST','/api/power',{state:'resume'});
 assert.ok(await waitFor(async()=>(await rows()).filter(r=>r.runs?.some((run:any)=>run.heldSlot!==undefined)).length===2));
 const before=f.calls.length;await f.request('POST','/api/power',{state:'resume'});
 for(const id of ['SCHEDULE_ONCE','SCHEDULE_REPEAT']){const r=(await rows()).find(r=>r.id===id);assert.equal(r.enabled,true,'pause consumed a scheduled once slot');assert.equal(r.lastRunAt,undefined);assert.equal(r.runs.length,1,'repeated checks duplicated the held-slot record');assert.match(r.runs[0].error,/grace/);}
 assert.equal((await f.request('POST','/api/routines/OBSOLETE_MANUAL/run',{})).body.pending,true);
 assert.equal(f.calls.length,before);assert.equal((await f.messages()).some(m=>['SCHEDULE_ONCE','SCHEDULE_REPEAT','OBSOLETE_MANUAL'].includes(m.text)),false,'held routine stored an undelivered prompt as a delivered message');
 await f.request('DELETE','/api/engine-pauses/scheduled-pause');await f.request('POST','/api/power',{state:'resume'});
 assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
 // A shared lane admits one scheduled turn per sweep, then the next
 // source remains due for the following existing scheduler sweep.
 await f.request('POST','/api/power',{state:'resume'});
 assert.ok(await waitFor(async()=>(await rows()).filter(r=>r.id!=='OBSOLETE_MANUAL').every(r=>r.lastRunAt)));
 assert.ok(await f.done());
 for(const id of ['SCHEDULE_ONCE','SCHEDULE_REPEAT'])assert.equal(f.calls.slice(before).filter(c=>String(c.messages.at(-1)?.content).includes(id)).length,1,'one eligible occurrence did not dispatch exactly once');
 assert.ok(String(f.calls.slice(before).find(c=>String(c.messages.at(-1)?.content).includes('SCHEDULE_REPEAT'))?.messages.at(-1)?.content).includes('PRESERVED_PRIOR_ROUTINE_REPORT'),'deferred routine dispatch dropped its previous report');
 assert.equal(f.calls.slice(before).some(c=>JSON.stringify(c.messages).includes('OBSOLETE_MANUAL')),false,'obsolete or manually held work replayed automatically');
 const old=(await rows()).find(r=>r.id==='OBSOLETE_MANUAL');assert.equal(old.lastRunAt,undefined);
 const manualBefore=f.calls.length;assert.equal((await f.request('POST','/api/routines/OBSOLETE_MANUAL/run',{})).status,202);assert.ok(await waitFor(()=>f.calls.length>manualBefore));assert.ok(await f.done());
 assert.equal(f.calls.slice(manualBefore).filter(c=>JSON.stringify(c.messages).includes('OBSOLETE_MANUAL')).length,1);
});

test('paused watcher checks retain their source frontier and transfer one resumed change to the durable queue',async t=>{
 const f=await fixture(t);await f.say('POSITIVE_WATCHER_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());
 const folder=join(f.home,'watched');mkdirSync(folder);writeFileSync(join(folder,'old.txt'),'baseline');
 const made=await f.request('POST','/api/watchers',{botId:f.bot.id,kind:'folder',target:folder,instruction:'WATCHER_CHANGED_SOURCE'});assert.equal(made.status,201);
 const id=made.body.watcher.id;await f.request('POST',`/api/watchers/${id}/check`,{});
 const saved=()=>JSON.parse(readFileSync(join(f.data,'watchers.json'),'utf8')).find((w:any)=>w.id===id);
 const frontier=saved().seen;assert.ok(frontier);await f.pause('watcher-pause');writeFileSync(join(folder,'new.txt'),'change');const before=f.calls.length;
 const held=await f.request('POST',`/api/watchers/${id}/check`,{});assert.equal(held.body.fired,false,'paused watcher consumed a change');assert.match(held.body.note,/paused/);assert.equal(saved().seen,frontier,'paused watcher advanced its frontier');assert.equal(f.calls.length,before);
 await f.request('DELETE','/api/engine-pauses/watcher-pause');const resumed=await f.request('POST',`/api/watchers/${id}/check`,{});assert.equal(resumed.body.fired,true);
 assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());assert.notEqual(saved().seen,frontier);
 assert.equal((await f.messages()).filter(m=>m.via==='watcher'&&m.text?.includes('WATCHER_CHANGED_SOURCE')).length,1,'watcher change was posted more than once');
 assert.equal((await f.request('POST',`/api/watchers/${id}/check`,{})).body.fired,false);
 assert.equal(f.calls.length,before+1);
});

test('a mixed room preserves only the paused member delivery without repeating its completed peer',async t=>{
 const f=await fixture(t,true);
 const second=(await f.request('POST','/api/bots',{name:'Synthetic peer'})).body.bot;
 await f.request('PATCH',`/api/bots/${second.id}`,{modelSelection:{instanceId:'gemini',model:'gemini-3.1-pro-preview'}});
 const made=await f.request('POST','/api/bloks',{name:'Synthetic room',memberIds:[f.bot.id,second.id]});assert.equal(made.status,201);const room=made.body.blok;
 await f.pause('one-room-member');const before=f.calls.length;
 assert.equal((await f.request('POST',`/api/bloks/${room.id}/messages`,{text:'ONE_ROOM_DELIVERY'})).status,201);
 assert.ok(await waitFor(()=>f.calls.length>before));assert.equal(f.calls.slice(before).every(c=>c.model==='gemini-3.1-pro-preview'),true,'paused room member invoked its provider');
 assert.ok(JSON.parse(readFileSync(join(f.data,'room-lines.json'),'utf8')).some((r:any)=>r.botId===f.bot.id&&r.roomId===room.id),'paused room delivery has no durable source owner');
 await f.request('DELETE','/api/engine-pauses/one-room-member');assert.ok(await waitFor(()=>f.calls.slice(before).some(c=>c.model==='gemini-3.8-flash')));assert.ok(await f.done());
 assert.equal(f.calls.slice(before).filter(c=>c.model==='gemini-3.1-pro-preview').length,1,'completed room peer was redelivered');assert.equal(f.calls.slice(before).filter(c=>c.model==='gemini-3.8-flash').length,1);
 assert.equal((await f.h.json(`/api/bloks/${room.id}/messages`)).messages.filter((m:any)=>m.text==='ONE_ROOM_DELIVERY'&&m.role==='user').length,1,'room source message was duplicated');
});

test('a paused workflow keeps its cursor and source ownership across restart until an admitted ask',async t=>{
 const f=await fixture(t,true);await f.say('POSITIVE_WORKFLOW_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());await f.pause('workflow-pause');const before=f.calls.length;
 const made=await f.request('POST','/api/workflows',{name:'Synthetic process',trigger:{kind:'manual'},steps:[{action:'ask',text:'WORKFLOW_SOURCE_ASK',targetId:f.bot.id}]});assert.equal(made.status,201);
 const id=made.body.workflow.id;const started=await f.request('POST',`/api/workflows/${id}/run`,{});assert.equal(started.status,202);const runId=started.body.run.id;
 const run=async()=>(await f.request('GET','/api/workflows')).body.workflows.find((w:any)=>w.id===id).runs.find((r:any)=>r.id===runId);
 assert.ok(await waitFor(async()=>(await run()).engineHold));assert.equal((await run()).cursor,0);assert.equal((await run()).state,'running');assert.equal(f.calls.length,before);
 assert.equal((await f.messages()).some(m=>m.text==='WORKFLOW_SOURCE_ASK'),false,'workflow stored a phantom delivered ask');
 await f.restart();assert.equal((await run()).state,'running','unstarted workflow was failed by restart reconciliation');assert.ok(await waitFor(async()=>(await run()).engineHold));assert.equal((await run()).cursor,0);assert.equal(f.calls.length,before);
 await f.request('DELETE','/api/engine-pauses/workflow-pause');assert.ok(await waitFor(async()=>(await run()).state==='done'),JSON.stringify({run:await run(),calls:f.calls,logs:f.h.logs()}));assert.equal((await run()).cursor,1);assert.equal((await run()).engineHold,undefined);
 assert.equal(f.calls.slice(before).filter(c=>String(c.messages.at(-1)?.content).includes('WORKFLOW_SOURCE_ASK')).length,1,'workflow source replayed or disappeared');
});

test('a paused job remains unoffered on its existing board across restart and is claimed only at invocation',async t=>{
 const f=await fixture(t,true);await f.say('POSITIVE_JOB_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());await f.request('POST','/api/engine-pauses',{id:'job-pause',agents:'all',selector:{family:'gemini'},until:Date.now()+120000,timeZone:'UTC'});const before=f.calls.length;
 const posted=await f.request('POST','/api/jobs',{title:'JOB_SOURCE_WORK',brief:'Synthetic task for the existing worker.'});assert.equal(posted.status,201);const id=posted.body.job.id;
 const job=async()=>(await f.request('GET','/api/jobs')).body.jobs.find((j:any)=>j.id===id);
 assert.ok(await waitFor(async()=>(await job()).engineHold),JSON.stringify({job:await job(),bot:f.bot,logs:f.h.logs()}));assert.equal((await job()).state,'open');assert.equal((await job()).offers.length,0,'pause consumed a job offer before invocation');assert.equal(f.calls.length,before);
 await f.restart();assert.equal((await job()).state,'open');assert.equal((await job()).offers.length,0);
 await f.request('DELETE','/api/engine-pauses/job-pause');assert.ok(await waitFor(async()=>(await job()).state==='done'),JSON.stringify({job:await job(),logs:f.h.logs(),calls:f.calls}));
 assert.equal((await job()).offers.length,1);assert.equal((await job()).engineHold,undefined);assert.equal(f.calls.slice(before).filter(c=>String(c.messages.at(-1)?.content).includes('JOB_SOURCE_WORK')).length,1);
});

test('a crash immediately after the durable pause commit cannot replay an interrupted turn after expiry',async t=>{
 const f=await fixture(t,true,true);await f.say('CRASH_HOLD_SOURCE');assert.ok(await waitFor(()=>f.calls.length===1));
 const waiting=await f.request('POST',`/api/bots/${f.bot.id}/messages`,{text:'QUEUED_BEHIND_UNCERTAIN_SOURCE',steer:false});assert.equal(waiting.body.queued,true);
 const queued=(await f.messages()).find(m=>m.text==='QUEUED_BEHIND_UNCERTAIN_SOURCE');assert.ok(queued?.queued);
 writeFileSync(f.arm,'armed');const until=Date.now()+1200;
 await assert.rejects(()=>f.pause('crash-restriction',{family:'gemini'},until));
 const saved=JSON.parse(readFileSync(join(f.data,'engine-pauses.json'),'utf8'));assert.ok(saved.invocations.some((r:any)=>r.cancelRequestedAt),'actual commit did not retain cancellation provenance');
 assert.ok(await waitFor(()=>Date.now()>until));const before=f.calls.length;
 await f.restart(()=>rmSync(f.arm,{force:true}));
 assert.ok(await waitFor(async()=>f.calls.length>before||(await f.messages()).some(m=>m.carryOn&&!m.carryOn.done)),'uncertain interrupted work has no existing reconciliation control');
 assert.equal(f.calls.length,before,'expired policy automatically replayed interrupted work');
 const held=(await f.request('GET','/api/engine-pauses')).body;assert.equal(held.pauses.find((p:any)=>p.id==='crash-restriction').state,'expired');assert.ok(held.holds.some((h:any)=>h.agentId===f.bot.id&&h.phase==='interrupted'));
 assert.equal(f.calls.length,before,'expired policy automatically replayed interrupted work');assert.equal((await f.messages()).find(m=>m.id===queued.id)?.queued,true,'uncertain waiting source was consumed');
 const peer=(await f.request('POST','/api/bots',{name:'Synthetic post-restart worker'})).body.bot;
 await f.request('POST',`/api/bots/${peer.id}/messages`,{text:'POSITIVE_NEW_SOURCE_AFTER_RESTART'});assert.ok(await waitFor(()=>f.calls.length>before));
 assert.equal(f.calls.slice(before).some(c=>String(c.messages.at(-1)?.content).includes('CRASH_HOLD_SOURCE')||String(c.messages.at(-1)?.content).includes('QUEUED_BEHIND_UNCERTAIN_SOURCE')),false,'old work leaked into an unrelated permitted invocation');
});

test('a newly received direct message keeps its original source id through preparation pauses and edits',async t=>{
 for(const change of ['pause','edit']){
  const f=await fixture(t);await f.say('POSITIVE_DIRECT_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());
  const asked=join(f.home,'direct-version-asked'),gate=join(f.home,'direct-version-release'),cli=join(f.home,'direct-fake-version.cjs');
  writeFileSync(cli,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version'){fs.writeFileSync(${JSON.stringify(asked)},'');const until=Date.now()+15000;const tick=()=>{if(fs.existsSync(${JSON.stringify(gate)})||Date.now()>until){console.log('2.1.300 (Claude Code)');process.exit(0);}setTimeout(tick,20);};tick();}else if(process.argv[2]==='auth')console.log(JSON.stringify({loggedIn:true}));else process.exit(99);\n`,{mode:0o755});
  const file=join(f.data,'config.json'),config=JSON.parse(readFileSync(file,'utf8'));config.instances.slow={driver:'claudeAgent',config:{cli}};writeFileSync(file,JSON.stringify(config));
  const reload=f.h.fetch('/api/providers/grok/connect',{method:'POST',body:JSON.stringify({key:'SYNTHETIC_UNUSED_KEY',url:'http://127.0.0.1:1'})});assert.ok(await waitFor(()=>existsSync(asked)));
  const before=f.calls.length;let source:any;
  try {
   assert.equal((await f.say('DIRECT_ORIGINAL_UNHEARD')).status,202);assert.ok(await waitFor(()=>JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find((b:any)=>b.id===f.bot.id).busy));
   source=(await f.messages()).find(m=>m.text==='DIRECT_ORIGINAL_UNHEARD');assert.ok(source?.queued,'direct preparation claimed the source was heard before invocation');
   if(change==='pause')await f.pause('direct-preparation');
   assert.equal((await f.request('PATCH',`/api/threads/${f.bot.threadId}/messages/${source.id}`,{text:'DIRECT_CURRENT_EDIT'})).status,200);
  } finally {writeFileSync(gate,'');await reload;}
  if(change==='pause'){
   assert.ok(await f.done());assert.equal(f.calls.length,before);assert.equal((await f.messages()).find(m=>m.id===source.id)?.queued,true,'a direct source was lost during the preparation pause');
   await f.request('DELETE','/api/engine-pauses/direct-preparation');
  }
  assert.ok(await waitFor(()=>f.calls.length>before));assert.ok(await f.done());
  assert.equal(f.calls.slice(before).filter(c=>String(c.messages.at(-1)?.content).includes('DIRECT_CURRENT_EDIT')).length,1,'current direct edit did not dispatch exactly once');
  assert.equal(f.calls.slice(before).some(c=>String(c.messages.at(-1)?.content).includes('DIRECT_ORIGINAL_UNHEARD')),false,'a stale direct preparation reached the provider');
  const stored=(await f.messages()).filter(m=>m.id===source.id);assert.equal(stored.length,1);assert.equal(stored[0].queued,false);
 }
});

test('a room routine remains unconsumed while every member is paused and a manual attempt does not add a replay',async t=>{
 const f=await fixture(t,true);await f.say('POSITIVE_ROOM_ROUTINE_CONTROL');assert.ok(await waitFor(()=>f.calls.length>0));assert.ok(await f.done());
 const peer=(await f.request('POST','/api/bots',{name:'Synthetic scheduled peer'})).body.bot;await f.request('PATCH',`/api/bots/${peer.id}`,{modelSelection:{instanceId:'gemini',model:'gemini-3.1-pro-preview'}});
 const room=(await f.request('POST','/api/bloks',{name:'Synthetic scheduled room',memberIds:[f.bot.id,peer.id]})).body.blok;
 await f.request('POST','/api/engine-pauses',{id:'room-routine-pause',agents:'all',selector:{family:'gemini'},until:Date.now()+120000,timeZone:'UTC'});
 const at=new Date(Date.now()-120000),date=`${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')}`;
 await f.restart(()=>writeFileSync(join(f.data,'routines.json'),JSON.stringify([{id:'room-once',targetId:room.id,targetKind:'room',prompt:'ROOM_ROUTINE_SOURCE',repeat:'once',date,time:`${String(at.getHours()).padStart(2,'0')}:${String(at.getMinutes()).padStart(2,'0')}`,days:[],enabled:true,createdAt:at.getTime()-60000,scheduledAt:at.getTime()-60000}])));
 const routine=async()=>(await f.request('GET','/api/routines')).body.routines.find((r:any)=>r.id==='room-once');
 assert.ok(await waitFor(async()=>(await routine()).runs?.some((run:any)=>run.heldSlot!==undefined)));
 assert.equal((await routine()).enabled,true,'a paused room consumed its once slot');assert.equal((await routine()).lastRunAt,undefined);
 const before=f.calls.length;assert.equal((await f.request('POST','/api/routines/room-once/run',{})).body.pending,true);assert.equal(f.calls.length,before);
 assert.equal((await f.h.json(`/api/bloks/${room.id}/messages`)).messages.some((m:any)=>m.text==='ROOM_ROUTINE_SOURCE'),false,'held room routine was posted before admission');
 await f.request('DELETE','/api/engine-pauses/room-routine-pause');assert.ok(await waitFor(()=>f.calls.length>=before+2));assert.ok(await f.done());
 assert.equal((await routine()).enabled,false);assert.equal((await routine()).runs.filter((run:any)=>run.heldSlot===undefined).length,1,'manual held request added an extra scheduled replay');
 assert.equal((await f.h.json(`/api/bloks/${room.id}/messages`)).messages.filter((m:any)=>m.text==='ROOM_ROUTINE_SOURCE').length,1);
 for(const model of ['gemini-3.8-flash','gemini-3.1-pro-preview'])assert.equal(f.calls.slice(before).filter(call=>call.model===model).length,1);
});
