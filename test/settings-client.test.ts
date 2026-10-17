import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { consumeSettingsControl, disconnectSettingsReports, observeCommittedSettings } from "../src/lib/settings-client.ts";

async function flush(t: TestContext) { t.mock.timers.tick(250); for (let i = 0; i < 40; i++) await Promise.resolve(); }

test("D5 private control consumption publishes mounted committed owners without replaying frame extras", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetchBefore = globalThis.fetch;
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "bloks-theme" ? "dark" : null,
    setItem: () => { throw Error("reporting wrote preferences"); },
  } });
  const posts: Array<{ path: string; body: any }> = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(typeof path, "string");
    assert.equal(path, "/api/settings/device-report", "unexpected reporting/network path");
    posts.push({ path: path as string, body: JSON.parse(init!.body as string) });
    return Response.json({ ok: true });
  };
  const detach = observeCommittedSettings(() => ({ "theme.applied": { status: "observed", value: "light" } }));
  try {
    const control = { kind: "settings-report", windowKey: "w".repeat(43), admission: {
      label: "fixture", generation: "generation", capability: "c".repeat(43), lifetimeMs: 60_000, extra: "SECRET-CONTROL-EXTRA",
    }, _seq: 1, extra: "SECRET-FRAME-EXTRA" };
    assert.equal(consumeSettingsControl({ kind: "hello" }, performance.now()), false);
    assert.equal(consumeSettingsControl(control, performance.now()), true);
    await flush(t);
    assert.equal(posts.length, 1, "a browser without a native bridge must not publish an empty completion twice");
    assert.deepEqual(posts[0].body.snapshot.values["theme.applied"], { status: "observed", value: "light" });
    assert.deepEqual(posts[0].body.snapshot.values["theme.saved"], { status: "observed", value: "dark" }, "stored and committed preference must stay separate");
    assert.deepEqual(posts[0].body.snapshot.values["room.lens"], { status: "unknown", reason: "unmounted" });
    assert.deepEqual(posts[0].body.snapshot.values["native.mode"], { status: "unknown", reason: "unsupported" });
    assert(!JSON.stringify(posts).includes("SECRET"));
    detach();
    await flush(t);
    assert.deepEqual(posts.at(-1)!.body.snapshot.values["theme.applied"], { status: "unknown", reason: "unmounted" });
    const total = posts.length;
    assert.equal(consumeSettingsControl({ kind: "settings-report", unavailable: true }, performance.now()), true);
    await flush(t); assert.equal(posts.length, total);
  } finally {
    disconnectSettingsReports(); detach(); globalThis.fetch = fetchBefore;
    if (storageBefore) Object.defineProperty(globalThis, "localStorage", storageBefore);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("I4 malformed private control is consumed without publishing or invoking native/network work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected work"); };
  try {
    for (const bad of [null, { windowKey: "public-label" }, { admission: { capability: "bad" } }, { unavailable: true }]) {
      const raw = { kind: "settings-report", ...bad };
      assert(consumeSettingsControl(raw, performance.now()));
    }
    await flush(t); assert.equal(calls, 0);
  } finally { disconnectSettingsReports(); globalThis.fetch = previous; }
});
