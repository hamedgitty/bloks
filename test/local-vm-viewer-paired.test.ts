// The Local VM's desktop, full size, from a computer paired to the server
// it runs on. Paired by the server's address, the viewer answers through
// the app's stand-in (electron/remote.mjs) under its ticket, as it does on
// the server itself; through Bloks Cloud, which carries a request and its
// answer but never the viewer's live socket, the window is told to watch
// the frames instead. Before, both handed the window an address the
// stand-in answered with its own page, and the desktop was a blank frame.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startLanProxy, startRemoteProxy } from "../electron/remote.mjs";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startHarness } from "./helpers/server.ts";

const OWNER = "fixture-owner-device-token";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** The desktop service beside Bloks, as far as the viewer needs it. */
async function passwordService() {
  const server = createServer((socket) => {
    socket.once("data", (line) => {
      const op = JSON.parse(String(line)).op as string;
      socket.end(JSON.stringify(op === "password" ? { ok: true, stdout: "fixture-pw\n", stderr: "" } : { ok: false, stdout: "", stderr: "not here" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

test("a paired computer opens the Local VM full size: live by the server's address, as frames through Bloks Cloud", { timeout: 120_000 }, async (t) => {
  const relay = await sealedRelay();
  t.after(() => relay.stop());
  const service = await passwordService();
  t.after(() => service.server.close());
  const home = mkdtempSync(join(tmpdir(), "bloks-vm-paired-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".bloks"));
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      remote: { devices: [{ id: "owner-device", name: "Owner's Mac", hash: sha(OWNER), pairedAt: 1 }] },
      relay: { enabled: true, url: relay.url, agentToken: "fixture-relay-agent", clientToken: "fixture-relay-client" },
      profile: { name: "Owner" },
    }),
  );
  const h = await startHarness({ HOME: home, BLOKS_LOOPBACK_ONLY: "1", BLOKS_DESKTOP: `127.0.0.1:${service.port}` });
  t.after(() => h.stop());
  await relay.connection;

  const files = mkdtempSync(join(tmpdir(), "bloks-vm-paired-ui-"));
  t.after(() => rmSync(files, { recursive: true, force: true }));
  writeFileSync(join(files, "index.html"), "<!doctype html><title>Fixture app</title>");
  const direct = await startLanProxy({ url: h.url, deviceId: "owner-device", deviceToken: OWNER }, { staticDir: files });
  const cloud = await startRemoteProxy(
    { relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: "owner-device", deviceToken: OWNER },
    { staticDir: files },
  );
  t.after(() => {
    direct.stop();
    cloud.stop();
  });
  const mint = async (proxy: { port: number }) => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/api/local-vm/viewer`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return { status: res.status, body: await res.json() };
  };

  // by address: a ticketed viewer, and the stand-in takes its page to the
  // server rather than answering with the app's own
  const live = await mint(direct);
  assert.equal(live.status, 200, JSON.stringify(live.body));
  assert.match(live.body.url, /^\/local-vm\/desktop\/[0-9a-f]{48}\/vnc\.html\?.*#password=fixture-pw$/);
  const page = await fetch(`http://127.0.0.1:${direct.port}${live.body.url.split("#")[0]}`);
  const text = await page.text();
  assert.doesNotMatch(text, /Fixture app/, "the viewer's address reached the server, not the app's own page");
  // nothing listens where the viewer would in this fixture, so the server
  // says so; that it is the server answering is the point
  assert.equal(page.status, 502);
  assert.match(text, /virtual desktop is not answering/);

  // through Bloks Cloud: no address that cannot load, and frames instead
  const framed = await mint(cloud);
  assert.equal(framed.status, 200, JSON.stringify(framed.body));
  assert.deepEqual(framed.body, { url: null, frames: true });
});
