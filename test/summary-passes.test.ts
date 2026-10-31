// Real HTTP turns and a synthetic Claude CLI. A part of a conversation
// too long for one summary request is read whole, in order, in several,
// each carrying the summary so far, and saved once, after the last. A
// request that fails or comes back empty, a summary dropped or written by
// another fold, a message taken back or edited, the lane closed or a stop
// meanwhile saves nothing, and words said meanwhile are in none of them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { HANDOFF_MAX_TOKENS, handoffKeep, keptSummary, planCompaction, SUMMARY_MAX_CHARS, summaryPasses, type Turn } from "../server/context.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** What the synthetic CLI does with the nth summary request and the nth
 * turn: fail, come back empty, never answer, wait to be let go, write a
 * summary this long, be refused as too long, or report this much used. */
interface Control { failAt?: number[]; emptyAt?: number[]; timeoutAt?: number; hold?: number[]; pad?: number; tooLong?: number[]; used?: number }
interface Said { role: "user" | "bot"; text: string; agent?: { dir: "in"; peerId: string; peerName: string }; replyTo?: { author: string; excerpt: string } }
interface Context { summary: string; through: number; at: number }
/** A session that goes on rather than a new one told the story; a model
 * with a smaller window; the lane's summary, or none; the lane beside
 * General rather than General, so it can be closed. */
interface Setup { resumed?: boolean; model?: string; context?: Context | null; aside?: boolean }

const previous: Context = { summary: "Previous fixture summary FACT-0.", through: 1, at: 1234 };
const facts = (text: string) => text.match(/FACT-\d+/g) ?? [];
const has = (text: string, fact: string) => new RegExp(`${fact}(?!\\d)`).test(text);
const LEFT_OUT = /earlier messages? (?:are|is) left out/;
const NEW = "FACT-NEW Carry on with the fixture.";

/** Told as they were said: the first is in the summary already, then
 * long ones, then an end a new session's story has room for most of. */
function plainLane(): Said[] {
  return [
    { role: "user", text: "FACT-0 where it started." },
    ...Array.from({ length: 80 }, (_, k): Said => ({ role: k % 2 ? "bot" : "user", text: `FACT-${k + 1} ${"x".repeat(k < 30 ? 6_000 : 1_500)}` })),
  ];
}

/** An open question, the agent's long replies ending in what they
 * settle, the decision in the middle, the longest message there can be,
 * and an end told with who sent each and what it replies to, one message
 * in it too long for the story to tell whole. */
function longLane(): Said[] {
  const peer = { dir: "in" as const, peerId: randomUUID(), peerName: "Fixture peer" };
  const lane: Said[] = [
    { role: "user", text: "FACT-0 where it started." },
    { role: "user", text: "FACT-1 Should we keep the fixture subscription? Not decided yet." },
    { role: "bot", text: "FACT-2 Open question: the fixture subscription. Pending your call." },
  ];
  for (let i = 3; i < 23; i++) lane.push(i % 2 ? { role: "user", text: `FACT-${i} ${"u".repeat(6_000)}` } : { role: "bot", text: `${"r".repeat(6_000)} FACT-${i}` });
  lane.push({ role: "user", text: "FACT-23 Decided: keep the fixture subscription." });
  lane.push({ role: "bot", text: `Kept. ${"r".repeat(2_000)} FACT-24` });
  lane.push({ role: "user", text: `FACT-25 ${"p".repeat(49_990)} FACT-26 ${"q".repeat(49_980)} FACT-27` });
  for (let i = 28; i < 72; i++) {
    lane.push(
      i === 66
        ? { role: "user", text: `FACT-66 ${"m".repeat(10_000)} MIDDLE-66 ${"m".repeat(10_000)} TAIL-66` }
        : i % 2
          ? { role: "bot", text: `FACT-${i} ${"t".repeat(1_500)}` }
          : i % 4
            ? { role: "user", text: `FACT-${i} ${"a".repeat(1_500)}`, replyTo: { author: "Passes fixture", excerpt: "an earlier fixture message" } }
            : { role: "user", text: `FACT-${i} ${"a".repeat(1_500)}`, agent: peer },
    );
  }
  return lane;
}

