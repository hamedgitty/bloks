// Closed projections over already-loaded owner records and verified pure
// resolvers. No store construction, IO or traversal of opaque maps on reads.
import { scalar, type InspectionField, type InspectionValue } from "./settings-inspection.ts";
import type { SettingsCategory } from "./settings-pages.ts";
import { waitUntil, MAX_STEPS } from "./workflows.ts";
import { isQuiet } from "./routines.ts";
import { DEFAULT_SPEND_CAP } from "./bloks.ts";

type Scope = InspectionField["scope"];
export type InspectionContext = {
  redact: (text: string) => string;
  reference: (category: SettingsCategory, id: string) => string;
  instanceIds: ReadonlySet<string>;
  workspaceRecall: boolean;
  connectorsConfigured: boolean;
};
export function own(root: unknown, field: string): {present:boolean;value:unknown} {
  if (!root || typeof root !== "object" || Array.isArray(root)) return {present:false,value:undefined};
  const d = Object.getOwnPropertyDescriptor(root,field);
  return d ? {present:true,value:"value" in d ? d.value : undefined} : {present:false,value:undefined};
}
const get = (root:unknown,field:string) => own(root,field).value;
const configured = (value:unknown): InspectionValue => ({status:"configured",configured:Boolean(value)});
const policy = (value:string): InspectionValue => ({status:"policy",policy:value});
function list(value:unknown, ctx:InspectionContext, refs?:Parameters<InspectionContext["reference"]>[0]):InspectionValue {
  if (!Array.isArray(value)) return {status:"unsupported",reason:"invalid_value"};
  if (value.length>32) return {status:"omitted",reason:"size_limit"};
  const values = value.map((entry) => refs && typeof entry === "string" ? {status:"value" as const,value:ctx.reference(refs,entry)} : scalar(entry,ctx.redact));
  return values.every((entry) => entry.status === "value")
    ? {status:"values",values:values.map((entry) => entry.value)} : {status:"unsupported",reason:"invalid_value"};
}
function fields(scope:Scope, root:unknown, control:string, ctx:InspectionContext) {
  const out:InspectionField[]=[];
  const add = (id:string, effective:InspectionValue, saved?:InspectionValue) => {
    const stored=own(root,id);
    out.push({id,scope,control,saved:saved ?? (stored.present ? scalar(stored.value,ctx.redact) : {status:"absent"}),effective});
  };
  return {out, add,
    scalar:(id:string,fallback:unknown) => add(id,scalar(get(root,id) ?? fallback,ctx.redact)),
    bool:(id:string,defaultOn=false) => add(id,{status:"value",value:defaultOn ? get(root,id)!==false : Boolean(get(root,id))}),
    opaque:(id:string) => {const v=get(root,id);add(id,configured(v),own(root,id).present?configured(v):{status:"absent"});},
    list:(id:string,refs?:Parameters<InspectionContext["reference"]>[0]) => {
      const v=get(root,id);add(id,list(v ?? [],ctx,refs),own(root,id).present?list(v,ctx,refs):{status:"absent"});
    },
  };
}
function selection(raw:unknown, prefix:string, target:ReturnType<typeof fields>, ctx:InspectionContext, primary=false) {
  const instance=get(raw,"instanceId"),model=get(raw,"model");
  const absent=raw===undefined || raw===null;
  target.add(prefix,absent ? primary ? {status:"unknown",reason:"missing_stored_model_selection"} : policy("none selected") :
    typeof instance === "string" && typeof model === "string" ? policy(ctx.instanceIds.has(instance)?"explicit selection; runtime eligibility not probed":"instance unavailable; dispatch may use an eligible backup or fail") : {status:"unsupported",reason:"invalid_value"},
    raw===undefined?{status:"absent"}:raw===null?{status:"value",value:null}:configured(true));
  if (typeof instance === "string") target.add(`${prefix}.instance`,{status:"value",value:ctx.reference("workspace.engines",instance)},configured(true));
  if (typeof model === "string") target.add(`${prefix}.model`,scalar(model,ctx.redact),scalar(model,ctx.redact));
}

