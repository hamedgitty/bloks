import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { after, test, type TestContext } from "node:test";
import { codexSpeedRoute, resolveCodexSpeed, requireCodexTier, CodexSpeedUnavailable } from "../server/codex-speed.ts";
import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
const home = fs.mkdtempSync(join(tmpdir(), "bloks-speed-unit-"));
process.env.HOME = home;
const { CodexDriver, catalogFromModelList } = await import("../server/drivers/codex.ts");
after(() => fs.rmSync(home, { recursive: true, force: true }));

for (const workspace of [undefined, "standard", "fast"] as const) for (const override of [undefined, null, "standard", "fast"] as const) {
  test(`live resolution ${workspace}/${override}`, () => {
    const cfg = { codex: { speed: workspace } }, bot = { codexSpeed: override };
    const r = resolveCodexSpeed(cfg, bot);
    assert.equal(r.resolved, override ?? workspace ?? "standard");
    assert.equal(r.source, override ? "agent" : "workspace");
    cfg.codex.speed = workspace === "fast" ? "standard" : "fast";
    assert.equal(resolveCodexSpeed(cfg, bot).resolved, override ?? cfg.codex.speed);
    bot.codexSpeed = null;
    assert.equal(resolveCodexSpeed(cfg, bot).resolved, cfg.codex.speed);
  });
}
test("one support predicate keeps native, remote Codex and other providers distinct", () => {
  assert.equal(codexSpeedRoute("codex", "any-model"), "native");
  assert.equal(codexSpeedRoute("boxAgent", "gpt-6"), "remote-unsupported");
  for (const kind of ["acp", "openai", "claudeAgent"]) assert.equal(codexSpeedRoute(kind, "gpt-6"), "not-codex");
  assert.equal(codexSpeedRoute("boxAgent", "sonnet"), "not-codex");
});
test("only serviceTiers priority advertises Fast, deprecated speed names do not", () => {
  const c = catalogFromModelList([{ data: [
    { model: "yes", serviceTiers: [{ id: "priority" }] },
    { model: "no", serviceTiers: [], additionalSpeedTiers: ["fast"] },
    { model: "unknown", additionalSpeedTiers: ["fast"] },
  ] }])!;
  assert.deepEqual(c.options.map((m) => m.codexFast), [true, false, undefined]);
});
for (const speed of ["standard", "fast"] as const) for (const ack of [null, undefined, "fast", "other", speed === "fast" ? "default" : "priority"]) {
  test(`strict acknowledgement ${speed}/${ack}`, () => assert.throws(() => requireCodexTier({ serviceTier: ack }, speed), CodexSpeedUnavailable));
}
interface Spec { ack?: string | null; absent?: boolean; resumeError?: string; freshError?: boolean; fast?: boolean; additional?: boolean; holdOpen?: boolean; compactError?: boolean; freshAck?: string | null; turnError?: {code:number;message:string}; admission?: "exit-before" | "exit-after" | "exit-after-response" | "timeout"; }
async function native(t: TestContext, spec: Spec = {}) {
  const frames: any[] = [], args: string[][] = [], events: RuntimeEvent[] = [];
  let release: (() => void) | undefined;
  t.mock.method(childProcess, "spawn", (_cli: unknown, argv: string[]) => {
    args.push(argv);
    const stdout = new PassThrough();
    const send = (m: unknown) => stdout.write(JSON.stringify(m) + "\n");
    const child = new EventEmitter();
    const stderr = new PassThrough();
    return Object.assign(child, { stdout, stderr, kill() {}, stdin: new Writable({ write(chunk, _enc, done) {
      const f = JSON.parse(String(chunk)); frames.push(f);
      if (f.method && f.id !== undefined) queueMicrotask(() => {
        let result: any = {};
        if (f.method === "model/list") result = { data: [{ model: "fixture", serviceTiers: spec.fast === undefined ? undefined : spec.fast ? [{ id: "priority" }] : [], additionalSpeedTiers: spec.additional ? ["fast"] : [] }] };
        if (f.method === "thread/compact/start" && spec.compactError) { send({id:f.id,error:{code:-32602,message:"synthetic compaction failure"}}); return; }
        if (f.method === "thread/start" || f.method === "thread/resume") {
          if (f.method === "thread/resume" && spec.resumeError) { send({ id: f.id, error: { code: -32602, message: spec.resumeError } }); return; }
          if (f.method === "thread/start" && spec.freshError) { send({ id: f.id, error: { code: -32602, message: "unknown field serviceTier" } }); return; }
          result = { thread: { id: f.params.threadId ?? "fresh" }, model: "fixture", ...(spec.absent ? {} : { serviceTier: f.method === "thread/start" && "freshAck" in spec ? spec.freshAck : "ack" in spec ? spec.ack : f.params.serviceTier }) };
        }
        if (f.method === "turn/start") {
          if (spec.turnError) { send({id:f.id,error:spec.turnError}); return; }
          if (spec.admission === "timeout") return;
          if (spec.admission === "exit-before" || spec.admission === "exit-after" || spec.admission === "exit-after-response") {
            if (spec.admission === "exit-after-response") {
              send({id:f.id,result:{turn:{id:"admitted"}}});
              globalThis.setImmediate(() => { stderr.write("synthetic transport exit"); child.emit("close",7); }); return;
            }
            if (spec.admission === "exit-after") {
              send({id:f.id,result:{turn:{id:"admitted"}}});
              send({method:"turn/started",params:{threadId:"kept-cursor",turn:{id:"admitted"}}});
            }
            stderr.write("synthetic transport exit"); child.emit("close", 7); return;
          }
        }
        const reply = () => {
          send({ id: f.id, result });
          if (f.method === "turn/start") send({ method: "turn/completed", params: { turn: { status: "completed" } } });
        };
        if (spec.holdOpen && f.method === "thread/resume") release = reply; else reply();
      });
      done();
    } }) });
  });
  t.mock.method(fs, "appendFileSync", () => {}); syncBuiltinESMExports();
  const instance = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", environment: {}, enabled: true, config: { cli: "explicit-fake", fullAuto: false } });
  instance.adapter.onEvent((e) => events.push(e));
  await setImmediate();
  t.after(async () => { await instance.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const start = async (extra: Partial<SendTurnInput> = {}) => {
    await instance.adapter.sendTurn({ threadId: "lane", text: "LOCAL FIXTURE", model: "fixture", resumeCursor: "kept-cursor", ...extra });
  };
  const ended = async () => {
    for (let i = 0; i < 200 && !events.some((e) => e.type === "turn.completed"); i++) await setImmediate();
    const ends = events.filter((e) => e.type === "turn.completed"); assert.equal(ends.length, 1); return ends[0];
  };
  return { instance, frames, args, events, start, ended, release: () => release?.() };
}
for (const spec of [{ ack: null }, { absent: true }, { ack: "other" }, { ack: "priority" }, { resumeError: "unknown field serviceTier: temporarily unavailable, limit exceeded" }, { resumeError: "unknown variant priority" }]) {
  test(`N1 refuses before compact/input without losing cursor: ${JSON.stringify(spec)}`, async (t) => {
    const h = await native(t, spec); await h.start({ compactFirst: true, effort: "high" });
    const end = await h.ended(); assert.equal(end.type === "turn.completed" && end.preInputRefusal?.kind, "codex-speed");
    if ("resumeError" in spec && end.type === "turn.completed") assert.match(end.preInputRefusal?.reason ?? "", /Update Codex/);
    assert.equal(h.frames.filter((f) => f.method === "thread/resume").length, 1);
    assert.equal(h.frames.filter((f) => ["thread/start", "thread/compact/start", "turn/start"].includes(f.method)).length, 0);
    assert.equal(h.events.some((e) => e.type === "session.started"), false);
    assert.equal(h.frames.find((f) => f.method === "thread/resume").params.serviceTier, "default");
  });
}
for (const speed of ["standard", "fast"] as const) for (const resumed of [false, true]) {
  test(`${speed}/${resumed ? "resume" : "fresh"}: one acknowledged channel, no turn-tier or argv-tier`, async (t) => {
    const h = await native(t, { fast: true });
    await h.start({ resumeCursor: resumed ? "kept-cursor" : undefined, codexSpeed: resolveCodexSpeed({ codex: { speed } }) });
    const end = await h.ended(); assert.equal(end.type === "turn.completed" && end.ok, true);
    const opens = h.frames.filter((f) => ["thread/start", "thread/resume"].includes(f.method)); assert.equal(opens.length, 1);
    assert.equal(opens[0].params.serviceTier, speed === "fast" ? "priority" : "default");
    const turns = h.frames.filter((f) => f.method === "turn/start"); assert.equal(turns.length, 1); assert.equal("serviceTier" in turns[0].params, false);
    const argv = h.args.at(-1)!; assert.equal(argv.some((x) => /service_tier/.test(x)), false); assert.equal(argv.includes("features.fast_mode=true"), speed === "fast");
    const report = h.events.find((e) => e.type === "codex.speed"); assert.equal(report?.type === "codex.speed" && report.actualTier, null);
  });
}
test("known unsupported Fast refuses before spawn and never trusts additionalSpeedTiers", async (t) => {
  const h = await native(t, { fast: false, additional: true }); const before = h.args.length;
  await assert.rejects(h.start({ codexSpeed: resolveCodexSpeed({ codex: { speed: "fast" } }) }), CodexSpeedUnavailable);
  assert.equal(h.args.length, before); assert.equal(h.frames.some((f) => /thread\/(start|resume|compact)|turn\/start/.test(f.method)), false);
});
test("an admitted snapshot survives a preference edit while resume is held", async (t) => {
  const h = await native(t, { holdOpen: true }); const config = { codex: { speed: "standard" as "standard" | "fast" } };
  await h.start({ codexSpeed: resolveCodexSpeed(config) });
  for (let i = 0; i < 100 && !h.frames.some((f) => f.method === "thread/resume"); i++) await setImmediate();
  config.codex.speed = "fast"; h.release(); await h.ended();
  assert.equal(h.frames.find((f) => f.method === "thread/resume").params.serviceTier, "default");
  assert.equal(resolveCodexSpeed(config).resolved, "fast");
});

for (const spec of [{ack:null},{absent:true},{ack:"other"},{freshError:true}]) test(`fresh unsupported acknowledgement stops before input: ${JSON.stringify(spec)}`, async(t)=>{
 const h=await native(t,spec);await h.start({resumeCursor:undefined});const end=await h.ended();
 assert.equal(end.type==="turn.completed"&&end.preInputRefusal?.kind,"codex-speed");
 assert.equal(h.frames.filter(f=>f.method==="thread/start").length,1);assert.equal(h.frames.some(f=>f.method==="turn/start"||f.method==="thread/compact/start"),false);
});

for (const via of ["missing-resume","failed-compaction"]) test(`fresh fallback rechecks acknowledgement after ${via}`,async(t)=>{
 const h=await native(t,{...(via==="missing-resume"?{resumeError:"conversation missing"}:{compactError:true}),freshAck:null});
 await h.start({compactFirst:via==="failed-compaction"});const end=await h.ended();
 assert.equal(end.type==="turn.completed"&&end.preInputRefusal?.kind,"codex-speed");
 assert.equal(h.frames.filter(f=>f.method==="thread/resume").length,1);assert.equal(h.frames.filter(f=>f.method==="thread/start").length,1);
 assert.equal(h.frames.filter(f=>f.method==="turn/start").length,0);assert.equal(h.events.some(e=>e.type==="session.started"),false);
});
test("stale known-unsupported metadata is unknown, not a permanent Fast refusal",async(t)=>{
 const h=await native(t,{fast:false});h.instance.models.checkedAt=Date.now()-300001;
 await h.start({codexSpeed:resolveCodexSpeed({codex:{speed:"fast"}})});const end=await h.ended();
 assert.equal(end.type==="turn.completed"&&end.ok,true);
 assert.equal(h.frames.filter(f=>f.method==="turn/start").length,1);
});


test("the admitted activity choice is copied before a caller can mutate its object",async(t)=>{
 const h=await native(t,{holdOpen:true});const choice=resolveCodexSpeed({codex:{speed:"standard"}});
 await h.start({codexSpeed:choice});for(let i=0;i<100&&!h.frames.some(f=>f.method==="thread/resume");i++)await setImmediate();
 choice.resolved="fast";choice.source="agent";choice.override="fast";h.release();await h.ended();
 const report=h.events.find(e=>e.type==="codex.speed");assert.equal(report?.type==="codex.speed"&&report.choice.resolved,"standard");assert.equal(report?.type==="codex.speed"&&report.choice.source,"workspace");
});


for (const code of [-32600,-32603]) test(`F1 RPC error ${code} is a definite rejection with original text`,async(t)=>{
 const h=await native(t,{turnError:{code,message:"synthetic definite rejection"}});await h.start();const end=await h.ended();
 assert.equal(end.type==="turn.completed"&&end.admissionUncertain,undefined,"RPC error response must not make admission uncertain");
 assert.ok(h.events.some(e=>e.type==="runtime.error"&&e.message.includes("synthetic definite rejection")));
 assert.equal(h.frames.filter(f=>f.method==="turn/start").length,1);
});
for (const admission of ["exit-before","exit-after","exit-after-response","timeout"] as const) test(`F1 admission window ${admission}`,async(t)=>{
 const h=await native(t,{admission});if(admission==="timeout")t.mock.timers.enable({apis:["setTimeout"]});
 await h.start();
 if(admission==="timeout"){
  for(let i=0;i<200&&!h.frames.some(f=>f.method==="turn/start");i++)await setImmediate();
  assert.ok(h.frames.some(f=>f.method==="turn/start"));t.mock.timers.tick(60_000);
 }
 const end=await h.ended();const uncertain=end.type==="turn.completed"?end.admissionUncertain:undefined;
 if(admission==="exit-after"||admission==="exit-after-response")assert.equal(uncertain,undefined,"acknowledged input must keep ordinary recovery");
 else {assert.match(uncertain??"",/Admission is uncertain/);assert.match(uncertain??"",admission==="timeout"?/did not answer while starting the turn/:/synthetic transport exit/,"uncertainty must include the engine error or exit detail");}
 assert.equal(h.frames.filter(f=>f.method==="turn/start").length,1,"unanswered input must not be replayed");
});
