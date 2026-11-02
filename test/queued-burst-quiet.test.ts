// GitHub 461: words that waited for a turn to finish go together in the
// next one (drainSteer). When the person's own words are among another
// agent's, that turn is theirs: nothing in it may invite the bare quiet
// word, a bare QUIET that comes anyway is never their answer, and their
// words say whose they are and sit right above the reply.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarness, type Harness } from "./helpers/server.ts";

// A scripted engine. Each turn takes the next plan for its slot, writes
// down what it was told, says its items, and can hold until released.
const CLI = String.raw`#!__NODE__
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir=__DIR__, kind='__KIND__', slot='__SLOT__';
const out=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log(kind==='codex'?'codex-cli 9.9.9':'2.1.299 (Claude Code)');process.exit();}
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit();}
if(process.argv.includes('auth')){out({loggedIn:true});process.exit();}
const words=c=>typeof c==='string'?c:Array.isArray(c)?c.map(x=>x?.text??'').join(''):'';
const run=async(told)=>{
 const path=dir+'/plan-'+slot+'.json', plans=JSON.parse(readFileSync(path,'utf8')), p=plans.shift()??{items:[]};writeFileSync(path,JSON.stringify(plans));
 appendFileSync(dir+'/told-'+slot+'.jsonl',JSON.stringify(told)+'\n');
 if(p.capture)writeFileSync(dir+'/token-'+slot,process.env.BLOKS_TOKEN??'');
 if(kind==='codex')out({method:'turn/started',params:{threadId:'thread',turn:{id:'native',status:'inProgress'}}});
 else out({type:'system',subtype:'init',session_id:'fixture',model:'claude-sonnet-5'});
 for(const [i,item] of (p.items??[]).entries()) {
  if(kind==='codex')out({method:'item/completed',params:{threadId:'thread',item:{id:'item'+i,type:'agentMessage',...item}}});
  else out({type:'assistant',message:{id:'item'+i,model:'claude-sonnet-5',content:[{type:'text',text:item.text}],usage:{input_tokens:1,output_tokens:1}}});
 }
 writeFileSync(dir+'/ready-'+slot,'yes');
 if(p.hold){const until=Date.now()+14000;while(!existsSync(dir+'/release-'+slot)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));}
 if(kind==='codex')out({method:'turn/completed',params:{threadId:'thread',turn:{id:'native',status:'completed'}}});
 else out({type:'result',subtype:'success',is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,result:'ok'});
};
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(kind==='claudeAgent'){if(m.type==='user')await run(words(m.message?.content));return;}
 if(m.method==='model/list')return out({id:m.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',isDefault:true}]}});
 if(m.method==='thread/start'||m.method==='thread/resume')return out({id:m.id,result:{thread:{id:'thread'},model:'gpt-6.1-sol'}});
 if(m.method==='turn/start'){out({id:m.id,result:{turn:{id:'native',status:'inProgress'}}});await run((m.params?.input??[]).map(x=>x.text??'').join(''));return;}
 if(m.id!==undefined)out({id:m.id,result:{}});
});
`;

