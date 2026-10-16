// Actual server-issued turn/check scopes, broker HTTP and explicit fake children.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test,type TestContext } from 'node:test';
import { startHarness } from './helpers/server.ts';
import { waitFor } from './helpers/turns.ts';
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'bloks-helper-origin-')),data=join(home,'.bloks'),projects=join(home,'.claude','projects'),cli=join(home,'explicit-fake.cjs'),calls=join(home,'calls.jsonl');
 mkdirSync(data);mkdirSync(projects,{recursive:true});mkdirSync(join(home,'origins'));
 writeFileSync(cli,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),home=process.env.HOME;
const native=args.includes('--input-format');
const kind=args[0]==='--version'?'version':args[0]==='auth'?'auth':native?'foreground':'helper-model';
fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({kind,pid:process.pid,token:!!process.env.BLOKS_TOKEN,descriptor:!!process.env.BLOKS_ENGINE_HELPER})+'\n');
if(kind==='version'){console.log('2.1.300 (Claude Code)');process.exit(0);}
if(kind==='auth'){console.log(JSON.stringify({loggedIn:true,apiProvider:'firstParty',authMethod:'claude.ai'}));process.exit(0);}
if(native){let buf='',started=false;process.stdin.on('data',chunk=>{buf+=chunk;while(buf.includes('\n')){const at=buf.indexOf('\n'),line=buf.slice(0,at);buf=buf.slice(at+1);if(!line)continue;const f=JSON.parse(line);if(f.type!=='user'||started)continue;started=true;const label=f.message.content.match(/ORIGIN ([A-Za-z0-9-]+)/)?.[1];if(label)fs.writeFileSync(path.join(home,'origins',label+'.json'),JSON.stringify({descriptor:process.env.BLOKS_ENGINE_HELPER||'',token:process.env.BLOKS_TOKEN||''}));console.log(JSON.stringify({type:'system',subtype:'init',session_id:'native-'+process.pid,model:'claude-sonnet-5'}));setInterval(()=>{},1000);}});return;}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const index=Math.max(args.indexOf('--session-id'),args.indexOf('--resume')),session=args[index+1],model='claude-fable-5';
 const folder=path.join(home,'.claude','projects','fake-project');fs.mkdirSync(folder,{recursive:true});
 fs.appendFileSync(path.join(folder,session+'.jsonl'),JSON.stringify({type:'assistant',sessionId:session,message:{role:'assistant',content:[{type:'text',text:'Synthetic review.'}]}})+'\n');
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model,apiKeySource:'none'}));
 console.log(JSON.stringify({type:'assistant',session_id:session,message:{model,content:[{type:'text',text:'Synthetic review.'}]}}));
 console.log(JSON.stringify({type:'result',session_id:session,subtype:'success',is_error:false,result:'Synthetic review.',modelUsage:{[model]:{inputTokens:1,outputTokens:1}}}));
});
`,{mode:0o700});
 writeFileSync(join(data,'config.json'),JSON.stringify({instances:{claude:{driver:'claudeAgent',config:{cli}}},agentDefaults:{modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}},secrets:{PLANTED_SECRET:'SYNTHETIC_NEVER_IN_STATUS'}}));
 const env={HOME:home,USERPROFILE:home,BLOKS_TOKEN:'SYNTHETIC_BROAD_TOKEN_MUST_NOT_REACH_CHECKS'};let h=await startHarness(env);
 t.after(async()=>{await h.stop();rmSync(home,{recursive:true,force:true});});
 const request=async(method:string,path:string,body?:unknown,authorization?:string)=>{const response=await h.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)}),...(authorization?{headers:{authorization}}:{})});return {status:response.status,body:await response.json()};};
 const {bot}=await h.json('/api/bots',{method:'POST',body:JSON.stringify({name:'Synthetic reviewer'})});
 await request('PATCH',`/api/bots/${bot.id}`,{approvals:'full',cwd:home});
 const start=async(label:string)=>{await request('POST',`/api/bots/${bot.id}/messages`,{text:'ORIGIN '+label});assert.ok(await waitFor(()=>existsSync(join(home,'origins',label+'.json'))));return JSON.parse(readFileSync(join(home,'origins',label+'.json'),'utf8'));};
 const log=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];
 const readEvents=async(descriptor:any,id:string)=>{const response=await h.fetch(`/api/engine-helper-runs/${id}/events`,{headers:{authorization:'EngineHelper '+descriptor.capability,origin:descriptor.origin}});assert.equal(response.status,200);return (await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));};
 const phase=async(descriptor:any,body:any)=>{const response=await h.fetch('/api/engine-helper-runs',{method:'POST',body:JSON.stringify(body),headers:{authorization:'EngineHelper '+descriptor.capability,origin:descriptor.origin}});return {status:response.status,body:await response.json()};};
 const review=()=>({version:1,operationId:randomUUID(),profile:'claude.review',reviewId:randomUUID(),sessionId:randomUUID(),resume:false,additionalDirectories:[],phase:'auth'});
 return {home,data,cli,bot,get h(){return h;},request,start,log,phase,readEvents,review,async restart(edit?:()=>void){await h.stop();edit?.();h=await startHarness(env);}};
}

test('a trusted native descriptor completes one auth/model operation after its parent ends without workspace authority',async t=>{
 const f=await fixture(t),origin=await f.start('allowed');assert.ok(origin.descriptor);const descriptor=JSON.parse(origin.descriptor),auth=f.review();
 const before=f.log().filter(call=>call.kind==='auth').length;
 assert.equal((await f.phase(descriptor,{...f.review(),additionalDirectories:[tmpdir()]})).body.state,'pending','native descriptor widened its authorized roots');
 assert.equal((await f.phase(descriptor,{...f.review(),origin:{fullAccess:true,agentId:'forged'}})).status,400);
 assert.equal(f.log().filter(call=>call.kind==='auth').length,before,'invalid scope reached auth');
 assert.equal((await f.phase(descriptor,auth)).body.state,'accepted');const events=await f.readEvents(descriptor,auth.operationId);assert.equal(events.at(-1).state,'completed');assert.equal(events.at(-1).outputComplete,true);
 await f.request('POST',`/api/bots/${f.bot.id}/interrupt`,{});assert.ok(await waitFor(()=>!JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find((b:any)=>b.id===f.bot.id).busy));
 const model={...auth,operationId:randomUUID(),phase:'model',authRunId:auth.operationId,prompt:'A synthetic bounded review.'};assert.equal((await f.phase(descriptor,model)).body.state,'accepted');
 const result=await f.readEvents(descriptor,model.operationId);assert.equal(result.at(-1).outputComplete,true);assert.equal(result.at(-1).cancelRequested,false);assert.equal(result.at(-1).remote,'unconfirmed');
 const children=f.log().filter(call=>call.kind==='helper-model');assert.equal(children.length,1);assert.equal(children[0].token,false,'broad parent credential reached the helper child');assert.equal(children[0].descriptor,false,'parent helper capability reached the helper child');
 assert.equal((await f.phase(descriptor,model)).body.state,'existing');assert.equal(f.log().filter(call=>call.kind==='helper-model').length,1);
 assert.equal((await f.phase(descriptor,{...model,operationId:randomUUID()})).status,409,'one successful auth authorized a second distinct model operation');
 assert.equal((await f.request('PATCH','/api/config',{profile:{about:'Positive synthetic owner setting'}})).status,200);
 const forbidden=await f.request('PATCH','/api/config',{profile:{about:'FORBIDDEN_HELPER_SETTING'}},'EngineHelper '+descriptor.capability);
 assert.ok([401,403].includes(forbidden.status),'helper credential fell through as local owner');
 assert.equal(JSON.parse(readFileSync(join(f.data,'config.json'),'utf8')).profile.about,'Positive synthetic owner setting','helper credential changed an owner setting');
 const status=await f.request('GET','/api/engine-pauses');assert.ok(status.body.helpers.operations.some((op:any)=>op.id===model.operationId&&op.remote==='unconfirmed'));assert.equal(JSON.stringify(status.body).includes('SYNTHETIC_NEVER_IN_STATUS'),false);
});

test('native pause, permission or selected config changes between helper phases prevent the actual model spawn',async t=>{
 for(const change of ['pause','unknown-family','permission','config']){
  const f=await fixture(t),origin=await f.start(change),descriptor=JSON.parse(origin.descriptor),auth=f.review();assert.equal((await f.phase(descriptor,auth)).body.state,'accepted');assert.equal((await f.readEvents(descriptor,auth.operationId)).at(-1).state,'completed');
  if(change==='pause')await f.request('POST','/api/engine-pauses',{id:'between-phases',agents:[f.bot.id],selector:{model:'claude-opus-5'},until:Date.now()+60000,timeZone:'UTC'});
  else if(change==='unknown-family')await f.request('POST','/api/engine-pauses',{id:'unknown-family-between-phases',agents:[f.bot.id],selector:{family:'gemini'},until:Date.now()+60000,timeZone:'UTC'});
  else if(change==='permission')await f.request('PATCH',`/api/bots/${f.bot.id}`,{approvals:'ask'});
  else {const next=join(f.home,'replacement-explicit-fake.cjs');copyFileSync(f.cli,next);const file=join(f.data,'config.json'),config=JSON.parse(readFileSync(file,'utf8'));config.instances.claude.config.cli=next;writeFileSync(file,JSON.stringify(config));const changed=await f.request('POST','/api/providers/grok/connect',{key:'SYNTHETIC_UNUSED_KEY',url:'http://127.0.0.1:1'});assert.equal(changed.status,200);}
  const before=f.log().filter(call=>call.kind==='helper-model').length;const denied=await f.phase(descriptor,{...auth,operationId:randomUUID(),phase:'model',authRunId:auth.operationId,prompt:'Must remain pending.'});assert.equal(denied.body.state,'pending','changed native authorization permitted a model launch');assert.equal(f.log().filter(call=>call.kind==='helper-model').length,before,'denied helper reached a native model invocation');
 }
});

test('a saved full-access agent in a constrained shared lane receives no full-access helper descriptor',async t=>{
 const f=await fixture(t);const positive=await f.start('private');assert.ok(positive.descriptor);await f.request('POST',`/api/bots/${f.bot.id}/interrupt`,{});
 const peer=(await f.request('POST','/api/bots',{name:'Synthetic peer'})).body.bot;
 const made=await f.request('POST','/api/bloks',{name:'Synthetic shared room',memberIds:[f.bot.id,peer.id]});assert.equal(made.status,201);const room=made.body.blok;
 await f.restart(()=>{const file=join(f.data,'bloks.json'),rooms=JSON.parse(readFileSync(file,'utf8'));rooms.find((r:any)=>r.id===room.id).sharing={since:Date.now(),history:'all',tools:'conversation'};writeFileSync(file,JSON.stringify(rooms));});
 assert.equal((await f.request('POST',`/api/bloks/${room.id}/messages`,{text:'@Synthetic reviewer ORIGIN constrained'})).status,201);assert.ok(await waitFor(()=>existsSync(join(f.home,'origins','constrained.json'))));
 const origin=JSON.parse(readFileSync(join(f.home,'origins','constrained.json'),'utf8'));assert.equal(origin.descriptor,'','shared-lane permissions were widened by the saved full-access preference');assert.equal(f.log().filter(call=>call.kind==='helper-model').length,0);
});

test('a watcher check receives only a narrow native descriptor and a pause blocks it before fake auth',async t=>{
 const f=await fixture(t),check=join(f.home,'explicit-check.cjs'),audit=join(f.home,'check-audit.json');
 writeFileSync(check,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{const descriptor=JSON.parse(process.env.BLOKS_ENGINE_HELPER||'null');if(!descriptor)throw new Error('Missing native check scope.');
 const body={version:1,operationId:crypto.randomUUID(),profile:'claude.review',reviewId:crypto.randomUUID(),sessionId:crypto.randomUUID(),resume:false,additionalDirectories:[],phase:'auth'};
 const headers={authorization:'EngineHelper '+descriptor.capability,'content-type':'application/json'};
 const accepted=await (await fetch(descriptor.origin+'/api/engine-helper-runs',{method:'POST',headers,body:JSON.stringify(body)})).json();
 if(accepted.state!=='accepted')throw new Error('Auth was not admitted.');
 const output=await (await fetch(descriptor.origin+'/api/engine-helper-runs/'+body.operationId+'/events',{headers})).text();
 const events=output.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 fs.writeFileSync(path.join(process.env.HOME,'check-audit.json'),JSON.stringify({keys:Object.keys(process.env).filter(key=>key.startsWith('BLOKS_')).sort(),broad:!!process.env.BLOKS_TOKEN,state:events.at(-1).state}));
 console.log('Synthetic constant check result.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`,{mode:0o700});
 const made=await f.request('POST','/api/watchers',{botId:f.bot.id,kind:'check',target:JSON.stringify(process.execPath)+' '+JSON.stringify(check),instruction:'Synthetic watcher instruction.'});assert.equal(made.status,201);const id=made.body.watcher.id;
 await f.request('POST',`/api/watchers/${id}/check`,{});assert.ok(await waitFor(()=>existsSync(audit)),'actual check did not reach the native auth broker');
 assert.ok(await waitFor(()=>JSON.parse(readFileSync(join(f.data,'watchers.json'),'utf8')).find((w:any)=>w.id===id)?.seen!==undefined),'the positive watcher check did not finish committing its baseline');
 const seen=JSON.parse(readFileSync(audit,'utf8'));assert.equal(seen.broad,false,'broad workspace token reached the check shell');assert.deepEqual(seen.keys,['BLOKS_ENGINE_HELPER']);assert.equal(seen.state,'completed');
 const before=f.log().filter(call=>call.kind==='auth').length;rmSync(audit);
 await f.request('POST','/api/engine-pauses',{id:'before-check',agents:[f.bot.id],selector:{family:'claude'},until:Date.now()+60000,timeZone:'UTC'});
 const held=await f.request('POST',`/api/watchers/${id}/check`,{});assert.equal(held.body.fired,false);assert.match(held.body.note,/paused/);assert.equal(existsSync(audit),false);assert.equal(f.log().filter(call=>call.kind==='auth').length,before,'paused check reached fake auth');
});
