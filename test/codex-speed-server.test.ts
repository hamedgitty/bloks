import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";
const patch = (s: Awaited<ReturnType<typeof codexCommands>>, id: string, body: unknown) => s.h.json(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const workspace = (s: Awaited<ReturnType<typeof codexCommands>>, speed: string) => s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ codex: { speed } }) });
const opens = (s: Awaited<ReturnType<typeof codexCommands>>) => s.calls().filter((c) => ["thread/start", "thread/resume"].includes(c.method));

test("saved default/override/clear survives restart and existing/new agents inherit live", async (t) => {
  const s = await codexCommands(t);
  assert.equal((await s.h.json("/api/config")).codex.speed, "standard");
  await s.turn("initial"); assert.equal(opens(s).at(-1).params.serviceTier, "default");
  await workspace(s, "fast"); await s.turn("inherit Fast"); assert.equal(opens(s).at(-1).params.serviceTier, "priority");
  await patch(s, s.bot.id, { codexSpeed: "standard" });
  await s.turn("override Standard"); assert.equal(opens(s).at(-1).params.serviceTier, "default");
  await s.reboot(); assert.equal((await s.current()).codexSpeed, "standard");
  await s.turn("after restart"); assert.equal(opens(s).at(-1).params.serviceTier, "default");
  await patch(s, s.bot.id, { codexSpeed: null }); await s.turn("clear to Fast"); assert.equal(opens(s).at(-1).params.serviceTier, "priority");
  const other = await s.hire("Peer"); assert.equal(other.codexSpeed ?? null, null);
  await s.post(`/api/bots/${other.id}/messages`, { text: "new inherited" });
  await waitFor(() => opens(s).length === 6); assert.equal(opens(s).at(-1).params.serviceTier, "priority");
  await workspace(s, "standard"); await s.turn("live inherited Standard"); assert.equal(opens(s).at(-1).params.serviceTier, "default");
  assert.equal(s.stored().codexSpeed, null); assert.equal(s.stored().modelSelection.instanceId, "codex");
  assert.equal((await s.messages()).some(m=>m.text?.startsWith("Codex requested ")),false,"speed status must never be stored as a chat message");
  assert.ok((await s.current()).tasks.every((task:any)=>task.codexDispatch===undefined),"ended speed status must disappear");
});

test("queued work resolves at start; steering carries no tier and admitted turn keeps its choice", async (t) => {
  const s = await codexCommands(t); await s.say("HOLD first");
  await waitFor(() => s.calls().some((c) => c.method === "turn/start"));
  await workspace(s, "fast");
  await s.say("steer the current turn");
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 1);
  await s.say("second queued", { steer: false });
  const before = opens(s).length;
  assert.equal(before, 1); assert.equal(opens(s)[0].params.serviceTier, "default");
  s.gate(); await waitFor(() => opens(s).length === 2); await s.settled();
  assert.equal(opens(s)[1].params.serviceTier, "priority");
  assert.ok(s.calls().filter((c) => c.method === "turn/steer").every((c) => !("serviceTier" in c.params)));
});

for (const refusal of [{ tierAck: null }, { tierAbsent: true }, { tierAck: "other" }, { tierError: "unknown field serviceTier: temporarily unavailable, limit exceeded" }]) {
 test(`typed native refusal preserves cursor and immediately hands over once: ${JSON.stringify(refusal)}`, async (t) => {
  const s = await codexCommands(t); await s.turn("warm"); const cursor = s.stored().tasks[0].resumeCursors.codex;
  // The same explicit fake CLI accepts both instances. Only resumes reject;
  // the configured backup opens a fresh thread and is acknowledged normally.
  await patch(s, s.bot.id, { backupSelection: { instanceId: "other", model: "gpt-6.1-sol" }, codexSpeed: "fast" });
  s.spec(refusal); const n = s.calls().filter((c) => c.method === "turn/start").length;
  await s.say("refused once"); await s.settled();
  // Null/absent/mismatch also refuses the backup; an RPC resume error allows
  // the fresh backup. Both outcomes must end without a same-engine retry.
  const calls = s.calls();
  assert.equal(calls.filter((c) => c.method === "thread/resume").length, 1);
  assert.equal(calls.filter((c) => c.method === "turn/start").length, n + ("tierError" in refusal ? 1 : 0));
  assert.equal(s.stored().tasks[0].resumeCursors.codex, cursor);
  assert.equal(opens(s).at(-1).params.serviceTier, "priority");
  assert.equal((await s.current()).modelSelection.instanceId, "codex");
  const text = (await s.messages()).map((m) => m.text ?? "").join("\n");
  assert.doesNotMatch(text, /Trying again in a minute|new session, with the conversation/);
  assert.doesNotMatch(text, /is out of usage|is overloaded|is out of credit/, "typed speed refusal must not rest the engine by its reason text");
  assert.match(text, /not sent|not submitted/);
  if ("tierError" in refusal) {
    const peer = await s.hire("No cooldown peer");
    await s.post(`/api/bots/${peer.id}/messages`, { text: "fresh peer after refusal" });
    await waitFor(async () => (await s.h.json("/api/bots?messages=0")).bots.find((b:any)=>b.id===peer.id).tasks.every((task:any)=>task.state==="idle"));
    assert.equal(s.calls().filter((c) => c.method === "turn/start").length, n + 2, "typed speed refusal must not rest the primary engine for another agent");
  }
 });
}