const asTurn = (m: Said): Turn => ({ role: m.role === "user" ? "user" : "assistant", text: m.text });

/** How many requests a story's fold of the plain lane takes: told as
 * they were said, its messages are measured here as the server does. */
function plainPasses(lane: Said[]): number {
  const told = lane.slice(previous.through).map(asTurn);
  return summaryPasses(told.slice(0, told.length - handoffKeep(told, HANDOFF_MAX_TOKENS))).length;
}

/** The conversation in a summary request, a message or a part of one at
 * a time. The fixture's words have no blank lines in them. */
function said(input: string) {
  const from = input.indexOf("The conversation:\n") + "The conversation:\n".length;
  return input.slice(from, input.indexOf("\n\nKeep: ")).split("\n\n").map((line) => {
    const [, who, n, of, text] = /^(Them|You)(?: \(part (\d+) of (\d+)\))?: ([\s\S]*)$/.exec(line)!;
    return { role: who === "Them" ? "user" : "bot", part: n ? { n: Number(n), of: Number(of) } : undefined, text };
  });
}

/** Every message the requests read, in order, its parts put back together. */
function reassembled(inputs: string[]) {
  const messages: Array<{ role: string; text: string }> = [];
  let expected: { n: number; of: number } | undefined;
  for (const input of inputs) {
    for (const line of said(input)) {
      assert.deepEqual(line.part?.n === 1 ? undefined : line.part, expected, "a part out of order");
      expected = line.part && line.part.n < line.part.of ? { n: line.part.n + 1, of: line.part.of } : undefined;
      if (line.part && line.part.n > 1) messages[messages.length - 1].text += line.text;
      else messages.push({ role: line.role, text: line.text });
    }
  }
  assert.equal(expected, undefined, "a message's last part was not read");
  return messages;
}

const cliSource = (home: string, records: string, model: string) => `#!${process.execPath}
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2), home=${JSON.stringify(home)}, records=${JSON.stringify(records)};
if(args[0]==="--version"){console.log("2.1.299 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const control=()=>JSON.parse(readFileSync(home+"/control.json","utf8"));
const publish=(name,record)=>{const file=records+"/"+name+".json";writeFileSync(file+".part",JSON.stringify({pid:process.pid,cwd:process.cwd(),...record}));renameSync(file+".part",file);};
// one request at a time, so each one's number is one more than those before it
const next=(prefix)=>readdirSync(records).filter(f=>f.startsWith(prefix)&&f.endsWith(".json")).length+1;
if(args[args.indexOf("--output-format")+1]==="text"){
 let input="";for await(const c of process.stdin)input+=c;
 const n=next("fold-"), set=control(), name=String(n).padStart(3,"0");
 publish("fold-"+name,{n,input});
 if((set.hold??[]).includes(n))while(!existsSync(home+"/release-"+n))await new Promise(r=>setTimeout(r,20));
 if(set.timeoutAt===n){process.on("SIGTERM",()=>{});setInterval(()=>{},1000);}
 else if((set.failAt??[]).includes(n)){console.error("Fixture pass failed");process.exitCode=7;}
 else if((set.emptyAt??[]).includes(n))console.log("   ");
 else{
  // every fact it read, in the summary so far and the conversation, made
  // as long as asked in words a cut can end between
  const read="Read: "+[...new Set(input.match(/FACT-\\d+/g)??[])].join(" ");
  let said=read;
  if(set.pad){said=(read+" "+"z ".repeat(set.pad)).slice(0,set.pad);if(said.endsWith(" "))said=said.slice(0,-1)+"z";}
  publish("out-"+name,{n,said});
  console.log(said);
 }
}else{
 let input="";
 process.stdin.on("data",function take(c){input+=c;
  const lines=input.split("\\n");lines.pop();
  const line=lines.find(s=>s.trim()&&JSON.parse(s).type==="user");if(!line)return;
  process.stdin.off("data",take);
  const content=JSON.parse(line).message.content, n=next("turn-"), set=control();
  publish("turn-"+String(n).padStart(3,"0"),{n,input:typeof content==="string"?content:content.map(b=>b.text??"").join("")});
  const emit=f=>console.log(JSON.stringify(f));
  emit({type:"system",subtype:"init",session_id:"fixture-session",model:${JSON.stringify(model)}});
  const tooLong=(set.tooLong??[]).includes(n);
  const text=tooLong?"Prompt is too long for this model's context window":"A fixture answer.";
  if(tooLong)emit({type:"assistant",error:"invalid_request",message:{content:[{type:"text",text}]}});
  else emit({type:"assistant",message:{content:[{type:"text",text}],usage:{input_tokens:set.used??1,output_tokens:1}}});
  emit({type:"result",subtype:"success",is_error:tooLong,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:text});
  setTimeout(()=>process.exit(0),50);
 });
}
`;

