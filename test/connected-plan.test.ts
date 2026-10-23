// The owner's Plan from a paired client, through the real HTTP boundary
// and the desktop's sealed relay path. All accounts, devices and links
// here belong to disposable loopback fixtures, never a billing service.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { keyFromToken, open, peek, seal } from "../server/relay-crypto.ts";
import { startLanProxy, startRemoteProxy } from "../electron/remote.mjs";
import { controlledChain } from "./helpers/agent-chain.ts";
import { startFakeSite, SITE_LICENCE } from "./helpers/fake-site.ts";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const OWNER = "fixture-connected-owner";
const MEMBERS = ["member", "admin", "guest"] as const;
const device = (id: string, token: string, personId?: string) => ({
  id, name: "Fixture device", hash: createHash("sha256").update(token).digest("hex"), pairedAt: 1,
  ...(personId ? { personId } : {}),
});

async function fixture(t: TestContext, options: { relay?: string; preload?: (home: string) => string; fault?: boolean } = {}) {
  const site = await startFakeSite();
  t.after(() => site.close());
  site.setAccount(SITE_LICENCE, { plan: "team", hosting: { tier: "standard", state: "active" } });
  const home = mkdtempSync(join(tmpdir(), "bloks-connected-plan-"));
  const data = join(home, ".bloks");
  mkdirSync(data);
  const config = {
    credits: { licence: SITE_LICENCE },
    brief: { enabled: false }, backups: { auto: false }, providers: {},
    remote: { enabled: true, devices: [device("owner-device", OWNER),
      { ...device("empty-person-device", "fixture-empty-person"), personId: "" },
      { ...device("null-person-device", "fixture-null-person"), personId: null }],
      memberDevices: MEMBERS.map((role) => device(`${role}-device`, `fixture-${role}`, `person-${role}`)) },
    ...(options.relay ? { relay: { enabled: true, url: options.relay, agentToken: "fixture-relay-agent" } } : {}),
  };
  writeFileSync(join(data, "config.json"), JSON.stringify(config));
  writeFileSync(join(data, "people.json"), JSON.stringify({ version: 3,
    people: MEMBERS.map((role) => ({ id: `person-${role}`, name: "Fixture person", createdAt: 1,
      ...(role === "guest" ? {} : { role, joinedAt: 1, invitedBy: "owner" }) })),
    memberships: [], invites: [], knocks: [],
  }));
  let siteBase = site.base;
  if (options.fault) {
    const front = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      if (req.url === "/api/cloud/manage") {
        res.writeHead(503, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: `PRIVATE-SERVICE-DETAIL ${SITE_LICENCE}`, url: `${site.base}/portal/PRIVATE-PORTAL-MARKER` }));
      }
      const answer = await fetch(site.base + req.url, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
      res.writeHead(answer.status, { "content-type": "application/json" }); res.end(await answer.text());
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    siteBase = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    t.after(() => { front.closeAllConnections(); front.close(); });
  }
  const preload = options.preload ? join(home, "fixture-preload.mjs") : null;
  if (preload) writeFileSync(preload, options.preload!(home));
  const h = await startHarness({ HOME: home, BLOKS_SITE_URL: siteBase,
    ...(preload ? { NODE_OPTIONS: `--import=${preload}` } : {}), BLOKS_CREDITS_URL: `${site.base}/api/ai`,
    BLOKS_LOOPBACK_ONLY: "1" });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  return { h, site, home, data, config };
}

const remote = (h: Harness, path: string, method = "GET", token = OWNER) => h.fetchRemote(path, { method, token });
const localBearer = (h: Harness, token: string, path = "/api/plan", method = "GET") => h.fetch(path, {
  method, headers: { authorization: `Bearer ${token}` },
});
const noSecret = (text: string, portal?: string) => {
  assert.ok(!text.includes(SITE_LICENCE), "a full licence escaped the credential owner");
  if (portal) assert.ok(!text.includes(portal), "an action-only management link was retained or broadcast");
};

async function events(h: Harness, t: TestContext) {
  const abort = new AbortController();
  const res = await fetch(`${h.url}/api/events`, { signal: abort.signal });
  assert.equal(res.status, 200);
  let text = "";
  const reader = res.body!.getReader();
  const done = (async () => {
    try { for (;;) { const part = await reader.read(); if (part.done) return; text += new TextDecoder().decode(part.value); } }
    catch { /* the test closes its stream */ }
  })();
  t.after(async () => { abort.abort(); await done; });
  return async () => { abort.abort(); await done; return text; };
}

