// The owner's Plan from a paired client, through the real HTTP boundary
// and the desktop's sealed relay path. All accounts, devices and links
// here belong to disposable loopback fixtures, never a billing service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

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

async function fixture(t: TestContext, options: { relay?: string } = {}) {
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
  const h = await startHarness({ HOME: home, BLOKS_SITE_URL: site.base, BLOKS_CREDITS_URL: `${site.base}/api/ai`,
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
  assert.deepEqual(first.body.capabilities, { licence: false, hosting: false });
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
  assert.deepEqual((await local.json()).capabilities, { licence: true, hosting: true });
  const bearer = await localBearer(h, OWNER);
  assert.equal(bearer.status, 200);
  assert.match(bearer.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual((await bearer.json()).capabilities, { licence: false, hosting: false });
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
  for (const token of ["fixture-unknown", "fixture-other-workspace-owner"]) {
    assert.equal((await remote(h, "/api/plan", "GET", token)).status, 401);
    assert.equal((await localBearer(h, token, "/api/plan/manage", "POST")).status, 401);
  }
  for (const authorization of ["", "Basic fixture-owner", "Bearer", "Bearer fixture-owner wrong-envelope"]) {
    assert.equal((await h.fetch("/api/plan/manage", { method: "POST", headers: { authorization } })).status, 401,
      "a malformed Authorization header became an uncredentialed local owner");
  }
  assert.equal((await h.fetchAs("https://unrelated.example", "/api/plan")).status, 403);
  assert.equal((await h.fetchAs("https://unrelated.example", "/api/plan/manage", { method: "POST", headers: { authorization: `Bearer ${OWNER}` } })).status, 403);
  assert.equal((await remote(h, "/api/plan")).status, 200);
  const before = site.bearers.length;
  writeFileSync(join(data, "config.json"), JSON.stringify({ ...config, remote: { ...config.remote, devices: [] } }));
  assert.equal((await remote(h, "/api/plan")).status, 401);
  assert.equal((await localBearer(h, OWNER, "/api/plan/manage", "POST")).status, 401);
  assert.equal(site.bearers.length, before);
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
  assert.deepEqual(shown.capabilities, { licence: false, hosting: false });
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
  const shown = await ask("/api/plan");
  assert.equal(shown.status, 200);
  assert.match(shown.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual((await shown.json()).capabilities, { licence: false, hosting: false });
  const manage = await ask("/api/plan/manage", { method: "POST" });
  assert.equal(manage.status, 200);
  assert.match(manage.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await manage.json()).url, `${site.base}/portal/session-1`);
  assert.equal((await ask("/api/plan/licence", { method: "DELETE" })).status, 403);
  assert.equal((await ask("/api/plan/hosting/link", { method: "POST" })).status, 403);
});
