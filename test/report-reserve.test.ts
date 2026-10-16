import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { reporting, until } from './helpers/report-reserve.ts';

test('eleven general mutations leave one ordinary CLI report and bound every subsequent write',async t=>{
 const f=await reporting(t);await f.use();
 const refused=await f.request('PUT',`/api/bots/${f.sender.id}/memory`,{text:'too far'},f.token);assert.equal(refused.status,429);assert.match(refused.body.error,/One direct message/);
 const cli=await f.command(['say',f.target.id,'FINAL']);assert.equal(cli.code,0,cli.err);assert.equal(JSON.parse(cli.out).ok,true);
 const receipt=await f.accepted();assert.equal(receipt.body.taskId,f.target.threadId);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
 assert.equal((await f.messages(f.sender)).filter(m=>m.agent?.dir==='out'&&m.text==='FINAL').length,1);
 assert.equal((await f.control('token',{token:f.token})).spent,12);
 assert.equal((await f.say({text:'different'})).status,429);
 assert.equal((await f.say({text:'self'},f.sender.id)).status,429);
});

test('earlier says keep general accounting and do not consume final opportunity',async t=>{
 const f=await reporting(t);assert.equal((await f.say({text:'earlier'})).body.ok,true);await f.use(10);
 assert.equal((await f.accepted()).body.queued,true);
 assert.equal((await f.messages()).filter(m=>['earlier','FINAL'].includes(m.text)).length,2);
 assert.equal((await f.control('token',{token:f.token})).spent,12);
});

test('normalization freezes one lane and receipt across ignored fields, later archive and queue take-back',async t=>{
 const f=await reporting(t);await f.use();const first=await f.accepted({text:'FINAL',replyTo:{author:'  Pat ',excerpt:' excerpt ',id:'x'}});
 const retry=await f.say({unused:42,now:false,text:' FINAL\n',taskId:'',replyTo:{excerpt:' excerpt ',author:'  Pat ',id:'x',ignored:'y'}});assert.deepEqual(retry,first);
 for(const changed of [{text:'FINAL',replyTo:{author:'Pat',excerpt:'excerpt',id:'z'}},{text:'FINAL',taskId:f.target.threadId},{text:'FINAL',now:true}])assert.equal((await f.say(changed)).status,429);
 await f.control('patch',{bot:f.target.id,patch:{archivedAt:Date.now(),tasks:f.target.tasks.map((lane:any)=>({...lane,title:'Renamed after admission'}))}});
 assert.deepEqual(await f.say({text:'FINAL',replyTo:{author:'Pat',excerpt:'excerpt',id:'x'}}),first);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
});

test('invalid bodies, missing task, archived target, self, room and NEVER refusals do not burn reserve',async t=>{
 const f=await reporting(t);await f.use();
 assert.equal((await f.say({text:''})).status,400);assert.equal((await f.say({text:'x'.repeat(100001)})).status,413);assert.equal((await f.say({text:'FINAL',taskId:'missing'})).status,404);
 assert.equal((await f.say({text:'FINAL'},'absent')).status,404);
 await f.control('patch',{bot:f.target.id,patch:{archivedAt:Date.now()}});assert.equal((await f.say()).status,409);await f.control('patch',{bot:f.target.id,patch:{archivedAt:null}});
 const room=(await f.request('POST','/api/bloks',{name:'Synthetic room',memberIds:[f.sender.id,f.target.id]})).body.blok;
 assert.equal((await f.request('POST',`/api/bloks/${room.id}/messages`,{text:'no fan-out'},f.token)).status,429);
 assert.equal((await f.say({},f.sender.id)).status,429);
 assert.equal((await f.request('PATCH','/api/config',{profile:{about:'forbidden'}},f.token)).status,403);
 assert.equal((await f.control('token',{token:f.token})).spent,11);
 assert.equal((await f.accepted()).body.ok,true);
});

test('parallel identical and distinct reserved submissions store only one admission',async t=>{
 const f=await reporting(t);await f.use();
 const results=await Promise.all(Array.from({length:12},(_,i)=>f.say({text:i<8?'FINAL':'OTHER'})));
 assert.ok(results.some(x=>x.body.ok||x.body.pending));assert.equal((await f.accepted()).body.ok,true);
 assert.equal((await f.messages()).filter(m=>m.role==='user').length,1);
 assert.equal((await f.control('token',{token:f.token})).spent,12);
});

test('ten-spent general/direct race and delayed body parsing never debit eleventh request twice',async t=>{
 const f=await reporting(t);await f.use(10);
 const delayed=httpRequest(f.url+`/api/bots/${f.target.id}/messages`,{method:'POST',headers:{origin:f.url,authorization:'Bearer '+f.token,'content-type':'application/json','transfer-encoding':'chunked'}});
 const done=new Promise<any>((resolve,reject)=>{delayed.on('response',res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve(JSON.parse(data)))});delayed.on('error',reject)});
 delayed.write('{"text":');await new Promise(r=>setTimeout(r,30));
 assert.equal((await f.request('PUT',`/api/bots/${f.sender.id}/memory`,{text:'cannot become twelfth general'},f.token)).status,429);
 const reserved=await f.say({text:'RESERVED'});assert.ok(reserved.body.ok||reserved.body.pending);
 delayed.end('"ELEVENTH"}');assert.equal((await done).ok,true);
 await until(async()=> (await f.messages()).filter(m=>m.role==='user').length===2);
 assert.equal((await f.control('token',{token:f.token})).spent,12);
});

