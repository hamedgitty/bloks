// Actual production fetch boundaries with a loopback fake provider only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { openAiCompatDriver } from "../server/drivers/openai-compat.ts";
import { EnginePauses, EnginePauseError, type PauseStorage } from "../server/engine-pauses.ts";
import type { RuntimeEvent } from "../server/contracts.ts";
import type { ProviderSpec } from "../server/providers.ts";
const worker = { kind: "agent", agentId: "worker", laneId: "worker-lane" } as const;
const other = { kind: "agent", agentId: "other", laneId: "other-lane" } as const;
async function until(check:()=>boolean) { for(let i=0;i<300;i++){if(check())return;await delay(10);}assert.fail("fake HTTP provider did not reach its expected state"); }
async function fixture(t:TestContext, options:{tools?:boolean;kind?:string;streamComplete?:boolean}={}) {
  const calls:Array<{path:string;body:any}>=[],physical:string[]=[];
  const held = new Set<import('node:http').ServerResponse>();
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;calls.push({path:req.url!,body});
    if(req.url==="/models"){res.setHeader("content-type","application/json");res.end(JSON.stringify({data:[{id:"primary-v1"}]}));return;}
    const text=body.messages.at(-1).content;
    if(text==="hold"){held.add(res);res.once("close",()=>held.delete(res));return;}
    const message=options.tools&&text==="tool-round"?{content:null,tool_calls:[{id:"ask-1",type:"function",function:{name:"ask_user",arguments:JSON.stringify({question:"Synthetic question"})}}]}:{content:"Fake complete reply."};
    if(body.stream){res.setHeader("content-type","text/event-stream");res.end('data: '+JSON.stringify({choices:[{delta:{content:"Fake stream reply."}}]})+'\n\n'+(options.streamComplete===false?'':'data: [DONE]\n\n'));}
    else{res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1}}));}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,"fetch",(...args:Parameters<typeof fetch>)=>{
    assert.ok(String(args[0]).startsWith(url+"/"),"fixture tried a non-fake provider");physical.push(String(args[0]));return Reflect.apply(fetch,globalThis,args);
  });
  let saved:unknown={version:1,pauses:[],invocations:[]},now=1000;
  const storage:PauseStorage={load:()=>structuredClone(saved),save:state=>{saved=structuredClone(state);}};
  const policy=new EnginePauses(storage,()=>now);
  const spec:ProviderSpec={kind:options.kind??"gemini",name:"Fake API",url,auth:"none",keyHint:"",docsUrl:"",tools:options.tools,
    models:{default:"primary-v1",options:[{id:"primary-v1",label:"Primary"}]},small:"small-v1"};
  const instance=await openAiCompatDriver(spec).create({instanceId:"api",displayName:"Fake API",enabled:true,environment:{},config:{url,apiKeyEnv:"UNSET_SYNTHETIC_KEY"},enginePauses:policy});
  const events:RuntimeEvent[]=[];instance.adapter.onEvent(e=>events.push(e));
  const pause=(agents:"all"|string[]="all",selector:any={instanceId:"api"})=>policy.activate({kind:"agent",id:"coordinator"},{id:randomUUID(),agents,selector,until:2000,timeZone:"UTC"});
  t.after(async()=>{await instance.dispose();for(const res of held)res.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));t.mock.restoreAll();});
  return {instance,policy,storage,calls,physical,events,pause,setNow:(n:number)=>{now=n;}};
}

test("actual API one-shot and readiness deny before HTTP, retain preferences and expire",async t=>{
  const f=await fixture(t);
  assert.equal(await f.instance.generateText!("positive",worker),"Fake complete reply.");
  assert.equal((await f.instance.snapshot()).state,"available");
  const before=f.physical.length;await f.pause();
  await assert.rejects(f.instance.generateText!("blocked",worker),e=>e instanceof EnginePauseError);
  await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);
  await assert.rejects(f.instance.adapter.sendTurn({threadId:"lane",text:"blocked",invocationOrigin:worker}),e=>e instanceof EnginePauseError);
  assert.equal(f.physical.length,before,"paused API crossed actual fetch boundary");
  f.setNow(2000);assert.equal(await f.instance.generateText!("after expiry",worker),"Fake complete reply.");
  assert.equal(f.calls.filter(c=>c.body?.messages).at(-1)!.body.model,"small-v1");
  assert.equal(f.instance.models.default,"primary-v1");
});