async function fixture(t: TestContext, lane: Said[], control: Control = {}, setup: Setup = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-passes-"));
  const data = join(home, ".bloks"), records = join(home, "calls");
  mkdirSync(data); mkdirSync(records);
  const cli = join(home, "fake-claude.mjs"), id = randomUUID(), threadId = randomUUID(), general = randomUUID();
  const context = setup.context === undefined ? previous : setup.context, model = setup.model ?? "claude-sonnet-5";
  // Another engine served it last, so the next turn is a new session
  // told the story. Resumed, its session goes on, and it folds only
  // when the engine says it is too long or after a turn that filled it.
  const lanes = [
    ...(setup.aside ? [{ id: general, title: "General", createdAt: 1, resumeCursors: {} }] : []),
    { id: threadId, title: setup.aside ? "Aside" : "General", createdAt: setup.aside ? 2 : 1, ...(context ? { context } : {}),
      ...(setup.resumed ? { lastInstanceId: "claude", resumeCursors: { claude: "fixture-session" } } : { lastInstanceId: "previous-engine", resumeCursors: {} }) },
  ];
  const bot = { id, threadId: lanes[0].id, activeTaskId: threadId, name: "Passes fixture", title: "", description: "",
    color: "blue", shape: "circle", createdAt: 1, unread: false, notifications: false, resumeCursors: {},
    modelSelection: { instanceId: "claude", model }, tasks: lanes };
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot]));
  const ids = lane.map(() => randomUUID());
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(lane.map((m, i) => ({ id: ids[i], at: i + 1, kind: "text", ...m }))));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: false, beforeTurn: 0 }, instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  writeFileSync(join(home, "control.json"), JSON.stringify(control));
  writeFileSync(cli, cliSource(home, records, model), { mode: 0o755 });
  const h = await startHarness({ HOME: home, USERPROFILE: home });
  const read = (prefix: string) =>
    readdirSync(records).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(records, n), "utf8")));
  const folds = () => read("fold-") as Array<{ n: number; input: string; pid: number; cwd: string }>;
  const written = () => read("out-") as Array<{ n: number; said: string }>;
  const turns = () => read("turn-") as Array<{ n: number; input: string }>;
  t.after(async () => {
    const children = folds().filter((c) => existsSync(c.cwd));
    for (const child of children) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ } }
    await h.stop();
    for (const child of children) if (child.cwd.startsWith(join(tmpdir(), "bloks-text-"))) rmSync(child.cwd, { recursive: true, force: true, maxRetries: 3 });
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const messages = async () => (await h.json(`/api/bots/${id}/messages?limit=200&thread=${threadId}`)).messages as any[];
  const busy = async () => Boolean((await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy);
  return {
    h, id, threadId, ids, folds, written, turns, messages, busy,
    lane: () => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].tasks.find((t: any) => t.id === threadId),
    stored: () => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].tasks.find((t: any) => t.id === threadId)?.context,
    send: (text: string, extra: object = {}) => h.fetch(`/api/bots/${id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: threadId, ...extra }) }),
    /** Lets the held requests go, or one of them. */
    release: (n?: number) => { for (const k of n === undefined ? control.hold ?? [] : [n]) writeFileSync(join(home, `release-${k}`), "1"); },
    settled: async () => (await messages()).filter((m) => m.kind === "text" && m.text && !m.deleted && !m.queued && !m.unsent),
    summarised: async () => (await messages()).filter((m) => m.kind === "notice" && /were summarised|was summarised/.test(m.text ?? "")).length,
    /** Every turn asked for has been heard or stopped, and no summary
     * request is still running. */
    idle: async (heard: number, ms?: number) => {
      assert.ok(await waitFor(async () => !(await busy()) && turns().length >= heard && folds().every((c) => !existsSync(c.cwd)), ms),
        `the lane did not settle: ${h.logs()}`);
      // the close handler's continuation, before its saved state is read from here
      await h.json("/api/bots?messages=0");
    },
  };
}

describe("a fold read in several requests", { concurrency: 4 }, () => {
  const longest = { ...previous, summary: `Previous fixture summary FACT-0. ${"s".repeat(SUMMARY_MAX_CHARS - 33)}` };
  for (const [pad, prior] of [[0, previous], [8_000, previous], [9_000, longest], [0, null]] as const) {
    test(`a new session's story, after summaries of ${pad ? `${pad} characters` : "a few words"} from ${prior === longest ? "the longest summary" : prior ? "a short one" : "none"}: every folded message read whole, in order`, async (t) => {
      const lane = longLane();
      const f = await fixture(t, lane, { pad }, { context: prior });
      assert.equal((await f.send(NEW)).status, 202);
      await f.idle(1);
      const folds = f.folds(), written = f.written(), context = f.stored();
      assert.ok(folds.length >= 4, `${folds.length} requests: ${f.h.logs()}`);
      // each within the bound, and each carrying the summary the one before wrote
      let summary: string | null = prior?.summary ?? null;
      for (const [i, fold] of folds.entries()) {
        assert.equal(fold.n, i + 1);
        assert.ok(fold.input.length <= 48_760, `request ${fold.n} was ${fold.input.length} characters`);
        if (summary === null) assert.equal(fold.input.includes("Summary so far:"), false);
        else assert.ok(fold.input.includes(`Summary so far:\n${summary}\n\nThe conversation:\n`), `request ${fold.n} did not carry the summary before it`);
        summary = keptSummary(written[i].said).summary;
      }
      // saved once, after the last, at the longest a lane keeps when asked
      assert.equal(context.summary, summary);
      if (pad) assert.ok(summary!.length > 7_900 && summary!.length <= SUMMARY_MAX_CHARS, `${summary!.length} characters`);
      assert.ok(context.at > previous.at);
      assert.equal(await f.summarised(), 1);
      // every message folded, whole and in order, the agent's replies and the longest message too
      const folded = lane.slice(prior?.through ?? 0, context.through);
      assert.deepEqual(reassembled(folds.map((r) => r.input)), folded.map((m) => ({ role: m.role, text: m.text })));
      assert.ok(folded.some((m) => m.text.length > 40_000), "the longest message was not folded");
      for (const m of folded) for (const fact of facts(m.text)) assert.ok(has(context.summary, fact), `${fact} is not in the summary`);
      // the decision was read after the question it settles
      const decided = folds.find((r) => r.input.includes("FACT-23 Decided"))!;
      assert.ok(/Summary so far:\n[^\n]*FACT-1(?!\d)/.test(decided.input), "the decision was read without the question before it");
      // the story: the summary, then every later message, none left out
      const [told, own] = f.turns()[0].input.split("--- the new message ---");
      assert.ok(told.includes(`[Earlier in this conversation, summarised]\n${context.summary}`));
      assert.equal(LEFT_OUT.test(told), false, "the story left messages out");
      for (const m of lane.slice(context.through)) for (const fact of facts(m.text)) assert.ok(has(told, fact), `${fact} is not in the story`);
      // the one too long to tell whole is told, cut in its middle and saying so
      assert.ok(told.includes("TAIL-66") && !told.includes("MIDDLE-66") && /\[\.\.\. \d+ characters left out \.\.\.\]/.test(told), "FACT-66 was not told clipped");
      // the turn's own words, apart from it and from every summary request
      assert.match(own, /FACT-NEW Carry on with the fixture\.\s*$/);
      assert.equal(told.includes("FACT-NEW"), false);
      assert.ok(folds.every((r) => !r.input.includes("FACT-NEW")));
    });
  }

  test("the turn's own words, long and replying to an earlier message, are in no summary and told once, apart from the story", async (t) => {
    const lane = plainLane();
    const f = await fixture(t, lane);
    const words = `FACT-OWN ${"o".repeat(30_000)} FACT-OWN-END`;
    const replyTo = { id: f.ids[40], author: "Passes fixture", excerpt: "an earlier fixture message" };
    assert.equal((await f.send(words, { replyTo })).status, 202);
    await f.idle(1);
    const context = f.stored();
    assert.ok(context.through > previous.through);
    assert.equal(await f.summarised(), 1);
    assert.ok(f.folds().every((r) => !r.input.includes("FACT-OWN")));
    // the summary covers no more than came before it
    const settled = await f.settled();
    assert.ok(context.through <= settled.findIndex((m) => m.text.startsWith("FACT-OWN")), "the summary counts the turn's own words");
    const input = f.turns()[0].input;
    const [told, own] = input.split("--- the new message ---");
    assert.equal(input.split("FACT-OWN ").length, 2, "the turn's own words were told more than once");
    assert.equal(told.includes("FACT-OWN"), false);
    assert.ok(own.includes(`(Replying to Passes fixture's earlier message: "an earlier fixture message")\n\n${words}`));
    assert.equal(LEFT_OUT.test(told), false);
  });

  test("a fold that fits is one request", async (t) => {
    const lane: Said[] = [
      { role: "user", text: "FACT-0 where it started." },
      ...Array.from({ length: 50 }, (_, k): Said => ({ role: k % 2 ? "bot" : "user", text: `FACT-${k + 1} ${"x".repeat(1_500)}` })),
    ];
    const f = await fixture(t, lane);
    assert.equal((await f.send(NEW)).status, 202);
    await f.idle(1);
    assert.equal(f.folds().length, 1);
    assert.ok(f.stored().through > previous.through);
    assert.equal(f.stored().summary, f.written()[0].said);
    assert.equal(LEFT_OUT.test(f.turns()[0].input), false);
  });

  for (const outcome of ["fail", "empty"] as const) {
    for (const which of ["first", "middle", "last"] as const) {
      test(`a request that ${outcome === "fail" ? "fails" : "comes back empty"}, the ${which}, saves nothing`, async (t) => {
        const lane = plainLane();
        const total = plainPasses(lane);
        assert.ok(total >= 3, `${total} requests`);
        const at = which === "first" ? 1 : which === "last" ? total : Math.ceil(total / 2);
        const f = await fixture(t, lane, outcome === "fail" ? { failAt: [at] } : { emptyAt: [at] });
        assert.equal((await f.send(NEW)).status, 202);
        await f.idle(1);
        assert.equal(f.folds().length, at, "a request went out after one failed");
        assert.deepEqual(f.stored(), previous);
        assert.equal(await f.summarised(), 0);
        // and the story says it leaves messages out, rather than passing for whole
        assert.match(f.turns()[0].input, LEFT_OUT);
      });
    }
  }

  test("a request that never answers saves nothing", { timeout: 120_000 }, async (t) => {
    const f = await fixture(t, plainLane(), { timeoutAt: 2 });
    assert.equal((await f.send(NEW)).status, 202);
    await f.idle(1, 90_000);
    assert.equal(f.folds().length, 2);
    assert.deepEqual(f.stored(), previous);
    assert.equal(await f.summarised(), 0);
  });

  test("a summary dropped while a request is out is not brought back", async (t) => {
    const f = await fixture(t, plainLane(), { hold: [2] });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    assert.equal((await f.h.json(`/api/bots/${f.id}/tasks/${f.threadId}/summary`, { method: "DELETE" })).dropped, true);
    f.release();
    await f.idle(1);
    assert.equal(f.folds().length, 2, "a request went out after the summary was dropped");
    assert.equal(f.stored(), undefined);
    assert.equal(await f.summarised(), 0);
  });

  test("a message taken back while a request is out leaves the summary as it was", async (t) => {
    const f = await fixture(t, plainLane(), { hold: [2] });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    // one the first request read
    assert.equal((await f.h.fetch(`/api/threads/${f.threadId}/messages/${f.ids[2]}`, { method: "DELETE" })).status, 200);
    f.release();
    await f.idle(1);
    assert.equal(f.folds().length, 2, "a request went out after a message was taken back");
    assert.deepEqual(f.stored(), previous);
    assert.equal(await f.summarised(), 0);
  });

  // the first request reads the second message, the fifth the 28th
  for (const [which, index] of [["one the first request read", 1], ["one a later request was to read", 27]] as const) {
    test(`a message edited while a request is out, ${which}, leaves the summary as it was`, async (t) => {
      const lane = plainLane();
      const f = await fixture(t, lane, { hold: [2] });
      assert.equal((await f.send(NEW)).status, 202);
      assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
      const edited = await f.h.fetch(`/api/threads/${f.threadId}/messages/${f.ids[index]}`, { method: "PATCH", body: JSON.stringify({ text: "FACT-EDITED in other words." }) });
      assert.equal(edited.status, 200);
      assert.equal((await edited.json()).message.id, f.ids[index]);
      f.release();
      await f.idle(1);
      assert.equal(f.folds().length, 2, "a request went out after a message was edited");
      assert.ok(f.folds()[0].input.includes(lane[1].text), "the first request did not read the second message");
      assert.equal(f.folds()[0].input.includes(lane[27].text), false);
      assert.deepEqual(f.stored(), previous);
      assert.equal(await f.summarised(), 0);
      assert.match(f.turns()[0].input, LEFT_OUT);
    });
  }

  for (const which of ["first", "last"] as const) {
    test(`a stop while the ${which} request is out ends the turn before it starts, with nothing saved`, async (t) => {
      const lane = plainLane();
      const at = which === "first" ? 1 : plainPasses(lane);
      const f = await fixture(t, lane, { hold: [at] });
      assert.equal((await f.send(NEW)).status, 202);
      assert.ok(await waitFor(() => f.folds().length === at), f.h.logs());
      assert.equal((await f.h.fetch(`/api/bots/${f.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: f.threadId }) })).status, 200);
      f.release();
      await f.idle(0);
      assert.equal(f.folds().length, at, "a request went out after the stop");
      assert.deepEqual(f.stored(), previous);
      assert.equal(await f.summarised(), 0);
      assert.equal(f.turns().length, 0, "the engine heard the stopped turn");
      assert.ok((await f.messages()).some((m) => /Stopped before .* had started on it/.test(m.text ?? "")), f.h.logs());
    });
  }

  test("words sent while a request is out wait for their own turn and are in no summary", async (t) => {
    const f = await fixture(t, plainLane(), { hold: [2] });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    assert.equal((await f.send("FACT-LATER And one more thing.")).status, 202);
    assert.equal((await f.messages()).find((m) => m.text?.includes("FACT-LATER"))?.queued, true);
    f.release();
    await f.idle(2);
    const context = f.stored();
    assert.ok(context.through > previous.through);
    assert.equal(await f.summarised(), 1);
    assert.ok(f.folds().every((r) => !r.input.includes("FACT-LATER")));
    assert.ok((await f.settled()).findIndex((m) => m.text.includes("FACT-LATER")) >= context.through);
    assert.equal(f.turns()[0].input.includes("FACT-LATER"), false);
    assert.match(f.turns()[1].input, /FACT-LATER And one more thing\./);
  });

  test("a message that settles while a request is out is after what the summary covers", async (t) => {
    // a resumed session the engine says is too long: the lane is free
    // while it folds, and the turn is asked again once it has
    const f = await fixture(t, plainLane(), { hold: [2], tooLong: [1] }, { resumed: true });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    assert.equal((await f.send("FACT-LATER And one more thing.")).status, 202);
    assert.ok(await waitFor(() => f.turns().some((r) => r.input.includes("FACT-LATER"))), f.h.logs());
    assert.equal(f.stored().through, previous.through);
    f.release();
    await f.idle(3);
    const context = f.stored();
    assert.ok(context.through > previous.through, f.h.logs());
    assert.equal(await f.summarised(), 1);
    assert.ok(f.folds().every((r) => !r.input.includes("FACT-LATER")));
    assert.ok((await f.settled()).findIndex((m) => m.text.includes("FACT-LATER")) >= context.through, "the summary counts a message it never read");
  });

  test("two folds from one summary, the later done first: one is saved, and the other asks nothing more", async (t) => {
    // both turns too long for the engine: each folds from the same summary
    const f = await fixture(t, plainLane(), { hold: [1, 2], tooLong: [1, 2] }, { resumed: true });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(async () => f.folds().length === 1 && !(await f.busy())), f.h.logs());
    assert.equal((await f.send("FACT-LATER And one more thing.")).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    f.release(2);
    assert.ok(await waitFor(() => f.stored()?.through > previous.through && f.turns().length === 3), f.h.logs());
    await f.idle(3);
    const saved = f.stored(), asked = f.folds().length;
    assert.ok(asked > 2);
    assert.equal(saved.summary, f.written().at(-1)!.said);
    f.release(1);
    // the first, let go after the second was saved, ends there, as a fold
    // that could not be made always has
    assert.ok(await waitFor(async () => (await f.messages()).some((m) => /could not be summarised/.test(m.text ?? ""))), f.h.logs());
    await f.idle(3);
    assert.equal(f.folds().length, asked, "the first fold asked again after the second was saved");
    assert.deepEqual(f.stored(), saved);
    assert.equal(await f.summarised(), 1);
  });

  test("a lane closed while a request is out, with no summary before, gets none", async (t) => {
    const f = await fixture(t, plainLane(), { hold: [2], tooLong: [1] }, { resumed: true, context: null, aside: true });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(async () => f.folds().length === 2 && !(await f.busy())), f.h.logs());
    assert.equal((await f.h.fetch(`/api/bots/${f.id}/tasks/${f.threadId}`, { method: "DELETE" })).status, 200);
    f.release();
    // what the held request wrote, then long enough for a next one to start
    assert.ok(await waitFor(() => f.written().some((w) => w.n === 2)), f.h.logs());
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await f.idle(1);
    assert.equal(f.folds().length, 2, "a request went out after the lane was closed");
    assert.equal(f.lane(), undefined, "the closed lane came back");
    assert.equal(f.turns().length, 1, "the closed lane's turn was asked again");
  });

  test("a fold after a turn that fails late is tried again from what is saved, not from what it had written", async (t) => {
    // a smaller window, filled by the turn: the fold before it fails at
    // once, the one after it fails at its last request, and the next try
    // starts again from the saved summary
    const lane: Said[] = [
      { role: "user", text: "FACT-0 where it started." },
      ...Array.from({ length: 30 }, (_, k): Said => ({ role: k % 2 ? "bot" : "user", text: `FACT-${k + 1} ${"x".repeat(6_000)}` })),
    ];
    const after = [...lane.slice(previous.through).map(asTurn), { role: "user" as const, text: NEW }, { role: "assistant" as const, text: "A fixture answer." }];
    const total = summaryPasses(planCompaction(after, 21_600, 6).fold).length;
    assert.ok(total >= 2, `${total} requests`);
    const f = await fixture(t, lane, { failAt: [1, 1 + total], used: 30_000 }, { resumed: true, model: "small-fixture-model" });
    assert.equal((await f.send(NEW)).status, 202);
    assert.ok(await waitFor(() => f.stored()?.through > previous.through, 30_000), f.h.logs());
    await f.idle(1);
    const folds = f.folds();
    assert.equal(folds.length, 1 + 2 * total, f.h.logs());
    const first = folds.slice(1, 1 + total), again = folds.slice(1 + total);
    // the same requests again, the first carrying the saved summary
    assert.deepEqual(again.map((r) => r.input), first.map((r) => r.input));
    assert.ok(again[0].input.includes(`Summary so far:\n${previous.summary}\n\nThe conversation:\n`));
    assert.equal(f.stored().summary, f.written().at(-1)!.said);
    assert.equal(await f.summarised(), 1);
  });
});
