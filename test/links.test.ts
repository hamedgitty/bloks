// bloks:// links (electron/links.mjs).
//
// On Windows and Linux a link that opened Bloks arrives as one of the
// launch's own arguments, and only a second launch's arguments were ever
// read, so "Add to Bloks" did nothing when Bloks was not already running.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { linkInArgv, teamLink } from "../electron/links.mjs";

test("only a gallery team by name is a link worth passing on", () => {
  assert.deepEqual(teamLink("bloks://team/research-crew"), { kind: "team", slug: "research-crew" });
  assert.deepEqual(teamLink("bloks://team/research-crew/"), { kind: "team", slug: "research-crew" });
  assert.equal(teamLink("bloks://team/Research Crew"), null);
  assert.equal(teamLink("bloks://pair/abc"), null);
  assert.equal(teamLink("https://team/research-crew"), null);
  assert.equal(teamLink("not a link"), null);
});

test("the link is found among a launch's arguments, wherever the system puts it", () => {
  // Windows, opened by the link
  assert.equal(linkInArgv(["C:\\Program Files\\Bloks\\Bloks.exe", "bloks://team/research-crew"]), "bloks://team/research-crew");
  // Linux, with a flag of Chromium's ahead of it
  assert.equal(linkInArgv(["/opt/Bloks/bloks", "--no-sandbox", "bloks://team/x"]), "bloks://team/x");
  assert.equal(linkInArgv(["/opt/Bloks/bloks"]), null);
  assert.equal(linkInArgv(undefined), null);
});

test("the launch the link started reads its own arguments, not only a second launch's", () => {
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("app.whenReady().then(");
  assert.ok(start >= 0, "no whenReady block to look in");
  const ready = main.slice(start, main.indexOf("\n});\n", start));
  assert.match(ready, /deliverLink\((\w+)\)/);
  assert.match(ready, /linkInArgv\(process\.argv\)/, "a link that opened Bloks on Windows or Linux is never delivered");
});
