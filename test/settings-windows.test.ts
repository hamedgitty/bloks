import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsWindows, SETTINGS_LEASE_MS, SETTINGS_REMOTE_WINDOWS, SETTINGS_DEVICE_WINDOWS } from "../server/settings-windows.ts";
import { MAX_SSE_CLIENTS } from "../server/limits.ts";
import { deviceSettingsSnapshot } from "../src/lib/settings-observation.ts";

function fixture() {
  let elapsed = 0;
  let wall = 1_700_000_000_000;
  const windows = new SettingsWindows({ monotonic: () => elapsed, wall: () => wall });
  return { windows, advance: (ms: number) => { elapsed += ms; }, wall: (time: number) => { wall = time; } };
}
const direct = { path: "direct", deviceId: null } as const;
const remote = { path: "remote", deviceId: "device-one" } as const;
function snapshot(revision = 1, theme = "dark") {
  return { schema: 1, revision, observedAt: 123, values: { "theme.applied": { status: "observed", value: theme } } };
}

test("I6 new windows are unknown; observations are full whitelisted replacements", () => {
  const { windows } = fixture();
  const { admission } = windows.open(direct)!;
  assert.equal(windows.inspect().windows[0].freshness, "unknown");
  assert.equal(windows.inspect().windows[0].lastReported, null);
  assert(windows.report(direct, admission, 1, snapshot()));
  const first = windows.inspect().windows[0];
  assert.equal(first.freshness, "recent-observation");
  assert.equal(first.source.identity, "unverified-window");
  assert.equal(first.transport, "observed-open");
  assert.deepEqual(first.lastReported!.snapshot.values["theme.applied"], { status: "observed", value: "dark" });
  assert(windows.report(direct, admission, 2, { schema: 1, revision: 2, observedAt: 124, values: {} }));
  assert.deepEqual(windows.inspect().windows[0].lastReported!.snapshot.values["theme.applied"], { status: "unknown", reason: "unsupported" });
});

test("I6 capabilities bind window, device, path and workspace; inspection never exposes admission", () => {
  const { windows } = fixture();
  const a = windows.open(remote)!;
  const b = windows.open(remote)!;
  assert(!windows.report(remote, { ...b.admission, capability: a.admission.capability }, 1, snapshot()));
  assert(!windows.report({ ...remote, deviceId: "device-two" }, a.admission, 1, snapshot()));
  assert(!windows.report({ path: "direct", deviceId: remote.deviceId }, a.admission, 1, snapshot()));
  assert(!fixture().windows.report(remote, a.admission, 1, snapshot()));
  assert(windows.report(remote, a.admission, 1, snapshot(1, "dark")));
  assert(windows.report(remote, b.admission, 1, snapshot(1, "light")));
  const output = JSON.stringify(windows.inspect());
  for (const material of [a.windowKey, b.windowKey, a.admission.capability, b.admission.capability, a.admission.generation, b.admission.generation]) {
    assert(!output.includes(material), "private admission material escaped inspection");
  }
  assert.deepEqual(windows.inspect().windows.map((x) => x.lastReported!.snapshot.values["theme.applied"]), [
    { status: "observed", value: "dark" }, { status: "observed", value: "light" },
  ]);
  assert(windows.inspect().windows.every((x) => x.transport === "unconfirmed"));
});

