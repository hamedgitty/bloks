import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsReporter, type ReportAdmission, type SettingsReportTransport } from "../src/lib/settings-reporter.ts";
import type { DeviceSettingsSnapshot } from "../src/lib/settings-observation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Drain only queued promise work; no clock waits or timers in this fixture.
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const admission = (generation = "first"): ReportAdmission => ({
  label: "fixture-window", capability: `private-${generation}`, generation, lifetimeMs: 60_000,
});
function setup(native?: () => Promise<unknown>) {
  let now = 0;
  let theme = "dark";
  let captures = 0;
  let admissions = 0;
  const reports: { admission: ReportAdmission; sequence: number; snapshot: DeviceSettingsSnapshot }[] = [];
  const reporter = new SettingsReporter({
    capture: () => { captures++; return { "theme.applied": { status: "observed", value: theme } }; },
    native, monotonic: () => now, wall: () => 123,
  });
  const transport: SettingsReportTransport = {
    admit: async () => admission(String(++admissions)),
    post: async (a, sequence, snapshot) => { reports.push({ admission: a, sequence, snapshot }); },
  };
  return {
    reporter, transport, reports, captures: () => captures, admissions: () => admissions,
    advance: (ms: number) => { now += ms; }, change: (value: string) => { theme = value; reporter.changed(); },
  };
}

test("D2 two changes during admission coalesce; capture follows issuance and uses latest committed value", async () => {
  const f = setup();
  const opened = deferred<ReportAdmission>();
  let opens = 0;
  f.transport.admit = () => { opens++; return opened.promise; };
  f.reporter.connect(f.transport);
  await flush();
  f.change("light");
  f.change("dark");
  await flush();
  assert.equal(opens, 1);
  assert.equal(f.captures(), 0, "snapshot was captured before slow session issuance");
  opened.resolve(admission());
  await flush();
  assert.equal(f.reports.length, 1);
  assert.equal(f.captures(), 1);
  assert.equal(f.reports[0].snapshot.revision, 3);
  assert.deepEqual(f.reports[0].snapshot.values["theme.applied"], { status: "observed", value: "dark" });
  f.reporter.disconnect();
});

test("I7 one report in flight retains only one latest replacement", async () => {
  const f = setup();
  const sent = deferred<void>();
  const post = f.transport.post;
  let inFlight = 0;
  let maximum = 0;
  f.transport.post = async (...args) => {
    maximum = Math.max(maximum, ++inFlight);
    await post(...args);
    if (f.reports.length === 1) await sent.promise;
    inFlight--;
  };
  f.reporter.connect(f.transport);
  await flush();
  for (let i = 0; i < 500; i++) f.change(i % 2 ? "light" : "dark");
  await flush();
  assert.equal(f.reports.length, 1);
  sent.resolve();
  await flush();
  assert.equal(f.reports.length, 2);
  assert.equal(maximum, 1);
  assert.equal(f.reports[1].snapshot.revision, 501);
  assert.deepEqual(f.reports[1].snapshot.values["theme.applied"], { status: "observed", value: "light" });
  f.reporter.disconnect();
});

test("D2 expired authority renews once for actual changes, never on idle or report acknowledgement", async () => {
  const f = setup();
  f.reporter.connect(f.transport);
  await flush();
  assert.equal(f.admissions(), 1);
  f.advance(60_000);
  await flush();
  assert.equal(f.admissions(), 1);
  const renewed = deferred<ReportAdmission>();
  let renewals = 0;
  f.transport.admit = () => { renewals++; return renewed.promise; };
  f.change("light");
  await flush();
  f.change("dark");
  f.change("light");
  await flush();
  assert.equal(renewals, 1);
  assert.equal(f.reports.length, 1);
  renewed.resolve(admission("renewed"));
  await flush();
  assert.equal(f.reports.length, 2);
  assert.equal(f.reports[1].sequence, 1);
  assert.equal(f.reports[1].admission.generation, "renewed");
  assert.deepEqual(f.reports[1].snapshot.values["theme.applied"], { status: "observed", value: "light" });
  await flush();
  assert.equal(renewals, 1);
  f.reporter.disconnect();
});

test("D2 lost admission reply is not retried; subsequent real change may try once", async () => {
  const f = setup();
  const lost = deferred<ReportAdmission>();
  let opens = 0;
  f.transport.admit = () => { opens++; return lost.promise; };
  f.reporter.connect(f.transport);
  await flush();
  f.change("light");
  lost.reject(Error("ambiguous lost reply"));
  await flush();
  assert.equal(opens, 1, "ambiguous session open was replayed");
  assert.equal(f.reports.length, 0);
  await flush();
  assert.equal(opens, 1);
  f.transport.admit = async () => { opens++; return admission("next-change"); };
  f.change("light");
  await flush();
  assert.equal(opens, 2);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0].snapshot.values["theme.applied"], { status: "observed", value: "light" }, "report failure must leave preference usable");
  f.reporter.disconnect();
});

test("D2 close while open is outstanding discards the late response", async () => {
  const f = setup();
  const old = deferred<ReportAdmission>();
  f.transport.admit = () => old.promise;
  f.reporter.connect(f.transport);
  await flush();
  f.reporter.disconnect();
  old.resolve(admission());
  await flush();
  assert.equal(f.reports.length, 0);
  assert.equal(f.captures(), 0);
});