test("self speed read/write authority is bounded and GET remains free at the existing budget", async (t) => {
 const s = await codexCommands(t); s.spec({ captureCredential: true }); await s.say("HOLD credential");
 await waitFor(() => s.calls().some((c) => c.method === "turn/start"));
 const record = JSON.parse(readFileSync(join(s.root,"credentials.jsonl"),"utf8").trim().split("\n")[0]);
 const token = record.botId;
 const req = (path: string, method="GET", body?: unknown) => s.h.fetch(path,{method,headers:{authorization:`Bearer ${token}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const me = await (await req("/api/agent/whoami")).json();
 assert.deepEqual(me.codexSpeed,{default:"standard",override:null,resolved:"standard",source:"workspace"});
 assert.equal((await req("/api/config","PATCH",{codex:{speed:"fast"}})).status,403);
 const peer = await s.hire("Peer"); assert.equal((await req(`/api/bots/${peer.id}`,"PATCH",{codexSpeed:"fast"})).status,403);
 for (const value of [false,{},[],"priority",0]) assert.equal((await req(`/api/bots/${s.bot.id}`,"PATCH",{codexSpeed:value})).status,400);
 // Use valid own writes to consume the remaining turn budget.
 for(let i=0;i<12;i++) { const r=await req(`/api/bots/${s.bot.id}`,"PATCH",{codexSpeed:i%2?null:"fast"}); if(r.status===429)break; }
 for(let i=0;i<16;i++) assert.equal((await req("/api/agent/whoami")).status,200);
 assert.equal((await req(`/api/bots/${s.bot.id}`,"PATCH",{codexSpeed:"fast"})).status,429);
 for (const value of [false,{},null,"priority",{speed:"fast",extra:true}]) assert.equal((await s.h.fetch("/api/config",{method:"PATCH",body:JSON.stringify({codex:value})})).status,400);
 s.gate(); await s.settled();
});


test("the same preference reaches routine, watcher, webhook, workflow and job dispatches",async(t)=>{
 const s=await codexCommands(t);await workspace(s,"fast");
 const count=()=>s.calls().filter(c=>c.method==="turn/start").length;
 const heard=async(before:number)=>{await waitFor(()=>count()>before);await s.settled();const recent=opens(s).at(-1);assert.equal(recent.params.serviceTier,"priority");};
 let n=count();const {routine}=await s.post("/api/routines",{targetId:s.bot.id,targetKind:"agent",prompt:"ORIGIN routine",time:"23:59",days:[]});await s.post(`/api/routines/${routine.id}/run`);await heard(n);
 const folder=join(s.root,"watched-fixture");mkdirSync(folder);writeFileSync(join(folder,"initial.txt"),"old");
 const {watcher}=await s.post("/api/watchers",{botId:s.bot.id,kind:"folder",target:folder,instruction:"ORIGIN watcher"});
 await waitFor(async()=>(await s.h.json("/api/watchers")).watchers.find((w:any)=>w.id===watcher.id)?.lastCheck);
 await s.post(`/api/watchers/${watcher.id}/check`);n=count();writeFileSync(join(folder,"new.txt"),"new");const fired=await s.post(`/api/watchers/${watcher.id}/check`);assert.equal(fired.fired,true);await heard(n);
 n=count();const {webhook}=await s.post("/api/webhooks",{name:"Fixture",botId:s.bot.id});assert.equal((await s.h.fetch(`/hook/${webhook.token}`,{method:"POST",body:JSON.stringify({event:"ORIGIN webhook"})})).status,202);await heard(n);
 n=count();const {workflow}=await s.post("/api/workflows",{name:"Fixture",trigger:{kind:"manual"},steps:[{action:"ask",targetId:s.bot.id,text:"ORIGIN workflow"}]});await s.post(`/api/workflows/${workflow.id}/run`);await heard(n);
 const {bots}=await s.h.json("/api/bots?messages=0");for(const b of bots)if(b.id!==s.bot.id)await patch(s,b.id,{hidden:true});
 n=count();await s.post("/api/jobs",{title:"ORIGIN job",brief:"ORIGIN job"});await heard(n);
 assert.equal((await s.current()).codexSpeed??null,null);assert.equal(s.calls().filter(c=>c.method==="turn/start").length,5);
});

test("a Codex backup and automatic return use this agent's current shared speed preference",async(t)=>{
 const s=await codexCommands(t,{BLOKS_BACKUP_STAY_MS:"20"});await s.turn("warm primary");
 await patch(s,s.bot.id,{backupSelection:{instanceId:"other",model:"gpt-6.1-sol"},codexSpeed:"fast"});
 s.spec({tierError:"unknown field serviceTier"});await s.say("backup now");await s.settled();
 assert.equal(opens(s).at(-1).params.serviceTier,"priority");assert.equal(s.calls().filter(c=>c.method==="turn/start").length,2);
 s.spec({tierError:undefined});await patch(s,s.bot.id,{codexSpeed:"standard"});
 await new Promise(r=>setTimeout(r,40));await s.turn("return to primary");
 assert.equal(opens(s).at(-1).params.threadId,s.stored().tasks[0].resumeCursors.codex);assert.equal(opens(s).at(-1).params.serviceTier,"default");
 assert.equal(s.stored().modelSelection.instanceId,"codex");assert.equal(s.stored().backupSelection.instanceId,"other");
});


test("unknown original admission sends one input and never retries or hands over",async(t)=>{
 const s=await codexCommands(t);await s.turn("warm");const cursor=s.stored().tasks[0].resumeCursors.codex;
 await patch(s,s.bot.id,{backupSelection:{instanceId:"other",model:"gpt-6.1-sol"},codexSpeed:"fast"});
 const n=s.calls().filter(c=>c.method==="turn/start").length;s.spec({unknownAdmission:true});
 await s.say("unknown original");await s.settled();
 assert.equal(s.calls().filter(c=>c.method==="turn/start").length,n+1,"uncertain admission was submitted more than once");
 assert.equal(opens(s).filter(c=>c.method==="thread/start").length,1,"uncertain original was handed to a fresh backup session");
 assert.equal(s.stored().tasks[0].resumeCursors.codex,cursor);
 const notices=(await s.messages()).filter(m=>m.kind==="notice").map(m=>m.text??"").join("\n");
 assert.match(notices,/Admission is uncertain/);assert.match(notices,/temporarily unavailable, limit exceeded/,"uncertain admission must retain the engine exit detail");assert.doesNotMatch(notices,/Trying again in a minute|picking this up|is out of usage/);
});


for (const [name, spec, detail] of [
 ["draining", { turnError: { code: -32600, message: "Server is draining; retry after reconnecting" } }, "Server is draining; retry after reconnecting"],
 ["not submitted", { turnError: { code: -32603, message: "failed to submit turn input: NotSubmitted" } }, "failed to submit turn input: NotSubmitted"],
 ["exit after acknowledgement", { crashAfterStart: true }, "synthetic exit after acknowledgement"],
] as const) test(`F1 ordinary recovery survives ${name}`, async (t) => {
 const s=await codexCommands(t,{BLOKS_RETRY_WAIT_MS:"20"});await s.turn("warm");
 await patch(s,s.bot.id,{backupSelection:{instanceId:"other",model:"gpt-6.1-sol"}});
 const before=s.calls().filter(c=>c.method==="turn/start").length;s.spec(spec);
 await s.say("recover original");
 await waitFor(async()=> (await s.messages()).some(m=> /picking this up|Admission is uncertain|Completion is uncertain/.test(m.text??"")), "ordinary Codex recovery never reached the configured backup");
 assert.doesNotMatch((await s.messages()).map(m=>m.text??"").join("\n"),/Admission is uncertain|Completion is uncertain/,"known rejection or acknowledged input must use ordinary recovery");
 await s.settled();
 assert.equal(s.calls().filter(c=>c.method==="turn/start").length,before+3,"ordinary recovery must retry once, then use the backup once");
 const text=(await s.messages()).map(m=>m.text??"").join("\n");
 assert.ok(text.includes(detail),"Codex's original error or exit text must remain visible");
 assert.doesNotMatch(text,/Admission is uncertain|Completion is uncertain/);
});


test("P1 running metadata survives reload and preference edits, then disappears without transcript output",async(t)=>{
 const s=await codexCommands(t);await s.say("HOLD running snapshot");
 await waitFor(async()=>(await s.current()).tasks.find((task:any)=>task.id===s.bot.threadId)?.codexDispatch);
 const active=()=>s.current().then(b=>b.tasks.find((task:any)=>task.id===s.bot.threadId));
 const first=(await active()).codexDispatch;
 assert.deepEqual(first,{choice:{default:"standard",override:null,resolved:"standard",source:"workspace"},configuredTier:"default",actualTier:null});
 await workspace(s,"fast");await patch(s,s.bot.id,{codexSpeed:"fast"});
 assert.deepEqual((await active()).codexDispatch,first,"owner reload must return the original active choice");
 assert.equal((await s.messages()).some(m=>m.text?.startsWith("Codex requested ")),false);
 s.gate();await s.settled();assert.equal((await active()).codexDispatch,undefined);
 await s.turn("next dispatch");assert.equal((await active()).codexDispatch,undefined);
 assert.equal((await s.messages()).some(m=>m.text?.startsWith("Codex requested ")),false,"Fast and override must not leave a status line either");
});
