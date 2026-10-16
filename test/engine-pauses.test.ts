// Restriction/persistence core only. Driver and HTTP integration proofs are
// separate: these tests do not claim all provider entry points are wired.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EnginePauses, EnginePauseError, pauseFile, type EngineRoute, type PauseRequest, type PauseStorage } from "../server/engine-pauses.ts";

const actor = { kind: "agent", id: "coordinator" } as const;
const origin = { kind: "agent", agentId: "worker", laneId: "lane" } as const;
const claude: EngineRoute = { instanceId: "primary", driverKind: "claudeAgent", family: "claude", model: "exact-primary" };
const request = (id = "pause", extra: Partial<PauseRequest> = {}): PauseRequest => ({ id, agents: "all", selector: { family: "claude" }, until: 2_000, timeZone: "Europe/Berlin", ...extra });
function memory() {
  let state: unknown = { version: 1, pauses: [], invocations: [] };
  return { load: () => structuredClone(state), save: (next: unknown) => { state = structuredClone(next); } };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  return { wait, release };
}

test("policy cancellation provenance survives restart and expiry without authorizing an old lane replay", async () => {
  const storage = memory();let now = 1_000;
  const policy = new EnginePauses(storage, () => now);
  const lease = await policy.prepare(origin, [claude], "turn");let calls = 0;
  lease.invoke(() => { calls++; });
  await policy.activate(actor, request());
  assert.equal((storage.load() as any).invocations[0].cancelRequestedAt, 1_000, "policy cancellation provenance was not durable before driver cancellation");
  now = 3_000;
  const restarted = new EnginePauses(storage, () => now);
  assert.equal(restarted.status().pauses[0].state, "expired");
  assert.equal(restarted.interruptedLane("worker", "lane", 999), true, "expiry forgot the interrupted source");
  assert.equal(restarted.interruptedLane("worker", "other-lane", 999), false);
  assert.equal(restarted.interruptedLane("worker", "lane", 1_001), false, "an older generation blocked unrelated new work");
  const allowed = await restarted.prepare({ ...origin, laneId: "new-lane" }, [claude], "positive");allowed.invoke(() => { calls++; });await allowed.closed();
  assert.equal(calls, 2);
  assert.equal(restarted.status().invocations[0].state, "residual");
});
const code = (wanted: EnginePauseError["code"]) => (e: unknown) => e instanceof EnginePauseError && e.code === wanted;

test("activation fences dispatch during blocked persistence, then cancels after durable commit", async () => {
  const store = memory(), entered = barrier(), release = barrier();
  let blocked = false, durable = false, cancels = 0, invocations = 0;
  const storage: PauseStorage = { load: store.load, async save(value) {
    if (blocked) { entered.release(); await release.wait; }
    store.save(value); durable = true;
  } };
  const policy = new EnginePauses(storage, () => 1_000);
  const lease = await policy.prepare(origin, [claude], "turn");
  lease.onCancel(() => { assert.equal(durable, true); cancels++; });
  lease.invoke(() => invocations++);
  durable = false; blocked = true;
  const saving = policy.activate(actor, request());
  await entered.wait;
  assert.throws(() => lease.invoke(() => invocations++), code("activating"));
  assert.equal(policy.status().activating.length, 1);
  assert.equal(cancels, 0, "cancellation preceded durable restriction");
  release.release(); await saving;
  assert.equal(cancels, 1);
  assert.equal(policy.status().invocations[0].state, "cancelRequested");
  assert.equal(invocations, 1);
  await lease.closed();
  assert.equal(policy.status().invocations.length, 0);
});

test("a failed write is not a successful protection receipt or unrestricted future startup state", async () => {
  const storage: PauseStorage = { load: () => ({ version: 1, pauses: [], invocations: [] }), save: () => { throw new Error("planted-sensitive-value"); } };
  const policy = new EnginePauses(storage, () => 1_000);
  await assert.rejects(policy.activate(actor, request()), e => code("storage")(e) && !String(e).includes("planted"));
  assert.equal(policy.status().unavailable, true);
  assert.throws(() => policy.assertAllowed(origin, [claude]), code("storage"));
  assert.equal(policy.status().pauses.length, 0);
});

test("restart after commit enforces policy and retains uncertainty past expiry", async () => {
  const storage = memory();
  let now = 1_000;
  const policy = new EnginePauses(storage, () => now);
  const old = await policy.prepare(origin, [claude], "review");
  old.invoke(() => {});
  await policy.activate(actor, request());
  const restarted = new EnginePauses(storage, () => now);
  assert.equal(restarted.allowed(origin, [claude]), false);
  assert.equal(restarted.status().invocations[0].state, "residual");
  now = 2_000;
  assert.equal(restarted.allowed(origin, [claude]), true);
  assert.equal(restarted.status().invocations[0].state, "residual", "expiry erased uncertainty");
  await old.closed();
});

