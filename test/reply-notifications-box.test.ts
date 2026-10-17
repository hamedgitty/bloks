import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { BoxAgentDriver } from "../server/drivers/boxagent.ts";
import { ReplyNotifications, settledReply } from "../server/reply-notifications.ts";
import type { RuntimeEvent } from "../server/contracts.ts";
for (const [name, result, events, expected] of [
  ["adapter's empty placeholder", "", [], null],
  ["provider's literal same words", "(finished)", [], "(finished)"],
  ["provider's final result", "The report", [{id:"p",type:"assistant",text:"Progress"}], "The report"],
  ["provider event fallback", null, [{id:"p",type:"assistant",text:"Report from event"}], "Report from event"],
] as const) test(`Box mapping: ${name}`, async t => {
  t.mock.method(fs,"mkdirSync",()=>undefined);t.mock.method(fs,"appendFileSync",()=>undefined);syncBuiltinESMExports();
  const paths:string[]=[];
  t.mock.method(globalThis,"fetch",async(input: string | URL | Request)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);paths.push(url.pathname);
    assert.match(url.pathname,/^\/api\/v1\/sandboxes\/synthetic-box\/(prompt|events|prompts\/run)$/);
    return Response.json(url.pathname.endsWith('/prompt')?{id:'run'}:url.pathname.endsWith('/events')?{events}:{status:'completed',result});
  });
  const instance=await BoxAgentDriver.create({instanceId:'box',displayName:'Synthetic box',environment:{BOX_TOKEN:'synthetic-token'},config:{pollMs:1},enabled:true});
  t.after(async()=>{await instance.dispose();t.mock.restoreAll();syncBuiltinESMExports();});
  const received:RuntimeEvent[]=[], held=new ReplyNotifications();const delivery: { notice: ReturnType<typeof settledReply> } = { notice: null };
  instance.adapter.onEvent(e=>{
    received.push(e);
    if(e.type==='turn.started')held.start(e.threadId,e.turnId,e.threadId,'helper',false);
    if(e.type==='item.completed'&&e.itemType==='assistant_text')held.text(e.threadId,e.turnId,{id:'saved',at:1,role:'bot',kind:'text',text:e.text},e.replyPhase,e.syntheticText);
    if(e.type==='turn.completed')delivery.notice=settledReply(held.take(e.threadId,e.turnId),{ok:e.ok,continues:false,quiet:false,maintenance:false});
  });
  await instance.adapter.sendTurn({threadId:'lane',text:'Neutral task',integrations:{computer:{boxId:'synthetic-box',token:'synthetic-token'}}});
  for(let i=0;i<100&&!received.some(e=>e.type==='turn.completed');i++)await pause(10);
  assert.ok(received.some(e=>e.type==='turn.completed'),'fixture never completed');
  const item=received.find(e=>e.type==='item.completed'&&e.itemType==='assistant_text') as Extract<RuntimeEvent,{type:'item.completed',itemType:'assistant_text'}>;
  assert.equal(item.text,expected??'(finished)','existing chat content changed');
  assert.equal(item.syntheticText,expected===null?true:undefined);
  assert.equal(delivery.notice?.message.text??null,expected,'generated placeholder acquired notification authority');
  assert.equal(paths.length,3);
});
