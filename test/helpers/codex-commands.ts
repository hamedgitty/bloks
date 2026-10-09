import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";

export async function waitFor(check: () => unknown | Promise<unknown>, why = "fixture did not finish") {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error(why);
}

export async function codexCommands(t: TestContext, extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "bloks-codex-commands-"));
  const cli = join(root, "fake-codex.mjs");
  const spec = { auto: false, hold: false, compact: "ok", refuseSteer: false, used: 40_000, window: 1_000_000, forgotten: false, holdSkills: false, refuseSkills: false };
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks/config.json"), JSON.stringify({ instances: {
    codex: { driver: "codex", config: { cli } }, other: { driver: "codex", config: { cli } },
  } }));
  writeFileSync(join(root, "spec.json"), JSON.stringify(spec));
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") {console.log("codex-cli 0.160.0");process.exit(0);}
if (process.argv[2] === "login") {console.log("Logged in using ChatGPT");process.exit(0);}
const root = ${JSON.stringify(root)};
process.stdin.on("end",()=>process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m)+"\\n");
const log = (m) => appendFileSync(root+"/calls.jsonl",JSON.stringify(m)+"\\n");
let thread, turn, ended=false, total=0;
const finish = () => {
  if(ended)return;ended=true;
  out({method:"item/completed",params:{threadId:thread,turnId:turn,item:{type:"agentMessage",id:"answer",text:"ANSWER"}}});
  out({method:"turn/completed",params:{threadId:thread,turn:{id:turn,status:"completed"}}});
};
createInterface({input:process.stdin}).on("line",async (line)=>{
  const m=JSON.parse(line);if(!m.method)return;
  const spec=JSON.parse(readFileSync(root+"/spec.json","utf8"));
  const reply=(result={})=>out({id:m.id,result});
  if(m.method==="initialize")return reply();
  if(m.method==="initialized")return;
  if(m.method==="model/list")return reply({data:[{id:"gpt-6.1-sol",model:"gpt-6.1-sol",displayName:"GPT-6.1 Sol",isDefault:true,hidden:false}]});
  log({method:m.method,params:m.params,cwd:process.cwd()});
  if(m.method==="skills/list"){
    if(spec.refuseSkills)return out({id:m.id,error:{code:-1,message:"skills unavailable"}});
    const listed=()=>reply({data:[{cwd:m.params.cwds[0],skills:[
    {name:"selected",description:"A native skill",enabled:true,path:root+"/PLANTED_PATH/SKILL.md"},
    {name:"other-skill",description:"Another skill",enabled:true,path:root+"/OTHER_PATH/SKILL.md"},
    {name:"off",description:"Disabled",enabled:false,path:root+"/DISABLED_PATH/SKILL.md"}
    ],errors:[]}]});
    if(spec.holdSkills){const timer=setInterval(()=>{if(existsSync(root+"/skill-gate")){clearInterval(timer);listed();}},20);return;}
    return listed();
  }
  if(m.method==="thread/start"||m.method==="thread/resume"){
    if(m.method==="thread/resume"&&spec.forgotten)return out({id:m.id,error:{code:-1,message:"forgotten"}});
    thread=m.params.threadId??"native-"+process.pid;return reply({thread:{id:thread},model:"gpt-6.1-sol"});
  }
  if(m.method==="thread/compact/start"){
    if(spec.compact==="reject")return out({id:m.id,error:{code:-1,message:"Compaction refused"}});
    reply();const compact="compact-"+process.pid;
    out({method:"turn/started",params:{threadId:thread,turn:{id:compact}}});
    if(spec.compact==="hold")return;
    out({method:"item/started",params:{threadId:thread,turnId:compact,item:{type:"contextCompaction",id:"manual"}}});
    out({method:"turn/completed",params:{threadId:thread,turn:{id:compact,status:"completed"}}});
    out({method:"item/completed",params:{threadId:thread,turnId:compact,item:{type:"contextCompaction",id:"manual"}}});return;
  }
  if(m.method==="turn/steer"){
    if(spec.refuseSteer)return out({id:m.id,error:{code:-1,message:"Not taken"}});return reply();
  }
  if(m.method!=="turn/start")return reply();
  turn="work-"+process.pid;reply({turn:{id:turn}});
  out({method:"turn/started",params:{threadId:thread,turn:{id:turn}}});
  const text=m.params.input.filter(i=>i.type==="text").map(i=>i.text).join("");
  if(spec.auto){
    total+=spec.used;
    out({method:"thread/tokenUsage/updated",params:{threadId:thread,turnId:turn,tokenUsage:{total:{inputTokens:total,outputTokens:1},last:{inputTokens:spec.used,outputTokens:1},modelContextWindow:spec.window}}});
    out({method:"item/started",params:{threadId:thread,turnId:turn,item:{type:"contextCompaction",id:"automatic"}}});
    out({method:"item/completed",params:{threadId:thread,turnId:turn,item:{type:"contextCompaction",id:"automatic"}}});
    out({method:"item/completed",params:{threadId:thread,turnId:turn,item:{type:"contextCompaction",id:"automatic"}}});
  } else if(spec.used){
    total+=spec.used;
    out({method:"thread/tokenUsage/updated",params:{threadId:thread,turnId:turn,tokenUsage:{total:{inputTokens:total,outputTokens:1},last:{inputTokens:spec.used,outputTokens:1},modelContextWindow:spec.window}}});
  }
  const ping=/PING ([a-z0-9-]+)/.exec(text);
  if(ping)await fetch(process.env.BLOKS_URL+"/api/bots/"+ping[1]+"/messages",{method:"POST",headers:{authorization:"Bearer "+process.env.BLOKS_TOKEN,"content-type":"application/json"},body:JSON.stringify({text:"AGENT $selected",namedSkills:true,skillNames:["selected"]})});
  if(spec.hold||text.includes("HOLD")){
    out({method:"item/started",params:{threadId:thread,turnId:turn,item:{type:"commandExecution",id:"held-tool",command:"$selected hold"}}});
    const timer=setInterval(()=>{if(existsSync(root+"/gate")){clearInterval(timer);finish();}},20);
    const compactTimer=setInterval(()=>{if(existsSync(root+"/auto-start")){clearInterval(compactTimer);out({method:"item/started",params:{threadId:thread,turnId:turn,item:{type:"contextCompaction",id:"held-auto"}}});}},20);
  }else finish();
});
`, { mode: 0o755 });
  const env = { HOME: root, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ELEVENLABS_API_KEY: "", ...extraEnv };
  let h = await startHarness(env);
  t.after(async () => { writeFileSync(join(root, "gate"), ""); await h.crash(); rmSync(root, { recursive: true, force: true }); });
  const post = (path: string, body: unknown = {}) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  const hire = async (name: string) => {
    const { bot } = await post("/api/bots", { name });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    return bot;
  };
  const bot = await hire("Rex");
  // The child may still be writing a long frame. A complete JSONL
  // record ends in a newline; malformed complete records still fail.
  const calls = (): any[] => existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const current = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const s = { root, bot, hire, post, calls, current, get h() { return h; },
    spec: (change: Record<string, unknown>) => writeFileSync(join(root, "spec.json"), JSON.stringify({ ...spec, ...change })),
    say: (text: string, extra: Record<string, unknown> = {}) => post(`/api/bots/${bot.id}/messages`, { text, taskId: bot.threadId, ...extra }),
    messages: async (lane = bot.threadId) => (await h.json(`/api/bots/${bot.id}/messages?thread=${lane}&limit=500`)).messages as any[],
    stored: () => (JSON.parse(readFileSync(join(root, ".bloks/bots.json"), "utf8")) as any[]).find((b) => b.id === bot.id),
    commands: async (lane = bot.threadId) => (await h.json(`/api/bots/${bot.id}/commands?taskId=${lane}`)).commands as any[],
    gate: () => writeFileSync(join(root, "gate"), ""),
    skillsGate: () => writeFileSync(join(root, "skill-gate"), ""),
    startAuto: () => writeFileSync(join(root, "auto-start"), ""),
    async settled() { await waitFor(async () => (await current()).tasks.every((task: any) => task.state === "idle")); },
    async turn(text: string, extra = {}) {
      const n = calls().filter((c) => c.method === "turn/start").length;
      await s.say(text, extra);
      await waitFor(() => calls().filter((c) => c.method === "turn/start").length > n);
      await s.settled();
      return calls().filter((c) => c.method === "turn/start")[n];
    },
    async reboot() { await h.crash(); h = await startHarness(env); },
  };
  return s;
}
