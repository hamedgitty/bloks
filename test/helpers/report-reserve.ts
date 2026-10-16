// Actual server/router/store with test-only IPC fault injection and explicit Codex.
// No test control endpoint or production test switch is added.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
const server= fileURLToPath(new URL('../../server/index.ts',import.meta.url));
const cli=fileURLToPath(new URL('../../bin/bloks.mjs',import.meta.url));
export async function until<T>(read:()=>T|Promise<T>,why='fixture did not settle'):Promise<NonNullable<T>> {
 const end=Date.now()+10000;
 while(Date.now()<end){const x=await read();if(x)return x as NonNullable<T>;await new Promise(r=>setTimeout(r,10));}
 throw new Error(why);
}
export async function reporting(t:TestContext){
 const home=mkdtempSync(join(tmpdir(),'rr-')),host=join(dirname(server),'.report-test-'+randomUUID()+'.ts');
 mkdirSync(join(home,'.bloks'));
 const fake=join(home,'explicit-fake.cjs');
 writeFileSync(fake,`#!${process.execPath}\n`+String.raw`
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline');
const home=process.env.HOME,log=x=>fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({...x,pid:process.pid})+'\n');
if(process.argv[2]==='--version'){log({method:'version'});console.log('codex-cli 0.160.0');process.exit(0)}
if(process.argv[2]==='login'){log({method:'fake-login-status'});console.log('Logged in using ChatGPT');process.exit(0)}
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');let thread,turn;
process.stdin.on('end',()=>process.exit(0));
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method)return;const reply=result=>out({id:m.id,result:result||{}});
 log({method:m.method,text:m.params?.input?.filter(x=>x.type==='text').map(x=>x.text).join('')});
 if(m.method==='initialize')return reply();if(m.method==='initialized')return;
 if(m.method==='model/list')return reply({data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'Synthetic',isDefault:true}]});
 if(m.method==='account/read')return reply({account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'plus'}});
 if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId||'thread-'+process.pid;return reply({thread:{id:thread},model:'gpt-6.1-sol'})}
 if(m.method==='turn/start'){turn='turn-'+process.pid;reply({turn:{id:turn}});out({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});if(fs.existsSync(path.join(home,'steer-mode'))&&fs.readFileSync(path.join(home,'steer-mode'),'utf8')==='prewrite')out({method:'item/started',params:{threadId:thread,turnId:turn,item:{type:'contextCompaction',id:'synthetic-compaction'}}});return}
 if(m.method==='turn/steer'){
  const mode=fs.existsSync(path.join(home,'steer-mode'))?fs.readFileSync(path.join(home,'steer-mode'),'utf8'):'';
  if(mode==='drop')return process.exit(0);
  if(mode==='stall'){const timer=setInterval(()=>{if(fs.existsSync(path.join(home,'steer-release'))){clearInterval(timer);reply()}},10);return;}
  return reply();
 }
 if(m.method==='turn/interrupt'){reply();out({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'interrupted'}}});return}
 return reply();
});
`,{mode:0o700});
 writeFileSync(join(home,'.bloks/config.json'),JSON.stringify({instances:{codex:{driver:'codex',config:{cli:fake}}},agentDefaults:{modelSelection:{instanceId:'codex',model:'gpt-6.1-sol'}},recall:{beforeTurn:false}}));
 const controls=String.raw`
let reportFault='',reportGate:undefined|(()=>void),reportWait:Promise<void>|undefined;
const originalAppend=store.appendMessage.bind(store);
store.appendMessage=((thread:string,input:any)=>{
 const target=input.text==='FINAL'&&input.role==='user';
 const result=originalAppend(thread,input);
 if(target&&reportFault==='after-persist')throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT');
 if(input.agent?.dir==='out'&&reportFault==='sender-activity')throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT');
 return result;
}) as typeof store.appendMessage;
const originalQueueSet=steerQueues.set.bind(steerQueues);
steerQueues.set=((...args:Parameters<typeof originalQueueSet>)=>{const result=originalQueueSet(...args);if(reportFault==='after-queue'){reportFault='';throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')}return result}) as typeof steerQueues.set;
const originalJson=json;
json=((res:any,status:number,body:any)=>{if((reportFault==='output'&&body?.ok&&body?.taskId)||(reportFault==='uncertain-output'&&(body?.uncertain||body?.pending))){reportFault='';res.destroy();return}return originalJson(res,status,body)}) as typeof json;
process.on('message',(m:any)=>{
 let value:any;
 try{
  if(m.op==='mint')value=agentTokens.mint(m.bot,m.task,Date.now());
  if(m.op==='token'){const token=agentTokens.identify(m.token,Date.now());value=token?{spent:token.spent,report:token.report}:null}
  if(m.op==='steering')value=steerAttempts.has(m.task);
  if(m.op==='messages')value=store.messagesFor(m.task);
  if(m.op==='revoke')agentTokens.revokeTask(m.task);
  if(m.op==='expire'){const held=agentTokens.identify(m.token,Date.now());if(held)held.expiresAt=0}
  if(m.op==='renew'){const held=agentTokens.identify(m.token,Date.now()+7200000,()=>true);value=held?.report}
  if(m.op==='depth')agentChain.set(m.task,m.depth);
  if(m.op==='patch')value=store.patchBot(m.bot,m.patch);
  if(m.op==='fault')reportFault=m.mode;
  if(m.op==='hold'){reportWait=new Promise(done=>reportGate=done)}
  if(m.op==='release'){reportGate?.();reportWait=undefined}
  process.send?.({id:m.id,value});
 }catch{process.send?.({id:m.id,error:'fixture control failed'})}
});
`;
 let source=readFileSync(server,'utf8');
 const marker='  if (!blok && !opts.presetMessage) {';
 assert.ok(source.includes(marker));
 source=source.replace(marker,marker+"\n    if (opts.admission && reportWait) await reportWait;\n    if (opts.admission && reportFault === 'before-persist') throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT');");
 source=source.replace('  if (drain.on && !opts.carriedOn', "  if (opts.admission && reportFault === 'drain-transition') drain.start(30000);\n  if (drain.on && !opts.carriedOn");
 writeFileSync(host,source+'\n'+controls);
 const port=20000+Math.floor(Math.random()*20000),url='http://127.0.0.1:'+port;
 const spawnHost=()=>spawn(process.execPath,[host],{env:{HOME:home,USERPROFILE:home,PATH:'/nonexistent',BLOKS_PORT:String(port),BLOKS_TEST_PARENT_PID:String(process.pid),BLOKS_RETRY_WAIT_MS:'60000',BLOKS_STATIC_DIR:''},stdio:['ignore','pipe','pipe','ipc']});
 let child=spawnHost();let logs='';
 const watch=()=>{child.stdout?.on('data',x=>logs+=x);child.stderr?.on('data',x=>logs+=x);child.on('message',(x:any)=>{pending.get(x.id)?.(x);pending.delete(x.id)})};
 const pending=new Map<string,(x:any)=>void>();watch();
 const control=(op:string,args:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=randomUUID();pending.set(id,x=>x.error?reject(new Error(x.error)):resolve(x.value));child.send({id,op,...args})});
 const request=async(method:string,path:string,body?:unknown,token?:string)=>{
  const res=await fetch(url+path,{method,headers:{origin:url,'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};
 };
 t.after(async()=>{
  child.kill('SIGTERM');
  await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,1500))]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r))}
  const callFile=join(home,'calls.jsonl');
  const pids=()=>existsSync(callFile)?[...new Set<number>(readFileSync(callFile,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x).pid))]:[];
  const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
  // Stop only an exact fixture executable, never a reused unrelated PID.
  for(const pid of pids().filter(alive)){
   try{if(readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').includes(fake))process.kill(pid,'SIGTERM')}catch{/* absent, or non-Linux: observe below */}
  }
  await until(()=>pids().every(pid=>!alive(pid)),'recorded fake child remained after isolated host teardown');
  t.diagnostic('All '+pids().length+' recorded explicit fake child PIDs absent after teardown.');
  rmSync(host,{force:true});rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:20});
 });
 await until(async()=>{if(child.exitCode!==null)throw new Error(logs.slice(-1200));try{return (await fetch(url+'/api/health')).ok}catch{return false}},'isolated HTTP host did not start').catch(error=>{throw new Error(error.message+' '+logs.slice(-2500))});
 const sender=(await request('POST','/api/bots',{name:'Synthetic sender'})).body.bot;
 const target=(await request('POST','/api/bots',{name:'Synthetic recipient'})).body.bot;
 await control('patch',{bot:target.id,patch:{hiredBy:sender.id}});
 const minted=await control('mint',{bot:sender.id,task:sender.threadId});
 const token=minted.token as string;
 const say=(body:Record<string,unknown>={text:'FINAL'},to=target.id)=>request('POST',`/api/bots/${to}/messages`,body,token);
 const use=async(n=11)=>{for(let i=0;i<n;i++)assert.equal((await request('PUT',`/api/bots/${sender.id}/memory`,{text:'Synthetic '+i},token)).status,200)};
 const messages=async(bot=target)=> (await request('GET',`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=200`)).body.messages as any[];
 const calls=()=>existsSync(join(home,'calls.jsonl'))?readFileSync(join(home,'calls.jsonl'),'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 const accepted=async(body:Record<string,unknown>={text:'FINAL'})=>until(async()=>{const x=await say(body);return x.body.ok?x:null},'same submission never reached an accepted receipt');
 const command=(args:string[])=>new Promise<{code:number|null;out:string;err:string}>(resolve=>{const p=spawn(process.execPath,[cli,...args],{env:{HOME:home,PATH:'/nonexistent',BLOKS_URL:url,BLOKS_TOKEN:token},stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('exit',code=>resolve({code,out,err}))});
 const restart=async()=>{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));child=spawnHost();watch();await until(async()=>{try{return (await fetch(url+'/api/health')).ok}catch{return false}})};
 return {home,url,token,sender,target,control,request,say,use,messages,calls,accepted,command,restart,logs:()=>logs};
}