function retainedText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return retainedText(file);
    // Config is the licence's deliberate durable owner, not public state.
    if (/^config\.json(?:\.|$)/.test(entry.name)) return "";
    return /\.(json|jsonl|log)$/.test(entry.name) ? readFileSync(file, "utf8") : "";
  }).join("\n");
}

const remoteForbidden: ReadonlyArray<readonly [string, string]> = [
  ["DELETE", "/api/plan/licence"], ["POST", "/api/plan/hosting/link"],
  ["GET", "/api/plan/manage"], ["POST", "/api/plan"],
  ["PUT", "/api/plan/manage"], ["HEAD", "/api/plan"],
  ["POST", "/api/plan/manage/"], ["GET", "/api/plan/future-action"],
];

test("a paired owner reads the host account and asks for management only with POST, without local-machine capabilities", async (t) => {
  const { h, site, data } = await fixture(t);
  const stopEvents = await events(h, t);
  const first = await remote(h, "/api/plan?fresh=1");
  assert.equal(first.status, 200);
  assert.equal(first.body.account.plan, "team");
  assert.equal(first.body.accountState, "live");
  assert.equal(first.body.sameComputer, false);
  assert.equal(first.body.licence.kept, false);
  noSecret(JSON.stringify(first.body));
  assert.deepEqual(site.bearers, [SITE_LICENCE], "a plan view must not mint a management link");
  const made = await remote(h, "/api/plan/manage", "POST");
  assert.equal(made.status, 200);
  assert.deepEqual(made.body, { url: `${site.base}/portal/session-1`, manageAt: "portal" });
  assert.deepEqual(site.bearers, [SITE_LICENCE, SITE_LICENCE]);
  noSecret(JSON.stringify(made.body));
  const portal = made.body.url;
  const again = await remote(h, "/api/plan");
  noSecret(JSON.stringify(again.body), portal);
  noSecret(JSON.stringify(await h.json("/api/bots?messages=1")), portal);
  noSecret(await stopEvents(), portal);
  noSecret(h.logs(), portal);
  noSecret(retainedText(data), portal);
  site.manageAt("link");
  const link = await remote(h, "/api/plan/manage", "POST");
  assert.deepEqual(link.body, { url: "https://app.link.com/recurring", manageAt: "link" });
});

test("only local requests without any bearer retain licence and hosting actions; every other Plan operation stays closed remotely", async (t) => {
  const { h, site, data } = await fixture(t);
  const local = await h.fetch("/api/plan");
  assert.equal(local.status, 200);
  assert.match(local.headers.get("cache-control") ?? "", /no-store/);
  const localPlan = await local.json();
  assert.equal(localPlan.sameComputer, true);
  assert.equal(localPlan.licence.kept, false, "this headless fixture keeps its own key, not an app-shared key");
  const bearer = await localBearer(h, OWNER);
  assert.equal(bearer.status, 200);
  assert.match(bearer.headers.get("cache-control") ?? "", /no-store/);
  const bearerPlan = await bearer.json();
  assert.equal(bearerPlan.sameComputer, false);
  assert.equal(bearerPlan.licence.kept, false);
  const managedHere = await localBearer(h, OWNER, "/api/plan/manage", "POST");
  assert.equal(managedHere.status, 200);
  assert.match(managedHere.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await managedHere.json()).url, `${site.base}/portal/session-1`);
  const before = site.bearers.length;
  for (const [method, path] of remoteForbidden) {
    assert.equal((await remote(h, path, method)).status, 403, `${method} ${path} opened remotely`);
    assert.equal((await localBearer(h, OWNER, path, method)).status, 403, `${method} ${path} trusted loopback over a bearer`);
  }
  assert.equal(site.bearers.length, before, "a forbidden request contacted the account service");
  assert.ok(readFileSync(join(data, "config.json"), "utf8").includes(SITE_LICENCE), "a forbidden action removed the key");
  assert.deepEqual(site.linkKeys, [], "a remote request minted a hosting link");
  assert.equal((await h.fetch("/api/plan/hosting/link", { method: "POST" })).status, 200);
  assert.equal(site.linkKeys.length, 1, "local hosting access was lost");
  const removed = await h.json("/api/plan/licence", { method: "DELETE" });
  assert.equal(removed.removed, true, "local key removal was lost");
});

