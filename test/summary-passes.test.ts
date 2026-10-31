// Real HTTP turns and a synthetic Claude CLI. A part of a conversation
// too long for one summary request is read whole, in order, in several,
// each carrying the summary so far, and saved once, after the last. A
// request that fails or comes back empty, a summary dropped, a message
// taken back or a stop meanwhile saves nothing, and words said meanwhile
// are in none of them.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { HANDOFF_MAX_TOKENS, handoffKeep, keptSummary, SUMMARY_MAX_CHARS, summaryPasses, type Turn } from "../server/context.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** What the synthetic CLI does with the nth summary request, and whether
 * the first turn is refused as too long. */
interface Control { failAt?: number; emptyAt?: number; timeoutAt?: number; holdAt?: number; pad?: number; tooLongOnce?: boolean }
interface Said { role: "user" | "bot"; text: string; agent?: { dir: "in"; peerId: string; peerName: string }; replyTo?: { author: string; excerpt: string } }

const previous = { summary: "Previous fixture summary FACT-0.", through: 1, at: 1234 };
const facts = (text: string) => text.match(/FACT-\d+/g) ?? [];
const has = (text: string, fact: string) => new RegExp(`${fact}(?!\\d)`).test(text);
const LEFT_OUT = /earlier messages? (?:are|is) left out/;

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
 * and an end told with who sent each and what it replies to. */
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
      i % 2
        ? { role: "bot", text: `FACT-${i} ${"t".repeat(1_500)}` }
        : i % 4
          ? { role: "user", text: `FACT-${i} ${"a".repeat(1_500)}`, replyTo: { author: "Passes fixture", excerpt: "an earlier fixture message" } }
          : { role: "user", text: `FACT-${i} ${"a".repeat(1_500)}`, agent: peer },
    );
  }
  return lane;
}

/** How many requests a story's fold of the plain lane takes: told as
 * they were said, its messages are measured here as the server does. */
