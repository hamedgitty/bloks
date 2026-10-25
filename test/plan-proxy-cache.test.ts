// Isolated real HTTP/proxy tests for Plan caching and desktop account signals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startLanProxy, startRemoteProxy } from "../electron/remote.mjs";
import { startFakeSite, SITE_LICENCE } from "./helpers/fake-site.ts";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const OWNER = "fixture-connected-owner";
async function fixture(t: TestContext, options: { relay: string; preload: (home: string) => string }) {
  const site = await startFakeSite();
  t.after(() => site.close());
  const home = mkdtempSync(join(tmpdir(), "bloks-plan-ipc-"));
  const data = join(home, ".bloks");
  mkdirSync(data);
  writeFileSync(join(data, "config.json"), JSON.stringify({
    credits: { licence: SITE_LICENCE }, brief: { enabled: false }, backups: { auto: false },
    remote: { enabled: true, devices: [{ id: "owner-device", name: "Fixture device", hash: createHash("sha256").update(OWNER).digest("hex"), pairedAt: 1 }] },
    relay: { enabled: true, url: options.relay, agentToken: "fixture-relay-agent" },
  }));
  const preload = join(home, "fixture-preload.mjs");
  writeFileSync(preload, options.preload(home));
  const h = await startHarness({ HOME: home, NODE_OPTIONS: `--import=${preload}`, BLOKS_SITE_URL: site.base,
    BLOKS_CREDITS_URL: `${site.base}/api/ai`, BLOKS_LOOPBACK_ONLY: "1" });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  return { h, site, home, data };
}
const localBearer = (h: Harness, token: string, path: string) => h.fetch(path, { headers: { authorization: `Bearer ${token}` } });
const noSecret = (text: string) => assert.ok(!text.includes(SITE_LICENCE), "a full licence escaped the fixture");