test("member, admin and room-guest credentials cannot read or manage the owner's Plan, including over loopback", async (t) => {
  const { h, site } = await fixture(t);
  for (const role of MEMBERS) {
    for (const [method, path] of [["GET", "/api/plan"], ["GET", "/api/plan?fresh=1"], ["POST", "/api/plan/manage"], ["DELETE", "/api/plan/licence"], ["POST", "/api/plan/hosting/link"]] as const) {
      const overNetwork = await remote(h, path, method, `fixture-${role}`);
      assert.equal(overNetwork.status, 403, `${role} ${method} ${path} over network`);
      const loopback = await localBearer(h, `fixture-${role}`, path, method);
      assert.equal(loopback.status, 403, `${role} ${method} ${path} over loopback`);
      noSecret(JSON.stringify(overNetwork.body));
      noSecret(await loopback.text());
    }
  }
  assert.deepEqual(site.bearers, [], "a non-owner's ask reached the account service");
});

test("unknown, revoked and other-workspace credentials never become the local owner, and hostile origins stay outside", async (t) => {
  const { h, site, data, config } = await fixture(t);
  assert.equal((await remote(h, "/api/plan?fresh=1")).status, 200);
  const cacheFile = join(data, "plan-cache.json");
  const configFile = join(data, "config.json");
  const accountBefore = readFileSync(cacheFile, "utf8");
  const configBefore = readFileSync(configFile, "utf8");
  const callsBefore = site.bearers.length;
  const denied = async (answer: Response, status: number) => {
    assert.equal(answer.status, status);
    assert.match(answer.headers.get("cache-control") ?? "", /no-store/, "an early auth refusal may not be cached");
    noSecret(await answer.text());
  };
  for (const token of ["fixture-unknown", "fixture-other-workspace-owner"]) {
    assert.equal((await remote(h, "/api/plan", "GET", token)).status, 401);
    for (const path of ["/api/plan", "/api/plan?fresh=1"]) await denied(await localBearer(h, token, path), 401);
    await denied(await localBearer(h, token, "/api/plan/manage", "POST"), 401);
  }
  for (const authorization of ["", "Basic fixture-owner", "Bearer", "Bearer fixture-owner wrong-envelope"]) {
    await denied(await h.fetch("/api/plan/manage", { method: "POST", headers: { authorization } }), 401);
  }
  for (const path of ["/api/plan", "/api/plan?fresh=1"]) await denied(await h.fetchAs("https://unrelated.example", path), 403);
  await denied(await h.fetchAs("https://unrelated.example", "/api/plan/manage", { method: "POST", headers: { authorization: `Bearer ${OWNER}` } }), 403);
  assert.equal(site.bearers.length, callsBefore, "a rejected identity contacted the account service");
  assert.equal(readFileSync(cacheFile, "utf8"), accountBefore, "a rejected request changed the cached account");
  assert.equal(readFileSync(configFile, "utf8"), configBefore, "a rejected request changed the host licence or settings");
  writeFileSync(configFile, JSON.stringify({ ...config, remote: { ...config.remote, devices: [] } }));
  assert.equal((await remote(h, "/api/plan")).status, 401);
  for (const path of ["/api/plan", "/api/plan?fresh=1"]) await denied(await localBearer(h, OWNER, path), 401);
  await denied(await localBearer(h, OWNER, "/api/plan/manage", "POST"), 401);
  assert.equal(site.bearers.length, callsBefore, "a revoked credential contacted the account service");
  assert.equal(readFileSync(cacheFile, "utf8"), accountBefore);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).credits, JSON.parse(configBefore).credits);
});

test("a malformed person identity on a recognized device is never interpreted as the owner", async (t) => {
  const { h, site } = await fixture(t);
  for (const token of ["fixture-empty-person", "fixture-null-person"]) {
    for (const [method, path] of [["GET", "/api/plan"], ["POST", "/api/plan/manage"], ["DELETE", "/api/plan/licence"]] as const) {
      assert.equal((await remote(h, path, method, token)).status, 403, `${method} ${path} with ${token}`);
      const here = await localBearer(h, token, path, method);
      assert.equal(here.status, 403, `loopback ${method} ${path} with ${token}`);
      noSecret(await here.text());
    }
  }
  assert.deepEqual(site.bearers, []);
});