function plainPasses(lane: Said[]): number {
  const told: Turn[] = lane.slice(previous.through).map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
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

const cliSource = (home: string, records: string) => `#!${process.execPath}
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
 if(set.holdAt===n)while(!existsSync(home+"/release"))await new Promise(r=>setTimeout(r,20));
 if(set.timeoutAt===n){process.on("SIGTERM",()=>{});setInterval(()=>{},1000);}
 else if(set.failAt===n){console.error("Fixture pass failed");process.exitCode=7;}
 else if(set.emptyAt===n)console.log("   ");
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
  const content=JSON.parse(line).message.content, n=next("turn-");
  publish("turn-"+String(n).padStart(3,"0"),{n,input:typeof content==="string"?content:content.map(b=>b.text??"").join("")});
  const emit=f=>console.log(JSON.stringify(f));
  emit({type:"system",subtype:"init",session_id:"fixture-session",model:"claude-sonnet-5"});
  const tooLong=control().tooLongOnce&&!existsSync(home+"/too-long");
  if(tooLong)writeFileSync(home+"/too-long","1");
  const text=tooLong?"Prompt is too long for this model's context window":"A fixture answer.";
  if(tooLong)emit({type:"assistant",error:"invalid_request",message:{content:[{type:"text",text}]}});
  else emit({type:"assistant",message:{content:[{type:"text",text}],usage:{input_tokens:1,output_tokens:1}}});
  emit({type:"result",subtype:"success",is_error:tooLong,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:text});
  setTimeout(()=>process.exit(0),50);
 });
}
`;

async function fixture(t: TestContext, lane: Said[], control: Control = {}, resumed = false) {
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-passes-"));
  const data = join(home, ".bloks"), records = join(home, "calls");
  mkdirSync(data); mkdirSync(records);
  const cli = join(home, "fake-claude.mjs"), id = randomUUID(), threadId = randomUUID();
  const bot = { id, threadId, activeTaskId: threadId, name: "Passes fixture", title: "", description: "",
    color: "blue", shape: "circle", createdAt: 1, unread: false, notifications: false, resumeCursors: {},
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    // Another engine served it last, so the next turn is a new session
    // told the story. Resumed, its session goes on, and it folds only
    // when the engine says it is too long.
    tasks: [{ id: threadId, title: "General", createdAt: 1, context: previous,
      ...(resumed ? { lastInstanceId: "claude", resumeCursors: { claude: "fixture-session" } } : { lastInstanceId: "previous-engine", resumeCursors: {} }) }],
  };
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot]));
  const ids = lane.map(() => randomUUID());
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(lane.map((m, i) => ({ id: ids[i], at: i + 1, kind: "text", ...m }))));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: false, beforeTurn: 0 }, instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  writeFileSync(join(home, "control.json"), JSON.stringify(control));
  writeFileSync(cli, cliSource(home, records), { mode: 0o755 });
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
  const messages = async () => (await h.json(`/api/bots/${id}/messages?limit=200`)).messages as any[];
  return {
    h, id, threadId, ids, folds, written, turns, messages,
    stored: () => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].tasks[0].context,
    send: (text: string) => h.fetch(`/api/bots/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) }),
    release: () => writeFileSync(join(home, "release"), "1"),
    settled: async () => (await messages()).filter((m) => m.kind === "text" && m.text && !m.deleted && !m.queued && !m.unsent),
    summarised: async () => (await messages()).filter((m) => m.kind === "notice" && /summarised/.test(m.text ?? "")).length,
    /** Every turn asked for has been heard or stopped, and no summary
     * request is still running. */
    idle: async (heard: number, ms?: number) => {
      assert.ok(await waitFor(async () => {
        const busy = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy;
        return !busy && turns().length >= heard && folds().every((c) => !existsSync(c.cwd));
      }, ms), `the lane did not settle: ${h.logs()}`);
      // the close handler's continuation, before its saved state is read from here
      await h.json("/api/bots?messages=0");
    },
  };
}

describe("a fold read in several requests", { concurrency: 4 }, () => {
  for (const pad of [0, 8_000, 9_000]) {
    test(`a new session's story, after summaries of ${pad ? `${pad} characters` : "a few words"}: every folded message read whole, in order`, async (t) => {
      const lane = longLane();
      const f = await fixture(t, lane, { pad });
      assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
      await f.idle(1);
      const folds = f.folds(), written = f.written(), context = f.stored();
      assert.ok(folds.length >= 4, `${folds.length} requests: ${f.h.logs()}`);
      // each within the bound, and each carrying the summary the one before wrote
      let summary = previous.summary;
      for (const [i, fold] of folds.entries()) {
        assert.equal(fold.n, i + 1);
        assert.ok(fold.input.length <= 48_760, `request ${fold.n} was ${fold.input.length} characters`);
        assert.ok(fold.input.includes(`Summary so far:\n${summary}\n\nThe conversation:\n`), `request ${fold.n} did not carry the summary before it`);
        summary = keptSummary(written[i].said).summary;
      }
      // saved once, after the last, at the longest a lane keeps when asked
      assert.equal(context.summary, summary);
      if (pad) assert.ok(summary.length > 7_900 && summary.length <= SUMMARY_MAX_CHARS, `${summary.length} characters`);
      assert.ok(context.at > previous.at);
      assert.equal(await f.summarised(), 1);
      // every message folded, whole and in order, the agent's replies and the longest message too
      const folded = lane.slice(previous.through, context.through);
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
      // the turn's own words, apart from it and from every summary request
      assert.match(own, /FACT-NEW Carry on with the fixture\.\s*$/);
      assert.equal(told.includes("FACT-NEW"), false);
      assert.ok(folds.every((r) => !r.input.includes("FACT-NEW")));
    });
  }

  test("a fold that fits is one request", async (t) => {
    const lane: Said[] = [
      { role: "user", text: "FACT-0 where it started." },
      ...Array.from({ length: 50 }, (_, k): Said => ({ role: k % 2 ? "bot" : "user", text: `FACT-${k + 1} ${"x".repeat(1_500)}` })),
    ];
    const f = await fixture(t, lane);
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
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
        const f = await fixture(t, lane, outcome === "fail" ? { failAt: at } : { emptyAt: at });
        assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
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
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
    await f.idle(1, 90_000);
    assert.equal(f.folds().length, 2);
    assert.deepEqual(f.stored(), previous);
    assert.equal(await f.summarised(), 0);
  });

  test("a summary dropped while a request is out is not brought back", async (t) => {
    const f = await fixture(t, plainLane(), { holdAt: 2 });
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    assert.equal((await f.h.json(`/api/bots/${f.id}/tasks/${f.threadId}/summary`, { method: "DELETE" })).dropped, true);
    f.release();
    await f.idle(1);
    assert.equal(f.folds().length, 2, "a request went out after the summary was dropped");
    assert.equal(f.stored(), undefined);
    assert.equal(await f.summarised(), 0);
  });

  test("a message taken back while a request is out leaves the summary as it was", async (t) => {
    const f = await fixture(t, plainLane(), { holdAt: 2 });
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    // one the first request read
    assert.equal((await f.h.fetch(`/api/threads/${f.threadId}/messages/${f.ids[2]}`, { method: "DELETE" })).status, 200);
    f.release();
    await f.idle(1);
    assert.equal(f.folds().length, 2, "a request went out after a message was taken back");
    assert.deepEqual(f.stored(), previous);
    assert.equal(await f.summarised(), 0);
  });

  test("a stop while a request is out ends the turn before it starts, with nothing saved", async (t) => {
    const f = await fixture(t, plainLane(), { holdAt: 2 });
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
    assert.ok(await waitFor(() => f.folds().length === 2), f.h.logs());
    assert.equal((await f.h.fetch(`/api/bots/${f.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: f.threadId }) })).status, 200);
    f.release();
    await f.idle(0);
    assert.equal(f.folds().length, 2, "a request went out after the stop");
    assert.deepEqual(f.stored(), previous);
    assert.equal(await f.summarised(), 0);
    assert.equal(f.turns().length, 0, "the engine heard the stopped turn");
    assert.ok((await f.messages()).some((m) => /Stopped before .* had started on it/.test(m.text ?? "")), f.h.logs());
  });

  test("words sent while a request is out wait for their own turn and are in no summary", async (t) => {
    const f = await fixture(t, plainLane(), { holdAt: 2 });
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
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
    const f = await fixture(t, plainLane(), { holdAt: 2, tooLongOnce: true }, true);
    assert.equal((await f.send("FACT-NEW Carry on with the fixture.")).status, 202);
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
});
