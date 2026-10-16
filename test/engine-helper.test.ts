// Actual fixed-profile broker -> explicit fake executable. No real provider,
// auth environment, home directory, PATH lookup or HTTP dependency is used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { EnginePauses, type PauseStorage } from "../server/engine-pauses.ts";
import { EngineHelperBroker, HelperError, helperFile, type HelperRequest, type ReviewProfile } from "../server/engine-helper.ts";
import { engineHelperHttp } from "../server/engine-helper-http.ts";

const code = (value: HelperError["code"]) => (e: unknown) => e instanceof HelperError && e.code === value;
function memory(empty: unknown): PauseStorage {
  let saved = structuredClone(empty);
  return { load: () => structuredClone(saved), save: value => { saved = structuredClone(value); } };
}
async function until(ready: () => boolean) {
  for (let i = 0; i < 300; i++) { if (ready()) return; await delay(10); }
  assert.fail("fake boundary did not reach its expected state");
}
function fixture(t: TestContext, options: { lifetime?: number; attach?: number; storage?: PauseStorage } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bloks-helper-")), projects = join(home, "projects");
  mkdirSync(projects);
  const settings = join(home, "fake.json"), counter = join(home, "starts.jsonl"), exe = join(home, "fake-claude.cjs");
  let spec: Record<string, unknown> = { projects, counter };
  const set = (change: Record<string, unknown>) => { spec = { ...spec, ...change }; writeFileSync(settings, JSON.stringify(spec)); };
  set({});
  writeFileSync(exe, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
const spec=JSON.parse(fs.readFileSync(process.env.FAKE_SETTINGS,'utf8'));
const auth=process.argv[2]==='auth';
fs.appendFileSync(spec.counter,JSON.stringify({phase:auth?'auth':'model',args:process.argv.slice(2),env:process.env,pid:process.pid})+'\n');
const finish=()=>{
 if(auth) process.stdout.write(spec.badAuth?'SECRET-invalid-auth':JSON.stringify({loggedIn:true,apiProvider:'firstParty',authMethod:'claude.ai',...(spec.omitProjects?{}:{projectsDirectory:spec.projects}),secret:'PLANTED-AUTH-SECRET'}));
 else if(spec.overflowModel) process.stdout.write('x'.repeat(9*1024*1024));
 else { process.stdout.write(JSON.stringify({type:'result',result:'OK ć 🐈',session_id:process.argv[process.argv.indexOf('--session-id')+1]})+'\n'); if(spec.modelCrash) process.exitCode=9; }
};
if(spec[auth?'hangAuth':'hangModel']) {
 if(spec.ignoreTerm) process.on('SIGTERM',()=>{});
 setInterval(()=>{},1000);
} else { finish(); }
`, { mode: 0o700 });
  let now = 1_000, alive = true;
  const policyStorage = memory({ version: 1, pauses: [], invocations: [] });
  const policy = new EnginePauses(policyStorage, () => now);
  const storage = options.storage ?? memory({ version: 1, reviews: [], operations: [] });
  const origin = { id: "trusted-origin", invocation: { kind: "agent", agentId: "worker", laneId: "lane" } as const, host: "fake-host", generation: "origin-1" };
  let profile: ReviewProfile = { host: "fake-host", originGeneration: "origin-1", permissionGeneration: "perm-1", configurationGeneration: "config-1",
    effectiveFullAccess: true, cwd: home, roots: [home], executable: exe, environment: {
      HOME: home, PATH: "", FAKE_SETTINGS: settings, BLOKS_TOKEN: "PLANTED-BROAD-TOKEN", BLOKS_ENGINE_HELPER: "PLANTED-PARENT-CAP",
      ANTHROPIC_API_KEY: "PLANTED-API-KEY", ANTHROPIC_BASE_URL: "https://unreachable.invalid",
    }, projectsDirectory: projects, instanceId: "configured-claude" };
  const broker = new EngineHelperBroker(policy, storage, () => structuredClone(profile), {
    now: () => now, timing: { attach: options.attach ?? 1000, lifetime: options.lifetime ?? 10_000, auth: 2000, model: 3000, hardStop: 30, observeStop: 200 },
  });
  const token = broker.issue(origin, () => alive);
  const starts = () => { try { return readFileSync(counter, "utf8").trim().split("\n").map(s => JSON.parse(s)); } catch { return []; } };
  const attached: { detach(): void }[] = [];
  const start = async (req: HelperRequest) => {
    const receipt = await broker.start(token, req);
    attached.push(broker.attach(token, req.operationId, 0, () => {})); return receipt;
  };
  const req = (extra: Partial<HelperRequest> = {}): HelperRequest => ({ version: 1, operationId: randomUUID(), profile: "claude.review", phase: "auth",
    reviewId: randomUUID(), sessionId: randomUUID(), resume: false, additionalDirectories: [home], ...extra } as HelperRequest);
  const model = (auth: HelperRequest, extra: Partial<HelperRequest> = {}): HelperRequest => ({ ...auth, operationId: randomUUID(), phase: "model", authRunId: auth.operationId, prompt: "Independent fake review", ...extra } as HelperRequest);
  const pause = (selector = { family: "claude" } as { family?: string; model?: string }) => policy.activate({ kind: "agent", id: "delegated-coordinator" }, {
    id: randomUUID(), agents: "all", selector, until: now + 10_000, timeZone: "Europe/Berlin",
  });
  const auth = async () => { const r = req(); await start(r); await broker.settled(token, r.operationId); assert.equal(broker.status().operations.find(x => x.id === r.operationId)?.state, "completed"); return r; };
  t.after(async () => {
    for (const run of broker.status().operations) await broker.cancel(token, run.id).catch(() => {});
    for (const run of broker.status().operations) await broker.settled(token, run.id);
    for (const a of attached) a.detach();
    rmSync(home, { recursive: true, force: true });
  });
  return { broker, token, policy, storage, policyStorage, home, projects, origin, starts, start, req, model, auth, pause, set,
    setNow: (value: number) => { now = value; }, endParent: () => { alive = false; },
    change: (change: Partial<ReviewProfile>) => { profile = { ...profile, ...change }; }, profile: () => profile };
}

test("allowed actual auth/model child pair preserves session and fixed argv without broad credentials", async t => {
  const f = fixture(t), a = await f.auth(), m = f.model(a);
  await f.start(m); await f.broker.settled(f.token, m.operationId);
  assert.deepEqual(f.starts().map(s => s.phase), ["auth", "model"]);
  const child = f.starts()[1];
  assert.ok(child.args.includes("fable") && child.args.includes("opus"));
  assert.equal(child.args[child.args.indexOf("--session-id") + 1], a.sessionId);
  assert.equal(child.env.OMNI_CLAUDE_REVIEW, "1");
  assert.equal(Object.keys(child.env).some(k => k.startsWith("BLOKS_")), false);
  assert.equal(child.env.ANTHROPIC_API_KEY, undefined);
  const events = f.broker.events(f.token, m.operationId);
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.match(Buffer.concat(events.filter(e => e.type === "stdout").map(e => Buffer.from(e.dataBase64 as string, "base64"))).toString("utf8"), /OK ć 🐈/);
  assert.equal(events.at(-1)?.state, "residual", "local child close falsely proved remote completion");
  assert.equal(events.at(-1)?.outputComplete, true);
  assert.equal(f.broker.status().operations[1].localClosed, true);
  const safe = JSON.stringify(f.broker.status());
  assert.equal(safe.includes("PLANTED"), false); assert.equal(safe.includes(f.home), false);
  assert.equal(safe.includes("Independent fake review"), false);
  const authEvents = JSON.stringify(f.broker.events(f.token, a.operationId));
  assert.equal(authEvents.includes("PLANTED-AUTH-SECRET"), false);
});

test("subscription auth without a projects field uses only the bound native config directory", async t => {
  const f = fixture(t); f.set({ omitProjects: true });
  const a = await f.auth();
  const auth = f.broker.events(f.token, a.operationId).find(e => e.type === "auth");
  assert.equal(auth?.projectsDirectory, f.projects);
  assert.equal(f.starts().length, 1);
});

test("pause and unknown alias/model-specific fallback deny before either actual child; positive control executes", async t => {
  const f = fixture(t); await f.auth();
  const baseline = f.starts().length;
  await f.pause({ model: "possibly-forbidden-opus" });
  await assert.rejects(f.start(f.req()), e => String(e).includes("paused"));
  assert.equal(f.starts().length, baseline, "denial launched auth or model");
  assert.equal(f.broker.status().operations.length, 1);
});

test("missing/forged capability and constrained effective scope refuse auth, even if saved agent is full access", async t => {
  const f = fixture(t); await f.auth(); const count = f.starts().length;
  await assert.rejects(f.broker.start("forged", f.req()), code("forbidden"));
  f.change({ effectiveFullAccess: false, permissionGeneration: "shared-lane" });
  await assert.rejects(f.start(f.req()), code("pending"));
  assert.equal(f.starts().length, count);
  assert.equal(JSON.stringify(f.broker.status()).includes("PLANTED"), false);
});

test("concurrent same auth starts reconcile once, alternate auth/model UUIDs cannot reuse a review", async t => {
  const f = fixture(t), a = f.req();
  const receipts = await Promise.all([f.broker.start(f.token, a), f.broker.start(f.token, a)]);
  assert.deepEqual(receipts.map(r => r.state).sort(), ["accepted", "existing"]);
  f.broker.attach(f.token, a.operationId, 0, () => {});
  await f.broker.settled(f.token, a.operationId);
  await assert.rejects(f.start({ ...a, operationId: randomUUID() }), code("conflict"));
  const m = f.model(a), other = f.model(a);
  const models = await Promise.allSettled([f.broker.start(f.token, m), f.broker.start(f.token, other)]);
  assert.equal(models.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(models.filter(r => r.status === "rejected" && code("conflict")(r.reason)).length, 1);
  const winner = models[0].status === "fulfilled" ? m : other;
  f.broker.attach(f.token, winner.operationId, 0, () => {});
  await f.broker.settled(f.token, winner.operationId);
  assert.deepEqual(f.starts().map(s => s.phase), ["auth", "model"]);
  assert.equal((await f.broker.start(f.token, winner)).state, "existing");
  await assert.rejects(f.broker.start(f.token, { ...winner, prompt: "changed" }), code("conflict"));
  await assert.rejects(f.start(f.model(a)), code("conflict"));
  assert.equal(f.starts().length, 2, "residual freed model binding for a second launch");
});

test("permission/config changes and a pause between phases cannot reuse successful auth", async t => {
  for (const change of [{ permissionGeneration: "reduced", effectiveFullAccess: false }, { configurationGeneration: "new-account" }, { host: "different-host" }]) {
    const f = fixture(t), a = await f.auth();
    f.change(change);
    await assert.rejects(f.start(f.model(a)), code("pending"));
    assert.equal(f.starts().filter(s => s.phase === "model").length, 0);
  }
  const f = fixture(t), a = await f.auth(); await f.pause();
  await assert.rejects(f.start(f.model(a)), e => String(e).includes("paused"));
  assert.deepEqual(f.starts().map(s => s.phase), ["auth"]);
});

test("registered review continues after parent ends only within original deadline; no new review", async t => {
  const f = fixture(t), a = await f.auth(); f.endParent();
  await assert.rejects(f.start(f.req()), code("pending"));
  const m = f.model(a); await f.start(m); await f.broker.settled(f.token, m.operationId);
  assert.equal(f.starts().length, 2);
  const g = fixture(t), b = await g.auth(); g.endParent(); g.setNow(11_000);
  await assert.rejects(g.start(g.model(b)), code("pending"));
  assert.deepEqual(g.starts().map(s => s.phase), ["auth"]);
  assert.equal((await g.broker.start(g.token, b)).state, "existing", "readback refreshed or lost the original operation");
});

test("bad auth and unauthorized roots leave model unlaunched; no auth output secret escapes", async t => {
  const f = fixture(t); f.set({ badAuth: true });
  const a = f.req(); await f.start(a); await f.broker.settled(f.token, a.operationId);
  assert.equal(f.broker.status().operations[0].state, "failed");
  await assert.rejects(f.start(f.model(a)), code("pending"));
  assert.equal(JSON.stringify(f.broker.events(f.token, a.operationId)).includes("SECRET"), false);
  f.set({ badAuth: false }); await f.auth();
  await assert.rejects(f.start(f.req({ additionalDirectories: [tmpdir()] })), code("pending"));
  assert.equal(f.starts().filter(s => s.phase === "model").length, 0);
});

test("active auth is cancelled, reconnect cannot undo cancellation, and status does not wait for close", async t => {
  const f = fixture(t); f.set({ hangAuth: true, ignoreTerm: true }); const a = f.req();
  await f.start(a); await until(() => f.starts().length === 1);
  const read = f.broker.attach(f.token, a.operationId, 0, () => {});
  await f.pause();
  assert.equal(f.policy.status().invocations[0].state, "cancelRequested");
  read.detach();
  f.broker.attach(f.token, a.operationId, 0, () => {});
  await f.broker.settled(f.token, a.operationId);
  assert.equal(f.starts().length, 1);
  assert.equal(f.broker.status().operations[0].state, "cancelled");
  assert.ok(f.broker.events(f.token, a.operationId).some(e => e.type === "cancel-requested"));
  await assert.rejects(f.start(f.model(a)), e => String(e).includes("paused"));
});

test("first attachment grace works; disconnect cancellation cannot be reversed by readback", async t => {
  const f = fixture(t, { attach: 300 }); f.set({ hangAuth: true }); const a = f.req();
  await f.broker.start(f.token, a); await until(() => f.starts().length === 1);
  await delay(30);
  assert.equal(f.broker.status().operations[0].state, "running");
  const first = f.broker.attach(f.token, a.operationId, 0, () => {}); first.detach();
  f.broker.attach(f.token, a.operationId, 0, () => {});
  await f.broker.settled(f.token, a.operationId);
  assert.equal(f.broker.status().operations[0].state, "cancelled");
  assert.equal(f.starts().length, 1);
});

test("restart invalidates capability, preserves residual and model binding without raw output or replay", async t => {
  const f = fixture(t), a = await f.auth(), m = f.model(a);
  await f.start(m); await f.broker.settled(f.token, m.operationId);
  const restarted = new EngineHelperBroker(new EnginePauses(f.policyStorage), f.storage, () => f.profile());
  await assert.rejects(restarted.start(f.token, m), code("forbidden"));
  const newCap = restarted.issue(f.origin, () => true);
  await assert.rejects(restarted.start(newCap, m), code("conflict"));
  assert.equal(restarted.status().operations[1].state, "residual");
  await restarted.reconcile(m.operationId, { localClosed: true, descendants: "closed", remote: "none" });
  assert.equal(restarted.status().operations[1].reason, "residual-settled");
  assert.equal(f.starts().length, 2);
  assert.equal(JSON.stringify(restarted.status()).includes("PLANTED"), false);
});

test("strict helper ledger refuses corrupt storage and excludes persisted prompt/output/capabilities", async t => {
  const f = fixture(t), store = helperFile(join(f.home, "helper-ledger.json"));
  const broker = new EngineHelperBroker(f.policy, store, () => f.profile());
  const token = broker.issue(f.origin, () => true), a = f.req();
  await broker.start(token, a); broker.attach(token, a.operationId, 0, () => {}); await broker.settled(token, a.operationId);
  const data = readFileSync(join(f.home, "helper-ledger.json"), "utf8");
  assert.equal(data.includes(token), false); assert.equal(data.includes("PLANTED"), false);
  writeFileSync(join(f.home, "helper-ledger.json"), '{"secret":"PLANTED",broken');
  const broken = new EngineHelperBroker(f.policy, store, () => f.profile());
  assert.equal(broken.status().unavailable, true);
  assert.throws(() => broken.issue(f.origin, () => true), code("storage"));
});

test("actual local HTTP POST/GET stream agrees with broker schema and denies Host/Origin/broad-token access", async t => {
  const f = fixture(t);
  let handler: ReturnType<typeof engineHelperHttp>;
  const server = createServer((req, res) => { void handler(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  handler = engineHelperHttp(f.broker, origin);
  const headers = { Authorization: `EngineHelper ${f.token}`, "Content-Type": "application/json" };
  const send = (input: HelperRequest, extra = {}) => fetch(`${origin}/api/engine-helper-runs`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  const a = f.req();
  const response = await send(a); assert.equal(response.status, 200);
  assert.equal((await response.json() as any).state, "accepted");
  const stream = await fetch(`${origin}/api/engine-helper-runs/${a.operationId}/events?after=0`, { headers });
  assert.equal(stream.status, 200);
  const events = (await stream.text()).split("\n").filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6)));
  assert.equal(events.at(-1).state, "completed");
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1));
  assert.equal(events.filter(e => e.type === "auth").length, 1);
  const m = f.model(a), model = await send(m); assert.equal(model.status, 200);
  const output = await fetch(`${origin}/api/engine-helper-runs/${m.operationId}/events?after=0`, { headers });
  assert.match(await output.text(), /dataBase64/);
  assert.deepEqual(f.starts().map(s => s.phase), ["auth", "model"]);
  const count = f.starts().length;
  const badOrigin = await send(f.req(), { Origin: "https://untrusted.invalid" }); assert.equal(badOrigin.status, 403); await badOrigin.text();
  const broad = await send(f.req(), { Authorization: "Bearer PLANTED-BROAD-TOKEN" }); assert.equal(broad.status, 403); assert.equal((await broad.text()).includes("PLANTED"), false);
  const wrongHost = await new Promise<number>(resolve => {
    const req = httpRequest(`${origin}/api/engine-helper-runs`, { method: "POST", headers: { ...headers, Host: "untrusted.invalid" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.end(JSON.stringify(f.req()));
  });
  assert.equal(wrongHost, 403);
  const cursor = await fetch(`${origin}/api/engine-helper-runs/${a.operationId}/events?after=99999`, { headers }); assert.equal(cursor.status, 400); await cursor.text();
  const otherCap = f.broker.issue({ ...f.origin, id: "other-origin" }, () => true);
  const read = await fetch(`${origin}/api/engine-helper-runs/${a.operationId}/events`, { headers: { Authorization: `EngineHelper ${otherCap}` } }); assert.equal(read.status, 403); await read.text();
  const cancel = await fetch(`${origin}/api/engine-helper-runs/${a.operationId}`, { method: "DELETE", headers: { Authorization: `EngineHelper ${otherCap}` } }); assert.equal(cancel.status, 403); await cancel.text();
  await f.pause(); const held = await send(f.req()); assert.equal(held.status, 200); assert.equal((await held.json() as any).state, "pending");
  assert.equal(f.starts().length, count, "denied HTTP request reached a fake child");
});

test("activation and permission/root changes during durable preparation win before actual spawn", async t => {
  for (const scenario of ["pause", "permissions", "roots"] as const) {
    const f = fixture(t); await f.auth(); const baseline = f.starts().length;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let a = f.req();
    const one = join(f.home, "one"), two = join(f.home, "two"), link = join(f.home, "root-link");
    if (scenario === "roots") {
      mkdirSync(one); mkdirSync(two); symlinkSync(one, link); a = f.req({ additionalDirectories: [link] });
    }
    const save = f.storage.save;
    let held = false;
    f.storage.save = async value => {
      if (!held && (value as any).operations.some((r: any) => r.id === a.operationId && r.invocationId)) {
        held = true; entered(); await blocked;
      }
      await save(value);
    };
    await f.start(a); await writing;
    if (scenario === "pause") await f.pause();
    if (scenario === "permissions") f.change({ effectiveFullAccess: false, permissionGeneration: "reduced-after-preparation" });
    if (scenario === "roots") { unlinkSync(link); symlinkSync(two, link); }
    release(); await f.broker.settled(f.token, a.operationId);
    assert.equal(f.starts().length, baseline, `${scenario} crossed the actual child boundary`);
    assert.ok(["pending", "cancelled"].includes(f.broker.status().operations[1].state));
    const terminal = f.broker.events(f.token, a.operationId).find(e => e.type === "terminal")!;
    assert.equal(terminal.exitCode, null, "never-spawned terminal must carry explicit null exitCode");
    assert.equal(terminal.signal, null, "never-spawned terminal must carry explicit null signal");
    assert.equal(terminal.outputComplete, false);
  }
});

test("ledger failure after spawn still stops the exact child and preserves uncertain intent", async t => {
  const f = fixture(t); await f.auth(); f.set({ hangAuth: true });
  const a = f.req(), save = f.storage.save;
  f.storage.save = value => {
    if ((value as any).operations.some((r: any) => r.id === a.operationId && r.state === "running")) throw new Error("PLANTED-STORAGE-SECRET");
    return save(value);
  };
  await f.start(a); await f.broker.settled(f.token, a.operationId);
  assert.equal(f.broker.status().unavailable, true);
  const restored = new EngineHelperBroker(new EnginePauses(f.policyStorage), f.storage, () => f.profile());
  assert.equal(restored.status().operations[1].state, "residual");
  assert.equal(restored.status().operations[1].localClosed, false);
  assert.equal(JSON.stringify(restored.status()).includes("PLANTED"), false);
});

test("a pending pause write fences the actual helper spawn, not just initial selection", async t => {
  const f = fixture(t); await f.auth(); const baseline = f.starts().length, a = f.req();
  let releaseBroker!: () => void, brokerEntered!: () => void, releasePause!: () => void, pauseEntered!: () => void;
  const brokerWait = new Promise<void>(resolve => { releaseBroker = resolve; });
  const brokerWriting = new Promise<void>(resolve => { brokerEntered = resolve; });
  const pauseWait = new Promise<void>(resolve => { releasePause = resolve; });
  const pauseWriting = new Promise<void>(resolve => { pauseEntered = resolve; });
  const saveBroker = f.storage.save, savePause = f.policyStorage.save;
  let held = false;
  f.storage.save = async value => {
    if (!held && (value as any).operations.some((r: any) => r.id === a.operationId && r.invocationId)) { held = true; brokerEntered(); await brokerWait; }
    await saveBroker(value);
  };
  f.policyStorage.save = async value => {
    if ((value as any).pauses.length) { pauseEntered(); await pauseWait; }
    await savePause(value);
  };
  await f.start(a); await brokerWriting;
  const activating = f.pause(); await pauseWriting;
  try {
    releaseBroker();
    await until(() => f.broker.events(f.token, a.operationId).some(e => e.type === "terminal" || e.type === "launched"));
    assert.equal(f.broker.events(f.token, a.operationId).some(e => e.type === "launched"), false, "forbidden auth crossed pending policy at actual spawn");
    assert.equal(f.starts().length, baseline);
  } finally { releaseBroker(); releasePause(); await activating; }
  await f.broker.settled(f.token, a.operationId);
});

test("model-specific activation cancels an allowed running primary whose internal fallback may be protected", async t => {
  const f = fixture(t), a = await f.auth(); f.set({ hangModel: true, ignoreTerm: true });
  const m = f.model(a); await f.start(m); await until(() => f.starts().length === 2);
  await f.pause({ model: "opus" });
  assert.equal(f.policy.status().invocations[0].state, "cancelRequested");
  await f.broker.settled(f.token, m.operationId);
  const state = f.broker.status().operations[1];
  assert.equal(state.localClosed, true); assert.equal(state.state, "residual");
  assert.equal(state.remote, "unconfirmed", "a sent cancel falsely proved remote completion");
  assert.equal(state.outputComplete, false);
  assert.equal(f.starts().length, 2);
  f.setNow(11_000);
  await assert.rejects(f.start(f.model(a)), code("conflict"));
  assert.equal(f.starts().length, 2, "cancelled/residual review replayed under a new model UUID");
});

test("model crash or output overflow cannot be returned as a valid content stream plus residual", async t => {
  for (const settings of [{ modelCrash: true }, { overflowModel: true }]) {
    const f = fixture(t), a = await f.auth(); f.set(settings);
    const m = f.model(a); await f.start(m); await f.broker.settled(f.token, m.operationId);
    const terminal = f.broker.events(f.token, m.operationId).filter(e => e.type === "terminal").at(-1)!;
    assert.equal(terminal.state, "failed"); assert.equal(terminal.outputComplete, false);
    assert.equal(f.broker.status().operations[1].outstanding, true);
    assert.equal(f.policy.status().invocations[0].state, "residual", "broken output erased uncertain provider work");
    await assert.rejects(f.start(f.model(a)), code("conflict"));
    assert.equal(f.starts().length, 2);
  }
});