test("failed refreshes distinguish cached, unavailable and refused account facts from Free; management fails without a link", async (t) => {
  const { h, site } = await fixture(t);
  const live = await remote(h, "/api/plan?fresh=1");
  assert.equal(live.body.accountState, "live");
  site.down(true);
  const cached = await remote(h, "/api/plan?fresh=1");
  assert.equal(cached.status, 200);
  assert.equal(cached.body.accountState, "cached");
  assert.equal(cached.body.account.plan, "team");
  assert.equal(cached.body.accountAt, live.body.accountAt);
  assert.ok(cached.body.problem);
  const failed = await remote(h, "/api/plan/manage", "POST");
  assert.equal(failed.status, 502);
  assert.equal(failed.body.url, undefined);
  site.down(false);
  site.setAccount(SITE_LICENCE, null);
  const refused = await remote(h, "/api/plan?fresh=1");
  assert.equal(refused.body.accountState, "refused");
  assert.equal(refused.body.account, null);
  assert.equal(refused.body.licence.present, true);
  site.down(true);
  const unavailable = await remote(h, "/api/plan?fresh=1");
  assert.equal(unavailable.body.accountState, "unavailable");
  assert.equal(unavailable.body.account, null);
  assert.equal(unavailable.body.licence.present, true);
  assert.ok(unavailable.body.problem);
  for (const value of [cached, failed, refused, unavailable]) noSecret(JSON.stringify(value.body));
});

test("the actual desktop proxy carries the owner's Plan and action-only management through sealed relay requests", { timeout: 60_000 }, async (t) => {
  const relay = await sealedRelay();
  t.after(() => relay.stop());
  const { h, site } = await fixture(t, { relay: relay.url });
  await relay.connection;
  const ui = mkdtempSync(join(tmpdir(), "bloks-connected-plan-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  const app = await startRemoteProxy({ relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: "owner-device", deviceToken: OWNER }, { staticDir: ui, client: "macOS fixture" });
  t.after(() => app.stop());
  const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${app.port}${path}`, init);
  const plan = await ask("/api/plan?fresh=1");
  assert.equal(plan.status, 200);
  assert.match(plan.headers.get("cache-control") ?? "", /no-store/);
  const shown = await plan.json();
  assert.equal(shown.account.plan, "team");
  assert.equal(shown.sameComputer, false);
  assert.equal(shown.licence.kept, false);
  noSecret(JSON.stringify(shown));
  assert.deepEqual(site.bearers, [SITE_LICENCE]);
  const manage = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(manage.status, 200);
  assert.match(manage.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await manage.json(), { url: `${site.base}/portal/session-1`, manageAt: "portal" });
  const before = site.bearers.length;
  for (const [method, path] of remoteForbidden) assert.equal((await ask(path, { method })).status, 403, `${method} ${path}`);
  assert.equal(site.bearers.length, before);
  noSecret(h.logs(), `${site.base}/portal/session-1`);
  site.down(true);
  for (const [path, method] of [["/api/plan?fresh=1", "GET"], ["/api/plan/manage", "POST"]] as const) {
    const failed = await ask(path, { method });
    assert.equal(failed.status, method === "GET" ? 200 : 502);
    assert.match(failed.headers.get("cache-control") ?? "", /no-store/);
    const body = await failed.json();
    if (method === "GET") assert.equal(body.accountState, "cached");
    else assert.equal(body.url, undefined);
    noSecret(JSON.stringify(body), `${site.base}/portal/session-1`);
  }
});

test("an actual agent turn cannot use Plan even when its request is local", async (t) => {
  const site = await startFakeSite();
  t.after(() => site.close());
  site.setAccount(SITE_LICENCE, { plan: "team" });
  const f = await controlledChain(t, { credits: { licence: SITE_LICENCE } }, { BLOKS_SITE_URL: site.base, BLOKS_CREDITS_URL: `${site.base}/api/ai` });
  const bot = await f.hire("Fixture");
  const turn = await f.begin(bot);
  for (const [method, path] of [["GET", "/api/plan"], ["POST", "/api/plan/manage"], ["POST", "/api/plan/hosting/link"], ["DELETE", "/api/plan/licence"]] as const) {
    const res = await f.agent(turn, path, undefined, method);
    assert.equal(res.status, 403, `${method} ${path}`);
    noSecret(await res.text());
  }
  assert.deepEqual(site.bearers, []);
  await f.finish(turn, bot);
});


test("the desktop LAN proxy keeps Plan replies private and retains the paired owner's limited operations", async (t) => {
  const { h, site } = await fixture(t);
  const ui = mkdtempSync(join(tmpdir(), "bloks-plan-lan-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  const app = await startLanProxy({ lan: new URL(h.url).host, deviceToken: OWNER, deviceId: "owner-device" }, { staticDir: ui });
  t.after(() => app.stop());
  const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${app.port}${path}`, init);
  const shown = await ask("/api/plan?fresh=1");
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("cache-control") ?? "", /no-store/);
  const lanPlan = await shown.json();
  assert.equal(lanPlan.sameComputer, false);
  assert.equal(lanPlan.licence.kept, false);
  const manage = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(manage.status, 200);
  assert.match(manage.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await manage.json()).url, `${site.base}/portal/session-1`);
  assert.equal((await ask("/api/plan/licence", { method: "DELETE" })).status, 403);
  assert.equal((await ask("/api/plan/hosting/link", { method: "POST" })).status, 403);
  site.down(true);
  const failed = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(failed.status, 502);
  assert.match(failed.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await failed.json()).url, undefined);
  const cached = await ask("/api/plan?fresh=1");
  assert.match(cached.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await cached.json()).accountState, "cached");
});