test("overlap, exact expiry, idempotency and cancellation never rewrite preferences", async () => {
  let now = 1_000;
  const policy = new EnginePauses(memory(), () => now);
  const preferred = { model: "exact-primary", backup: "exact-backup", effort: "high" };
  await policy.activate(actor, request("early"));
  await policy.activate(actor, request("late", { until: 3_000 }));
  preferred.model = "edited-model";
  now = 2_000;
  assert.equal(policy.allowed(origin, [claude]), false);
  await assert.rejects(policy.cancel({ kind: "agent", id: "other" }, "late"), code("forbidden"));
  await policy.cancel(actor, "late");
  assert.equal(policy.allowed(origin, [claude]), true);
  const duplicate = policy.activate(actor, request("late", { until: 3_000 }));
  assert.equal(policy.allowed(origin, [claude]), true, "idempotent cancelled request resurrected a fence");
  assert.ok((await duplicate).cancelledAt);
  await assert.rejects(policy.activate(actor, request("late", { until: 4_000 })), code("conflict"));
  await assert.rejects(policy.activate({ kind: "agent", id: "other" }, request("late", { until: 3_000 })), code("conflict"));
  assert.deepEqual(preferred, { model: "edited-model", backup: "exact-backup", effort: "high" });
  const expired = await policy.activate(actor, request("early"));
  assert.equal(expired.until, 2_000);
  assert.equal(policy.status().pauses.find(p => p.id === "early")?.state, "expired");
});

test("same-instance model backup works; actual small model and unknown aliases are matched", async () => {
  const policy = new EnginePauses(memory(), () => 1_000);
  await policy.activate(actor, request("model", { selector: { instanceId: "primary", model: "exact-primary" } }));
  const backup = { ...claude, model: "exact-backup" };
  assert.equal(policy.choose(origin, [{ routes: [claude] }, { routes: [backup] }])?.routes[0].model, "exact-backup");
  assert.equal(policy.allowed(origin, [{ ...claude, model: null }]), false);
  assert.equal(policy.allowed(origin, [backup]), true, "positive alternative did not run");
  await policy.activate(actor, request("small", { selector: { model: "small" } }));
  assert.equal(policy.allowed(origin, [backup]), true);
  assert.equal(policy.allowed(origin, [{ ...backup, model: "small" }]), false);
});

test("scoped agents, all/future agents, shared factory identity and multiple instances", async () => {
  const policy = new EnginePauses(memory(), () => 1_000);
  await policy.activate(actor, request("scoped", { agents: ["worker"] }));
  assert.equal(policy.allowed(origin, [claude]), false);
  const unaffected = { kind: "agent", agentId: "unaffected" } as const;
  assert.equal(policy.allowed(unaffected, [claude]), true);
  assert.equal(policy.allowed({ kind: "service" }, [claude]), false, "unattributed catalog exempted itself");
  assert.equal(policy.allowed(origin, [{ ...claude, instanceId: "second" }]), false);
  await policy.activate(actor, request("all"));
  assert.equal(policy.allowed({ kind: "agent", agentId: "future" }, [claude]), false);
  assert.equal(policy.allowed(unaffected, [{ instanceId: "api", driverKind: "api", family: "openai", model: "known" }]), true);
  assert.equal(policy.allowed(unaffected, [{ instanceId: "custom", driverKind: "custom", family: null, model: null }]), false);
});

test("second captured invocation cannot reuse a permission across an await or reload", async () => {
  const policy = new EnginePauses(memory(), () => 1_000);
  const lease = await policy.prepare(origin, [claude], "skill-review");
  let calls = 0;
  lease.invoke(() => calls++);
  await policy.activate(actor, request());
  assert.throws(() => lease.invoke(() => calls++), code("closed"));
  assert.equal(calls, 1);
  assert.equal(policy.status().invocations.length, 1, "parent ended/reload erased a captured invocation");
  await lease.closed();
});

test("late cancellation is generation scoped and a hanging cancel leaves status available", async () => {
  let now = 1_000;
  const policy = new EnginePauses(memory(), () => now);
  const first = await policy.prepare(origin, [claude], "turn");
  let oldCancelled = 0, newCancelled = 0;
  const hangs = barrier();
  first.onCancel(() => { oldCancelled++; return hangs.wait; });
  first.invoke(() => {});
  await policy.activate(actor, request());
  assert.equal(oldCancelled, 1);
  assert.equal(policy.status().invocations.length, 1);
  now = 2_000;
  const next = await policy.prepare(origin, [claude], "turn");
  next.onCancel(() => { newCancelled++; });
  next.invoke(() => {});
  await first.closed();
  hangs.release();
  assert.equal(newCancelled, 0);
  assert.equal(policy.status().invocations[0].id, next.record.id);
  await next.closed();
});

test("a residual cannot be reused and a caller cannot mutate the lease's admission identity", async () => {
  const policy = new EnginePauses(memory(), () => 1_000);
  const run = await policy.prepare(origin, [claude], "turn");
  const view = run.record;
  if (view.origin.kind === "agent") view.origin.agentId = "unaffected";
  view.routes[0].family = "openai";
  await policy.activate(actor, request("scoped", { agents: ["worker"] }));
  assert.equal(run.signal.aborted, true, "mutable public record changed cancellation scope");
  await run.closed();
  const residual = await policy.prepare({ kind: "agent", agentId: "unaffected" }, [claude], "remote");
  residual.invoke(() => {});
  await residual.residual();
  assert.throws(() => residual.invoke(() => assert.fail("uncertain operation replayed")), code("closed"));
  assert.equal(policy.status().invocations[0].state, "residual");
  await residual.closed();
});

