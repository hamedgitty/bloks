import test from "node:test";
import assert from "node:assert/strict";
import { inspectWorkspaceCategory, inspectMcpSettings } from "../server/settings-workspace.ts";
import { inspectionRedactor } from "../server/settings-redaction.ts";
import type { InspectionField } from "../server/settings-inspection.ts";
const resolved={beforeTurn:200000,beforeTurnAt:.6,stallMinutes:15};
function field(rows:InspectionField[],id:string){const row=rows.find((r)=>r.id===id);assert.ok(row,id);return row;}
const read=(category:Parameters<typeof inspectWorkspaceCategory>[0],saved:unknown={},runtime:unknown=saved)=>inspectWorkspaceCategory(category,{saved,runtime,resolved,redact:inspectionRedactor(saved,runtime)});

test('workspace categories use actual loaded defaults including consent, backup, box sleep and brief parser',()=>{
  for(const [category,id,value] of [
    ['workspace.general','brief.enabled',true],['workspace.general','brief.time','08:00'],
    ['workspace.backups','backups.auto',true],['workspace.computers','box.sleepAfter',20],
    ['workspace.voices','speech.useDiscoveredOpenAI',false],['workspace.devices','remote.enabled',false],
  ] as const)assert.deepEqual(field(read(category),id).effective,{status:'value',value});
  assert.deepEqual(field(read('workspace.general',{brief:{time:'bad'}}),'brief.time').effective,{status:'value',value:'08:00'});
  assert.deepEqual(field(read('workspace.general',{brief:{time:'23:59',enabled:false}}),'brief.time').effective,{status:'value',value:'23:59'});
  assert.deepEqual(field(read('workspace.computers',{box:{sleepAfter:0}}),'box.sleepAfter').effective,{status:'value',value:0});
});

test('owner defaults distinguish absent, null, false, zero and empty saved values without truthy-default substitution',()=>{
  // Source owners: brief tick skips only false; backup owner defaults unless
  // false; speech discovery requires truthy consent; box idle uses ?? 20;
  // parseBriefTime refuses these non-time values. Do not generalize one
  // owner's fallback rule across unrelated preference families.
  const cases = [
    { label:'absent', present:false, value:undefined, enabled:true, consent:false, sleep:20 },
    { label:'null', present:true, value:null, enabled:true, consent:false, sleep:20 },
    { label:'false', present:true, value:false, enabled:false, consent:false, sleep:false },
    { label:'zero', present:true, value:0, enabled:true, consent:false, sleep:0 },
    { label:'empty', present:true, value:'', enabled:true, consent:false, sleep:'' },
  ] as const;
  for(const c of cases){
    for(const [category,path,expected] of [
      ['workspace.general',['brief','enabled'],c.enabled],
      ['workspace.backups',['backups','auto'],c.enabled],
      ['workspace.voices',['speech','useDiscoveredOpenAI'],c.consent],
      ['workspace.computers',['box','sleepAfter'],c.sleep],
      ['workspace.general',['brief','time'],'08:00'],
    ] as const){
      const saved=c.present?{[path[0]]:{[path[1]]:c.value}}:{};
      const found=field(read(category,saved),path.join('.'));
      assert.deepEqual(found.saved,c.present?{status:'value',value:c.value}:{status:'absent'},`${c.label} ${found.id} saved`);
      assert.deepEqual(found.effective,{status:'value',value:expected},`${c.label} ${found.id} effective`);
    }
  }
  const saved={brief:{enabled:false,time:'09:30'},box:{sleepAfter:0}};
  const runtime={brief:{enabled:true,time:'10:15'},box:{sleepAfter:15}};
  for(const [category,id,stored,effective] of [
    ['workspace.general','brief.enabled',false,true],
    ['workspace.general','brief.time','09:30','10:15'],
    ['workspace.computers','box.sleepAfter',0,15],
  ] as const){
    const found=field(read(category,saved,runtime),id);
    assert.deepEqual(found.saved,{status:'value',value:stored});
    assert.deepEqual(found.effective,{status:'value',value:effective});
  }
});

test('new agent defaults preserve automatic model and effort policy without resolving stale model/folder references',()=>{
  const rows=read('workspace.agentDefaults');assert.match(JSON.stringify(field(rows,'agentDefaults.modelSelectionPolicy').effective),/automatic selection at creation/);
  assert.deepEqual(field(rows,'agentDefaults.effort').effective,{status:'policy',policy:'engine default'});
  const selected=read('workspace.agentDefaults',{agentDefaults:{cwd:'/does-not-exist',modelSelection:{instanceId:'stale',model:'stale'},effort:'high',approvals:'full'}});
  assert.match(JSON.stringify(field(selected,'agentDefaults.cwdPolicy').effective),/stale-path fallback is not probed/);
  assert.match(JSON.stringify(field(selected,'agentDefaults.modelSelectionPolicy').effective),/if still available/);
  assert.match(JSON.stringify(field(selected,'agentDefaults.hiringPolicy').effective),/cannot exceed/);
});

test('keys, channel URLs/addresses, MCP commands/maps and secret names are configured status only',()=>{
  const secret='PRIVATE_SETTINGS_SENTINEL';const root={chat:{whatsapp:{token:secret,verifyToken:secret,phoneNumberId:secret,webhookUrl:`https://example.test/${secret}`},email:{id:secret,domain:secret,allowFrom:[secret]}},secrets:{[secret]:secret},composio:{key:secret}};
  for(const category of ['workspace.apps','workspace.channels'] as const)assert.ok(!JSON.stringify(read(category,root)).includes(secret));
  const mcp={id:secret,name:secret,transport:'stdio',command:secret,args:[secret],headers:{[secret]:secret},env:{[secret]:secret},url:`https://example.test/${secret}`};
  const rows=inspectMcpSettings(mcp,inspectionRedactor({mcpServers:[mcp]}));assert.ok(!JSON.stringify(rows).includes(secret));
  for(const id of ['command','args','url','headers','env'])assert.deepEqual(field(rows,id).effective,{status:'configured',configured:true});
  assert.ok(!rows.some((r)=>r.id==='id'));
});

test('unsupported observations say why and never invent readiness or device defaults',()=>{
  for(const [category,id,reason] of [
    ['workspace.voices','speech.discoveredKeyAvailability','auth_discovery_not_run'],
    ['workspace.apps','composio.connectedAccounts','connection_refresh_not_run'],
    ['workspace.computers','computer.localVm','native_vm_probe_not_run'],
    ['workspace.import','setup.imports','filesystem_discovery_not_run'],
    ['device.iphone','iphone.coverage','private_client_contract_dependency_issue_303'],
  ] as const)assert.deepEqual(field(read(category),id).effective,{status:'unknown',reason});
});
