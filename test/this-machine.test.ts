// What the server and the desktop app call the machine they run on: the
// app's own words (src/lib/thisComputer.ts), picked by the platform, with
// "Mac" only on a Mac (GitHub 429).
import { test } from "node:test";
import assert from "node:assert/strict";

import { machineKind, thisMachine } from "../server/this-machine.ts";
import { thisMachine as appMachine } from "../electron/hosting-move.mjs";

test("a Mac is this Mac, Windows this PC, anything else this computer, on both sides", () => {
  const words = { darwin: "this Mac", win32: "this PC", linux: "this computer", freebsd: "this computer" };
  for (const [platform, said] of Object.entries(words)) {
    assert.equal(thisMachine(platform), said, platform);
    assert.equal(appMachine(platform), said, `the app on ${platform}`);
  }
});

test("a desktop is a Mac on macOS, a PC on Windows, else a computer", () => {
  const kinds = { darwin: "mac", win32: "pc", linux: "computer", freebsd: "computer" };
  for (const [platform, kind] of Object.entries(kinds)) assert.equal(machineKind(platform), kind, platform);
});
