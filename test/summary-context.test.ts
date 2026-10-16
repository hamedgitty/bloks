// Real HTTP turns and a synthetic Claude CLI. A failed text child cannot
// commit part of a fold, including an absorb whose defrag then fails.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

type Path = "ordinary" | "handoff" | "forced" | "absorb" | "defrag";
type Outcome = "success" | "empty" | "fail" | "timeout";
const previous = { summary: "The previous fixture summary.", through: 1, at: 1234, microFrom: 0 };

async function fixture(t: TestContext, path: Path, outcome: Outcome) {
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-context-"));
  const data = join(home, ".bloks"), records = join(home, "calls");
  mkdirSync(data); mkdirSync(records);
  const cli = join(home, "fake-claude.mjs"), id = randomUUID(), threadId = randomUUID();
  const model = path === "ordinary" ? "small-fixture-model" : "claude-sonnet-5";
  const bot = { id, threadId, activeTaskId: threadId, name: "Summary fixture", title: "", description: "",
    color: "blue", shape: "circle", createdAt: 1, unread: false, notifications: false, resumeCursors: {},
    modelSelection: { instanceId: "claude", model },
    tasks: [{ id: threadId, title: "General", createdAt: 1, context: previous,
      lastInstanceId: path === "handoff" ? "previous-engine" : "claude",
      resumeCursors: path === "handoff" ? {} : { claude: "fixture-session" } }],
  };
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot]));
  // Twelve messages outside the old summary, enough to fold while
  // preserving the normal six-message tail. Small messages exercise the
  // force and single-message paths without triggering an ordinary fold.
  const long = path === "ordinary" ? 12000 : path === "handoff" ? 8000 : 20;
  const messages = Array.from({ length: 13 }, (_, i) => ({ id: randomUUID(), at: i + 1,
    role: i % 2 ? "bot" : "user", kind: "text", text: "Fixture fact " + i + ": " + "x".repeat(long) }));
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(messages));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: path === "absorb" || path === "defrag", beforeTurn: 0 },
    instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2), home=${JSON.stringify(home)}, path=${JSON.stringify(path)}, outcome=${JSON.stringify(outcome)};