test('lost actual HTTP output returns retained receipt without readiness, activity or recipient replay',async t=>{
 const f=await reporting(t);await f.use();await f.control('fault',{mode:'output'});
 await assert.rejects(f.say());const recovered=await f.accepted();const calls=f.calls().length;
 assert.deepEqual(await f.say(),recovered);assert.equal(f.calls().length,calls);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
 assert.equal((await f.messages(f.sender)).filter(m=>m.agent?.dir==='out').length,1);
});

for(const phase of ['before-persist','before-persist-status','after-persist','after-queue','sender-activity'])test(`explicit admission provenance: ${phase}`,async t=>{
 const f=await reporting(t);
 if(phase==='after-queue')await f.request('POST',`/api/bots/${f.target.id}/messages`,{text:'BUSY'});
 await f.use();await f.control('fault',{mode:phase});const result=await f.say();
 assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'),false);
 if(phase==='before-persist'||phase==='before-persist-status'){
  assert.equal(result.status,phase==='before-persist'?500:409);assert.equal((await f.control('token',{token:f.token})).report,undefined);
  await f.control('fault',{mode:''});assert.equal((await f.accepted()).body.ok,true);
 }else if(phase==='after-persist'){
  assert.equal(result.body.uncertain,true);assert.deepEqual(await f.say(),result);assert.equal((await f.say({text:'OTHER'})).status,429);
  assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
  assert.equal((await f.messages(f.sender)).find(m=>m.agent?.dir==='out')?.agent.status,'uncertain');
 }else {assert.equal(result.body.ok,true);assert.deepEqual(await f.say(),result);if(phase==='after-queue')assert.equal(result.body.queued,true)}
});

test('pending retries are bounded; renewal retains claim, revocation before dispatch prevents effects',async t=>{
 const f=await reporting(t);await f.use();await f.control('hold');const first=await f.say();assert.equal(first.body.pending,true);
 const again=await Promise.all(Array.from({length:20},()=>f.say()));assert.ok(again.every(x=>x.body.pending));
 const renewed=await f.control('renew',{token:f.token});assert.equal(renewed.identity,(await f.control('token',{token:f.token})).report.identity);
 await f.control('revoke',{task:f.sender.threadId});await f.control('release');
 assert.equal((await f.say()).status,401);assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,0);
 const next=await f.control('mint',{bot:f.sender.id,task:f.sender.threadId});assert.equal(next.spent,0);assert.equal(next.report,undefined);
});

for(const mode of ['drop','stall','success','prewrite'])test(`actual Codex --now boundary: ${mode}`,async t=>{
 const f=await reporting(t);writeFileSync(join(f.home,'steer-mode'),mode);
 await f.request('POST',`/api/bots/${f.target.id}/messages`,{text:'BUSY'});
 await until(()=>f.calls().some(c=>c.method==='turn/start'));
 await f.use();
 const body={text:'FINAL',now:true};let result=await f.say(body);
 if(mode==='success'||mode==='prewrite')result=await f.accepted(body);
 else result=await until(async()=>{const x=await f.say(body);return x.body.uncertain||x.body.ok?x:null});
 if(mode==='drop')await until(async()=>!(await f.control('steering',{task:f.target.threadId})));
 result=await f.say(body);
 assert.deepEqual(await f.say(body),result);
 const words=(await f.messages()).filter(m=>m.text==='FINAL');const steers=f.calls().filter(c=>c.method==='turn/steer');
 if(mode==='prewrite'){assert.equal(result.body.queued,true);assert.equal(steers.length,0);assert.equal(words.length,1)}
 else if(mode==='success'){assert.equal(result.body.steered,true);assert.equal(steers.length,1);assert.equal(words.length,1)}
 else{assert.equal(result.body.uncertain,true);assert.equal(steers.length,1);assert.equal(words.length,0);assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);assert.equal((await f.say({text:'replacement'})).status,429)}
});

test('a drain queues the reserved submission and separate chain refusal leaves reserve free',async t=>{
 const f=await reporting(t);await f.use();await f.control('depth',{task:f.sender.threadId,depth:100});
 assert.equal((await f.say()).status,429);assert.equal((await f.control('token',{token:f.token})).report,undefined);
 await f.control('depth',{task:f.sender.threadId,depth:0});await f.request('POST','/api/maintenance/drain',{seconds:30});
 const final=await f.accepted();assert.equal(final.body.queued,true);
 assert.equal((await f.messages()).find(m=>m.text==='FINAL')?.queued,true);
 assert.equal(f.calls().filter(c=>c.method==='turn/start').length,0);
});

