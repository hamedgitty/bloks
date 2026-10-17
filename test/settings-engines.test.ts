import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRegistry } from "../server/harness/registry.ts";
import type { AnyProviderDriver } from "../server/contracts.ts";
import { inspectEngineSettings, inspectProviderCredential, inspectCustomEndpoint } from "../server/settings-engines.ts";
import { inspectionRedactor } from "../server/settings-redaction.ts";
import { SettingsPages } from "../server/settings-pages.ts";
import type { InspectionField } from "../server/settings-inspection.ts";
import type { InspectionContext } from "../server/settings-records.ts";
const secret='PRIVATE_ENGINE_SENTINEL';const pages=new SettingsPages();
const ctx:InspectionContext={redact:inspectionRedactor({secrets:{TOKEN:secret}}),reference:(c,id)=>pages.reference(c,id),instanceIds:new Set(),workspaceRecall:true,connectorsConfigured:false};
function field(rows:InspectionField[],id:string){const row=rows.find((r)=>r.id===id);assert.ok(row,id);return row;}
const value=(value:unknown)=>({status:'value',value});

test('registry configuration observation clones already-retained inputs without invoking driver callbacks or health',async()=>{
  const calls={defaults:0,decode:0,create:0,snapshot:0};
  const driver={driverKind:'fixture',metadata:{displayName:'Fixture'},models:{default:'fixture',options:[]},
    defaultConfig(){calls.defaults++;return {};},decodeConfig(raw:unknown){calls.decode++;return raw;},
    async create(){calls.create++;return {instanceId:'fixture-instance',driverKind:'fixture',async dispose(){},snapshot(){calls.snapshot++;throw new Error('health trap');}};},
  } as unknown as AnyProviderDriver;
  const registry=new ProviderRegistry([driver]);
  const input={driver:'fixture',enabled:false,config:{opaque:secret},environment:{TOKEN:secret}};
  await registry.load({'fixture-instance':input});const before={...calls};
  input.environment.TOKEN='changed after load';
  for(let i=0;i<20;i++){
    const observed=registry.configuredInput('fixture-instance');assert.equal(observed?.environment?.TOKEN,secret);
    const rows=inspectEngineSettings(observed,ctx,true);assert.ok(!JSON.stringify(rows).includes(secret));
    observed!.environment!.TOKEN='changed returned clone';
  }
  assert.deepEqual(calls,before);assert.equal(calls.snapshot,0);
  assert.equal(registry.configuredInput('absent'),null);
  await registry.reload({},['fixture-instance']);assert.equal(registry.configuredInput('fixture-instance'),null);
});

test('known driver scalar defaults and explicit empty configurations match the pinned owner branches',()=>{
  for(const driver of ['codex','antigravity','geminiCli','opencode','grokCli','pi']){
    const rows=inspectEngineSettings({driver},ctx,true);
    assert.deepEqual(field(rows,'enabled').effective,value(true));assert.deepEqual(field(rows,'config.fullAuto').effective,value(false));
    assert.deepEqual(field(rows,'config.cli').effective,{status:'configured',configured:true});
    const empty=inspectEngineSettings({driver,config:{}},ctx,true);
    assert.match(JSON.stringify(field(rows,'config').effective),/driver defaults/);
    assert.match(JSON.stringify(field(empty,'config').effective),/explicit driver configuration/);
  }
  const claude=inspectEngineSettings({driver:'claudeAgent'},ctx,true);
  assert.deepEqual(field(claude,'config.permissionMode').effective,value('acceptEdits'));
  assert.deepEqual(field(inspectEngineSettings({driver:'boxAgent'},ctx,true),'config.pollMs').effective,value(2500));
  assert.deepEqual(field(inspectEngineSettings({driver:'boxAgent',config:{pollMs:0}},ctx,true),'config.pollMs').effective,value(0));
  assert.deepEqual(field(inspectEngineSettings({driver:'codex',config:{cli:'',fullAuto:'true'}},ctx,true),'config.cli').effective,{status:'configured',configured:false});
  assert.deepEqual(field(inspectEngineSettings({driver:'codex',config:{fullAuto:'true'}},ctx,true),'config.fullAuto').effective,value(false));
});

test('invalid permission config and unsupported drivers remain factual unknowns without raw exception strings',()=>{
  const invalid=inspectEngineSettings({driver:'claudeAgent',config:{permissionMode:secret}},ctx,false);
  assert.deepEqual(field(invalid,'config.permissionMode').effective,{status:'unsupported',reason:'invalid_value'});
  const future=inspectEngineSettings({driver:secret,displayName:secret,config:{[secret]:secret},environment:{[secret]:secret}},ctx,false);
  assert.deepEqual(field(future,'config.coverage').effective,{status:'unknown',reason:'driver_projection_unsupported'});
  assert.ok(!JSON.stringify({invalid,future}).includes(secret));
  assert.match(JSON.stringify(field(future,'eligibility').effective),/not readiness/);
});

test('environment precedence and opaque API endpoints expose configured status, not credentials or environment names',()=>{
  const rows=inspectProviderCredential({}, {key:secret,url:`https://example.test/${secret}`});
  assert.deepEqual(field(rows,'key').saved,{status:'absent'});assert.deepEqual(field(rows,'key').effective,{status:'configured',configured:true});
  assert.ok(!JSON.stringify(rows).includes(secret));
  const api=inspectEngineSettings({driver:'openrouter',config:{url:`https://example.test/${secret}`,apiKeyEnv:secret},environment:{[secret]:secret}},ctx,true);
  for(const id of ['config.url','config.apiKeyEnv','environment'])assert.deepEqual(field(api,id).effective,{status:'configured',configured:true});
  assert.ok(!JSON.stringify(api).includes(secret));
});

test('custom hosts retain the credential-owner fallback policy without exposing key labels or identities',()=>{
  const root={id:secret,name:secret,url:`https://example.test/${secret}`,activeKeyId:'missing',keys:[{id:secret,label:secret,key:secret}]};
  const rows=inspectCustomEndpoint(root,ctx);assert.ok(!JSON.stringify(rows).includes(secret));
  assert.deepEqual(field(rows,'activeCredential').effective,{status:'configured',configured:true});
  assert.deepEqual(field(inspectCustomEndpoint({...root,keys:[]},ctx),'activeCredential').effective,{status:'configured',configured:false});
});
