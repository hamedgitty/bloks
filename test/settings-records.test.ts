import test from "node:test";
import assert from "node:assert/strict";
import { inspectAgentSettings, inspectRoomSettings, type InspectionContext } from "../server/settings-records.ts";
import { SettingsPages } from "../server/settings-pages.ts";
import type { InspectionField } from "../server/settings-inspection.ts";
import { DEFAULT_SHARING } from "../server/bloks.ts";
const pages=new SettingsPages();
const secret='SECRET_SENTINEL_REGISTERED';
const ctx:InspectionContext={redact:(s)=>s.replaceAll(secret,'[redacted]'),reference:(category,id)=>pages.reference(category,id),
  instanceIds:new Set(['available']),workspaceRecall:true,connectorsConfigured:false};
function field(rows:InspectionField[],id:string){const f=rows.find((row)=>row.id===id);assert.ok(f,id);return f;}
const value=(value:unknown)=>({status:'value',value});

test('agent projection answers preferences, engine-default effort and conditional owner grants without a provider',()=>{
  const rows=inspectAgentSettings({},ctx);
  for(const [id,v] of [['notifications',true],['browser',false],['speakReplies',false],['pinned',false],['engineHooks',true],['seniority',1],['approvals','ask'],['computer','auto'],['composio',true],['composio.effective',false],['recallBeforeTurn.effective',true]] as const)assert.deepEqual(field(rows,id).effective,value(v),id);
  assert.deepEqual(field(rows,'effort').effective,{status:'policy',policy:'engine default'});
  assert.match(JSON.stringify(field(rows,'approvals.context').effective),/shared-room.*hiring/);
  assert.deepEqual(field(rows,'modelSelection').effective,{status:'unknown',reason:'missing_stored_model_selection'});
  assert.equal(field(rows,'approvals').control,'Agent > Settings and sidebar controls');
});

test('enabled recall and connector preferences explain contextual dispatch limits without resolving or granting a turn',()=>{
  const root={recallBeforeTurn:true,composio:true,browser:true,approvals:'full'};
  const before=structuredClone(root);const rows=inspectAgentSettings(root,{...ctx,connectorsConfigured:true});
  assert.deepEqual(field(rows,'recallBeforeTurn.effective').effective,value(true));
  assert.deepEqual(field(rows,'composio.effective').effective,value(true));
  const recall=JSON.stringify(field(rows,'recallBeforeTurn.context').effective);
  for(const condition of ['personal owner turns','rooms','guests','routines','rehearsals','commands','fallback','retry','continuing'])assert.ok(recall.includes(condition),`recall context omits ${condition}`);
  const tools=JSON.stringify(field(rows,'tools.context').effective);
  assert.match(tools,/preferences.*not permission/);assert.match(tools,/shared-room.*guest/);
  assert.deepEqual(root,before);
  assert.deepEqual(field(inspectAgentSettings(root,{...ctx,workspaceRecall:false}),'recallBeforeTurn.effective').effective,value(false));
  assert.deepEqual(field(inspectAgentSettings({...root,recallBeforeTurn:false},ctx),'recallBeforeTurn.effective').effective,value(false));
});

test('shared tool grant inspection names Team, engine checkpoint and per-agent intersections rather than implying unconditional use',()=>{
  const root={sharing:{tools:'desk',ownerTools:{browser:true,connectors:true,computer:true},collaboratorsApprove:true}};
  const before=structuredClone(root);const rows=inspectRoomSettings(root,ctx);
  const policy=JSON.stringify(field(rows,'sharing.approval.policy').effective);
  for(const condition of ['Team','Claude approval checkpoint',"agent's own grants",'spending','collaborator approvals',"owner's explicit setting"])assert.ok(policy.includes(condition),`room context omits ${condition}`);
  assert.deepEqual(field(rows,'sharing.ownerTools.browser').effective,value(true));
  assert.deepEqual(field(rows,'sharing.collaboratorsApprove').effective,value(true));
  assert.deepEqual(root,before);
});

test('new sharing budget default does not replace a missing legacy cap or a deliberate zero',()=>{
  const created=DEFAULT_SHARING();
  const rows=inspectRoomSettings({sharing:created},ctx);
  assert.deepEqual(field(rows,'sharing.spendCap').effective,value(created.spendCap));
  const policy=JSON.stringify(field(rows,'sharing.creation.policy').effective);
  assert.ok(policy.includes(`new shared rooms start with a monthly cap of ${created.spendCap}`));
  assert.match(policy,/existing missing cap means no cap/);
  assert.deepEqual(field(inspectRoomSettings({sharing:{}},ctx),'sharing.spendCap').effective,value(0));
  assert.deepEqual(field(inspectRoomSettings({sharing:{spendCap:0}},ctx),'sharing.spendCap').effective,value(0));
});

test('missing existing-agent model is unknown, not creation-time automatic policy, and saved null is distinct',()=>{
  assert.deepEqual(field(inspectAgentSettings({},ctx),'modelSelection').saved,{status:'absent'});
  const empty=inspectAgentSettings({modelSelection:null,backupSelection:null},ctx);
  assert.deepEqual(field(empty,'modelSelection').saved,value(null));
  assert.deepEqual(field(empty,'modelSelection').effective,{status:'unknown',reason:'missing_stored_model_selection'});
  assert.deepEqual(field(empty,'backupSelection').saved,value(null));
  assert.deepEqual(field(empty,'backupSelection').effective,{status:'policy',policy:'none selected'});
  for(const raw of [false,0,''])assert.deepEqual(field(inspectAgentSettings({modelSelection:raw},ctx),'modelSelection').effective,{status:'unsupported',reason:'invalid_value'});
});