test("remote Plan reads update host entitlements without emitting a desktop account that can trigger Hosting", async (t) => {
  const relay = await sealedRelay();
  t.after(() => relay.stop());
  const { h, home, data, site } = await fixture(t, { relay: relay.url, preload: (root) => `
import { appendFileSync } from "node:fs";
process.parentPort = {
  postMessage(message) { appendFileSync(${JSON.stringify(join(root, "fixture-ipc.jsonl"))}, JSON.stringify(message) + "\\n"); },
  on(_event, listener) { queueMicrotask(() => listener({ data: { kind: "licence", key: ${JSON.stringify(SITE_LICENCE)} } })); },
};
` });
  await relay.connection;
  const ui = join(home, "fixture-ipc-ui");
  mkdirSync(ui);
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  const lan = await startLanProxy({ lan: new URL(h.url).host, deviceToken: OWNER, deviceId: "owner-device" }, { staticDir: ui });
  const sealed = await startRemoteProxy({ relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: "owner-device", deviceToken: OWNER }, { staticDir: ui });
  t.after(() => { lan.stop(); sealed.stop(); });
  const frames = () => readFileSync(join(home, "fixture-ipc.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const readers: Array<[string, () => Promise<Response>]> = [
    ["owner loopback bearer", () => localBearer(h, OWNER, "/api/plan?fresh=1")],
    ["LAN desktop", () => fetch(`http://127.0.0.1:${lan.port}/api/plan?fresh=1`)],
    ["sealed desktop", () => fetch(`http://127.0.0.1:${sealed.port}/api/plan?fresh=1`)],
  ];
  for (const [label, read] of readers) {
    // Establish a different verified baseline so each read must change
    // the host, even if the synthetic licence handoff already ran.
    site.setAccount(SITE_LICENCE, { plan: "cloud" });
    const baseline = await h.json("/api/plan?fresh=1");
    assert.equal(baseline.ownerPlan, "cloud");
    assert.equal(baseline.licence.kept, true);
    site.setAccount(SITE_LICENCE, { plan: "team" });
    const before = frames().length;
    const remoteRead = await read();
    assert.equal(remoteRead.status, 200, label);
    assert.match(remoteRead.headers.get("cache-control") ?? "", /no-store/, label);
    const remoteBody = await remoteRead.json();
    assert.equal(remoteBody.ownerPlan, "team", label);
    assert.equal(remoteBody.sameComputer, false, label);
    assert.equal(JSON.parse(readFileSync(join(data, "owner-plan.json"), "utf8")).plan, "team", label);
    const remoteFrames = frames().slice(before);
    assert.ok(remoteFrames.some((frame) => frame.kind === "desktop.plan" && frame.plan === "team"), `${label} suppressed the host entitlement update`);
    assert.equal(remoteFrames.filter((frame) => frame.kind === "desktop.account").length, 0, `${label} emitted a Hosting account trigger`);
  }
  for (const [label, base, headers] of [
    ["loopback bearer", h.url, { authorization: `Bearer ${OWNER}` }],
    ["LAN proxy", `http://127.0.0.1:${lan.port}`, {}],
    ["sealed proxy", `http://127.0.0.1:${sealed.port}`, {}],
  ] as const) {
    const refused = await fetch(`${base}/api/plan/hosting/link`, { method: "POST", headers });
    assert.equal(refused.status, 403, label);
    assert.match(refused.headers.get("cache-control") ?? "", /no-store/, label);
  }
  const afterRemote = frames().length;
  const localRead = await h.fetch("/api/plan?fresh=1");
  assert.equal(localRead.status, 200);
  const localBody = await localRead.json();
  assert.equal(localBody.sameComputer, true);
  assert.equal(localBody.licence.kept, true, "the local window lost its app-shared key marker");
  const localFrames = frames().slice(afterRemote).filter((frame) => frame.kind === "desktop.account");
  assert.equal(localFrames.length, 1, "the local window lost its own desktop account report");
  assert.equal(localFrames[0].plan, "team");
});

test("desktop LAN transport exceptions keep fresh Plan and manage failures out of caches", async (t) => {
  const ui = mkdtempSync(join(tmpdir(), "bloks-plan-unreachable-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  const paths: string[] = [];
  const app = await startLanProxy({ lan: "127.0.0.1:9", deviceToken: OWNER, deviceId: "owner-device" }, {
    staticDir: ui,
    fetcher: async (input) => {
      paths.push(String(input));
      throw new Error(`PRIVATE-TRANSPORT-DETAIL ${SITE_LICENCE}`);
    },
  });
  t.after(() => app.stop());
  for (const [path, method] of [["/api/plan?fresh=1", "GET"], ["/api/plan/manage", "POST"]] as const) {
    const answer = await fetch(`http://127.0.0.1:${app.port}${path}`, { method });
    assert.equal(answer.status, 503);
    assert.match(answer.headers.get("cache-control") ?? "", /no-store/);
    const body = await answer.text();
    noSecret(body);
    assert.doesNotMatch(body, /PRIVATE-TRANSPORT-DETAIL/);
  }
  assert.deepEqual(paths, ["http://127.0.0.1:9/api/plan?fresh=1", "http://127.0.0.1:9/api/plan/manage"]);
});


test("desktop sealed transport exceptions keep fresh Plan and manage failures out of caches", async (t) => {
  const ui = mkdtempSync(join(tmpdir(), "bloks-plan-relay-down-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  let asks = 0;
  const relay = createServer((req, res) => {
    if (req.url === "/space/client/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return void res.end('data: {"kind":"hello","online":true}\n\n');
    }
    if (req.url === "/space/client/ask") { asks++; return void req.socket.destroy(); }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const app = await startRemoteProxy({ relayUrl, relayToken: "fixture-relay-client", deviceToken: OWNER, deviceId: "owner-device" }, { staticDir: ui });
  t.after(() => app.stop());
  for (const [path, method] of [["/api/plan?fresh=1", "GET"], ["/api/plan/manage", "POST"]] as const) {
    const answer = await fetch(`http://127.0.0.1:${app.port}${path}`, { method });
    assert.equal(answer.status, 502);
    assert.match(answer.headers.get("cache-control") ?? "", /no-store/);
    const body = await answer.text();
    noSecret(body);
    assert.deepEqual(JSON.parse(body), { error: "the other computer could not be reached" });
  }
  assert.equal(asks, 2, "a transport failure retried an explicit management action");
});
