import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";
import { CodexSpeedUnavailable, resolveCodexSpeed } from "../server/codex-speed.ts";

const isolatedHome = mkdtempSync(join(tmpdir(), "bloks-box-speed-unit-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
after(() => rmSync(isolatedHome, {recursive:true,force:true}));

async function boat(t: TestContext) {
 const requests: Array<{method:string;path:string;body:any}> = [], boxes: any[] = [];
 const server=createServer((req,res)=>{
  let raw="";req.on("data",c=>raw+=c);req.on("end",()=>{
   const body=JSON.parse(raw||"{}");requests.push({method:req.method!,path:req.url!,body});
   const path=new URL(req.url!,"http://localhost").pathname;
   const data=path.endsWith("/sandboxes")?{sandboxes:boxes}:path.endsWith("/prompt")?{promptId:"synthetic-prompt"}:path.endsWith("/events")?{events:[]}:path.includes("/prompts/")?{promptRun:{status:"finished"},result:"BOX ANSWER"}:{};
   res.setHeader("content-type","application/json");res.end(JSON.stringify(data));
  });
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${(server.address() as any).port}`;
 const add=(id:string)=>boxes.push({id:"box-"+id,name:`bloks-${id.slice(0,8)}-${createHash("sha256").update(id).digest("hex").slice(0,6)}`,state:"ready"});
 return {url,requests,add,prompts:()=>requests.filter(r=>r.method==="POST"&&r.path.endsWith("/prompt"))};
}
for (const speed of ["standard","fast"] as const) test(`B1 direct driver refuses ${speed} before prompt, Box Claude unaffected`,async(t)=>{
 const b=await boat(t), original=fetch;
 t.mock.method(globalThis,"fetch",(input:any,init?:RequestInit)=>{const u=new URL(String(input)); assert.equal(u.hostname,"boat.dev");return original(new URL(u.pathname+u.search,b.url),init);});
 const {BoxAgentDriver}=await import("../server/drivers/boxagent.ts");
 const instance=await BoxAgentDriver.create({instanceId:"computer",displayName:"Box",enabled:true,environment:{BOX_TOKEN:"DUMMY"},config:{pollMs:1}});
 t.after(()=>instance.dispose());
 const input={threadId:"fixture",text:"LOCAL",model:"gpt-6",codexSpeed:resolveCodexSpeed({codex:{speed}}),integrations:{computer:{boxId:"synthetic",token:"DUMMY"}}};
 let refused:unknown;try{await instance.adapter.sendTurn(input);}catch(error){refused=error;}
 assert.equal(b.prompts().length,0,"remote Codex prompt crossed the unavailable-route guard");assert.ok(refused instanceof CodexSpeedUnavailable);
 const events:any[]=[];instance.adapter.onEvent(e=>events.push(e));await instance.adapter.sendTurn({...input,model:"sonnet"});
 await waitFor(()=>events.some(e=>e.type==="turn.completed"));assert.equal(b.prompts().length,1);
 assert.equal(b.prompts()[0].body.provider,"claude-code");assert.deepEqual(Object.keys(b.prompts()[0].body).sort(),["model","prompt","provider"]);
});
for (const speed of ["standard","fast"] as const) test(`B1 Box primary ${speed} hands over once to native backup with one input`,async(t)=>{
 const b=await boat(t);
 const s=await codexCommands(t,{NODE_OPTIONS:`--import=${new URL("./helpers/boat-fetch.mjs",import.meta.url).href}`,BLOKS_TEST_BOAT_URL:b.url});
 await s.h.json("/api/config",{method:"PATCH",body:JSON.stringify({box:{token:"DUMMY"}})});
 await s.h.json(`/api/bots/${s.bot.id}`,{method:"PATCH",body:JSON.stringify({modelSelection:{instanceId:"computer",model:"gpt-6"},backupSelection:{instanceId:"codex",model:"gpt-6.1-sol"}})});
 await s.h.json("/api/config",{method:"PATCH",body:JSON.stringify({codex:{speed}})});
 await s.say("one Box refusal");await s.settled();
 assert.equal(b.prompts().length,0);
 assert.equal(s.calls().filter(c=>c.method==="turn/start").length,1);
 const opened=s.calls().find(c=>c.method==="thread/start");assert.equal(opened.params.serviceTier,speed==="fast"?"priority":"default");
 const messages=(await s.messages()).map(m=>m.text??"").join("\n");assert.match(messages,/picking this up/);assert.doesNotMatch(messages,/Trying again in a minute/);
 const stored=s.stored();assert.equal(stored.modelSelection.instanceId,"computer");assert.equal(stored.backupSelection.instanceId,"codex");assert.equal(stored.codexSpeed??null,null);
 // A new session clears the ordinary backup stay; the routine must hand over its own source.
 await s.reboot();
 // The source starts once on the permitted backup, with no premature failed run.
 const {routine}=await s.post("/api/routines",{targetId:s.bot.id,targetKind:"agent",prompt:"ROUTINE BACKUP",time:"23:59",days:[]});
 await s.post(`/api/routines/${routine.id}/run`);await s.settled();
 const state=(await s.h.json("/api/routines")).routines.find((r:any)=>r.id===routine.id);
 assert.equal(state?.runs?.length,1,"backup duplicated or lost the routine source");
 assert.equal(state.runs[0].state,"ok");
 assert.equal(s.calls().filter(c=>c.method==="turn/start").length,2);
 assert.equal(b.prompts().length,0);
 // A different agent's Box Claude turn still reaches the same Box instance.
 const peer=await s.hire("Box peer");b.add(peer.id);
 await s.h.json(`/api/bots/${peer.id}`,{method:"PATCH",body:JSON.stringify({modelSelection:{instanceId:"computer",model:"sonnet"},computer:"cloud"})});
 await s.post(`/api/bots/${peer.id}/messages`,{text:"Box Claude"});await waitFor(()=>b.prompts().length===1);
 assert.equal(b.prompts()[0].body.provider,"claude-code");
});
test("B1 no backup ends not-sent; a room refuses once without input or retry",async(t)=>{
 const b=await boat(t);const s=await codexCommands(t,{NODE_OPTIONS:`--import=${new URL("./helpers/boat-fetch.mjs",import.meta.url).href}`,BLOKS_TEST_BOAT_URL:b.url});
 await s.h.json("/api/config",{method:"PATCH",body:JSON.stringify({box:{token:"DUMMY"}})});
 await s.h.json(`/api/bots/${s.bot.id}`,{method:"PATCH",body:JSON.stringify({modelSelection:{instanceId:"computer",model:"gpt-6"},backupSelection:null})});
 await s.say("no backup");await s.settled();assert.match((await s.messages()).map(m=>m.text??"").join("\n"),/message was not sent/);
 const peer=await s.hire("Peer");
 const {blok}=await s.post("/api/bloks",{name:"Fixture room",memberIds:[s.bot.id,peer.id]});
 await s.post(`/api/bloks/${blok.id}/messages`,{text:"@Rex check"});
 await waitFor(async()=>{const {messages}=await s.h.json(`/api/bloks/${blok.id}/messages?limit=100`);return messages.some((m:any)=>m.from===s.bot.id&&/not sent/.test(m.text??""));});
 const {messages}=await s.h.json(`/api/bloks/${blok.id}/messages?limit=100`);
 assert.equal(messages.filter((m:any)=>m.from===s.bot.id&&/not sent/.test(m.text??"")).length,1);
 assert.equal(b.prompts().length,0);assert.equal(s.calls().filter(c=>c.method==="turn/start").length,0);
 assert.equal(s.stored().modelSelection.instanceId,"computer");
});


test("B1 Telegram return and routine owner settle both say not sent with no backup", async(t)=>{
 const b=await boat(t), updates:any[]=[], sends:any[]=[];let next=1;
 const telegram=createServer((req,res)=>{let raw="";req.on("data",x=>raw+=x);req.on("end",()=>{
  const body=JSON.parse(raw||"{}");res.setHeader("content-type","application/json");
  const reply=(result:unknown)=>res.end(JSON.stringify({ok:true,result}));
  if(req.url?.endsWith("getMe"))return reply({id:12345,is_bot:true,username:"FixtureBot"});
  if(req.url?.endsWith("getUpdates"))return void setTimeout(()=>reply(updates.filter(u=>u.update_id>=body.offset)),30);
  if(req.url?.endsWith("sendMessage")){sends.push(body);return reply({message_id:sends.length});}
  return reply(true);
 });});
 await new Promise<void>(r=>telegram.listen(0,"127.0.0.1",r));t.after(()=>{telegram.closeAllConnections();telegram.close();});
 const s=await codexCommands(t,{NODE_OPTIONS:`--import=${new URL("./helpers/boat-fetch.mjs",import.meta.url).href}`,BLOKS_TEST_BOAT_URL:b.url,BLOKS_TEST_TELEGRAM_URL:`http://127.0.0.1:${(telegram.address() as any).port}`});
 await s.h.json("/api/config",{method:"PATCH",body:JSON.stringify({box:{token:"DUMMY"}})});
 await s.h.json(`/api/bots/${s.bot.id}`,{method:"PATCH",body:JSON.stringify({modelSelection:{instanceId:"computer",model:"gpt-6"},backupSelection:null})});
 const push=(text:string)=>updates.push({update_id:next++,message:{message_id:next,chat:{id:10101,type:"private"},from:{id:10101,is_bot:false,first_name:"Synthetic owner"},text}});
 const pairing=await s.post("/api/telegram",{token:"12345:TEST_ONLY",enabled:true,botId:s.bot.id,pair:true});assert.ok(pairing.pairing);push(pairing.pairing);
 await waitFor(()=>sends.some(m=>m.text.startsWith("Paired.")));
 push("REMOTE REFUSAL");await waitFor(()=>sends.some(m=>/message was not sent/.test(m.text)));
 await s.settled();assert.equal(sends.filter(m=>/message was not sent/.test(m.text)).length,1);
 const {routine}=await s.post("/api/routines",{targetId:s.bot.id,targetKind:"agent",prompt:"ROUTINE REFUSAL",time:"23:59",days:[]});assert.ok(routine?.id);
 await s.post(`/api/routines/${routine.id}/run`);
 await waitFor(async()=>{const current=(await s.h.json("/api/routines")).routines.find((r:any)=>r.id===routine.id);return current?.runs?.some((r:any)=>r.state==="failed"&&/message was not sent/.test(r.error??""));},"routine owner did not retain the not-submitted cause");
 assert.equal(b.prompts().length,0);assert.equal(s.calls().filter(c=>c.method==="turn/start").length,0);
 assert.equal(s.stored().modelSelection.instanceId,"computer");
});
