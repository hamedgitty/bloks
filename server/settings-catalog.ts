import { own, inspectAgentSettings, inspectRoomSettings, inspectAutomationSettings, inspectProjectSettings, inspectSkillSettings, inspectRuleSettings, type InspectionContext, type AutomationKind } from "./settings-records.ts";
import { inspectWorkspaceCategory, inspectMcpSettings } from "./settings-workspace.ts";
import { inspectEngineSettings, inspectProviderCredential, inspectCustomEndpoint } from "./settings-engines.ts";
import { inspectionRedactor } from "./settings-redaction.ts";
import { scalar, type WorkspaceInspectionInput, type InspectionField } from "./settings-inspection.ts";
import type { SettingsPages, SettingsCategory } from "./settings-pages.ts";
import type { observedSkillLibrary } from "./skills.ts";
import type { SettingsWindows } from "./settings-windows.ts";

const get=(root:unknown,key:string)=>own(root,key).value;
const array=(raw:unknown):unknown[]=>Array.isArray(raw)?raw:[];
const id=(raw:unknown)=>typeof get(raw,'id')==='string'?get(raw,'id') as string:null;
const values=(root:unknown):[string,unknown][]=>root && typeof root==='object' && !Array.isArray(root)
  ? Object.entries(Object.getOwnPropertyDescriptors(root)).flatMap(([key,d])=>'value' in d?[[key,d.value] as [string,unknown]]:[]) : [];
type Row={id:string;visible:boolean;project:()=>object};
export interface SettingsCatalogInput {
  agentId:string|null;
  workspace:WorkspaceInspectionInput;
  savedObservation:{source:string;observedAt:number}|null;
  bots:readonly unknown[];rooms:readonly unknown[];projects:readonly unknown[];
  routines:readonly unknown[];watchers:readonly unknown[];workflows:readonly unknown[];hooks:readonly unknown[];rules:readonly unknown[];
  profileNotes:readonly unknown[];sidebarSections:readonly string[];
  skills:ReturnType<typeof observedSkillLibrary>;
  engines:readonly {id:string;input:unknown;loaded:boolean}[];
  ownerDevices:readonly unknown[];
  windows:ReturnType<SettingsWindows['inspect']>;
  boot:{version:string;port:number;listening:'loopback'|'network';timezone:string|null;remoteEnabled:boolean};
}

/** Plain owner inputs only. No lazy disk owners, registry methods, transport
 * probes or action callbacks belong in this projection boundary. */
