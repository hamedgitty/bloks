// Each agent browser profile is a browser of its own, on a port of its
// own, found from the profile rather than from whoever reached a shared
// port first. Chrome itself is not started here: a script that speaks
// just enough of it stands in (helpers/fake-chrome.mjs).
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { closeBrowser, launch, listTargets, profilePort } from "../server/cdp.ts";

const scratch = mkdtempSync(join(tmpdir(), "bloks-cdp-"));
const chrome = join(scratch, "fake-chrome.mjs");
copyFileSync(fileURLToPath(new URL("./helpers/fake-chrome.mjs", import.meta.url)), chrome);
chmodSync(chrome, 0o755);

const started: string[] = [];
after(async () => {
  for (const profile of started) await closeBrowser(profile);
  rmSync(scratch, { recursive: true, force: true });
});

function profile(name: string) {
  const dir = join(scratch, name);
  started.push(dir);
  return dir;
}

async function gone(dir: string) {
  for (let i = 0; i < 40 && (await profilePort(dir)); i++) await new Promise((done) => setTimeout(done, 50));
  return (await profilePort(dir)) === null;
}

describe("a browser per profile", { skip: process.platform === "win32" && "a script stands in for Chrome" }, () => {
  test("two profiles are two browsers, and each is found again by its own", async () => {
    const ada = profile("ada");
    const room = profile("room-1");
    const adaPort = await launch(ada, chrome);
    const roomPort = await launch(room, chrome);
    assert.notEqual(roomPort, adaPort, "a shared room must never drive the agent's signed-in browser");
    assert.equal(await launch(ada, chrome), adaPort, "a running browser is used again, not started twice");
    assert.equal(await profilePort(room), roomPort);
    const [page] = await listTargets(roomPort);
    assert.equal(page.title, room, "the room's port reaches the room's browser");
  });

  test("two asking at once for one profile share one browser", async () => {
    const dir = profile("together");
    const [a, b] = await Promise.all([launch(dir, chrome), launch(dir, chrome)]);
    assert.equal(a, b);
  });

  test("a port left in a profile by a browser that is gone is not believed", async () => {
    const dir = profile("stale");
    mkdirSync(dir);
    // something else has since taken the port the old browser wrote down
    const other: Server = createServer((_req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/someone-else" })));
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const taken = (other.address() as AddressInfo).port;
    try {
      writeFileSync(join(dir, "DevToolsActivePort"), `${taken}\n/devtools/browser/the-old-one`);
      assert.equal(await profilePort(dir), null);
      const port = await launch(dir, chrome);
      assert.notEqual(port, taken);
      assert.equal(await profilePort(dir), port);
    } finally {
      other.close();
    }
  });

  test("closing one profile's browser leaves the others running", async () => {
    const one = profile("one");
    const two = profile("two");
    await launch(one, chrome);
    const twoPort = await launch(two, chrome);
    assert.equal(await closeBrowser(one), true);
    assert.ok(await gone(one), "the closed browser stopped listening");
    assert.equal(await profilePort(two), twoPort);
    assert.equal(await closeBrowser(join(scratch, "never-started")), false);
  });
});
