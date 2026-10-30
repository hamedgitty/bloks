// "Close to the tray" on Windows (electron/tray.mjs, GitHub 446): off
// unless turned on, kept with the theme (electron/workspaces.mjs), and
// never in the way of a real quit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { closeHides } from "../electron/tray.mjs";
import { parseRegistry, setTray } from "../electron/workspaces.mjs";

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