export function settingsCatalog(category:SettingsCategory,input:SettingsCatalogInput,pages:SettingsPages):Row[]{
  const redact=inspectionRedactor(input.workspace.saved,input.workspace.runtime,...input.engines.map((e)=>({instances:{one:e.input}})));
  const reference=(c:SettingsCategory,id:string)=>pages.reference(c,
    c==='workspace.engines'?`instance:${id}`:c==='workspace.apps'?`mcp:${id}`:c==='projects.skills'?`skill:${id}`:c==='automations'?`workflow:${id}`:id);
  const ctx:InspectionContext={redact,reference,instanceIds:new Set(input.engines.filter((e)=>e.loaded).map((e)=>e.id)),
    workspaceRecall:get(get(input.workspace.runtime,'recall'),'beforeTurn')!==false,connectorsConfigured:Boolean(get(get(input.workspace.runtime,'composio'),'key'))};
  const workspace={...input.workspace,redact};
  const provenance={source:'loaded owner state',saved:input.savedObservation,liveFileFreshness:'not probed'};
  const record=(key:string,project:()=>object,visible=true):Row=>({id:key,visible,project});
  const projected=(key:string,project:()=>InspectionField[],visible=true)=>record(key,()=>({provenance,fields:project()}),visible);
  const canRoom=(roomId:unknown)=>input.agentId===null || typeof roomId==='string' && input.rooms.some((r)=>id(r)===roomId && array(get(r,'memberIds')).includes(input.agentId));
  const relatedRoomAllowed=(kind:unknown,target:unknown)=>kind!=='room'||canRoom(target);
  const canWorkflow=(w:unknown)=>{
    const trigger=get(w,'trigger');return relatedRoomAllowed(get(trigger,'targetKind'),get(trigger,'targetId')) &&
      array(get(w,'steps')).every((s)=>get(s,'action')!=='post'||canRoom(get(s,'targetId')));
  };
  if(category==='agent')return input.bots.flatMap((bot)=>{
    const key=id(bot);return key?[projected(key,()=>inspectAgentSettings(bot,ctx))]:[];
  });
  if(category==='room')return input.rooms.flatMap((room)=>{
    const key=id(room);return key?[projected(key,()=>inspectRoomSettings(room,ctx),canRoom(key))]:[];
  });
  if(category==='automations'){
    const rows:Row[]=[];
    const add=(kind:AutomationKind,root:unknown,visible:boolean,key=id(root))=>{if(key)rows.push(projected(`${kind}:${key}`,()=>inspectAutomationSettings(kind,root,ctx),visible));};
    for(const r of input.routines)add('routine',r,relatedRoomAllowed(get(r,'targetKind'),get(r,'targetId')));
    for(const w of input.watchers)add('watcher',w,input.agentId===null||get(w,'botId')===input.agentId);
    for(const w of input.workflows)add('workflow',w,canWorkflow(w));
    for(const h of input.hooks){
      const workflowId=get(h,'workflowId');
      const workflowAllowed=input.agentId===null||!workflowId||input.workflows.some((w)=>id(w)===workflowId&&canWorkflow(w));
      add('webhook',h,workflowAllowed&&(!get(h,'blokId')||canRoom(get(h,'blokId'))));
    }
    for(const bot of input.bots)if(input.agentId===null||id(bot)===input.agentId){
      for(const lane of array(get(bot,'tasks')))if(get(lane,'goal'))add('goal',get(lane,'goal'),true,`${id(bot)}:${id(lane)}`);
    }
    return rows;
  }
  if(category==='projects.skills'){
    const rows:Row[]=[];
    for(const p of input.projects){const key=id(p);if(key)rows.push(projected(`project:${key}`,()=>inspectProjectSettings(p,ctx),input.agentId===null||array(get(p,'memberIds')).includes(input.agentId)));}
    const observation=input.skills.lastObserved;
    rows.push(record('library-observation',()=>({source:'natural skill-owner reads only',freshness:'last observed, not a filesystem attestation',
      lastObservedAt:observation?.observedAt??null,ownerChangedAt:observation?.invalidatedAt??null,lastAttempt:input.skills.lastAttempt,
      omittedItems:observation?.omittedItems??null,status:observation?'last-observed':'unknown'})));
    if(observation)for(const skill of observation.items)rows.push(projected(`skill:${skill.id}`,()=>inspectSkillSettings(skill,ctx)));
    input.sidebarSections.forEach((section,i)=>rows.push(record(`section:${section}`,()=>({control:'Sidebar > Section order',position:i+1,name:scalar(section,redact)}))));
    return rows;
  }
  if(category==='workspace.engines'){
    const rows=input.engines.map((e)=>projected(`instance:${e.id}`,()=>inspectEngineSettings(e.input,ctx,e.loaded)));
    const saved=get(input.workspace.saved,'providers'),runtime=get(input.workspace.runtime,'providers');
    for(const [kind,provider] of values(runtime))rows.push(projected(`provider:${kind}`,()=>inspectProviderCredential(get(saved,kind),provider)));
    rows.push(projected('legacy:xai',()=>inspectProviderCredential(get(input.workspace.saved,'xai'),get(input.workspace.runtime,'xai'))));
    for(const endpoint of array(get(input.workspace.runtime,'custom'))){const key=id(endpoint);if(key)rows.push(projected(`custom:${key}`,()=>inspectCustomEndpoint(endpoint,ctx)));}
    return rows;
  }
  if(category==='workspace.policy')return input.rules.flatMap((r)=>{const key=id(r);return key?[projected(key,()=>inspectRuleSettings(r,ctx))]:[];});
  if(category==='device.browser'||category==='device.native'){
    const rows:Row[]=[record('observation-boundary',()=>({control:'Device-owned controls',status:input.windows.windows.length?'dated-client-observations':'unknown',
      evictedObservations:input.windows.evictedObservations,recordBounds:input.windows.limits,
      meaning:'recent reports are authenticated observations, not independently attested current UI; expiry retains values'}))];
    for(const window of input.windows.windows)rows.push(record(window.label,()=>{
      const previous=window.lastReported;
      const fields=previous?Object.entries(previous.snapshot.values).filter(([key])=>category==='device.native'?/^(native|window)\./.test(key):!/^(native|window)\./.test(key))
        .map(([key,value])=>({id:key,control:deviceControl(key),reported:value})):null;
      return {windowReference:pages.reference('device.browser',window.label),source:{path:window.source.path,identity:window.source.identity,
        deviceReference:window.source.deviceId?pages.reference('workspace.devices',`device:${window.source.deviceId}`):null},
        transportKnowledge:window.transport,freshness:window.freshness,lastReported:previous?{
          issuedAt:previous.issuedAt,receivedAt:previous.receivedAt,clientObservedAt:previous.snapshot.observedAt,
          revision:previous.snapshot.revision,sequence:previous.sequence,currentGeneration:previous.currentGeneration,fields,
        }:null};
    }));
    return rows;
  }
  if(category==='workspace.about')return [record('build',()=>({control:'Settings > About and updates',version:scalar(input.boot.version,redact),nativeUpdateState:'see dated device.native observations; no update check performed'}))];
  if(category==='workspace.launch')return [record('server',()=>({control:'Server launch and config.json',source:'server boot and already-loaded configuration',
    port:input.boot.port,listening:input.boot.listening,timeZone:input.boot.timezone,arbitraryEnvironment:'excluded'}))];
  const rows:Row[]=[projected('workspace',()=>{
    const fields=inspectWorkspaceCategory(category,workspace,ctx);
    if(category==='workspace.devices')for(const field of fields){
      if(field.id==='remote.enabled')field.effective={status:'value',value:input.boot.remoteEnabled};
      if(field.id==='remote.listening')field.effective={status:'value',value:input.boot.listening};
    }
    return fields;
  })];
  if(category==='workspace.apps')for(const server of array(get(input.workspace.runtime,'mcpServers'))){const key=id(server);if(key)rows.push(projected(`mcp:${key}`,()=>inspectMcpSettings(server,redact)));}
  if(category==='workspace.profile')for(const note of input.profileNotes){const key=id(note);if(key && get(note,'state')==='kept')rows.push(record(`note:${key}`,()=>({control:'Settings > About you > Kept notes',text:scalar(get(note,'text'),redact)})));}
  if(category==='workspace.channels')for(const [botId,binding] of values(get(get(input.workspace.runtime,'telegram'),'bots'))){
    rows.push(record(`telegram:${botId}`,()=>({control:'Settings > Chat and email > Telegram',agentReference:pages.reference('agent',botId),
      configured:Boolean(get(binding,'token')),enabled:get(binding,'enabled')===true,ownerPaired:get(binding,'ownerUserId')!==undefined,
      pairingConfigured:Boolean(get(binding,'pairing'))})));
  }
  if(category==='workspace.devices')for(const device of input.ownerDevices){const key=id(device);if(key && !get(device,'personId'))rows.push(record(`device:${key}`,()=>({control:'Settings > Phone and devices',name:scalar(get(device,'name'),redact),identity:'paired-owner-device',connection:'not inferred from pairing'})));}
  return rows;
}

function deviceControl(key:string):string {
  if(key.startsWith('theme.')||key.startsWith('conversations.'))return 'Settings > General > Appearance';
  if(key.startsWith('sidebar.'))return 'Sidebar collapse and fold controls';
  if(key.startsWith('desktop.'))return 'Desktop chat dock, drag and resize controls';
  if(key.startsWith('terminal.'))return 'Conversation > Terminal and divider';
  if(key.startsWith('room.'))return 'Room > Topics and stream';
  if(key==='native.mode'||key==='native.hostConfigured')return 'Settings > Phone and devices';
  if(key==='native.quickAskRegistered')return 'Settings > General > Quick ask shortcut';
  if(key==='native.updateState')return 'Settings > About and updates';
  if(key.startsWith('native.'))return 'Operating system permissions and native capability';
  return 'Window and viewport controls';
}