test("API small model and explicit scope use actual wire identity on a shared instance",async t=>{
  const f=await fixture(t);assert.equal(await f.instance.generateText!("positive",worker),"Fake complete reply.");
  await f.pause(["worker"],{model:"small-v1"});const before=f.physical.length;
  await assert.rejects(f.instance.generateText!("forbidden small",worker),e=>e instanceof EnginePauseError);
  assert.equal(await f.instance.generateText!("other permitted",other),"Fake complete reply.");
  assert.equal(f.physical.length,before+1);
  assert.equal(f.calls.filter(c=>c.body?.messages).at(-1)!.body.model,"small-v1");
});

test("API persistence race rechecks at the real fetch and disposed instance cannot launch",async t=>{
  const f=await fixture(t);assert.equal(await f.instance.generateText!("positive",worker),"Fake complete reply.");
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);const save=f.storage.save;let held=false;
  f.storage.save=async state=>{if(!held&&(state as any).invocations.some((r:any)=>r.purpose==="compat-text")){held=true;entered();await gate;}await save(state);};
  const before=f.physical.length,pending=f.instance.generateText!("never sent",worker),rejected=assert.rejects(pending,e=>e instanceof EnginePauseError);
  await writing;const activation=f.pause();release();await activation;await rejected;
  assert.equal(f.physical.length,before,"stale API admission crossed actual fetch boundary");
  f.setNow(2000);await f.instance.dispose();
  await assert.rejects(f.instance.generateText!("disposed",worker),e=>e instanceof EnginePauseError);
  assert.equal(f.physical.length,before);
});

test("tool loop rechecks each physical request after a permitted round, with quiet policy outcome",async t=>{
  const f=await fixture(t,{tools:true});
  f.instance.adapter.onEvent(e=>{if(e.type==="request.opened"){assert.equal(typeof e.requestId,"string");const requestId=e.requestId!;void(async()=>{await f.pause();await f.instance.adapter.respondToRequest!("lane",requestId,{behavior:"answer",message:"Synthetic answer"});})().catch(error=>{throw error;});}});
  await f.instance.adapter.sendTurn({threadId:"lane",text:"tool-round",invocationOrigin:worker});
  await until(()=>f.events.some(e=>e.type==="turn.completed"));
  const end=f.events.find(e=>e.type==="turn.completed") as any;
  assert.equal(end.stopReason,"engine_paused");
  assert.equal(f.calls.filter(c=>c.path==="/chat/completions").length,1,"tool loop sent a second model request under pause");
  assert.equal(f.physical.length,1);
  assert.equal(f.events.some(e=>e.type==="runtime.error"),false);
});

test("API cancellation persists remote uncertainty and leaves other-agent work permitted",async t=>{
  const f=await fixture(t);const pending=f.instance.generateText!("hold",worker),rejected=assert.rejects(pending,e=>e instanceof EnginePauseError);
  await until(()=>f.calls.some(c=>c.body?.messages.at(-1).content==="hold"));
  await f.pause(["worker"]);await rejected;
  assert.equal(f.policy.status().invocations.some(r=>r.origin.kind==="agent"&&r.origin.agentId==="worker"&&r.state==="residual"),true);
  assert.equal(await f.instance.generateText!("other permitted",other),"Fake complete reply.");
  f.setNow(2000);assert.equal(f.policy.status().invocations.some(r=>r.state==="residual"),true);
});

test("unknown gateway route stays pending under a family pause without a provider probe",async t=>{
  const f=await fixture(t,{kind:"openrouter"});assert.equal(await f.instance.generateText!("positive",worker),"Fake complete reply.");
  await f.pause("all",{family:"claude"});const before=f.physical.length;
  await assert.rejects(f.instance.generateText!("named-safe-but-unresolved",worker),e=>e instanceof EnginePauseError);
  await assert.rejects(f.instance.snapshot(),e=>e instanceof EnginePauseError);
  assert.equal(f.physical.length,before,"unknown gateway route guessed itself safe");
});

test("stream EOF without a completion marker preserves a factual remote residual",async t=>{
  const f=await fixture(t,{streamComplete:false});
  await f.instance.adapter.sendTurn({threadId:"lane",text:"stream",invocationOrigin:worker});
  await until(()=>f.events.some(e=>e.type==="turn.completed"));
  assert.equal(f.events.some(e=>e.type==="content.delta"),true);
  assert.equal(f.policy.status().invocations.some(r=>r.state==="residual"),true);
  assert.equal(f.calls.length,1);
});