let h: Harness, home: string;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait(check: () => boolean | Promise<boolean>, why: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  assert.fail(`${why}\n${h.logs().slice(-1500)}`);
}
const plan = (slot: string, p: unknown[]) => {
  writeFileSync(join(home, `plan-${slot}.json`), JSON.stringify(p));
  for (const f of ["ready", "release", "token"]) rmSync(join(home, `${f}-${slot}`), { force: true });
};
const told = (slot: string): string[] =>
  existsSync(join(home, `told-${slot}.jsonl`)) ? readFileSync(join(home, `told-${slot}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const hire = async (name: string, slot: string, kind: string) => {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
  await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: slot, model: kind === "claudeAgent" ? "claude-sonnet-5" : "gpt-6.1-sol" } }) });
  return (await h.json("/api/bots")).bots.find((x: any) => x.id === bot.id);
};
const busy = async (b: any) => (await h.json("/api/bots")).bots.find((x: any) => x.id === b.id).busy;
const said = async (b: any) => (await h.json(`/api/bots/${b.id}/messages?thread=${b.threadId}&limit=500`)).messages.filter((m: any) => !b.messages.some((g: any) => g.id === m.id)) as any[];
const ask = async (b: any, text: string, extra: Record<string, unknown> = {}, token?: string) => {
  const r = await h.fetch(`/api/bots/${b.id}/messages`, {
    method: "POST",
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    body: JSON.stringify({ text, ...extra }),
  });
  assert.ok(r.ok, await r.text());
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "bloks-burst-quiet-"));
  mkdirSync(join(home, ".bloks"));
  const instances: Record<string, unknown> = {};
  for (const [slot, kind] of [["sender", "codex"], ["receiver", "claudeAgent"]]) {
    const cli = join(home, `${slot}.mjs`);
    writeFileSync(cli, CLI.replaceAll("__NODE__", process.execPath).replaceAll("__DIR__", JSON.stringify(home)).replaceAll("__KIND__", kind).replaceAll("__SLOT__", slot), { mode: 0o755 });
    instances[slot] = { driver: kind, config: { cli } };
    plan(slot, []);
  }
  writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ instances }));
  h = await startHarness({ HOME: home, USERPROFILE: home });
});
after(async () => { await h?.stop(); rmSync(home, { recursive: true, force: true }); });

/** Holds a turn of another agent open for its credential, so the test
 * can speak as that agent while the receiver is busy. */
async function asAgent(go: (token: string) => Promise<void>) {
  plan("sender", [{ items: [], hold: true, capture: true }]);
  const sender = await hire("Planner", "sender", "codex");
  await ask(sender, "Coordinate the neutral work");
  await wait(() => existsSync(join(home, "token-sender")) && readFileSync(join(home, "token-sender"), "utf8").length > 0, "no sender credential");
  try { await go(readFileSync(join(home, "token-sender"), "utf8")); }
  finally { writeFileSync(join(home, "release-sender"), "yes"); await wait(async () => !(await busy(sender)), "sender never settled"); }
}

test("a burst with the person's words in it never invites QUIET, labels their words, puts them last, and hides a bare QUIET", async () => {
  await asAgent(async (token) => {
    plan("receiver", [{ items: [{ text: "First answer" }], hold: true }, { items: [{ text: "QUIET" }] }]);
    const receiver = await hire("Builder", "receiver", "claudeAgent");
    await ask(receiver, "Build the neutral thing");
    await wait(() => existsSync(join(home, "ready-receiver")), "the first turn never ran");
    // while it works: another agent, the person, the agent again
    await ask(receiver, "Status from the planner, part one", {}, token);
    await ask(receiver, "Did the build pass?", { delivery: "wait" });
    await ask(receiver, "Status from the planner, part two", {}, token);
    await wait(async () => (await said(receiver)).filter((m: any) => m.queued).length === 3, "the three messages did not wait");
    rmSync(join(home, "ready-receiver"));
    writeFileSync(join(home, "release-receiver"), "yes");
    await wait(() => told("receiver").length === 2, "the waiting words never started a turn");
    await wait(async () => !(await busy(receiver)), "the burst turn never settled");
    await pause(200);

    const prompt = told("receiver")[1];
    // the agent's words carry who sent them and how to answer, and no
    // invitation to end the person's turn on the quiet word
    assert.match(prompt, /A message from Planner, another agent/);
    assert.doesNotMatch(prompt, /QUIET/);
    // the person's words say whose they are, and come last
    assert.match(prompt, /\(From the person\. It waited for this turn\.\)\n\nDid the build pass\?$/);
    assert.ok(prompt.indexOf("part two") < prompt.indexOf("Did the build pass?"), "the person's words were not last");

    const all = await said(receiver);
    const first = all.findIndex((m: any) => m.text === "First answer");
    const after = all.slice(first + 1).filter((m: any) => m.kind === "text" || m.kind === "notice");
    // in the chat as the agent heard them: the agent's two, then the person's
    assert.deepEqual(after.slice(0, 3).map((m: any) => m.text), ["Status from the planner, part one", "Status from the planner, part two", "Did the build pass?"]);
    assert.ok(after[2].deliveredAt && after[2].queuedAt < after[2].deliveredAt, "the person's message lost when it was written");
    // the bare quiet word is not their answer, and the chat says so
    assert.ok(!all.some((m: any) => m.role === "bot" && m.kind === "text" && m.text === "QUIET"), "a bare QUIET was shown as the reply");
    const notice = after.at(-1);
    assert.equal(notice?.kind, "notice");
    assert.equal(notice?.text, "Builder finished this turn without a reply to you.");
  });
});

test("a burst of only another agent's words still may end quietly", async () => {
  await asAgent(async (token) => {
    plan("receiver", [{ items: [{ text: "Working" }], hold: true }, { items: [{ text: "QUIET" }] }]);
    const receiver = await hire("Checker", "receiver", "claudeAgent");
    const before = told("receiver").length;
    await ask(receiver, "Check the neutral thing");
    await wait(() => existsSync(join(home, "ready-receiver")), "the first turn never ran");
    await ask(receiver, "Planner note one", {}, token);
    await ask(receiver, "Planner note two", {}, token);
    await wait(async () => (await said(receiver)).filter((m: any) => m.queued).length === 2, "the notes did not wait");
    rmSync(join(home, "ready-receiver"));
    writeFileSync(join(home, "release-receiver"), "yes");
    await wait(() => told("receiver").length === before + 2, "the notes never started a turn");
    await wait(async () => !(await busy(receiver)), "the burst turn never settled");
    await pause(200);
    const prompt = told("receiver")[before + 1];
    assert.match(prompt, /answer with exactly QUIET and nothing else/);
    assert.doesNotMatch(prompt, /From the person/);
    const all = await said(receiver);
    assert.ok(!all.some((m: any) => m.role === "bot" && (m.text === "QUIET" || m.kind === "notice")), "a quiet agent burst left something behind");
  });
});

test("the person's own waiting words alone are told as they were written", async () => {
  plan("receiver", [{ items: [{ text: "Working" }], hold: true }, { items: [{ text: "Here is the answer" }] }]);
  const receiver = await hire("Writer", "receiver", "claudeAgent");
  const before = told("receiver").length;
  await ask(receiver, "Write the neutral thing");
  await wait(() => existsSync(join(home, "ready-receiver")), "the first turn never ran");
  await ask(receiver, "And add a title", { delivery: "wait" });
  await wait(async () => (await said(receiver)).some((m: any) => m.queued), "the words did not wait");
  rmSync(join(home, "ready-receiver"));
  writeFileSync(join(home, "release-receiver"), "yes");
  await wait(() => told("receiver").length === before + 2, "the words never started a turn");
  await wait(async () => !(await busy(receiver)), "the turn never settled");
  assert.equal(told("receiver")[before + 1], "And add a title");
});
