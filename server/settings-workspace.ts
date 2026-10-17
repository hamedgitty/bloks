import { inspectWorkspaceSettings, scalar, type InspectionField, type InspectionValue, type WorkspaceInspectionInput } from "./settings-inspection.ts";
import { own, type InspectionContext } from "./settings-records.ts";
import { parseBriefTime } from "./brief.ts";
import type { SettingsCategory } from "./settings-pages.ts";

const get=(root:unknown,...path:string[]):unknown=>path.reduce((value,key)=>own(value,key).value,root);
const configured=(value:unknown):InspectionValue=>({status:"configured",configured:Boolean(value)});
const policy=(text:string):InspectionValue=>({status:"policy",policy:text});
function present(root:unknown,path:string[]){return own(path.slice(0,-1).reduce((value,key)=>own(value,key).value,root),path.at(-1)!);}

export function inspectWorkspaceCategory(category:SettingsCategory,input:WorkspaceInspectionInput,selection?:Pick<InspectionContext,'reference'|'instanceIds'>):InspectionField[]{
  const fields:InspectionField[]=[];
  const read=(...path:string[])=>get(input.runtime,...path);
  const add=(path:string[],control:string,effective:InspectionValue,opaque=false)=>{
    const saved=present(input.saved,path);
    fields.push({id:path.join('.'),scope:'workspace',control,saved:saved.present?(opaque?configured(saved.value):scalar(saved.value,input.redact)):{status:'absent'},effective});
  };
  const plain=(path:string[],control:string,effective:unknown)=>add(path,control,scalar(effective,input.redact));
  const opaque=(path:string[],control:string)=>add(path,control,configured(read(...path)),true);
  const core=inspectWorkspaceSettings(input);
  if(category==='workspace.general'){
    fields.push(...core.filter((f)=>/^(compaction|turns|recall|agents|skills|changes|shortcuts)\./.test(f.id)));
    plain(['brief','enabled'],'Brief > Settings',read('brief','enabled')!==false);
    plain(['brief','time'],'Brief > Settings',parseBriefTime(read('brief','time'))??'08:00');
  }else if(category==='workspace.profile')fields.push(...core.filter((f)=>f.id.startsWith('profile.')));
  else if(category==='workspace.voices'){
    fields.push(...core.filter((f)=>f.id.startsWith('speech.')));
    plain(['speech','useDiscoveredOpenAI'],'Settings > Voices > Discovered key consent',Boolean(read('speech','useDiscoveredOpenAI')));
    add(['speech','discoveredKeyAvailability'],'Settings > Voices', {status:'unknown',reason:'auth_discovery_not_run'});
  }else if(category==='workspace.apps'){
    fields.push(...core.filter((f)=>f.id.startsWith('composio.')));
    opaque(['composio','url'],'Settings > Apps and keys');
    opaque(['secrets'],'Agent secure secret cards');
    add(['composio','connectedAccounts'],'Settings > Apps and keys', {status:'unknown',reason:'connection_refresh_not_run'});
  }else if(category==='workspace.computers'){
    fields.push(...core.filter((f)=>f.id.startsWith('box.')));
    plain(['box','sleepAfter'],'Settings > Computers',read('box','sleepAfter')??20);
    add(['computer','localVm'],'Settings > Computers',{status:'unknown',reason:'native_vm_probe_not_run'});
    add(['computer','availability'],'Agent > Computer',{status:'unknown',reason:'cloud_or_local_discovery_not_run'});
  }else if(category==='workspace.backups'){
    plain(['backups','auto'],'Settings > Backups',read('backups','auto')!==false);
    add(['backups','location'],'Settings > Backups',policy('directory beside the workspace data directory; inspection does not create or read backups'));
  }else if(category==='workspace.cloud'){
    plain(['relay','enabled'],'Settings > Bloks Cloud',Boolean(read('relay','enabled')));
    for(const key of ['url','agentToken','clientToken'])opaque(['relay',key],'Settings > Bloks Cloud');
    add(['relay','eligibility'],'Settings > Bloks Cloud',policy('requires pairing enabled, configured relay URL and workspace credential; connection health is not probed'));
  }else if(category==='workspace.devices'){
    plain(['remote','enabled'],'Settings > Phone and devices',read('remote','enabled')===true);
    add(['remote','listening'],'Settings > Phone and devices',{status:'unknown',reason:'boot_listener_metadata_required'});
    add(['remote','identity'],'Settings > Phone and devices',policy('owner devices only; member devices and pairing admission material are excluded'));
  }else if(category==='workspace.channels'){
    for(const [channel,keys] of [
      ['slack',['botToken','appToken']],['discord',['token']],
      ['whatsapp',['token','phoneNumberId','appSecret','verifyToken','number','webhookUrl']],
      ['email',['id','domain','allowFrom']],
    ] as const){
      const control='Settings > Chat and email';
      plain(['chat',channel,'enabled'],control,Boolean(read('chat',channel,'enabled')));
      for(const key of keys)opaque(['chat',channel,key],control);
    }
    add(['chat','email','allowFromPolicy'],'Settings > Chat and email',policy('an empty allow list accepts anyone who has the address; addresses are configured status only'));
    add(['telegram','legacyConfigured'],'Settings > Chat and email > Telegram',configured(read('telegram','token')),true);
    add(['telegram','pendingMigration'],'Settings > Chat and email > Telegram',configured(read('telegram','pending')),true);
  }else if(category==='workspace.agentDefaults'){
    opaque(['agentDefaults','cwd'],'Settings > New agents > Folder');
    add(['agentDefaults','cwdPolicy'],'Settings > New agents > Folder',policy(read('agentDefaults','cwd')?'saved folder is validated at creation; stale-path fallback is not probed':'own workspace'));
    const approvals=read('agentDefaults','approvals');
    add(['agentDefaults','approvals'],'Settings > New agents > Approvals',!approvals?{status:'value',value:'ask'}:typeof approvals === 'string' && ['ask','edits','auto','full'].includes(approvals)?{status:'value',value:approvals}:{status:'unknown',reason:'invalid_stored_approval_mode'});
    add(['agentDefaults','hiringPolicy'],'Settings > New agents > Approvals',policy('an agent hire cannot exceed the hiring agent approvals'));
    const effort=read('agentDefaults','effort');
    add(['agentDefaults','effort'],'Settings > New agents > Effort',effort?policy('explicit preference, applied only where the engine supports it'):policy('engine default'));
    if(effort)plain(['agentDefaults','effortSelected'],'Settings > New agents > Effort',effort);
    opaque(['agentDefaults','modelSelection'],'Settings > New agents > Model');
    const wanted=read('agentDefaults','modelSelection'),instance=get(wanted,'instanceId'),model=get(wanted,'model');
    const decision=!wanted?'automatic selection at creation: ready then available, preferring Claude; not resolved by inspection':
      selection && typeof instance==='string'?(selection.instanceIds.has(instance)?'explicit instance available in loaded metadata; runtime eligibility not probed':'saved instance unavailable; automatic selection at creation, not resolved by inspection'):
      'explicit instance if still available; otherwise automatic selection at creation';
    add(['agentDefaults','modelSelectionPolicy'],'Settings > New agents > Model',policy(decision));
    if(typeof instance==='string')add(['agentDefaults','modelSelection','instanceId'],'Settings > New agents > Model',selection?{status:'value',value:selection.reference('workspace.engines',instance)}:{status:'unknown',reason:'loaded_instance_metadata_required'},true);
    if(typeof model==='string')plain(['agentDefaults','modelSelection','model'],'Settings > New agents > Model',model);
  }else if(category==='workspace.import'){
    add(['setup','imports'],'Settings > Bring your setup',{status:'unknown',reason:'filesystem_discovery_not_run'});
    add(['setup','markers'],'Settings > Bring your setup',policy('completed imports and onboarding markers are lifecycle data, not active preference defaults'));
  }else if(category==='workspace.security'){
    add(['security','checkup'],'Settings > Security checkup',policy('derived checkup, not a separate saved policy; inspection does not scan, probe or repair security state'));
  }else if(category==='workspace.record'){
    add(['record','history'],'Settings > Record',policy('audit history is data, not a setting; inspection does not read or verify the audit record'));
  }else if(category==='device.navigation'){
    add(['navigation','history'],'Sidebar and dismiss controls',policy('selection, last-used, dismissal, onboarding and analytics markers are presentation or lifecycle data; no identifiers or contents are projected'));
  }else if(category==='device.iphone'){
    add(['iphone','coverage'],'iPhone Settings',{status:'unknown',reason:'private_client_contract_dependency_issue_303'});
  }
  return fields;
}

export function inspectMcpSettings(root:unknown,redact:(text:string)=>string):InspectionField[]{
  const out:InspectionField[]=[];const control='Settings > Apps and keys > MCP servers';
  for(const id of ['name','transport','command','args','url','headers','env']){
    const raw=own(root,id);const opaque=!['name','transport'].includes(id);
    const value=opaque?configured(raw.value):scalar(raw.value??null,redact);
    out.push({id,scope:'workspace',control,saved:raw.present?value:{status:'absent'},effective:value});
  }
  return out;
}
