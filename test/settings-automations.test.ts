import test from "node:test";
import assert from "node:assert/strict";
import { inspectAutomationSettings, inspectProjectSettings, inspectSkillSettings, inspectRuleSettings, type InspectionContext } from "../server/settings-records.ts";
import { inspectionRedactor } from "../server/settings-redaction.ts";
import { SettingsPages } from "../server/settings-pages.ts";
import type { InspectionField } from "../server/settings-inspection.ts";
const secret='PRIVATE_AUTOMATION_SENTINEL';const pages=new SettingsPages();
const ctx:InspectionContext={redact:inspectionRedactor({secrets:{TOKEN:secret}}),reference:(c,id)=>pages.reference(c,id),instanceIds:new Set(),workspaceRecall:true,connectorsConfigured:false};
function field(rows:InspectionField[],id:string){const row=rows.find((r)=>r.id===id);assert.ok(row,id);return row;}
const value=(value:unknown)=>({status:'value',value});

test('routine projection reports check-in quiet policy, schedule and General fallback without evaluating a slot',()=>{
  const root={targetKind:'agent',targetId:secret,name:secret,prompt:secret,time:'09:00',every:30,days:[],enabled:true,quiet:false,runs:[{summary:secret}],lastReport:{summary:secret},thread:undefined};
  const rows=inspectAutomationSettings('routine',root,ctx);assert.deepEqual(field(rows,'quiet').effective,value(true));
  assert.deepEqual(field(rows,'every').effective,value(30));assert.deepEqual(field(rows,'repeat').effective,value('weekly'));
  assert.match(JSON.stringify(field(rows,'thread.policy').effective),/first conversation/);
  assert.deepEqual(field(inspectAutomationSettings('routine',{...root,targetKind:'room'},ctx),'quiet').effective,value(false));
  assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!rows.some((r)=>['runs','lastReport'].includes(r.id)));
});

test('watcher checks, webhook admission and goal check commands remain configured status with no history or action',()=>{
  for(const [kind,root,opaque] of [
    ['watcher',{name:secret,botId:secret,kind:'check',target:secret,instruction:secret,mentions:secret,every:30,enabled:true,seen:secret,lastError:secret,fires:[secret]},['target','instruction','mentions']],
    ['webhook',{name:secret,botId:secret,token:secret,enabled:true,deliveries:[secret],lastFiredAt:17},['token']],
    ['goal',{text:secret,check:secret,budget:0,status:'paused',lastReason:secret,turns:12},['text','check']],
  ] as const){
    const rows=inspectAutomationSettings(kind,root,ctx);assert.ok(!JSON.stringify(rows).includes(secret));
    for(const key of opaque)assert.deepEqual(field(rows,key).effective,{status:'configured',configured:true});
    for(const key of ['seen','lastError','fires','deliveries','lastFiredAt','lastReason','turns'])assert.ok(!rows.some((r)=>r.id===key));
  }
  assert.deepEqual(field(inspectAutomationSettings('goal',{budget:0},ctx),'budget').effective,value(0));
  assert.deepEqual(field(inspectAutomationSettings('goal',{},ctx),'budget').effective,{status:'unsupported',reason:'invalid_value'});
});

test('workflow definitions preserve actual timeout/from defaults and strict continuation while opaque templates stay private',()=>{
  const root={name:secret,trigger:{kind:'message',targetKind:'room',targetId:secret,contains:secret,from:undefined},enabled:true,
    steps:[{id:secret,action:'approve',text:secret,targetId:secret,when:{left:secret,op:'contains',right:secret}},{action:'post',targetId:secret,text:secret}],runs:[{waiting:{secret}}]};
  const rows=inspectAutomationSettings('workflow',root,ctx);assert.ok(!JSON.stringify(rows).includes(secret));
  assert.deepEqual(field(rows,'trigger.from').effective,value('user'));
  assert.deepEqual(field(rows,'steps.1.timeoutMin').effective,value(1440));
  assert.deepEqual(field(rows,'steps.1.onTimeout').effective,value('stop'));
  for(const raw of [false,0,''])assert.deepEqual(field(inspectAutomationSettings('workflow',{...root,steps:[{action:'approve',timeoutMin:raw}]},ctx),'steps.1.timeoutMin').effective,value(1));
  const oversized=inspectAutomationSettings('workflow',{...root,steps:Array.from({length:13},()=>root.steps[0])},ctx);
  assert.deepEqual(field(oversized,'steps').effective,{status:'omitted',reason:'size_limit'});
});

test('project, library and policy settings exclude opaque filesystem, registry, command and arbitrary nested fields',()=>{
  const project=inspectProjectSettings({name:secret,brief:secret,folders:[secret],include:[secret],memberIds:[secret],archivedAt:1,unknown:secret},ctx);
  const skill=inspectSkillSettings({id:secret,name:secret,description:secret,body:secret,source:'user',registry:secret,sha256:secret,version:'1',unknown:secret},ctx);
  const rule=inspectRuleSettings({id:secret,effect:'deny',field:'command',op:'contains',value:secret,botId:secret,enabled:true,unknown:secret},ctx);
  for(const rows of [project,skill,rule]){assert.ok(!JSON.stringify(rows).includes(secret));assert.ok(!rows.some((r)=>r.id==='unknown'||r.id==='id'));}
  assert.deepEqual(field(project,'folders').effective,{status:'configured',configured:true});
  assert.deepEqual(field(skill,'registry').effective,{status:'configured',configured:true});
  assert.deepEqual(field(rule,'value').effective,{status:'configured',configured:true});
  assert.match(JSON.stringify(field(rule,'evaluation.policy').effective),/deny rules precede/);
});