test("a real fake child is cancelled by its own lease while another agent keeps running", async t => {
  const policy = new EnginePauses(memory(), () => 1_000);
  const first = await policy.prepare(origin, [claude], "turn");
  const second = await policy.prepare({ kind: "agent", agentId: "unaffected" }, [claude], "turn");
  const children: ChildProcessWithoutNullStreams[] = [];
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const start = async (lease: typeof first) => {
    const child = lease.invoke(() => spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(()=>{},1000)'], { env: {}, stdio: ["pipe", "pipe", "pipe"] }));
    children.push(child);
    lease.onCancel(() => { child.kill("SIGTERM"); });
    await once(child.stdout, "data");
    return child;
  };
  const a = await start(first), b = await start(second);
  const closed = once(a, "close");
  await policy.activate(actor, request("scoped", { agents: ["worker"] }));
  await closed;
  await first.closed();
  assert.equal(b.exitCode, null);
  assert.equal(b.signalCode, null, "shared engine cancellation killed the other agent");
  assert.equal(policy.status().invocations.length, 1);
  const otherClosed = once(b, "close"); b.kill("SIGTERM"); await otherClosed; await second.closed();
});

test("strict file storage preserves policy across restart, protects mode and fails closed on corrupt input", async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-pause-core-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "pauses.json");
  const policy = new EnginePauses(pauseFile(file), () => 1_000);
  await policy.activate(actor, request());
  assert.equal(new EnginePauses(pauseFile(file), () => 1_000).allowed(origin, [claude]), false);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = readFileSync(file, "utf8");
  assert.ok(before.includes('"version":1'));
  writeFileSync(file, '{"secret":"planted-secret", broken');
  const broken = new EnginePauses(pauseFile(file), () => 1_000);
  assert.equal(broken.status().unavailable, true);
  assert.throws(() => broken.assertAllowed(origin, [claude]), e => code("storage")(e) && !String(e).includes("planted"));
  await assert.rejects(broken.activate(actor, request()), code("storage"));
  assert.equal(readFileSync(file, "utf8"), '{"secret":"planted-secret", broken');
});

for (const stage of ["before-commit", "after-commit"] as const) test(`a process crash ${stage} cannot acknowledge an unrestricted pause`, async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-pause-crash-")), file = join(home, "pauses.json");
  const entry = new URL("../server/engine-pauses.ts", import.meta.url).href;
  const script = `
    import {EnginePauses,pauseFile} from ${JSON.stringify(entry)};
    const disk=pauseFile(${JSON.stringify(file)});
    const stage=${JSON.stringify(stage)};
    const policy=new EnginePauses({load:disk.load,save:async state=>{
      if(stage==='after-commit') disk.save(state);
      console.log('barrier');
      setInterval(()=>{},1000);
      await new Promise(()=>{});
    }},()=>1000);
    const saving=policy.activate({kind:'owner'},${JSON.stringify(request())});
    let forbidden=0;
    try{policy.assertAllowed(${JSON.stringify(origin)},[${JSON.stringify(claude)}]);forbidden++;}catch{}
    if(forbidden) console.log('FORBIDDEN');
    await saving;
    console.log('ACKNOWLEDGED');
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(home, { recursive: true, force: true });
  });
  await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error(`child exited before persistence barrier: ${err}`); })]);
  assert.equal(out, "barrier\n", err);
  child.kill("SIGKILL"); await closed;
  assert.equal(out.includes("FORBIDDEN"), false);
  assert.equal(out.includes("ACKNOWLEDGED"), false);
  const restarted = new EnginePauses(pauseFile(file), () => 1_000);
  assert.equal(restarted.status().unavailable, false);
  assert.equal(restarted.allowed(origin, [claude]), stage === "before-commit");
  assert.equal(restarted.status().pauses.length, stage === "after-commit" ? 1 : 0);
});

test("concurrent activation preserves both scopes and discarded metadata never reaches status", async () => {
  const storage = memory();
  const policy = new EnginePauses(storage, () => 1_000);
  await Promise.all([
    policy.activate(actor, request("first", { agents: ["worker", "worker"] })),
    policy.activate(actor, request("second", { agents: ["other"] })),
  ]);
  assert.equal(policy.status().pauses.length, 2);
  const saved = storage.load() as any;
  saved.pauses[0].secret = "planted-sensitive-value";
  saved.pauses[0].creator.secret = "planted-sensitive-value";
  const reloaded = new EnginePauses({ load: () => saved, save: storage.save }, () => 1_000);
  assert.equal(reloaded.allowed(origin, [claude]), false);
  assert.equal(JSON.stringify(reloaded.status()).includes("planted-sensitive-value"), false);
  const same = await reloaded.activate(actor, request("first", { agents: ["worker"] }));
  assert.deepEqual(same.agents, ["worker"]);
});