test('held/unavailable recipient, malformed body and cross-origin guards leave final opportunity',async t=>{
 const f=await reporting(t);await f.use();
 await f.request('POST',`/api/bots/${f.target.id}/wheel`,{why:'synthetic hold'});assert.equal((await f.say()).status,409);
 await f.request('DELETE',`/api/bots/${f.target.id}/wheel`);
 const before=await f.control('token',{token:f.token});assert.equal(before.report,undefined);
 await f.control('patch',{bot:f.target.id,patch:{modelSelection:{instanceId:'missing',model:'synthetic'},backupSelection:null}});
 assert.equal((await f.say()).status,409);assert.equal((await f.control('token',{token:f.token})).report,undefined);
 await f.control('patch',{bot:f.target.id,patch:{modelSelection:{instanceId:'codex',model:'gpt-6.1-sol'}}});
 const malformed=await fetch(f.url+`/api/bots/${f.target.id}/messages`,{method:'POST',headers:{origin:f.url,authorization:'Bearer '+f.token,'content-type':'application/json'},body:'{'});assert.equal(malformed.status,500); // existing malformed-JSON status, not admission evidence
 const cross=await fetch(f.url+`/api/bots/${f.target.id}/messages`,{method:'POST',headers:{origin:'https://synthetic.invalid',authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify({text:'FINAL'})});assert.equal(cross.status,403);
 assert.equal((await f.accepted()).body.ok,true);
});

test('late original completion updates only its claim and expiry never exposes cached authority',async t=>{
 const f=await reporting(t);await f.use();await f.control('hold');assert.equal((await f.say()).body.pending,true);
 await f.control('release');const receipt=await f.accepted();assert.deepEqual(await f.say(),receipt);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
 await f.control('expire',{token:f.token});assert.equal((await f.say()).status,401);
});

test('restart revokes cached receipts without replaying recipient messages',async t=>{
 const f=await reporting(t);await f.use();await f.accepted();await f.restart();
 assert.equal((await f.say()).status,401);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
 const next=await f.control('mint',{bot:f.sender.id,task:f.sender.threadId});assert.equal(next.report,undefined);assert.equal(next.spent,0);
});

test('busy chain refusal and later queue take-back preserve the original reserved receipt',async t=>{
 const f=await reporting(t);await f.request('POST',`/api/bots/${f.target.id}/messages`,{text:'BUSY'});await f.use();
 await f.control('depth',{task:f.sender.threadId,depth:100});assert.equal((await f.say()).status,429);
 assert.equal((await f.control('token',{token:f.token})).report,undefined);await f.control('depth',{task:f.sender.threadId,depth:0});
 const receipt=await f.accepted();assert.equal(receipt.body.queued,true);
 // Owner take-back cannot speak as a sender. Use the caller's fresh general
 // credential for the existing take-back route, not its occupied final slot.
 const next=await f.control('mint',{bot:f.sender.id,task:f.sender.threadId});
 const taken=await f.request('POST',`/api/bots/${f.target.id}/take-back`,{},next.token);assert.equal(taken.status,200);
 assert.deepEqual(await f.say(),receipt);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,0);
 const removed=taken.body.takenBack.find((m:any)=>m.text==='FINAL');assert.ok(removed);
 const raw=await f.control('messages',{task:f.target.threadId});const tombstone=raw.find((m:any)=>m.id===removed.id);assert.equal(tombstone.deleted,true);assert.equal(tombstone.text,'');
});


test('a drain transition inside startTurn reports the persisted queue admission',async t=>{
 const f=await reporting(t);await f.use();await f.control('fault',{mode:'drain-transition'});
 const receipt=await f.accepted();assert.equal(receipt.body.queued,true);
 assert.equal((await f.messages()).find(m=>m.text==='FINAL')?.queued,true);
 assert.equal(f.calls().filter(c=>c.method==='turn/start').length,0);
});


test('disconnect and revoke after RPC write cannot replay or publish receipt to a new token',async t=>{
 const f=await reporting(t);await f.request('POST',`/api/bots/${f.target.id}/messages`,{text:'BUSY'});
 await until(()=>f.calls().some(c=>c.method==='turn/start'));await f.use();
 writeFileSync(join(f.home,'steer-mode'),'stall');await f.control('fault',{mode:'uncertain-output'});
 await assert.rejects(f.say({text:'FINAL',now:true}));await until(()=>f.calls().some(c=>c.method==='turn/steer'));
 const original=await f.control('token',{token:f.token});assert.equal(original.report.dispatched,true);
 await f.control('revoke',{task:f.sender.threadId});
 const next=await f.control('mint',{bot:f.sender.id,task:f.sender.threadId});
 writeFileSync(join(f.home,'steer-release'),'');await until(async()=>!(await f.control('steering',{task:f.target.threadId})));
 assert.equal((await f.say({text:'FINAL',now:true})).status,401);
 assert.equal((await f.control('token',{token:next.token})).report,undefined);
 assert.equal((await f.messages()).filter(m=>m.text==='FINAL').length,1);
 assert.equal(f.calls().filter(c=>c.method==='turn/steer').length,1);
 assert.equal(f.calls().filter(c=>c.method==='turn/start').length,1);
});