// Observe the relay's actual HTTP wire without decrypting it there. The
// request replay below is byte-identical ciphertext from the desktop.
async function observedRelay(t: TestContext) {
  const relay = await sealedRelay();
  const wire: string[] = [];
  const asks: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      wire.push(`${req.method} ${req.url}\n${body}`);
      if (req.url === "/space/client/ask") asks.push(body);
      const next = httpRequest(relay.url + req.url, { method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on("data", (chunk) => { wire.push(String(chunk)); res.write(chunk); });
        answer.on("end", () => res.end());
      });
      next.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      next.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await relay.stop(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, connection: relay.connection, wire, asks };
}

test("sealed management replays do not mint a second link; a revoked relay device never becomes the local owner", { timeout: 60_000 }, async (t) => {
  const relay = await observedRelay(t);
  const { h, site, data, config } = await fixture(t, { relay: relay.url });
  await relay.connection;
  const stopEvents = await events(h, t);
  const ui = mkdtempSync(join(tmpdir(), "bloks-plan-replay-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>Fixture</title>");
  t.after(() => rmSync(ui, { recursive: true, force: true }));
  const app = await startRemoteProxy({ relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: "owner-device", deviceToken: OWNER }, { staticDir: ui });
  t.after(() => app.stop());
  const ask = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${app.port}${path}`, init);
  const first = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(first.status, 200);
  const portal = (await first.json()).url;
  assert.equal(portal, `${site.base}/portal/session-1`);
  assert.equal(site.bearers.length, 1);
  const captured = relay.asks.find((text) => {
    const request = open(keyFromToken(OWNER, "phone-to-mac"), peek(JSON.parse(text).payload)!) as { path?: string } | null;
    return request?.path === "/api/plan/manage";
  });
  assert.ok(captured, "the desktop did not use the sealed manage route");
  const replay = await fetch(`${relay.url}/space/client/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: captured });
  const replayed = await replay.json();
  assert.equal((open(keyFromToken(OWNER, "mac-to-phone"), peek(replayed.payload)!) as { status: number }).status, 409);
  assert.equal(site.bearers.length, 1, "a repeated nonce contacted billing twice");
  const fresh = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(fresh.status, 200);
  assert.equal(site.bearers.length, 2, "a fresh explicit action was not served exactly once");
  await fresh.arrayBuffer();
  const shown = await ask("/api/plan?fresh=1");
  assert.equal(shown.status, 200);
  noSecret(await shown.text(), portal);
  noSecret(JSON.stringify(await h.json("/api/bots?messages=1")), portal);
  noSecret(await stopEvents(), portal);
  noSecret(retainedText(data), portal);
  noSecret(h.logs(), portal);
  noSecret(relay.wire.join("\n"), portal);
  // Drop the device in the real registry, then send an otherwise valid,
  // fresh envelope using its former key, never a forged internal header.
  writeFileSync(join(data, "config.json"), JSON.stringify({ ...config, remote: { ...config.remote, devices: [] } }));
  const before = site.bearers.length;
  const payload = seal(keyFromToken(OWNER, "phone-to-mac"), "owner-device", { method: "POST", path: "/api/plan/manage", ts: Date.now(), nonce: randomUUID() });
  const revoked = await fetch(`${relay.url}/space/client/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }) });
  assert.deepEqual(await revoked.json(), { payload: "" }, "a revoked device was still given a sealed answer");
  assert.equal(site.bearers.length, before);
});

test("real restricted reply, delegate and messenger credentials cannot read or manage the Plan", async (t) => {
  const trace = "fixture-restricted-tokens.json";
  const { h, site, home } = await fixture(t, { preload: (root) => `
import { writeFileSync } from "node:fs";
import { AgentTokens } from ${JSON.stringify(new URL("../server/agent-cli.ts", import.meta.url).href)};
const identify = AgentTokens.prototype.identify;
let made = false;
AgentTokens.prototype.identify = function (...args) {
  if (!made) {
    made = true;
    const now = Date.now();
    const owner = { owner: true, botId: "fixture", bindingGeneration: "fixture", userId: 1, name: "Fixture", requester: "owner", chatId: -1, group: { title: "Fixture" } };
    const delegate = { botId: "fixture", bindingGeneration: "fixture", personId: "fixture-delegate", userId: 2, name: "Fixture", grant: "fixture", requester: "fixture-delegate", chatId: 2 };
    writeFileSync(${JSON.stringify(join(root, trace))}, JSON.stringify({
      reply: this.mintReply("fixture", "fixture-lane", now, owner, 1).token,
      delegate: this.mintReply("fixture", "fixture-lane", now, delegate, 1).token,
      messenger: this.mintMessenger("fixture", "fixture-lane", now).token,
    }));
  }
  return identify.apply(this, args);
};
` });
  const tokens = JSON.parse(readFileSync(join(home, trace), "utf8"));
  for (const [kind, token] of Object.entries(tokens)) {
    assert.match(String(token), kind === "messenger" ? /^blm_/ : /^blr_/);
    for (const [method, path] of [["GET", "/api/plan"], ["GET", "/api/plan?fresh=1"], ["POST", "/api/plan/manage"], ["POST", "/api/plan/hosting/link"], ["DELETE", "/api/plan/licence"]] as const) {
      const refused = await localBearer(h, String(token), path, method);
      assert.equal(refused.status, 403, `${kind} ${method} ${path}`);
      assert.match((await refused.json()).error, /only (reply|message)/, "the genuine restricted credential was not identified");
    }
  }
  assert.deepEqual(site.bearers, []);
});

test("management service failure details never escape through a server response or retained state", async (t) => {
  const { h, data } = await fixture(t, { fault: true });
  const stopEvents = await events(h, t);
  for (const token of [undefined, OWNER]) {
    const answer = await h.fetch("/api/plan/manage", { method: "POST", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    assert.equal(answer.status, 502);
    assert.match(answer.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(await answer.json(), { error: "bloks.dev couldn't open billing just now. Try again in a moment." });
  }
  const publicText = [h.logs(), retainedText(data), await stopEvents()].join("\n");
  noSecret(publicText);
  assert.doesNotMatch(publicText, /PRIVATE-SERVICE-DETAIL|PRIVATE-PORTAL-MARKER/);
});

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
    assert.equal(remoteBody.licence.kept, false, `${label} was offered an app-shared key`);
    assert.equal(JSON.parse(readFileSync(join(data, "owner-plan.json"), "utf8")).plan, "team", label);
    const remoteFrames = frames().slice(before);
    assert.ok(remoteFrames.some((frame) => frame.kind === "desktop.plan" && frame.plan === "team"), `${label} suppressed the host entitlement update`);
    assert.equal(remoteFrames.filter((frame) => frame.kind === "desktop.account").length, 0, `${label} emitted a Hosting account trigger`);
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
