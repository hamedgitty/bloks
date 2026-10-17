import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { settingsAccess } from "../server/settings-access.ts";
import { AgentTokens, allows } from "../server/agent-cli.ts";
import { bearerToken } from "../server/http-guard.ts";
import type { AppConfig } from "../server/config.ts";

const device = (id:string,token:string,member=false) => ({id,name:'Fixture',hash:createHash('sha256').update(token).digest('hex'),pairedAt:1,...(member?{personId:'fixture-member'}:{})});
const saved: AppConfig = {remote:{enabled:true,devices:[device('owner-device','owner')],memberDevices:[device('member-device','member',true)]}};
function request(headers:IncomingMessage['headers']={},peer='127.0.0.1') {
  return {headers:{host:'127.0.0.1:8799',...headers},socket:{remoteAddress:peer}} as IncomingMessage;
}

test('actual device token resolver classifies loopback members and invalid/expired credentials before inspection',()=>{
  for(const headers of [{authorization:'Bearer member'},{authorization:'Bearer member',host:'192.0.2.2:8799'}]) {
    const role=settingsAccess(request(headers),saved,null,null);assert.equal(role.reader.role,'member');assert.equal(role.reporter.role,'member');
  }
  for(const authorization of ['Bearer revoked','Bearer','', 'not-a-token']) assert.equal(settingsAccess(request({authorization}),saved,null,null).reader.role,'invalid');
  const owner=settingsAccess(request({authorization:'Bearer owner'}),saved,null,null);
  assert.equal(owner.reader.role,'owner');assert.deepEqual(owner.reporter,{role:'owner',source:{path:'direct',deviceId:'owner-device'}});
  assert.equal(settingsAccess(request(),saved,null,null).reader.role,'owner');
});

test('trusted relay identity stays device-bound; forged relay claims, unknown/revoked devices and member relays fail closed',()=>{
  assert.equal(settingsAccess(request({'x-bloks-relay-device':'owner-device'}),saved,null,null).reader.role,'invalid');
  assert.equal(settingsAccess(request({'x-bloks-relay':'invented','x-bloks-relay-device':'owner-device'}),saved,null,null).reader.role,'invalid');
  assert.equal(settingsAccess(request(),saved,null,'member-device').reader.role,'member');
  assert.equal(settingsAccess(request(),saved,null,'revoked-device').reader.role,'invalid');
  const owner=settingsAccess(request(),saved,null,'owner-device');
  assert.deepEqual(owner.reporter,{role:'owner',source:{path:'remote',deviceId:'owner-device'}});
  assert.equal(settingsAccess(request({authorization:'Bearer owner',origin:'https://untrusted.example',host:'192.0.2.2'}),saved,null,null).reader.role,'invalid');
  assert.equal(settingsAccess(request(),saved,'agent',null).reporter.role,'agent');
  assert.equal(settingsAccess(request({},'192.0.2.3'),saved,'agent',null).reader.role,'member');
});

test('real HTTP request classification uses minted turn tokens and pure already-loaded pairing metadata with IO traps',async(t)=>{
  const tokens=new AgentTokens(); const turn=tokens.mint('fixture-agent','fixture-lane',Date.now());
  const server=createServer((req,res)=>{
    const original=new Map<string,Function>();
    try {
      for(const name of ['readFileSync','writeFileSync','renameSync','mkdirSync','readdirSync','statSync'] as const) {
        original.set(name,fs[name]);(fs as unknown as Record<string,unknown>)[name]=()=>{throw new Error('inspection reached IO');};
      }
      syncBuiltinESMExports();
      const agent=tokens.identify(bearerToken(req),Date.now());
      if(agent) assert.equal(allows(agent.botId,req.method!,new URL(req.url!,'http://fixture').pathname,()=>false).ok,true);
      const access=settingsAccess(req,saved,agent?.botId??null,null);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(access));
    } catch {res.writeHead(500);res.end('{}');}
    finally {for(const [name,value] of original) (fs as unknown as Record<string,unknown>)[name]=value;syncBuiltinESMExports();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));});
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/agent/settings`;
  for(const [token,role] of [[turn.token,'agent'],['owner','owner'],['member','member'],['expired','invalid']] as const) {
    const res=await fetch(url,{headers:{authorization:`Bearer ${token}`}});assert.equal(res.status,200);
    const result=await res.json() as {reader:{role:string}};assert.equal(result.reader.role,role);
  }
  tokens.revokeTask('fixture-lane');
  const expired=await fetch(url,{headers:{authorization:`Bearer ${turn.token}`}});
  assert.equal((await expired.json() as {reader:{role:string}}).reader.role,'invalid');
});
