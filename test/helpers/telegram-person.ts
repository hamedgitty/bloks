import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";

export const SAM = 10101, LEE = 20202;
export const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function removeFixture(root: string): Promise<void> {
  // A stopped metadata probe can close its cache a moment after the
  // harness. Retry this fixture's directory only, never any host path.
  for (let attempt = 0; ; attempt++) {
    try { rmSync(root, { recursive: true, force: true }); return; }
    catch (error) { if (attempt === 5) throw error; await nap(150 * (attempt + 1)); }
  }
}
export async function until<T>(check: () => T | false | undefined | Promise<T | false | undefined>, message: string): Promise<T> {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await nap(40); }
  throw new Error(message);
}

/** Protocol fixture, not proof of the vendor's sandbox. The installed
 * native engines have a separate synthetic-provider exercise. */
function engine(root: string, kind: "codex" | "claude"): string {
  const file = join(root, `fixture-${kind}.mjs`);
  writeFileSync(file, `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {spawnSync} from 'node:child_process';
const root=${JSON.stringify(root)},kind=${JSON.stringify(kind)},args=process.argv.slice(2);
if(args[0]==='--version'){console.log(kind==='codex'?'codex-cli 0.160.0':'2.1.291 (Claude Code)');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
const out=f=>process.stdout.write(JSON.stringify(f)+'\\n');
const log=f=>appendFileSync(join(root,'engine.jsonl'),JSON.stringify({pid:process.pid,...f})+'\\n');
const person=process.env.BLOKS_TOKEN?.startsWith('blr_');
const groupOwner=!person&&Boolean(process.env.BLOKS_REPLY_TOKEN);
let thread='fixture-'+process.pid,turn='turn-'+process.pid;
let guard,working=false,late=false,lateAfterEnd;
const pending=new Map();
const broker=(frame)=>new Promise((resolve,reject)=>{
 let socket;
 if(kind==='claude')socket=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.bloks.args[1];
 else if(groupOwner){const prefix='mcp_servers.bloks_reply.args=';socket=JSON.parse(args.find(a=>a.startsWith(prefix)).slice(prefix.length))[1]}
 else throw new Error('Restricted Codex person fixture must never start');
 const connection=createConnection(socket);connection.on('error',reject);connection.on('connect',()=>connection.write(JSON.stringify({...frame,id:'fixture-'+Math.random()})+'\\n'));
 createInterface({input:connection}).once('line',line=>{connection.end();resolve(JSON.parse(line))});
});
const reply=()=>broker({t:'reply',input:{text:'Hello Lee'}});
async function work(text){
 const systemFile=args.indexOf('--append-system-prompt-file');
 const system=systemFile<0?'':readFileSync(args[systemFile+1],'utf8');
 log({kind,person,groupOwner,codexHome:process.env.CODEX_HOME,replyToken:process.env.BLOKS_REPLY_TOKEN,replyPath:process.env.BLOKS_REPLY_PATH,text,token:process.env.BLOKS_TOKEN,url:process.env.BLOKS_URL,guard,args,system});
 const scenario=text.match(/FAKE_([A-Z]+)\\s*$/)?.[1];
 if(kind==='claude'&&scenario==='LATE'){
   late=true;
   const socket=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.bloks.args[1];
   await new Promise((resolve,reject)=>{
     const connection=createConnection(socket);connection.on('error',reject);
     connection.on('connect',()=>{
       // connect only confirms the client's end. A refused empty reply
       // confirms the broker has accepted and is reading this socket,
       // without sending text, before the result retires the listener.
       connection.write(JSON.stringify({t:'reply',id:'late-ready',input:{}})+'\\n');
       lateAfterEnd=()=>{
         out({type:'system',subtype:'init',session_id:'late-person-session',model:'claude-sonnet-5',permissionMode:'default',mcp_servers:[{name:'bloks',status:'connected'}]});
         out({type:'assistant',message:{content:[{type:'text',text:'LATE_PERSON_TEXT'}]}});
         connection.write(JSON.stringify({t:'ask',id:'late-person',tool:'Bash',input:{command:'touch synthetic-marker'}})+'\\n');
       };
     });
     createInterface({input:connection}).on('line',line=>{
       const answer=JSON.parse(line);
       if(answer.id==='late-ready'){
         log({lateReady:answer});
         out({type:'result',subtype:'success',is_error:false,result:'Private transcript only.'});
         return;
       }
       if(answer.id==='late-reply'){log({lateReply:answer});connection.end();resolve();return}
       if(answer.id!=='late-person')return;
       log({lateAnswer:answer});if(answer.behavior==='allow')writeFileSync(join(root,'effect'),'late effect');
       if(groupOwner)connection.write(JSON.stringify({t:'reply',id:'late-reply',input:{text:'LATE_GROUP_REPLY'}})+'\\n');
       else{connection.end();resolve()}
     });
   });
   return;
 }
 if(kind==='claude'&&scenario==='TERMINAL'){
   const socket=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.bloks.args[1];
   log({terminalSocket:socket});
   const answer=await broker({t:'ask',tool:'Bash',input:{command:'touch synthetic-active-marker'}});
   log({activeOwnerAsk:answer});
   if(answer.behavior==='allow')writeFileSync(join(root,'active-effect'),'active owner allowed');
   while(!existsSync(join(root,'finish-terminal')))await new Promise(r=>setTimeout(r,30));
 }
 if(scenario==='HOLD'){
   writeFileSync(join(root,'held'),'1');
   while(!existsSync(join(root,'release')))await new Promise(r=>setTimeout(r,30));
 }
 if(scenario==='APPROVE'){
   let answer;
   if(kind==='codex')answer=await new Promise(r=>{pending.set(900,r);out({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'write',command:'touch synthetic-marker',reason:'Synthetic writing escalation'}})});
   else answer=await broker({t:'ask',tool:'Bash',input:{command:'touch synthetic-marker'}});
   if(answer.decision==='accept'||answer.behavior==='allow')writeFileSync(join(root,'effect'),'approved');
 }
 if(scenario==='QUESTION'){
   const answer=kind==='claude'
     ?await broker({t:'ask',kind:'question',tool:'ask_user',input:{question:'Which day?'}})
     :await new Promise(r=>{pending.set(901,r);out({id:901,method:'item/tool/requestUserInput',params:{threadId:thread,turnId:turn,itemId:'question',questions:[{id:'q',question:'Which day?',options:[]}]}})});
   log({questionAnswer:answer});
 }
 if(scenario==='BLOKS'){
   log({questionAnswer:await broker({t:'ask',kind:'question',tool:'ask_user',input:{question:'Which day?'}})});
   log({secretAnswer:await broker({t:'ask',kind:'question',tool:'request_secret',input:{name:'Synthetic service key'}})});
   log({connectionAnswer:await broker({t:'ask',kind:'question',tool:'request_connection',input:{apps:['synthetic_service']}})});
 }
 if(groupOwner&&scenario==='CLI'){
   const said=spawnSync(process.execPath,[process.env.BLOKS_CLI,'reply','Hello group from CLI'],{env:process.env,encoding:'utf8'});
   log({cliReply:{status:said.status,stdout:said.stdout,stderr:said.stderr,error:said.error?String(said.error):undefined}});
 }else if((person||groupOwner)&&scenario!=='TEXT')log({reply:await reply()});
 if(kind==='codex'){
   out({method:'item/completed',params:{threadId:thread,turnId:turn,item:{id:'answer',type:'agentMessage',text:person?'Private transcript only.':'Owner answer.'}}});
   out({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
 }else{
   out({type:'assistant',message:{content:[{type:'text',text:person?'Private transcript only.':'Owner answer.'}]}});
   out({type:'result',subtype:'success',is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:thread,result:'finished'});
 }
}
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(kind==='claude'){
   if(m.type==='control_request'){
     if(person&&m.request.subtype==='mcp_status'&&existsSync(join(root,'hold-person-guard'))){
       writeFileSync(join(root,'person-guard-held'),'1');
       while(!existsSync(join(root,'release-person-guard')))await new Promise(r=>setTimeout(r,20));
     }
     const mount=JSON.parse(readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.bloks;
     const names=mount.env?.BLOKS_PUBLISH?.split(',')??['approve','ask_user','request_secret'];
     const response=m.request.subtype==='initialize'?{commands:[],current_permission_mode:'default'}:{mcpServers:[{name:'bloks',status:'connected',tools:names.map(name=>({name}))}]};
     const bad=person&&existsSync(join(root,'guard-case'))?readFileSync(join(root,'guard-case'),'utf8'):'';
     if(bad==='claude-mode'&&m.request.subtype==='initialize')response.current_permission_mode='bypassPermissions';
     if(bad==='claude-server'&&m.request.subtype==='mcp_status')response.mcpServers.push({name:'synthetic_account',status:'connected',tools:[{name:'read_history'}]});
     return out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}});
   }
   if(m.type==='user'){
     if(working){log({steered:m.message.content});return}
     working=true;
     out({type:'system',subtype:'init',session_id:thread,model:'claude-sonnet-5',permissionMode:'default',mcp_servers:[{name:'bloks',status:'connected'}]});
     await work(m.message.content);working=false;return;
   }
   return;
 }
 if(!m.method){pending.get(m.id)?.(m.result);pending.delete(m.id);return}
 const respond=result=>out({id:m.id,result});
 if(m.method==='initialize')return respond({});
 if(m.method==='initialized')return;
 if(m.method==='model/list')return respond({data:[{model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true}]});
 if(m.method==='skills/list')return respond({data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]});
 if(m.method==='config/read')return respond({config:{cli_auth_credentials_store:'file'}});
 if(m.method==='thread/start'||m.method==='thread/resume'){
   guard=m.params;thread=m.params.threadId??thread;
   if(existsSync(join(root,'hold-thread'))){
     writeFileSync(join(root,'thread-held'),'1');
     while(!existsSync(join(root,'release-thread')))await new Promise(r=>setTimeout(r,20));
   }
   return respond({thread:{id:thread},model:'gpt-6.1-sol',approvalPolicy:m.params.approvalPolicy,approvalsReviewer:'user',sandbox:{type:'dangerFullAccess',networkAccess:true},activePermissionProfile:null});
 }
 if(m.method==='turn/steer'){log({steered:m.params});return respond({})}
 if(m.method!=='turn/start')return respond({});
 respond({turn:{id:turn}});out({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
 await work(m.params.input.filter(i=>i.type==='text').map(i=>i.text).join(''));
});
// The driver closes stdin while processing result. Its EOF is the
// protocol signal to send the late frames, rather than a guessed delay.
process.stdin.on('end',()=>{if(!late)process.exit(0);lateAfterEnd?.()});
`, { mode: 0o755 });
  return file;
}