test('absent, null, false, zero and empty saved choices stay distinct; strict browser grants and automatic computers use source semantics',()=>{
  for(const saved of [null,false,0,'']){
    const rows=inspectAgentSettings({browser:saved,computer:saved,effort:saved},ctx);
    assert.deepEqual(field(rows,'browser').saved,value(saved));
    assert.deepEqual(field(rows,'browser').effective,value(false));
    assert.deepEqual(field(rows,'computer').saved,value(saved));
    assert.deepEqual(field(rows,'computer').effective,value('auto'));
    assert.deepEqual(field(rows,'effort').saved,value(saved));
    assert.deepEqual(field(rows,'effort').effective,{status:'policy',policy:'engine default'});
  }
  assert.deepEqual(field(inspectAgentSettings({browser:'true'},ctx),'browser').effective,value(false));
  assert.deepEqual(field(inspectAgentSettings({browser:true,computer:'off'},ctx),'browser').effective,value(true));
});

test('explicit and stale model/folder references remain policies; preferred values are never rewritten for eligibility',()=>{
  const selected={modelSelection:{instanceId:'available',model:'model-a'},backupSelection:{instanceId:secret,model:'model-b'},
    cwd:`/private/${secret}`,effort:'high',approvals:'full',computer:'cloud'};
  const before=structuredClone(selected);const rows=inspectAgentSettings(selected,ctx);assert.deepEqual(selected,before);
  assert.match(JSON.stringify(field(rows,'modelSelection').effective),/explicit selection; runtime eligibility not probed/);
  assert.match(JSON.stringify(field(rows,'backupSelection').effective),/instance unavailable/);
  assert.deepEqual(field(rows,'effort.selected').effective,value('high'));
  assert.match(JSON.stringify(field(rows,'effort').effective),/engine support/);
  assert.match(JSON.stringify(field(rows,'cwd.context').effective),/existence.*not probed/);
  assert.ok(!JSON.stringify(rows).includes(secret));
});

test('record projections exclude transcript, private lanes, tokens and unrecognized getters; registered text and ids cannot escape',()=>{
  let calls=0;const root={name:secret,title:secret,description:secret,modelSelection:{instanceId:secret,model:secret},
    voice:{provider:'openai',id:secret,name:secret},resumeCursors:{[secret]:secret},tasks:[{id:secret}],archiveNote:secret,
    mcpServers:[secret],skillIds:[secret],skills:[secret],engineHold:{secret},unknown:secret};
  Object.defineProperty(root,'unknownGetter',{get(){calls++;throw new Error(secret);}});
  const rows=inspectAgentSettings(root,ctx);const text=JSON.stringify(rows);assert.ok(!text.includes(secret));
  assert.equal(calls,0);for(const key of ['tasks','archiveNote','resumeCursors','engineHold','unknown'])assert.ok(!rows.some((r)=>r.id===key));
  assert.deepEqual(field(rows,'mcpServers').effective,{status:'values',values:[pages.reference('workspace.apps',secret)]});
  const getter=Object.create(null);Object.defineProperty(getter,'name',{get(){calls++;throw new Error(secret);}});
  assert.doesNotThrow(()=>inspectAgentSettings(getter,ctx));assert.equal(calls,0);
});

test('room projection preserves source desk states, sharing grants and zero budget without member identities or spend history',()=>{
  for(const [pinnedCwd,expected] of [[undefined,/first dispatch/],[null,/each agent/],['/chosen',/fixed room desk/]] as const){
    const rows=inspectRoomSettings({pinnedCwd},ctx);assert.match(JSON.stringify(field(rows,'desk.policy').effective),expected);
  }
  const legacy=inspectRoomSettings({sharing:{}},ctx);assert.deepEqual(field(legacy,"sharing.spendCap").effective,value(0));
  assert.equal(field(legacy,"sharing.tools").effective.status,"unknown");
  const room={name:secret,memberIds:[secret],pinned:true,sharing:{history:'all',spendCap:0,tools:'desk',
    memoryFor:[secret],ownerTools:{browser:true,connectors:false,computer:true,mcp:[secret]},
    spend:{byPerson:{[secret]:99}},chat:{token:secret},people:[secret]},lanes:{[secret]:secret}};
  const rows=inspectRoomSettings(room,ctx);assert.ok(!JSON.stringify(rows).includes(secret));
  assert.deepEqual(field(rows,'sharing.spendCap').effective,value(0));
  assert.deepEqual(field(rows,'sharing.ownerTools.browser').effective,value(true));
  assert.deepEqual(field(rows,'sharing.ownerTools.connectors').effective,value(false));
  assert.ok(!rows.some((r)=>r.id.includes('spend.')||r.id==='lanes'||r.id.includes('people')));
  assert.match(JSON.stringify(field(rows,'sharing.approval.policy').effective),/not unattended execution/);
});

test('large text and lists are omitted whole with a reason, never silently cut',()=>{
  const rows=inspectAgentSettings({description:secret.repeat(100),skillIds:Array.from({length:33},()=>secret)},ctx);
  for(const id of ['description','skillIds'])assert.deepEqual(field(rows,id).effective,{status:'omitted',reason:'size_limit'});
  assert.ok(!JSON.stringify(rows).includes(secret));
});