test("I7 sequence and committed revision reject duplicate and reordered reports", () => {
  const { windows } = fixture();
  const { admission } = windows.open(remote)!;
  assert(windows.report(remote, admission, 3, snapshot(5)));
  for (const seq of [-1, 0, 2, 3, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert(!windows.report(remote, admission, seq, snapshot(6, "light")));
  }
  assert(!windows.report(remote, admission, 4, snapshot(4, "light")));
  // Native completion can replace the same committed UI revision once; the
  // client prevents capture feedback and still supplies a larger sequence.
  assert(windows.report(remote, admission, 4, snapshot(5, "light")));
  assert.equal(windows.inspect().windows[0].lastReported!.sequence, 4);
});

test("I8 monotonic deadline ignores wall rollback, client time and delayed receipt", () => {
  const f = fixture();
  const { admission } = f.windows.open(remote)!;
  const data = snapshot();
  data.observedAt = Number.MAX_SAFE_INTEGER;
  f.advance(SETTINGS_LEASE_MS - 1);
  f.wall(-9_000_000);
  assert(f.windows.report(remote, admission, 1, data));
  const last = f.windows.inspect().windows[0].lastReported;
  assert.equal(last!.issuedAt, 1_700_000_000_000);
  assert.equal(last!.receivedAt, -9_000_000);
  assert.equal(f.windows.inspect().windows[0].freshness, "recent-observation");
  f.advance(1);
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown", "exact deadline must expire independent of late receipt");
  assert(!f.windows.report(remote, admission, 2, snapshot(2, "light")));
  assert.deepEqual(f.windows.inspect().windows[0].lastReported, last, "late newer sequence must preserve last accepted value");
  assert.equal(f.windows.inspect().windows[0].transport, "unconfirmed", "expiry must not infer remote disconnection");
});

test("D3 wall-clock forward jump does not shorten an elapsed-time lease", () => {
  const f = fixture();
  const { admission } = f.windows.open(remote)!;
  f.wall(Number.MAX_SAFE_INTEGER);
  assert(f.windows.report(remote, admission, 1, snapshot()), "wall-clock jump must not expire live elapsed-time authority");
  assert.equal(f.windows.inspect().windows[0].freshness, "recent-observation");
  f.advance(SETTINGS_LEASE_MS);
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown");
});

test("I8 late first report is rejected and cannot make an untouched entry fresh", () => {
  const f = fixture();
  const { admission } = f.windows.open(direct)!;
  f.advance(SETTINGS_LEASE_MS);
  assert(!f.windows.report(direct, admission, 1, snapshot()));
  assert.equal(f.windows.inspect().windows[0].lastReported, null);
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown");
});

test("D2 renewal retains one previous observation; old report and old close cannot touch replacement", () => {
  const f = fixture();
  const a = f.windows.open(remote)!;
  assert(f.windows.report(remote, a.admission, 1, snapshot()));
  f.advance(SETTINGS_LEASE_MS);
  const newer = f.windows.renew(a.binding)!;
  assert(newer);
  assert.notEqual(newer.generation, a.admission.generation);
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown");
  assert.equal(f.windows.inspect().windows[0].lastReported!.currentGeneration, false);
  assert(!f.windows.report(remote, newer, 1, snapshot(0, "light")), "renewal must not accept an obsolete committed revision");
  assert(!f.windows.report(remote, a.admission, 2, snapshot(2, "light")));
  assert(!f.windows.closeAdmission(remote, a.admission));
  assert(f.windows.report(remote, newer, 1, snapshot(2, "light")));
  for (let i = 0; i < 100; i++) f.windows.renew(a.binding);
  const output = f.windows.inspect();
  assert.equal(output.windows.length, 1);
  assert.deepEqual(output.windows[0].lastReported!.snapshot.values["theme.applied"], { status: "observed", value: "light" });
  assert.equal(output.windows[0].lastReported!.snapshot.revision, 2);
  assert.equal(JSON.stringify(output).match(/lastReported/g)!.length, 1, "renewal must not create a previous-generation chain");
});

test("D2 expired handle alone cannot resurrect a closed or replaced transport", () => {
  const f = fixture();
  const a = f.windows.open(remote)!;
  assert(f.windows.report(remote, a.admission, 1, snapshot()));
  f.windows.close(a.binding);
  f.advance(SETTINGS_LEASE_MS);
  assert.equal(f.windows.renew(a.admission), null, "serializable report authority is not a transport binding");
  assert.equal(f.windows.renewWindow(remote, a.admission.capability), null, "expired report capability must never become a window renewal key");
  assert.equal(f.windows.renewWindow(remote, a.windowKey), null, "closed private window binding must not renew");
  assert.equal(f.windows.renew(a.binding), null, "closed transport must not renew");
  assert(!f.windows.report(remote, a.admission, 2, snapshot(2)));
  const b = f.windows.open(remote)!;
  assert.notEqual(a.admission.label, b.admission.label);
  assert.equal(f.windows.inspect().windows[1].lastReported, null, "new window must not inherit another window's previous observation");
  assert.equal(f.windows.inspect().windows[0].freshness, "unknown");
  assert(f.windows.inspect().windows[0].lastReported);
});

test("I8 revocation and server restart invalidate old admissions without changing reported preferences", () => {
  const f = fixture();
  const a = f.windows.open(remote)!;
  const b = f.windows.open(direct)!;
  assert(f.windows.report(remote, a.admission, 1, snapshot()));
  f.windows.revoke(remote.deviceId);
  assert.equal(f.windows.renew(a.binding), null);
  assert(!f.windows.report(remote, a.admission, 2, snapshot(2)));
  assert.equal(f.windows.inspect().windows[0].transport, "revoked");
  assert(f.windows.inspect().windows[0].lastReported);
  assert(f.windows.report(direct, b.admission, 1, snapshot()));
  const restarted = fixture().windows;
  assert.equal(restarted.inspect().windows.length, 0);
  assert(!restarted.report(remote, a.admission, 3, snapshot()));
  assert.equal(restarted.renew(a.binding), null);
});

test("D4 direct anonymous open/close churn has a hard total record bound", () => {
  const f = fixture();
  for (let i = 0; i < MAX_SSE_CLIENTS * 5; i++) {
    const a = f.windows.open(direct)!;
    assert(a);
    assert(f.windows.report(direct, a.admission, 1, snapshot()));
    f.windows.close(a.binding);
    f.advance(1);
    assert(f.windows.inspect().windows.length <= MAX_SSE_CLIENTS, "retained direct records exceeded hard cap");
  }
  assert.equal(f.windows.inspect().windows.length, MAX_SSE_CLIENTS);
  assert.equal(f.windows.inspect().evictedObservations, MAX_SSE_CLIENTS * 4);
});

test("D4 all-live capacity refuses reporting; expiry retains values until disclosed reclamation", () => {
  const f = fixture();
  const all = Array.from({ length: MAX_SSE_CLIENTS }, () => f.windows.open(direct)!);
  assert(f.windows.report(direct, all[0].admission, 1, snapshot()));
  const before = f.windows.inspect();
  assert.equal(f.windows.open(direct), null);
  assert.deepEqual(f.windows.inspect(), before, "failed admission must not evict useful observations");
  f.advance(SETTINGS_LEASE_MS);
  assert(f.windows.inspect().windows[0].lastReported, "expiry alone must retain useful value");
  assert(f.windows.open(direct));
  assert.equal(f.windows.inspect().windows.length, MAX_SSE_CLIENTS);
  assert.equal(f.windows.inspect().evictedObservations, 1);
  assert.equal(f.windows.renew(all[0].binding), null, "evicted binding must not resurrect old authority");
});

test("D4 remote total and cross-path per-device limits count retained observations", () => {
  const f = fixture();
  for (let i = 0; i < SETTINGS_REMOTE_WINDOWS; i++) {
    assert(f.windows.open({ path: "remote", deviceId: `fixture-${Math.floor(i / SETTINGS_DEVICE_WINDOWS)}` }));
  }
  assert.equal(f.windows.open({ path: "remote", deviceId: "new-device" }), null);
  assert.equal(f.windows.inspect().windows.length, SETTINGS_REMOTE_WINDOWS);
  const g = fixture();
  for (let i = 0; i < SETTINGS_DEVICE_WINDOWS; i++) assert(g.windows.open({ ...remote, path: i % 2 ? "direct" : "remote" }));
  assert.equal(g.windows.open(remote), null, "per-device cap must include direct and remote records");
});

test("I6 malicious keys/getters/strings and mutable input cannot escape or rewrite accepted reports", () => {
  const f = fixture();
  const { admission } = f.windows.open(direct)!;
  const values = Object.create({ "theme.preference": { status: "observed", value: "light" } });
  Object.defineProperty(values, "native.mode", { get: () => { throw Error("not allowed"); } });
  values["theme.applied"] = { status: "observed", value: "SECRET-OPAQUE-URL" };
  values["unknown-secret-id"] = { status: "observed", value: "SECRET-OPAQUE-URL" };
  values["window.width"] = { status: "observed", value: Infinity };
  const data = { schema: 1, revision: 1, observedAt: 1, values };
  assert(f.windows.report(direct, admission, 1, data));
  assert(!JSON.stringify(f.windows.inspect()).includes("SECRET"));
  assert(!JSON.stringify(f.windows.inspect()).includes("unknown-secret-id"));
  values["theme.applied"] = { status: "observed", value: "light" };
  const output = f.windows.inspect();
  assert.deepEqual(output.windows[0].lastReported!.snapshot.values["theme.applied"], { status: "unknown", reason: "invalid" });
  output.windows[0].lastReported!.snapshot.values["theme.applied"] = { status: "observed", value: "dark" };
  assert.deepEqual(f.windows.inspect().windows[0].lastReported!.snapshot.values["theme.applied"], { status: "unknown", reason: "invalid" });
  assert(JSON.stringify(f.windows.inspect()).length < 16_384);
  for (const bad of [null, {}, { ...data, revision: -1 }, { ...data, observedAt: NaN }, { ...data, schema: 2 }]) assert.equal(deviceSettingsSnapshot(bad), null);
});
