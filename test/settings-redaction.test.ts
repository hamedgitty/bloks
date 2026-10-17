import test from "node:test";
import assert from "node:assert/strict";
import { inspectionRedactor } from "../server/settings-redaction.ts";
import { inspectAgentSettings, inspectRoomSettings } from "../server/settings-records.ts";
import { inspectWorkspaceSettings } from "../server/settings-inspection.ts";
import { SettingsPages } from "../server/settings-pages.ts";
const secret='fixture_SECRET_WITH/slash+plus';
function fixture(){return {
  providers:{host:{key:secret,url:`https://owner:${encodeURIComponent(secret)}@example.test/${encodeURIComponent(secret)}?token=${encodeURIComponent(secret)}`}},
  xai:{key:secret},composio:{key:secret,apiKey:secret},speech:{elevenlabsKey:secret,openaiKey:secret},box:{token:secret},
  custom:[{id:secret,name:secret,keys:[{id:secret,key:secret}]}],
  chat:{slack:{botToken:secret,appToken:secret},discord:{token:secret},whatsapp:{token:secret,appSecret:secret,verifyToken:secret,webhookUrl:`https://example.test/${encodeURIComponent(secret)}`}},
  telegram:{token:secret,pairing:secret,generation:secret,pending:{token:secret},bots:{[secret]:{token:secret,pairing:secret}}},
  mcpServers:[{id:secret,name:secret,url:`https://example.test/?token=${encodeURIComponent(secret)}`,command:secret,args:[secret],headers:{Authorization:`Bearer ${secret}`},env:{[secret]:secret}}],
  secrets:{[secret]:secret},relay:{agentToken:secret,clientToken:secret},remote:{devices:[{id:secret,hash:secret}],memberDevices:[{id:secret,hash:secret}]},
  instances:{[secret]:{environment:{[secret]:secret}}},profile:{name:secret,about:secret},
};}

test('explicit credential families protect human names and ids, including encoded URL components, without exposing opaque maps',()=>{
  const root=fixture();const redact=inspectionRedactor(root);const pages=new SettingsPages();
  const ctx={redact,reference:(category:Parameters<SettingsPages['reference']>[0],id:string)=>pages.reference(category,id),instanceIds:new Set<string>(),workspaceRecall:true,connectorsConfigured:true};
  const agent=inspectAgentSettings({name:secret,title:encodeURIComponent(secret),description:secret,voice:{id:secret,name:secret},modelSelection:{instanceId:secret,model:secret}},ctx);
  const room=inspectRoomSettings({name:secret,memberIds:[secret]},ctx);
  const workspace=inspectWorkspaceSettings({saved:root,runtime:root,resolved:{beforeTurn:200000,beforeTurnAt:.6,stallMinutes:15},redact});
  const all=JSON.stringify({agent,room,workspace});assert.ok(!all.includes(secret));assert.ok(!all.includes(encodeURIComponent(secret)));
  assert.match(all,/\[redacted\]/);
});

test('every known credential leaf can independently protect a permitted display name',()=>{
  const roots=[
    {providers:{host:{key:secret}}},{xai:{key:secret}},{composio:{key:secret}},{composio:{apiKey:secret}},
    {speech:{elevenlabsKey:secret}},{speech:{openaiKey:secret}},{box:{token:secret}},
    {custom:[{keys:[{key:secret}]}]}, {chat:{slack:{botToken:secret}}},{chat:{slack:{appToken:secret}}},
    {chat:{discord:{token:secret}}},{chat:{whatsapp:{token:secret}}},{chat:{whatsapp:{appSecret:secret}}},{chat:{whatsapp:{verifyToken:secret}}},
    {telegram:{token:secret}},{telegram:{bots:{opaque:{token:secret}}}},{telegram:{pending:{token:secret}}},
    {mcpServers:[{headers:{opaque:secret}}]},{mcpServers:[{env:{opaque:secret}}]},{mcpServers:[{args:[secret]}]},
    {secrets:{opaque:secret}},{relay:{agentToken:secret}},{relay:{clientToken:secret}},
    {remote:{devices:[{hash:secret}]}},{remote:{memberDevices:[{hash:secret}]}},
    {instances:{opaque:{environment:{opaque:secret}}}},
  ];
  for(const [i,root] of roots.entries()){
    const redact=inspectionRedactor(root);assert.equal(redact(secret),'[redacted]',`credential fixture ${i}`);
    assert.equal(redact(encodeURIComponent(secret)),'[redacted]',`encoded credential fixture ${i}`);
  }
});

test('redaction never invokes credential getters or follows inherited maps and still catches key patterns',()=>{
  let calls=0;const root=Object.create({secrets:{opaque:secret}});
  Object.defineProperty(root,'providers',{get(){calls++;throw new Error(secret);}});
  const redact=inspectionRedactor(root);assert.equal(calls,0);assert.equal(redact('sk-fakepattern01234567890'),'[redacted]');
  assert.equal(calls,0);
});

test('saved and environment-resolved credentials both protect permitted text, without reading environment or files',()=>{
  const saved={speech:{openaiKey:'saved-secret'}},runtime={composio:{key:'runtime-secret'}};
  assert.equal(inspectionRedactor(saved,runtime)('saved-secret and runtime-secret'),'[redacted] and [redacted]');
});
