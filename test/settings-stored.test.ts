import { test } from "node:test";
import assert from "node:assert/strict";
import { storedDeviceSettings, isSettingsStorageKey } from "../src/lib/settings-stored.ts";

test("S4 stored preferences have no invented defaults and read only fixed preference keys", () => {
  const seen: string[] = [];
  const result = storedDeviceSettings({ getItem: (key) => { seen.push(key); return null; } });
  assert.deepEqual(result["theme.saved"], { status: "observed", value: null });
  assert.deepEqual(result["conversations.saved"], { status: "observed", value: null });
  assert.deepEqual(result["desktop.savedDock"], { status: "observed", value: null });
  assert.deepEqual(result["terminal.savedHeight"], { status: "observed", value: null });
  assert.equal(seen.length, 7);
  assert(seen.every(isSettingsStorageKey));
  assert(isSettingsStorageKey(null));
  assert(!isSettingsStorageKey("private-session-token"));
});

test("S4 denied storage remains unavailable; malformed/opaque data never becomes an applied default", () => {
  const blocked = storedDeviceSettings({ getItem: () => { throw Error("SECRET-STORAGE-FAILURE"); } });
  assert(Object.values(blocked).every((x) => x?.status === "unknown" && x.reason === "unavailable"));
  const raw: Record<string, string> = {
    "bloks-theme": "SECRET-THEME", "bloks-show-conversations": "SECRET-CONVERSATIONS", "bloks-sidebar": "__proto__",
    "bloks-room-lens": "SECRET-LENS", "bloks-terminal-height": "",
    "bloks-folded-sections": '["SECRET-SECTION"]',
    "bloks-desktop-chat": '{"dock":"SECRET-DOCK","width":"SECRET-WIDTH","env":{"KEY":"SECRET-NESTED"}}',
  };
  const result = storedDeviceSettings({ getItem: (key) => raw[key] ?? null });
  assert(!JSON.stringify(result).includes("SECRET"));
  assert(!JSON.stringify(result).includes("__proto__"));
  assert.deepEqual(result["theme.saved"], { status: "unknown", reason: "invalid" });
  assert.deepEqual(result["terminal.savedHeight"], { status: "unknown", reason: "invalid" });
  assert.deepEqual(result["sidebar.savedFoldsConfigured"], { status: "observed", value: true });
});

test("S4 stored dock/geometry preserve finite values for comparison with mounted clamped layout", () => {
  const saved: Record<string, string> = {
    "bloks-theme": "system", "bloks-show-conversations": "off", "bloks-sidebar": "rail", "bloks-room-lens": "forum",
    "bloks-terminal-height": "0", "bloks-desktop-chat": '{"dock":"bottom","width":900,"height":30,"x":-400,"y":0}',
  };
  const result = storedDeviceSettings({ getItem: (key) => saved[key] ?? null });
  assert.deepEqual(result["theme.saved"], { status: "observed", value: "system" });
  assert.deepEqual(result["conversations.saved"], { status: "observed", value: false });
  assert.deepEqual(result["desktop.savedDock"], { status: "observed", value: "bottom" });
  assert.deepEqual(result["desktop.savedWidth"], { status: "observed", value: 900 });
  assert.deepEqual(result["desktop.savedX"], { status: "observed", value: -400 });
  assert.deepEqual(result["terminal.savedHeight"], { status: "observed", value: 0 });
});
