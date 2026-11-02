// "Close to the tray" on Windows (electron/tray.mjs, GitHub 446): off
// unless turned on, kept with the theme (electron/workspaces.mjs), and
// never in the way of a real quit.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { closeHides, traySize } from "../electron/tray.mjs";
import { parseRegistry, setTray } from "../electron/workspaces.mjs";

const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");

test("the close button hides the window only on Windows, with the setting on, and not while quitting", () => {
  const fresh = parseRegistry("{}");
  assert.equal(closeHides("win32", fresh.prefs, false), false, "off unless turned on: the window closes as before");
  const on = parseRegistry(JSON.stringify(setTray(fresh, true))).prefs;
  assert.equal(on.tray, true, "kept across a restart");
  assert.equal(closeHides("win32", on, false), true, "on: the window hides");
  assert.equal(closeHides("win32", on, true), false, "a real quit goes through");
  assert.equal(closeHides("darwin", on, false), false, "a Mac keeps its own close");
  assert.equal(closeHides("linux", on, false), false);
});

test("the tray icon is drawn at the notification area's size for the display's scale", () => {
  assert.equal(traySize(1), 16);
  assert.equal(traySize(1.25), 20);
  assert.equal(traySize(1.5), 24);
  assert.equal(traySize(2), 32);
  assert.equal(traySize(0), 16, "a scale that makes no sense is taken as 100%");
  assert.equal(traySize(Number.NaN), 16);
});

// The quits that do not go through before-quit first, read off the main
// process as written, since none of them can run without Electron.
test("every quit says so before a window is asked to close, and no icon means no hiding", () => {
  const close = main.match(/win\.on\("close", \(event\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
  assert.match(close, /if \(!tray \|\| !closeHides\(/, "a window is hidden only while there is an icon to bring it back");
  assert.match(main, /win\.on\("session-end", \(\) => \{\s*quitting = true;/, "Windows ending the session");
  assert.match(main, /quit: \(\) => \{\s*quitting = true;\s*return electronUpdater\.autoUpdater\.quitAndInstall\(\);/, "an update installing");
  assert.match(main, /app\.on\("before-quit", \(event\) => \{\s*quitting = true;/, "the tray's Quit, the menu's and a relaunch");
});
