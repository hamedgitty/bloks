// Real isolated server, actual fake driver children and the public CLI.
import assert from "node:assert/strict";
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync } from "node:fs";
import { createHash,randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test,type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";
const CLI=fileURLToPath(new URL('../bin/bloks.mjs',import.meta.url));
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function fixture(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'bloks-pause-api-')),data=join(home,'.bloks'),cli=join(home,'fake-claude.cjs'),calls=join(home,'starts.jsonl');mkdirSync(data);mkdirSync(join(home,'credentials'));
 const memberToken='synthetic-member-'+randomUUID(),ownerToken='synthetic-owner-'+randomUUID();
 writeFileSync(cli,`#!${process.execPath}\n`+`
const fs=require('node:fs'),args=process.argv.slice(2),home=${JSON.stringify(home)},calls=${JSON.stringify(calls)};
fs.appendFileSync(calls,JSON.stringify({args,pid:process.pid})+'\\n');
if(args[0]==='--version'){console.log('9.9.9 (Claude Code)');process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
if(args[0]==='--independent'){console.log('Independent fake owner invocation.');process.exit(0);}
if(args[args.indexOf('--output-format')+1]==='text'){process.stdin.resume();process.stdin.on('end',()=>console.log('Synthetic summary.'));return;}
let buf='',started=false;process.stdin.on('data',c=>{buf+=c;while(buf.includes('\\n')){const at=buf.indexOf('\\n'),line=buf.slice(0,at);buf=buf.slice(at+1);if(!line)continue;const f=JSON.parse(line);if(f.type!=='user'||started)continue;started=true;const label=f.message.content.match(/FIXTURE ([a-zA-Z0-9-]+)/)?.[1];if(label)fs.writeFileSync(home+'/credentials/'+label+'.json',JSON.stringify({token:process.env.BLOKS_TOKEN,pid:process.pid}));console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fake-'+process.pid,model:'claude-sonnet-5'}));setInterval(()=>{},1000);}});
`,{mode:0o700});
 const configured={instances:{claude:{driver:'claudeAgent',config:{cli}}},agentDefaults:{modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}},remote:{enabled:false,devices:[{id:'owner-device',name:'Owner fixture',hash:hash(ownerToken),pairedAt:1}],memberDevices:[{id:'member-device',personId:'member',name:'Member fixture',hash:hash(memberToken),pairedAt:1}]},secrets:{PLANTED_PRIVATE_KEY:'SYNTHETIC_PRIVATE_VALUE'}};
 writeFileSync(join(data,'people.json'),JSON.stringify({people:[{id:'member',name:'Synthetic member',createdAt:1}],memberships:[],invites:[],knocks:[]}));
 writeFileSync(join(data,'config.json'),JSON.stringify(configured));let h=await startHarness({HOME:home,USERPROFILE:home,BLOKS_LOOPBACK_ONLY:'1'});
 t.after(async()=>{await h.stop();rmSync(home,{recursive:true,force:true});});
 const request=async(method:string,path:string,body?:unknown,token?:string)=>{const res=await h.fetch(path,{method,headers:token?{authorization:'Bearer '+token}:{},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};};
 const make=async(name:string)=>{const {bot}=await h.json('/api/bots',{method:'POST',body:JSON.stringify({name})});await h.json(`/api/bots/${bot.id}`,{method:'PATCH',body:JSON.stringify({modelSelection:{instanceId:'claude',model:'claude-sonnet-5'}})});return bot;};
 const start=async(bot:any,label:string)=>{await h.json(`/api/bots/${bot.id}/messages`,{method:'POST',body:JSON.stringify({text:'FIXTURE '+label})});assert.ok(await waitFor(()=>existsSync(join(home,'credentials',label+'.json'))));return JSON.parse(readFileSync(join(home,'credentials',label+'.json'),'utf8'));};
 const count=()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').length:0;
 const command=(args:string[],token:string)=>new Promise<{code:number|null;body:any}>(resolve=>{const child=spawn(process.execPath,[CLI,...args],{env:{HOME:home,PATH:'/nonexistent',BLOKS_URL:h.url,BLOKS_TOKEN:token},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);child.on('close',code=>resolve({code,body:JSON.parse(out)}));});
 return {home,data,cli,configured,get h(){return h;},request,make,start,count,command,memberToken,ownerToken,async reboot(){await h.stop();h=await startHarness({HOME:home,USERPROFILE:home,BLOKS_LOOPBACK_ONLY:'1'});}};
}
const restriction=(id:string,agents:'all'|string[]='all')=>({id,agents,selector:{family:'claude'},until:Date.now()+120_000,timeZone:'UTC'});

test('owner pause receipt is durable and idempotent, overlaps survive cancellation and status has no probes',async t=>{
 const f=await fixture(t),body=restriction('owner-operation');
 assert.ok(await waitFor(async()=>{const status=await f.request('GET','/api/engine-pauses');return status.body.invocations.length===0?true:null;}));
 const baseline=f.count();
 const created=await f.request('POST','/api/engine-pauses',body);assert.equal(created.status,200);assert.equal(created.body.pauses[0].state,'active');assert.equal(created.body.coverage.state,'incomplete');assert.ok(created.body.coverage.boundaries[0].paths.includes('foreground'));
 const replay=await f.request('POST','/api/engine-pauses',body);assert.equal(replay.status,200);assert.equal(replay.body.pauses.length,1);
 assert.equal((await f.request('POST','/api/engine-pauses',{...body,until:body.until+1})).status,409);
 await f.request('POST','/api/engine-pauses',{...body,id:'overlap'});
 await f.request('DELETE','/api/engine-pauses/owner-operation');
 assert.equal((await f.request('POST','/api/engine-pauses',body)).body.pauses.find((p:any)=>p.id===body.id).state,'cancelled');
 for(let i=0;i<3;i++){const status=await f.request('GET','/api/engine-pauses');assert.equal(status.status,200);assert.doesNotMatch(JSON.stringify(status.body),/SYNTHETIC_PRIVATE_VALUE|PLANTED_PRIVATE_KEY/);}
 assert.equal(f.count(),baseline,'status or pause invoked a readiness/model provider');
 await f.reboot();assert.equal(f.count(),baseline,'restart probed a paused driver');
 const status=await f.request('GET','/api/engine-pauses');assert.equal(status.body.pauses.find((p:any)=>p.id==='overlap').state,'active');
 const config=JSON.parse(readFileSync(join(f.data,'config.json'),'utf8'));assert.deepEqual(config.agentDefaults.modelSelection,f.configured.agentDefaults.modelSelection);assert.equal(config.instances.claude.config.cli,f.cli);
 const malformed=await f.h.fetch('/api/engine-pauses',{method:'POST',body:'SYNTHETIC_PRIVATE_VALUE'});assert.equal(malformed.status,400);assert.doesNotMatch(await malformed.text(),/SYNTHETIC_PRIVATE_VALUE/);
});

test('delegated pause cancels only matched cross-rank work, binds creator and preserves unrelated authority',async t=>{
 const f=await fixture(t),a=await f.make('Coordinator'),b=await f.make('Other worker'),c=await f.make('Unrelated worker');
 const ca=await f.start(a,'a'),cb=await f.start(b,'b'),cc=await f.start(c,'c');
 assert.equal((await f.request('POST',`/api/bots/${b.id}/interrupt`,{},ca.token)).status,403);
 assert.equal((await f.request('PATCH',`/api/bots/${b.id}`,{modelSelection:{instanceId:'other',model:'other'}},ca.token)).status,403);
 const body=restriction('delegated',[b.id]);const created=await f.request('POST','/api/engine-pauses',{...body,creator:{kind:'owner'},workspaceId:'forged'},ca.token);
 assert.equal(created.status,200);assert.deepEqual(created.body.pauses.find((p:any)=>p.id===body.id).creator,{kind:'agent',id:a.id});
 assert.ok(await waitFor(async()=>{const status=(await f.request('GET','/api/engine-pauses')).body;return status.invocations.some((r:any)=>r.origin.agentId===b.id&&r.state==='residual')?true:null;}));
 const state=(await f.request('GET','/api/engine-pauses',undefined,ca.token)).body;
 assert.ok(state.holds.some((hold:any)=>hold.agentId===b.id&&hold.phase==='interrupted'),'interrupted work lost its source-owned hold');
 assert.ok(state.invocations.some((r:any)=>r.origin.agentId===a.id&&r.state==='running'));
 assert.ok(state.invocations.some((r:any)=>r.origin.agentId===c.id&&r.state==='running'));
 assert.equal((await f.request('DELETE','/api/engine-pauses/delegated',undefined,cc.token)).status,403);
 assert.equal((await f.request('POST','/api/engine-pauses',body,ca.token)).status,200);
 assert.equal((await f.request('POST','/api/engine-pauses',{...body,until:body.until+1},ca.token)).status,409);
 assert.equal((await f.request('GET','/api/config',undefined,ca.token)).status,403);
 assert.equal((await f.request('GET',`/api/bots/${a.id}/secrets`,undefined,ca.token)).status,403);
 const messages=(await f.h.json(`/api/bots/${b.id}/messages`)).messages;
 assert.equal(messages.some((m:any)=>m.kind==='notice'&&/failed|could not|try again/i.test(m.text??'')),false,'policy cancellation was presented as a provider failure');
 assert.equal((await f.request('GET','/api/engine-pauses',undefined,cb.token)).status,401,'stopped token became local owner');
 await f.request('DELETE','/api/engine-pauses/delegated');
 const self=restriction('self-cancel',[a.id]);await f.request('POST','/api/engine-pauses',self,ca.token).catch(()=>null);
 assert.ok(await waitFor(async()=>{const status=(await f.request('GET','/api/engine-pauses')).body;return status.pauses.find((p:any)=>p.id==='self-cancel')?.state==='active'?true:null;}));
 const count=f.count();const readback=await f.request('GET','/api/engine-pauses');assert.equal(readback.body.pauses.filter((p:any)=>p.id==='self-cancel').length,1);assert.equal(f.count(),count,'receipt loss replayed a provider invocation');
});

test('member and expired identities never borrow owner pause authority, independent owner use stays outside the gate',async t=>{
 const f=await fixture(t),body=restriction('member-denied');
 for(const method of ['GET','POST','DELETE']){
  const path=method==='DELETE'?'/api/engine-pauses/some-id':'/api/engine-pauses';
  const local=await f.request(method,path,method==='POST'?body:undefined,f.memberToken);assert.equal(local.status,403);
  const remote=await f.h.fetchRemote(path,{method,token:f.memberToken,...(method==='POST'?{body:JSON.stringify(body)}:{})});assert.ok(remote.status===403||remote.status===404,JSON.stringify({status:remote.status,body:remote.body}));
 }
 assert.equal((await f.request('POST','/api/engine-pauses',body,'expired-synthetic-token')).status,401);
 assert.equal((await f.request('POST','/api/engine-pauses',restriction('owner-paired'),f.ownerToken)).status,200);
 const independent=await new Promise<{code:number|null;text:string}>(resolve=>{const child=spawn(f.cli,['--independent'],{env:{HOME:f.home,PATH:'/nonexistent'},stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',c=>text+=c);child.on('close',code=>resolve({code,text}));});
 assert.equal(independent.code,0);assert.match(independent.text,/Independent fake owner/);
});

test('public pause CLI uses exact request id/deadline, reads status and cancels only its own record',async t=>{
 const f=await fixture(t),bot=await f.make('Coordinator'),auth=await f.start(bot,'cli');
 const until=new Date(Date.now()+120_000).toISOString();
 const created=await f.command(['engine-pause','--family','claude','--agents','different-worker','--until',until,'--timezone','UTC','--id','cli-operation'],auth.token);
 assert.equal(created.code,0,JSON.stringify(created.body));assert.equal(created.body.pauses[0].id,'cli-operation');assert.equal(created.body.pauses[0].until,Date.parse(until));
 assert.deepEqual(created.body.pauses[0].creator,{kind:'agent',id:bot.id});
 const status=await f.command(['engine-pauses'],auth.token);assert.equal(status.code,0);assert.equal(status.body.coverage.state,'incomplete');
 const cancelled=await f.command(['engine-unpause','cli-operation'],auth.token);assert.equal(cancelled.code,0);assert.equal(cancelled.body.pauses[0].state,'cancelled');
 for(const args of [['engine-pause','--until','tomorrow'],['engine-pause','--family','claude','unexpected'],['engine-pause','--unknown','x']])assert.equal((await f.command(args,auth.token)).code,1);
});