export interface PersonFixtureOptions {
  cli?: string;
  env?: Record<string, string>;
  seed?: (root: string) => void;
  files?: Record<string, Uint8Array>;
  /** The owner's opt-in to group messages, turned on once paired. Most
   * of these fixtures are about what groups do once it is given; a test
   * of the default passes false. */
  groups?: boolean;
}

/** Claude Code is the engine a person's turn runs on; a Codex agent holds it. */
export async function personFixture(t: TestContext, kind: "codex" | "claude" = "claude", options: PersonFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "bloks-telegram-people-"));
  mkdirSync(join(root, ".bloks")); mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-file-login" }));
  writeFileSync(join(root, ".bloks/config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli: kind === "codex" && options.cli ? options.cli : engine(root, "codex"), fullAuto: true } }, claude: { driver: "claudeAgent", config: { cli: kind === "claude" && options.cli ? options.cli : engine(root, "claude"), permissionMode: "bypassPermissions" } } } }));
  options.seed?.(root);
  const updates: any[] = [], calls: any[] = [];
  const sendFailures = new Map<string, "disconnect" | number>();
  let next = 1, messageId = 100;
  const stub = createServer((req, res) => {
    const parts: Buffer[] = []; req.on("data", (b) => parts.push(b)); req.on("end", () => {
      const method = req.url!.split("/").pop(); const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
      if (req.url?.startsWith("/file/")) {
        const id = method!.replace(/\.png$/, ""); calls.push({ method: "file", body: { file_id: id } });
        const bytes = options.files?.[id];
        res.statusCode = bytes ? 200 : 404; res.setHeader("content-type", "image/png"); return res.end(bytes ? Buffer.from(bytes) : "missing");
      }
      const call: any = { method, body }; calls.push(call); res.setHeader("content-type", "application/json");
      if (method === "sendMessage" && sendFailures.has(body.text)) {
        const fault = sendFailures.get(body.text)!;
        if (fault === "disconnect") { req.socket.destroy(); return; }
        res.statusCode = fault; res.end(JSON.stringify({ ok: false, description: "synthetic refusal", error_code: fault })); return;
      }
      const result = method === "getMe" ? { id: 12345, is_bot: true, username: "PlanningBot" } : method === "getUpdates" ? updates.filter((u) => u.update_id >= body.offset) : method === "sendMessage" ? { message_id: ++messageId } : method === "getFile" && options.files?.[body.file_id] ? { file_path: `${body.file_id}.png` } : true;
      if (method === "sendMessage") call.messageId = (result as { message_id: number }).message_id;
      setTimeout(() => res.end(JSON.stringify({ ok: true, result })), method === "getUpdates" ? 25 : 0);
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubURL = `http://127.0.0.1:${(stub.address() as any).port}`;
  const env = { HOME: root, CODEX_HOME: join(root, ".codex"), NODE_OPTIONS: `--import=${new URL("./telegram-fetch.mjs", import.meta.url).href}`, BLOKS_TEST_TELEGRAM_URL: stubURL, COMPOSIO_KEY: "", ELEVENLABS_API_KEY: "", ...options.env };
  let h: Awaited<ReturnType<typeof startHarness>>;
  try { h = await startHarness(env); } catch (error) { stub.closeAllConnections(); stub.close(); await removeFixture(root); throw error; }
  t.after(async () => { try { await h.stop(); } finally { stub.closeAllConnections(); stub.close(); await removeFixture(root); } });
  const ownerJson = async (path: string, init: RequestInit = {}): Promise<any> => {
    const response = options.env?.BLOKS_STATIC_DIR ? await h.fetchAs(h.url, path, init) : await h.fetch(path, init);
    const body = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, body })); return body;
  };
  const post = (path: string, body: unknown = {}) => ownerJson(path, { method: "POST", body: JSON.stringify(body) });
  const { bot } = await post("/api/bots", { name: "Planning" });
  const configured = await ownerJson(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: kind, model: kind === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5" }, approvals: "full" }) });
  assert.equal(configured.bot.approvals, "full");
  function say(text: string, fromId = SAM, extra: any = {}) {
    const update = { update_id: next++, message: { message_id: next, chat: { id: fromId, type: "private" }, from: { id: fromId, is_bot: false, first_name: fromId === SAM ? "Sam" : "Lee" }, text, ...extra } };
    updates.push(update);
    return update.message.message_id as number;
  }
  const pair = await post(`/api/bots/${bot.id}/telegram`, { token: "12345:TEST_ONLY_TOKEN", pair: true });
  assert.ok(pair.pairing); say(pair.pairing);
  await until(() => calls.some((c) => c.method === "sendMessage" && c.body.text.startsWith("Paired.")), "the owner did not pair");
  if (options.groups !== false) assert.equal((await post(`/api/bots/${bot.id}/telegram`, { groups: true })).groups, true);
  const messages = async (): Promise<any[]> => (await ownerJson(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`)).messages;
  const records = (): any[] => {
    if (!existsSync(join(root, "engine.jsonl"))) return [];
    // Another process may still be appending the last frame. Read complete
    // newline-delimited records only; a malformed completed frame still fails.
    const lines = readFileSync(join(root, "engine.jsonl"), "utf8").split("\n");
    lines.pop();
    return lines.filter(Boolean).map((line) => JSON.parse(line));
  };
  const status = () => ownerJson(`/api/bots/${bot.id}/telegram`);
  const sent = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
  return { root, bot, post, ownerJson, say, messages, records, status, calls, sent, sendFailures, get h() { return h; },
    async admit(text = "FAKE_REPLY") {
      say(text, LEE);
      const person = await until(async () => (await status()).people.find((p: any) => p.name === "Lee"), "Lee did not knock");
      await post(`/api/bots/${bot.id}/telegram`, { personId: person.id, action: "allow" });
      return person;
    },
    async idle() {
      const settled = async () => !(await ownerJson("/api/bots")).bots.find((b: any) => b.id === bot.id).busy && !(await messages()).some((m) => m.queued);
      await until(async () => (await settled()) && (await nap(150), await settled()), "the turn did not end");
    },
    async flushed() { const wanted = next; await until(() => calls.some((c) => c.method === "getUpdates" && c.body.offset >= wanted), "the bot did not finish reading the updates"); },
    async reboot(change?: () => void) { await h.crash(); change?.(); h = await startHarness(env); },
  };
}