export function inspectAgentSettings(root:unknown, ctx:InspectionContext):InspectionField[] {
  const f=fields("agent",root,"Agent > Settings and sidebar controls",ctx);
  for (const [id,fallback] of [["name",""],["title",""],["description",""],["color",null],["shape",null],["seniority",1],["mascotExpression",null],["section",null],["pinOrder",null]] as const) f.scalar(id,fallback);
  f.bool("notifications",true);f.bool("pinned");f.add("browser",{status:"value",value:get(root,"browser")===true});f.bool("speakReplies");f.bool("engineHooks",true);
  f.scalar("approvals","ask");
  f.add("approvals.context",policy("saved preference; deny rules, shared-room, guest, rehearsal and hiring restrictions still apply"),{status:"absent"});
  const computer=get(root,"computer");f.add("computer",{status:"value",value:typeof computer === "string" && ["cloud","sandbox","local","off"].includes(computer)?computer:"auto"});f.add("computer.context",policy("automatic selection and room/routine overrides resolve at turn dispatch; inspection does not create or discover a computer"),{status:"absent"});
  const effort=get(root,"effort");f.add("effort",policy(effort?"explicit preference; engine support and turn dispatch determine application":"engine default"));
  if(effort) f.add("effort.selected",scalar(effort,ctx.redact),scalar(effort,ctx.redact));
  const cwd=get(root,"cwd");f.opaque("cwd");f.add("cwd.context",policy(cwd?"explicit folder; existence and turn context not probed":"own workspace unless a room/project turn supplies its desk"),{status:"absent"});
  f.bool("composio",true);f.add("composio.effective",{status:"value",value:get(root,"composio")!==false && ctx.connectorsConfigured},{status:"absent"});
  f.bool("recallBeforeTurn",true);f.add("recallBeforeTurn.effective",{status:"value",value:get(root,"recallBeforeTurn")!==false && ctx.workspaceRecall},{status:"absent"});
  f.add("recallBeforeTurn.context",policy("Enabled preferences apply only to eligible personal owner turns; rooms, guests, routines, rehearsals, commands, fallback/retry and continuing turns are excluded; inspection does not run recall"),{status:"absent"});
  f.add("tools.context",policy("Tool switches and attachments are preferences, not permission to invoke; shared-room and guest turns intersect them with room grants, engine/plan eligibility, approvals and other dispatch restrictions"),{status:"absent"});
  f.list("skills");f.list("skillIds","projects.skills");f.list("mcpServers","workspace.apps");f.list("withoutComponents");
  f.add("avatarAt",configured(get(root,"avatarAt")),own(root,"avatarAt").present?configured(get(root,"avatarAt")):{status:"absent"});
  f.opaque("voice");const voice=get(root,"voice");
  if (voice) for (const id of ["provider","id","name"]) f.add(`voice.${id}`,scalar(get(voice,id)??null,ctx.redact),scalar(get(voice,id)??null,ctx.redact));
  selection(get(root,"modelSelection"),"modelSelection",f,ctx,true);selection(get(root,"backupSelection"),"backupSelection",f,ctx);
  return f.out;
}

export function inspectRoomSettings(root:unknown,ctx:InspectionContext):InspectionField[] {
  const f=fields("room",root,"Room > Settings, desk, Share and sidebar controls",ctx);
  for(const [id,fallback] of [["name",""],["section",null],["pinOrder",null]] as const)f.scalar(id,fallback);
  for(const id of ["leadOnly","archived","pinned"])f.bool(id);
  f.list("memberIds","agent");f.opaque("cwd");f.opaque("pinnedCwd");
  const desk=own(root,"pinnedCwd");f.add("desk.policy",policy(desk.value===undefined?"fixed on first dispatch":desk.value===null?"each agent keeps its own folder":"fixed room desk; filesystem state not probed"),{status:"absent"});
  const sharing=get(root,"sharing");f.add("sharing",configured(sharing),own(root,"sharing").present?configured(sharing):{status:"absent"});
  if(sharing) {
    const s=fields("room",sharing,"Room > Share",ctx);
    for(const [id,fallback] of [["history","join"],["spendCap",0]] as const)s.scalar(id,fallback);
    s.add("creation.policy",policy(`new shared rooms start with a monthly cap of ${DEFAULT_SPEND_CAP}; an existing missing cap means no cap, as does zero; creation defaults do not rewrite existing rooms`),{status:"absent"});
    const toolsChoice=get(sharing,"tools");s.add("tools",toolsChoice === "conversation" || toolsChoice === "desk" ? {status:"value",value:toolsChoice} : {status:"unknown",reason:"invalid_or_missing_stored_tool_policy"});
    for(const id of ["collaboratorsInvite","activityDetail","collaboratorsApprove"])s.bool(id);
    s.list("memoryFor","agent");s.opaque("chat");
    const tools=get(sharing,"ownerTools");for(const id of ["connectors","browser","computer"])s.add(`ownerTools.${id}`,{status:"value",value:Boolean(get(tools,id))},own(tools,id).present?scalar(get(tools,id),ctx.redact):{status:"absent"});
    s.add("ownerTools.mcp",list(get(tools,"mcp")??[],ctx,"workspace.apps"),own(tools,"mcp").present?list(get(tools,"mcp"),ctx,"workspace.apps"):{status:"absent"});
    s.add("approval.policy",policy("grants allow requests, not unattended execution; shared owner-tool grants require Team, a Claude approval checkpoint and the agent's own grants; approvals and spending gates remain; collaborator approvals need Team plus the owner's explicit setting"),{status:"absent"});
    f.out.push(...s.out.map((row)=>({...row,id:`sharing.${row.id}`})));
  }
  return f.out;
}

