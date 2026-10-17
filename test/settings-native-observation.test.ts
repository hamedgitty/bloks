import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeSettingsObservation } from "../electron/settings-observation.mjs";
import { deviceSettingsSnapshot } from "../src/lib/settings-observation.ts";

test("S4 finite native projection reads only the existing window/media/held flags, never profile or auth helpers", () => {
  const calls: string[] = [];
  const window = {
    isDestroyed: () => false,
    getBounds: () => { calls.push("bounds"); return { width: 1200, height: 900, x: 2, y: 3, extra: "SECRET-BOUNDS" }; },
    isMaximized: () => { calls.push("maximized"); return false; },
  };
  const input = {
    window, remote: true, shortcut: "SECRET-ACCELERATOR", update: "ready",
    media: (kind: string) => { calls.push(kind); return "granted"; },
  };
  Object.defineProperty(input, "profile", { get: () => { throw Error("private profile read"); } });
  Object.defineProperty(input, "auth", { get: () => { throw Error("auth helper started"); } });
  const raw = nativeSettingsObservation(input);
  assert.deepEqual(calls, ["bounds", "maximized", "microphone", "screen"]);
  assert(!JSON.stringify(raw).includes("SECRET"));
  const result = deviceSettingsSnapshot({ schema: 1, revision: 1, observedAt: 1, values: raw })!;
  assert.deepEqual(result.values["native.mode"], { status: "observed", value: "remote" });
  assert.deepEqual(result.values["native.quickAskRegistered"], { status: "observed", value: true });
  assert.deepEqual(result.values["native.updateState"], { status: "observed", value: "ready" });
  assert.deepEqual(result.values["native.authCapability"], { status: "unknown", reason: "unsupported" });
  assert.deepEqual(result.values["native.accessibility"], { status: "unknown", reason: "unsupported" });
});

test("S4 closed native window and missing media methods return explicit unsupported/unknown statuses", () => {
  const result = nativeSettingsObservation({
    window: { isDestroyed: () => true, getBounds: () => { throw Error("closed window was read"); }, isMaximized: () => false },
    remote: false, shortcut: null, update: "dev", media: () => undefined,
  });
  assert.deepEqual(result["window.width"], { status: "unknown", reason: "unsupported" });
  assert.deepEqual(result["native.microphone"], { status: "observed", value: "unknown" });
  assert.deepEqual(result["native.mode"], { status: "observed", value: "local" });
});
