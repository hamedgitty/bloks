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

type Path = "ordinary" | "handoff" | "forced" | "absorb" | "defrag" | "retry";
type Outcome = "success" | "empty" | "fail" | "timeout";
const previous = { summary: "The previous fixture summary.", through: 1, at: 1234, microFrom: 0 };

async function fixture(t: TestContext, path: Path, outcome: Outcome) {
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-context-"));
  const data = join(home, ".bloks"), records = join(home, "calls");
  mkdirSync(data); mkdirSync(records);
  const cli = join(home, "fake-claude.mjs"), id = randomUUID(), threadId = randomUUID();
  const model = path === "ordinary" || path === "retry" ? "small-fixture-model" : "claude-sonnet-5";
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
  const long = path === "ordinary" || path === "retry" ? 12000 : path === "handoff" ? 8000 : 20;
  const messages = Array.from({ length: 13 }, (_, i) => ({ id: randomUUID(), at: i + 1,
    role: i % 2 ? "bot" : "user", kind: "text", text: "Fixture fact " + i + ": " + "x".repeat(long) }));
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(messages));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: path === "absorb" || path === "defrag", beforeTurn: 0 },
    instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2), home=${JSON.stringify(home)}, path=${JSON.stringify(path)}, outcome=${JSON.stringify(outcome)};
if(args[0]==="--version"){console.log("2.1.299 (Claude Code)");process.exit(0);}
if(args[0]==="auth"){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const emit=f=>console.log(JSON.stringify(f));
const publish=(phase,extra={})=>{const name=${JSON.stringify(records)}+"/"+process.pid+"-"+phase+".json";writeFileSync(name+".part",JSON.stringify({phase,args,pid:process.pid,cwd:process.cwd(),...extra}));renameSync(name+".part",name);};
if(args[args.indexOf("--output-format")+1]==="text"){
 let input="";for await(const c of process.stdin)input+=c;
 const phase=input.startsWith("This is a running summary")?"defrag":input.includes("Newly said:")?"absorb":"fold";
 publish(phase,{input});
 if(path==="defrag"&&phase==="defrag")while(!existsSync(home+"/release-defrag"))await new Promise(r=>setTimeout(r,20));
 const applies=path==="defrag"?phase==="defrag":true;
 if(applies&&outcome==="timeout"){
  // Ignore graceful termination: the driver's hard deadline owns this.
  process.on("SIGTERM",()=>{});setInterval(()=>{},1000);
 }else if(applies&&outcome==="fail"){console.log("Partial fixture output.");console.error("Fixture summary failed");process.exitCode=7;}
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
  if(!failed)emit({type:"assistant",message:{content:[{type:"text",text}],usage:{input_tokens:path==="retry"?30000:1,output_tokens:1}}});
  emit({type:"result",subtype:"success",is_error:failed,num_turns:1,duration_api_ms:1,total_cost_usd:0,session_id:"fixture-session",result:text});
  setTimeout(()=>process.exit(0),50);
 });
}
`, { mode: 0o755 });
  const h = await startHarness({ HOME: home, USERPROFILE: home });
  const frames: any[] = [];
  const controller = new AbortController();
  let pump: Promise<void> | undefined;
  if (path === "defrag") {
    const stream = await h.fetch("/api/events", { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    pump = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split("\n").find(line => line.startsWith("data: "));
            if (data) frames.push(JSON.parse(data.slice(6)));
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
    })();
  }
  t.after(async () => {
    controller.abort(); await pump;
    const children = calls().filter(c => c.phase !== "turn" && existsSync(c.cwd));
    for (const child of children) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ } }
    await h.stop();
    for (const child of children) if (child.cwd.startsWith(join(tmpdir(), "bloks-text-"))) rmSync(child.cwd, { recursive: true, force: true, maxRetries: 3 });
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  const stored = () => JSON.parse(readFileSync(join(data, "bots.json"), "utf8"))[0].tasks[0].context;
  const calls = () => readdirSync(records).filter(n => n.endsWith(".json")).map(n => JSON.parse(readFileSync(join(records, n), "utf8")));
  const currentMessages = async () => (await h.json(`/api/bots/${id}/messages?limit=200`)).messages as any[];
  // Explicit bot updates bracket the defrag result in the same ordered
  // SSE stream. No sleep guesses which turn-end frames already arrived.
  const barrier = async (title: string) => {
    assert.ok((await h.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ title }) })).ok);
    assert.ok(await waitFor(() => frames.some(f => f.kind === "bot" && f.bot?.id === id && f.bot.title === title)));
    return frames.findIndex(f => f.kind === "bot" && f.bot?.id === id && f.bot.title === title);
  };
  let held = -1;
  const releaseDefrag = async () => {
    if (path !== "defrag") return;
    held = await barrier("Fixture defrag held");
    writeFileSync(join(home, "release-defrag"), "1");
  };
  const assertDefragBroadcasts = async (expected: number) => {
    if (path !== "defrag") return;
    const settled = await barrier("Fixture defrag settled");
    assert.equal(frames.slice(held + 1, settled).filter(f => f.kind === "bot" && f.bot?.id === id).length, expected,
      "a defrag commit broadcast did not match its result");
  };
  return { h, id, stored, calls, currentMessages, releaseDefrag, assertDefragBroadcasts };
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
        await f.releaseDefrag();
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
        await f.assertDefragBroadcasts(outcome === "success" ? 1 : 0);
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
    await f.releaseDefrag();
    assert.deepEqual(f.stored(), before, "a pending child advanced the context");
    assert.equal((await request).status, 202);
    assert.ok(await waitFor(() => f.calls().filter(c => c.phase !== "turn").every(c => !existsSync(c.cwd)), 70000), f.h.logs());
    await f.h.json("/api/bots?messages=0");
    assert.deepEqual(f.stored(), before, "a timed-out child advanced the context");
    assert.equal((await f.currentMessages()).some(m => m.kind === "notice" && /earliest .*summarised/.test(m.text ?? "")), false);
    await f.assertDefragBroadcasts(0);
  });

  test("a failed after-turn fold keeps context and carries stderr through its retry log", { timeout: 75000 }, async t => {
    const f = await fixture(t, "retry", "fail");
    const before = structuredClone(f.stored());
    assert.equal((await f.h.fetch(`/api/bots/${f.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Continue the fixture." }) })).status, 202);
    assert.ok(await waitFor(() => /\[fold\] gave up.*Fixture summary failed/.test(f.h.logs()), 60000), f.h.logs());
    assert.equal(f.calls().filter(c => c.phase === "fold").length, 5, "one pre-turn failure and four after-turn attempts were expected");
    assert.deepEqual(f.stored(), before);
    assert.equal((await f.currentMessages()).some(m => m.kind === "notice" && /earliest .*summarised/.test(m.text ?? "")), false);
  });
});