export type AutomationKind="routine"|"watcher"|"workflow"|"webhook"|"goal";
export function inspectAutomationSettings(kind:AutomationKind,root:unknown,ctx:InspectionContext):InspectionField[]{
  const controls={routine:'Calendar > Routine',watcher:'Automations > Watchers',workflow:'Automations > Workflows',webhook:'Automations > Webhooks',goal:'Conversation > Goal'};
  const f=fields('automation',root,controls[kind],ctx);
  if(kind!=='goal'){f.scalar('name','');f.bool('enabled');}
  const target=(id:string,category:SettingsCategory)=>{
    const value=get(root,id);f.add(id,typeof value==='string'?{status:'value',value:ctx.reference(category,value)}:{status:'absent'},own(root,id).present?configured(value):{status:'absent'});
  };
  if(kind==='routine'){
    f.scalar('targetKind',null);target('targetId',get(root,'targetKind')==='room'?'room':'agent');f.opaque('prompt');
    for(const [id,fallback] of [['time',null],['every',null],['repeat','weekly'],['date',null],['durationMin',null],['runsOn','agent preference']] as const)f.scalar(id,fallback);
    f.list('days');f.add('quiet',{status:'value',value:isQuiet({targetKind:get(root,'targetKind'),every:get(root,'every'),quiet:get(root,'quiet')} as Parameters<typeof isQuiet>[0])});f.opaque('thread');
    const hours=get(root,'activeHours');for(const id of ['from','to'])f.add(`activeHours.${id}`,scalar(get(hours,id)??null,ctx.redact),own(hours,id).present?scalar(get(hours,id),ctx.redact):{status:'absent'});
    f.add('thread.policy',policy(get(root,'thread')?'named existing or new conversation at run':'first conversation, normally General'),{status:'absent'});
    f.add('dispatch.policy',policy('existing missed-run grace and current turn limit apply; inspection never evaluates or runs the routine'),{status:'absent'});
  }else if(kind==='watcher'){
    target('botId','agent');f.scalar('kind',null);f.opaque('target');f.opaque('instruction');f.opaque('mentions');
    f.scalar('mode','act');f.scalar('every',30);f.opaque('thread');f.scalar('approvedBy',null);
    f.add('check.policy',policy('check commands require their existing approval; inspection never looks or runs a check'),{status:'absent'});
  }else if(kind==='webhook'){
    target('botId','agent');target('blokId','room');target('workflowId','automations');f.opaque('thread');f.opaque('token');
    f.add('ingress.policy',policy('secret ingress URLs and delivery payloads are excluded; inspection does not invoke the hook'),{status:'absent'});
  }else if(kind==='goal'){
    f.opaque('text');f.opaque('check');f.add('budget',scalar(get(root,'budget'),ctx.redact));f.scalar('status',null);
    f.add('creation.policy',policy('new goals default to twenty turns; a malformed existing budget is not replaced by that default'),{status:'absent'});
  }else{
    const trigger=get(root,'trigger');
    for(const id of ['kind','targetKind'])f.add(`trigger.${id}`,scalar(get(trigger,id)??null,ctx.redact),own(trigger,id).present?scalar(get(trigger,id),ctx.redact):{status:'absent'});
    const from=get(trigger,'from');f.add('trigger.from',{status:'value',value:from==='anyone'?'anyone':'user'},own(trigger,'from').present?scalar(from,ctx.redact):{status:'absent'});
    for(const id of ['contains','emoji'])f.add(`trigger.${id}`,configured(get(trigger,id)),own(trigger,id).present?configured(get(trigger,id)):{status:'absent'});
    const targetId=get(trigger,'targetId');f.add('trigger.targetId',typeof targetId==='string'?{status:'value',value:ctx.reference(get(trigger,'targetKind')==='room'?'room':'agent',targetId)}:{status:'absent'},configured(targetId));
    const steps=get(root,'steps');
    if(!Array.isArray(steps))f.add('steps',{status:'unsupported',reason:'invalid_value'});
    else if(steps.length>MAX_STEPS)f.add('steps',{status:'omitted',reason:'size_limit'},configured(true));
    else for(const [i,step] of steps.entries()){
      const prefix=`steps.${i+1}`;
      const action=get(step,'action');f.add(`${prefix}.action`,scalar(action,ctx.redact),scalar(action,ctx.redact));
      const tid=get(step,'targetId');f.add(`${prefix}.targetId`,typeof tid==='string'?(action==='approve'?configured(tid):{status:'value',value:ctx.reference(action==='post'?'room':'agent',tid)}):policy('preceding ask conversation where supported'),configured(tid));
      f.add(`${prefix}.text`,configured(get(step,'text')),configured(get(step,'text')));
      const when=get(step,'when');f.add(`${prefix}.when`,configured(when),configured(when));
      if(when){
        f.add(`${prefix}.when.op`,scalar(get(when,'op'),ctx.redact),scalar(get(when,'op'),ctx.redact));
        for(const id of ['left','right'])f.add(`${prefix}.when.${id}`,configured(get(when,id)),configured(get(when,id)));
      }
      if(action==='approve'){
        const minutes=get(step,'timeoutMin');
        const safe=minutes==null||['number','boolean','string'].includes(typeof minutes);
        const resolved=safe?waitUntil({timeoutMin:minutes} as Parameters<typeof waitUntil>[0],0)/60000:NaN;
        f.add(`${prefix}.timeoutMin`,scalar(resolved,ctx.redact),own(step,'timeoutMin').present?scalar(minutes,ctx.redact):{status:'absent'});
        const timeout=get(step,'onTimeout');f.add(`${prefix}.onTimeout`,{status:'value',value:timeout==='continue'?'continue':'stop'},own(step,'onTimeout').present?scalar(timeout,ctx.redact):{status:'absent'});
      }
    }
  }
  return f.out;
}