test("D2 mode switch/reconnect while open is pending cannot install the old admission", async () => {
  const f = setup();
  const old = deferred<ReportAdmission>();
  f.transport.admit = () => old.promise;
  f.reporter.connect(f.transport);
  await flush();
  const next: SettingsReportTransport = { ...f.transport, admit: async () => admission("replacement") };
  f.reporter.connect(next);
  old.resolve(admission("obsolete"));
  await flush();
  assert.equal(f.reports.length, 1);
  assert.equal(f.reports[0].admission.generation, "replacement");
  f.reporter.disconnect();
});

test("D3 admission arriving after conservative elapsed deadline cannot post or renew itself", async () => {
  const f = setup();
  const old = deferred<ReportAdmission>();
  let opens = 0;
  f.transport.admit = () => { opens++; return old.promise; };
  f.reporter.connect(f.transport);
  await flush();
  f.advance(60_000);
  old.resolve(admission());
  await flush();
  assert.equal(f.reports.length, 0);
  assert.equal(opens, 1);
  f.reporter.disconnect();
});

test("D5 one completed native result publishes once, then idle causes zero capture/report/renewal", async () => {
  const native = deferred<unknown>();
  let reads = 0;
  const f = setup(() => {
    if (++reads > 2) return Promise.reject(Error("fixture stops runaway native capture"));
    return native.promise;
  });
  f.reporter.connect(f.transport);
  await flush();
  assert.equal(reads, 1);
  assert.equal(f.reports.length, 1);
  native.resolve({ "native.mode": { status: "observed", value: "remote" }, privateKey: "SECRET" });
  await flush();
  assert.equal(f.reports.length, 2);
  assert.equal(reads, 1, "native completion fed back into another native capture");
  assert.deepEqual(f.reports[1].snapshot.values["native.mode"], { status: "observed", value: "remote" });
  assert.deepEqual(f.reports[1].snapshot.values["theme.applied"], { status: "observed", value: "dark" });
  assert(!JSON.stringify(f.reports).includes("SECRET"));
  f.advance(120_000);
  await flush();
  assert.equal(reads, 1);
  assert.equal(f.reports.length, 2);
  assert.equal(f.admissions(), 1);
  f.reporter.disconnect();
});

test("D5 stale native completion cannot overwrite a committed preference revision", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let reads = 0;
  const f = setup(() => ++reads === 1 ? first.promise : second.promise);
  f.reporter.connect(f.transport);
  await flush();
  f.change("light");
  await flush();
  first.resolve({ "native.mode": { status: "observed", value: "remote" } });
  await flush();
  assert.equal(reads, 2, "one pending actual-change capture must proceed after obsolete completion");
  assert(f.reports.every((x) => x.snapshot.values["native.mode"].status === "unknown"));
  second.resolve({ "native.mode": { status: "observed", value: "local" } });
  await flush();
  assert.equal(reads, 2);
  assert.deepEqual(f.reports.at(-1)!.snapshot.values["native.mode"], { status: "observed", value: "local" });
  assert.deepEqual(f.reports.at(-1)!.snapshot.values["theme.applied"], { status: "observed", value: "light" });
  f.reporter.disconnect();
});

test("D5 unmount suppresses obsolete native completion, including late expired completion", async () => {
  const native = deferred<unknown>();
  let reads = 0;
  const f = setup(() => { reads++; return native.promise; });
  f.reporter.connect(f.transport);
  await flush();
  f.reporter.disconnect();
  native.resolve({ "native.mode": { status: "observed", value: "remote" } });
  await flush();
  assert.equal(f.reports.length, 1);
  assert.equal(reads, 1);
  const late = deferred<unknown>();
  const g = setup(() => late.promise);
  g.reporter.connect(g.transport);
  await flush();
  g.advance(60_000);
  late.resolve({ "native.mode": { status: "observed", value: "remote" } });
  await flush();
  assert.equal(g.reports.length, 1, "native-only completion must not renew expired authority");
  assert.equal(g.admissions(), 1);
  g.reporter.disconnect();
});

test("D5 native results from the old mode cannot enter the reconnected window", async () => {
  const old = deferred<unknown>();
  const current = deferred<unknown>();
  let reads = 0;
  const f = setup(() => ++reads === 1 ? old.promise : current.promise);
  f.reporter.connect(f.transport);
  await flush();
  f.reporter.connect({ ...f.transport, admit: async () => admission("remote-mode") });
  await flush();
  assert.equal(reads, 1, "native reads must remain bounded across a mode switch");
  old.resolve({ "native.mode": { status: "observed", value: "local" } });
  await flush();
  assert.equal(reads, 2);
  assert(f.reports.every((report) => report.snapshot.values["native.mode"].status === "unknown"));
  current.resolve({ "native.mode": { status: "observed", value: "remote" } });
  await flush();
  assert.equal(f.reports.at(-1)!.admission.generation, "remote-mode");
  assert.deepEqual(f.reports.at(-1)!.snapshot.values["native.mode"], { status: "observed", value: "remote" });
  assert.equal(reads, 2);
  f.reporter.disconnect();
});
