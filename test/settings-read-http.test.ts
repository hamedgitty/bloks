import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsPages } from "../server/settings-pages.ts";
import { serveSettingsRead, type SettingsReader } from "../server/settings-read-http.ts";
import { allows, NEVER } from "../server/agent-cli.ts";

async function fixture(t: {after:(fn:()=>Promise<void>)=>void}) {
  const pages = new SettingsPages(); let reads = 0; const requests: string[] = [];
  const server = createServer((req,res) => {
    const url = new URL(req.url!,"http://fixture"); requests.push(`${req.method} ${url.pathname}`);
    if(url.pathname !== '/api/agent/settings') {res.writeHead(404);res.end('{}');return;}
    // Fixture credentials deliberately separate from application auth. Actual
    // production index authentication and side-effect traps remain separate.
    const token = req.headers.authorization;
    const reader: SettingsReader = token === 'Bearer owner' ? {role:'owner',identity:'owner'} :
      token === 'Bearer agent' ? {role:'agent',identity:'fixture-agent'} :
      token === 'Bearer member' ? {role:'member'} : token === 'Bearer invite' ? {role:'invite'} : {role:'invalid'};
    serveSettingsRead(reader,req.method!,url.searchParams,res,pages,() => {
      reads++; return [{id:'workspace',visible:true,project:() => ({fields:[{id:'agents.turnLimit',effective:{status:'value',value:24},control:'Settings > General > Working with agents'}]})}];
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => {server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));});
  return {base:`http://127.0.0.1:${(server.address() as {port:number}).port}`,reads:()=>reads,requests};
}
async function cli(base:string, token:string, args:string[]) {
  const home = mkdtempSync(join(tmpdir(),'bloks-settings-cli-'));
  try {
    const child = spawn(process.execPath,[new URL('../bin/bloks.mjs',import.meta.url).pathname,...args],
      {env:{...process.env,HOME:home,BLOKS_URL:base,BLOKS_TOKEN:token},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr=''; child.stdout.on('data',(b)=>stdout+=b);child.stderr.on('data',(b)=>stderr+=b);
    const [code] = await once(child,'close'); return {code,stdout,stderr};
  } finally {rmSync(home,{recursive:true,force:true});}
}

test('new narrow agent rule does not open old NEVER endpoints, writes or report authority',()=>{
  assert.equal(allows('fixture','GET','/api/agent/settings',()=>false).ok,true);
  for(const path of [...NEVER,'/api/settings/device-report','/api/settings/device-session']) {
    for(const method of ['GET','POST','PUT','PATCH','DELETE']) assert.equal(allows('fixture',method,path,()=>false).ok,false,`${method} ${path}`);
  }
  for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal(allows('fixture',method,'/api/agent/settings',()=>false).ok,false);
});

test('real HTTP read handler rejects member/invite/invalid and methods before owner access',async(t)=>{
  const f = await fixture(t);
  for(const [token,status] of [['member',403],['invite',403],['expired',401],['',401]] as const) {
    const res=await fetch(`${f.base}/api/agent/settings?category=workspace.general`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(res.status,status);assert.equal(res.headers.get('cache-control'),'no-store');
  }
  for(const method of ['POST','PUT','PATCH','DELETE']) {
    const res=await fetch(`${f.base}/api/agent/settings?category=workspace.general`,{method,headers:{authorization:'Bearer owner'}});assert.equal(res.status,405);
  }
  assert.equal(f.reads(),0);
  const a=await fetch(`${f.base}/api/agent/settings?category=workspace.general`,{headers:{authorization:'Bearer agent'}});
  const b=await fetch(`${f.base}/api/agent/settings?category=workspace.general`,{headers:{authorization:'Bearer owner'}});
  assert.deepEqual(await a.json(),await b.json());assert.equal(f.reads(),2);
});

test('real CLI discovers settings and reads one selected category without any write',async(t)=>{
  const f=await fixture(t);
  const help=await cli(f.base,'agent',['help']);assert.equal(help.code,0);assert.match(help.stdout,/settings.*--category/);
  assert.equal(f.requests.length,0);
  const result=await cli(f.base,'agent',['settings','--category','workspace.general']);
  assert.equal(result.code,0,result.stderr); const page=JSON.parse(result.stdout);
  assert.equal(page.rows[0].observation.fields[0].effective.value,24);
  assert.deepEqual(f.requests,['GET /api/agent/settings']);
  for(const args of [['settings','--raw'],['settings','--category'],['settings','--category','workspace.general','trailing']]) {
    const bad=await cli(f.base,'agent',args);assert.notEqual(bad.code,0);
  }
  assert.equal(f.requests.length,1);
});