export function inspectProjectSettings(root:unknown,ctx:InspectionContext):InspectionField[]{
  const f=fields('project',root,'Projects > Project settings and sidebar',ctx);
  for(const [id,fallback] of [['name',''],['brief',''],['color',null],['shape',null]] as const)f.scalar(id,fallback);
  f.opaque('folders');f.list('include');f.list('memberIds','agent');f.add('archived',configured(get(root,'archivedAt')),own(root,'archivedAt').present?configured(get(root,'archivedAt')):{status:'absent'});
  f.add('folders.policy',policy('configured folder references; filesystem standing is not probed by inspection'),{status:'absent'});
  return f.out;
}
export function inspectSkillSettings(root:unknown,ctx:InspectionContext):InspectionField[]{
  const f=fields('skill',root,'Skills > Library and agent attachments',ctx);
  const omitted=get(root,'omitted');
  for(const [id,fallback] of [['name',''],['description',''],['source',null],['version',null]] as const){
    if(Array.isArray(omitted) && omitted.includes(id))f.add(id,{status:'omitted',reason:'size_limit'},{status:'omitted',reason:'size_limit'});
    else f.scalar(id,fallback);
  }
  for(const id of ['body','registry','sha256'])f.opaque(id);
  f.add('content.policy',policy('instruction bodies and registry locations are configured status; this is owner-observed metadata, not a filesystem refresh'),{status:'absent'});
  return f.out;
}
export function inspectRuleSettings(root:unknown,ctx:InspectionContext):InspectionField[]{
  const f=fields('workspace',root,'Settings > Rules and approvals',ctx);
  for(const [id,fallback] of [['effect',null],['field',null],['op',null]] as const)f.scalar(id,fallback);
  f.bool('enabled');f.opaque('value');const id=get(root,'botId');f.add('botId',typeof id==='string'?{status:'value',value:ctx.reference('agent',id)}:policy('all agents'),own(root,'botId').present?configured(id):{status:'absent'});
  f.add('evaluation.policy',policy('enabled deny rules precede allows; inspection never evaluates a command or grants permission'),{status:'absent'});
  return f.out;
}
