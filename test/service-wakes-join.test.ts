// Real ingress and native steering using the existing synthetic Codex CLI.
// No real engine, provider, phone or Cloud. The runner supplies the strict
// optional test-only process allowlist and loopback transport guard.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const guard = process.env.BLOKS_TEST_SERVICE_GUARD;
test("strict service turns keep actual accepted and refused human steering, mixed queue identity and one completion wake", async t => {
  const f = await codexCommands(t, guard ? { NODE_OPTIONS: `--import=${guard}`, BLOKS_TEST_FAKE_CODEX: "1" } : {});
  const wakes: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const relay = createServer((req,res)=>{
    if(req.url?.startsWith('/space/agent/stream')){
      res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"kind":"hello","spaceId":"fixture"}\n\n');return;
    }
    let body="";req.on('data',c=>body+=c);req.on('end',()=>{
      const wake=JSON.parse(body||"{}").wake;
      if(wake)wakes.push(typeof wake==='string'?wake:wake.reason);
      res.writeHead(200,{"content-type":"application/json"});res.end('{}');
    });
  });
  relay.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise<void>(resolve=>relay.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const s of sockets)s.destroy();relay.close();});
  await f.h.json('/api/pair',{method:'PUT',body:JSON.stringify({enabled:true})});
  await f.h.json('/api/relay',{method:'PUT',body:JSON.stringify({url:`http://127.0.0.1:${(relay.address() as any).port}`,enabled:true,agentToken:'fixture-agent',clientToken:'fixture-client'})});
  const path=`/api/bots/${f.bot.id}/wakes`;
  const admit=(wakeId:string,text:string)=>f.h.fetchRemote(path,{host:'localhost',method:'POST',body:JSON.stringify({taskId:f.bot.threadId,wakeId,text})});
  const reset=()=>{const file=join(f.root,'gate');if(existsSync(file))rmSync(file);};
  const replies=()=>wakes.filter(w=>w==='reply').length;

  f.spec({hold:true,answer:'QUIET'});let n=replies();
  const first=await admit('b0000000-0000-4000-8000-000000000001','SERVICE HOLD');assert.equal(first.status,202);
  await f.called('turn/start',1);
  const joined=await f.say('Person asks for the literal word QUIET');assert.equal(joined.steered,true,JSON.stringify(joined));
  f.gate();await f.settled();await waitFor(()=>replies()===n+1,'joined substantive reply did not notify once');
  assert.equal((await f.messages()).filter(m=>m.role==='bot'&&m.text==='QUIET').length,1);
  assert.equal(f.count('turn/start'),1,'accepted steering became a separate turn');

  reset();f.spec({hold:true,answer:'QUIET'});n=replies();
  await f.say('PERSON HOLD');await f.called('turn/start',2);
  const queued=await admit('b0000000-0000-4000-8000-000000000002','PURE SERVICE QUEUED');
  assert.equal(queued.status,202);assert.equal(queued.body.status,'queued');
  f.gate();await f.called('turn/start',3);await f.settled();
  await new Promise(r=>setTimeout(r,300));
  assert.equal((await f.messages()).filter(m=>m.role==='bot'&&m.text==='QUIET').length,2,'router arrival silenced a human turn or made a pure service turn requested');
  assert.equal(replies(),n+1,'mixed human/service completion duplicated attention');

  reset();f.spec({hold:true,answer:'QUIET',refuseSteer:true});n=replies();
  const third=await admit('b0000000-0000-4000-8000-000000000003','SERVICE HOLD');assert.equal(third.status,202);
  await f.called('turn/start',4);
  const refused=await f.say('Person waits for the literal QUIET');assert.notEqual(refused.steered,true,JSON.stringify(refused));
  f.gate();await f.called('turn/start',5);await f.settled();await new Promise(r=>setTimeout(r,300));
  assert.equal((await f.messages()).filter(m=>m.role==='bot'&&m.text==='QUIET').length,3,'refused steering changed the current quiet service turn');
  assert.equal(replies(),n+1,'only the queued genuine person reply should notify');
});
