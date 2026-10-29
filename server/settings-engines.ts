import { own, type InspectionContext } from "./settings-records.ts";
import { scalar, type InspectionField, type InspectionValue } from "./settings-inspection.ts";
import { PROVIDER_SPECS, CUSTOM_SPEC } from "./providers.ts";
import { CREDITS_SPEC } from "./credits.ts";
const get=(root:unknown,key:string)=>own(root,key).value;
const configured=(raw:unknown):InspectionValue=>({status:'configured',configured:Boolean(raw)});
const policy=(value:string):InspectionValue=>({status:'policy',policy:value});

/** Input is the registry owner's retained construction input, not a newly
 * resolved instance map. Health, models and auth are never probed here. */
export function inspectEngineSettings(input:unknown,ctx:InspectionContext,loaded:boolean):InspectionField[]{
  const out:InspectionField[]=[];const control='Settings > Engines and keys';
  const add=(id:string,saved:InspectionValue,effective:InspectionValue)=>out.push({id,scope:'workspace',control,saved,effective});
  const simple=(id:string,fallback:unknown)=>{const stored=own(input,id);add(id,stored.present?scalar(stored.value,ctx.redact):{status:'absent'},scalar(stored.value??fallback,ctx.redact));};
  for(const [id,fallback] of [['driver',null],['displayName',null],['accentColor',null],['enabled',true]] as const)simple(id,fallback);
  add('loaded',{status:'absent'},{status:'value',value:loaded});
  const environment=own(input,'environment');add('environment',environment.present?configured(environment.value):{status:'absent'},configured(environment.value));
  const config=own(input,'config');add('config',config.present?configured(config.value):{status:'absent'},policy(config.value===undefined?'driver defaults at last registry load':'explicit driver configuration at last registry load'));
  const driver=get(input,'driver');const raw=config.value;
  const addConfig=(id:string,effective:InspectionValue,opaque=false)=>{
    const stored=own(raw,id);add(`config.${id}`,stored.present?(opaque?configured(stored.value):scalar(stored.value,ctx.redact)):{status:'absent'},effective);
  };
  if(driver==='claudeAgent'){
    const mode=get(raw,'permissionMode');
    addConfig('cli',configured(typeof get(raw,'cli')==='string'?get(raw,'cli'):'driver default'),true);
    addConfig('permissionMode',mode===undefined?{status:'value',value:'acceptEdits'}:typeof mode==='string' && ['acceptEdits','auto','bypassPermissions'].includes(mode)?{status:'value',value:mode}:{status:'unsupported',reason:'invalid_value'});
  }else if(driver==='codex' || driver==='antigravity' || typeof driver==='string' && ['geminiCli','opencode','commandcode','grokCli','pi','cursor','cline'].includes(driver)){
    const cli=get(raw,'cli');addConfig('cli',configured(typeof cli==='string' && (driver==='codex'||cli)?cli:'driver default'),true);
    addConfig('fullAuto',{status:'value',value:get(raw,'fullAuto')===true});
  }else if(driver==='boxAgent'){
    const poll=get(raw,'pollMs');addConfig('pollMs',scalar(typeof poll==='number'?poll:2500,ctx.redact));
  }else if([...PROVIDER_SPECS,CUSTOM_SPEC,CREDITS_SPEC].some((spec)=>spec.kind===driver)){
    const spec=[...PROVIDER_SPECS,CUSTOM_SPEC,CREDITS_SPEC].find((entry)=>entry.kind===driver)!;
    const url=get(raw,'url'),keyEnv=get(raw,'apiKeyEnv');
    addConfig('url',configured(typeof url==='string' && url?url.replace(/\/+$/,''):spec.url),true);
    addConfig('apiKeyEnv',configured(typeof keyEnv==='string'?keyEnv:'driver default'),true);
    // the driver's own reading: a spec that promises tools has them, an
    // opt-in one only on a literal true, anything else is chat only
    addConfig('tools',{status:'value',value:spec.tools===true||(spec.toolsOptIn===true && get(raw,'tools')===true)});
    // pictures read the same way: the provider's word, or a literal true
    addConfig('vision',{status:'value',value:spec.vision===true||get(raw,'vision')===true});
  }else{
    add('config.coverage',{status:'absent'},{status:'unknown',reason:'driver_projection_unsupported'});
  }
  add('eligibility',{status:'absent'},policy('configuration and loaded presence are not readiness, authentication or permission to invoke; current restriction owners remain authoritative'));
  return out;
}

export function inspectProviderCredential(saved:unknown,runtime:unknown):InspectionField[]{
  const control='Settings > Engines and keys';return ['key','url'].map((id):InspectionField=>{
    const value=own(saved,id);return {id,scope:'workspace',control,saved:value.present?configured(value.value):{status:'absent'},effective:configured(get(runtime,id))};
  });
}
export function inspectCustomEndpoint(root:unknown,ctx:InspectionContext):InspectionField[]{
  const out:InspectionField[]=[];const control='Settings > Engines and keys > Your endpoints';
  const add=(id:string,value:InspectionValue)=>out.push({id,scope:'workspace',control,saved:own(root,id).present?value:{status:'absent'},effective:value});
  add('name',scalar(get(root,'name')??'',ctx.redact));add('url',configured(get(root,'url')));
  const keys=get(root,'keys');add('keys',configured(keys));
  const named=get(root,'activeKeyId');add('activeKeyId',configured(named));
  add('tools',{status:'value',value:get(root,'tools')===true});
  add('vision',{status:'value',value:get(root,'vision')===true});
  const entries=Array.isArray(keys)?keys:[];
  const chosen=entries.find((key)=>get(key,'id')===named && get(key,'key'))??entries.find((key)=>Boolean(get(key,'key')));
  out.push({id:'activeCredential',scope:'workspace',control,saved:{status:'absent'},effective:configured(chosen)});
  return out;
}
