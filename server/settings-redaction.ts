// Defense in depth for permitted human text. Opaque fields are still excluded
// by the projectors. This never discovers credentials or reads an auth file.
import { own } from "./settings-records.ts";
const get=(root:unknown,key:string)=>own(root,key).value;
function values(raw:unknown):unknown[] {
  if(!raw || typeof raw!=="object")return [];
  return Object.values(Object.getOwnPropertyDescriptors(raw)).flatMap((entry)=>"value" in entry?[entry.value]:[]);
}

export function inspectionRedactor(...roots:unknown[]):(text:string)=>string {
  const protectedText=new Set<string>();
  const add=(raw:unknown)=>{
    // Match the existing credential redactor: common short command/URL
    // fragments must not rewrite permitted names and descriptions.
    if(typeof raw!=="string" || raw.length<8)return;
    protectedText.add(raw);protectedText.add(encodeURIComponent(raw));
  };
  const map=(raw:unknown)=>{for(const value of values(raw))add(value);};
  const url=(raw:unknown)=>{
    add(raw);
    if(typeof raw!=="string")return;
    try {
      const parsed=new URL(raw);add(decodeURIComponent(parsed.username));add(decodeURIComponent(parsed.password));
      for(const value of parsed.searchParams.values())add(value);
      for(const part of parsed.pathname.split('/'))if(part)add(decodeURIComponent(part));
      if(parsed.hash)add(decodeURIComponent(parsed.hash.slice(1)));
    } catch { /* no opaque URL or parse error is returned */ }
  };
  for(const root of roots){
    for(const [section,keys] of [
      ['xai',['key']],['composio',['key','apiKey']],['speech',['elevenlabsKey','openaiKey']],
      ['box',['token']],['relay',['agentToken','clientToken']],
    ] as const)for(const key of keys)add(get(get(root,section),key));
    const providers=get(root,'providers');for(const provider of values(providers)){add(get(provider,'key'));url(get(provider,'url'));}
    url(get(get(root,'xai'),'url'));url(get(get(root,'composio'),'url'));url(get(get(root,'relay'),'url'));
    map(get(root,'secrets'));
    for(const instance of values(get(root,'instances')))map(get(instance,'environment'));
    for(const endpoint of values(get(root,'custom'))){
      url(get(endpoint,'url'));for(const key of values(get(endpoint,'keys')))add(get(key,'key'));
    }
    const chat=get(root,'chat');
    for(const [channel,keys] of [
      ['slack',['botToken','appToken']],['discord',['token']],
      ['whatsapp',['token','appSecret','verifyToken']],
    ] as const)for(const key of keys)add(get(get(chat,channel),key));
    url(get(get(chat,'whatsapp'),'webhookUrl'));
    const telegram=get(root,'telegram');
    for(const binding of [telegram,get(telegram,'pending'),...values(get(telegram,'bots'))]){
      add(get(binding,'token'));add(get(binding,'pairing'));add(get(binding,'generation'));
    }
    for(const server of values(get(root,'mcpServers'))){
      map(get(server,'headers'));map(get(server,'env'));map(get(server,'args'));add(get(server,'command'));url(get(server,'url'));
      for(const value of values(get(server,'headers')))if(typeof value==='string' && /^Bearer\s+\S+$/i.test(value))add(value.replace(/^Bearer\s+/i,''));
    }
    const remote=get(root,'remote');for(const category of ['devices','memberDevices'])for(const device of values(get(remote,category))){add(get(device,'hash'));add(get(device,'id'));}
  }
  const secrets=[...protectedText].sort((a,b)=>b.length-a.length);
  return (text:string)=>{
    let out=text;for(const secret of secrets)out=out.split(secret).join('[redacted]');
    return out.replace(/\b(sk|ck|ak|gsk|xai)[-_][A-Za-z0-9_-]{12,}/g,'[redacted]')
      .replace(/\bblok_live_[0-9a-f]{32}\b/g,'[redacted]');
  };
}