if(args[0]==="--version"){console.log("9.9.9 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const emit=f=>console.log(JSON.stringify(f));
const publish=(phase,extra={})=>{const name=${JSON.stringify(records)}+"/"+process.pid+"-"+phase+".json";writeFileSync(name+".part",JSON.stringify({phase,args,cwd:process.cwd(),...extra}));renameSync(name+".part",name);};
if(args[args.indexOf("--output-format")+1]==="text"){
 let input="";for await(const c of process.stdin)input+=c;
 const phase=input.startsWith("This is a running summary")?"defrag":input.includes("Newly said:")?"absorb":"fold";
 publish(phase,{input});
 const applies=path==="defrag"?phase==="defrag":true;
 if(applies&&outcome==="timeout"){
  // Ignore graceful termination: the driver's hard deadline owns this.
  process.on("SIGTERM",()=>{});setInterval(()=>{},1000);
 }else if(applies&&outcome==="fail"){console.error("Fixture summary failed");process.exitCode=7;}
 else if(applies&&outcome==="empty")console.log("   ");
 else console.log(path==="defrag"&&phase==="absorb"?"fact ".repeat(2000):"A successful fixture summary.");
}else{
 let input="";
 process.stdin.on("data",function take(c){input+=c;const line=input.split("\\n").find(s=>s.trim()&&JSON.parse(s).type==="user");if(!line)return;
  process.stdin.off("data",take);publish("turn",{input:JSON.parse(line).message.content});
  emit({type:"system",subtype:"init",session_id:"fixture-session",model:${JSON.stringify(model)}});
  const failed=path==="forced"&&!existsSync(home+"/forced");
  if(failed)writeFileSync(home+"/forced","1");
  const text=failed?"Prompt is too long for this model's context window":"A fixture answer.";
  if(failed)emit({type:"assistant",error:"invalid_request",message:{content:[{type:"text",text}]}});
  if(!failed)emit({type:"assistant",message:{content:[{type:"text",text}],usage:{input_tokens:1,output_tokens:1}}});
  emit({type:"result",subtype:"success",is_error:failed,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:text});
  setTimeout(()=>process.exit(0),50);
 });
}
`, { mode: 0o755 });
  const h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true, maxRetries: 3 }); });
  const stored = () => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].tasks[0].context;
  const calls = () => readdirSync(records).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(records, n), "utf8")));
  const currentMessages = async () => (await h.json(`/api/bots/${id}/messages?limit=200`)).messages as any[];
  return { h, id, stored, calls, currentMessages };
}

describe("context commits after text generation", { concurrency: 4 }, () => {
  for (const path of ["ordinary", "handoff", "forced", "absorb", "defrag"] as const) {
    for (const outcome of ["success", "empty", "fail"] as const) {
      test(`${path}: ${outcome} preserves or commits the complete context`, async t => {
        const f = await fixture(t, path, outcome);
        const before = structuredClone(f.stored());
        const request = await f.h.fetch(`/api/bots/${f.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Continue the fixture." }) });
        assert.equal(request.status, 202, f.h.logs());
        const expected = path === "defrag" ? "defrag" : path === "absorb" ? "absorb" : "fold";
        assert.ok(await waitFor(() => f.calls().some(c => c.phase === expected)), `did not exercise ${expected}: ${f.h.logs()}`);
        assert.ok(await waitFor(async () => {
          const busy = (await f.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === f.id)?.busy;
          return !busy && f.calls().filter(c => c.phase !== "turn").every(c => !existsSync(c.cwd));
        }), `summary child did not settle: ${f.h.logs()}`);
        // Let the server finish the close handler's promise continuation
        // before reading its saved state from this separate process.
        await f.h.json("/api/bots?messages=0");
        if (outcome === "success") {
          assert.ok(await waitFor(() => f.stored().through > before.through));
          assert.equal(f.stored().summary, "A successful fixture summary.");
          if (path === "absorb" || path === "defrag") assert.equal(f.stored().through, 2);
          assert.ok(f.stored().at > before.at);
        } else {
          assert.deepEqual(f.stored(), before, `${path} committed a partial ${outcome} result`);
          assert.equal((await f.currentMessages()).some(m => m.kind === "notice" && /earliest .*summarised/.test(m.text ?? "")), false);
        }
        if (path === "defrag") assert.equal(f.calls().filter(c => c.phase === "absorb").length, 1, "defrag did not follow a successful absorb");
      });
    }
  }

  // The driver unit tests advance its clock. Here the real server waits
  // for the actual one-minute rejection on each context-writing path.
  for (const path of ["ordinary", "absorb", "defrag"] as const) test(`${path}: an actual child timeout preserves the saved context`, { timeout: 90000 }, async t => {
    const f = await fixture(t, path, "timeout");
    const before = structuredClone(f.stored());
    const request = f.h.fetch(`/api/bots/${f.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Continue the fixture." }) });
    const expected = path === "defrag" ? "defrag" : path === "absorb" ? "absorb" : "fold";
    assert.ok(await waitFor(() => f.calls().some(c => c.phase === expected)), `did not start ${expected}`);
    assert.deepEqual(f.stored(), before, "a pending child advanced the context");
    assert.equal((await request).status, 202);
    assert.ok(await waitFor(() => f.calls().filter(c => c.phase !== "turn").every(c => !existsSync(c.cwd)), 70000), f.h.logs());
    await f.h.json("/api/bots?messages=0");
    assert.deepEqual(f.stored(), before, "a timed-out child advanced the context");
    assert.equal((await f.currentMessages()).some(m => m.kind === "notice" && /earliest .*summarised/.test(m.text ?? "")), false);
  });
});
