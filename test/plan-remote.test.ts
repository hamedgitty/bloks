// The plan and the way to billing from the owner's own paired devices
// (GitHub 357). A workspace on a server elsewhere has no window of its
// own, so Settings, Plan in the app connected to it, or in a browser at
// bloks.dev/web, was the owner's only way to their subscription, and both
// routes refused it. Now the owner's device reads the plan and opens
// billing, on the network and through Bloks Cloud, and is told it is not
// the computer that keeps the key. Everything else under /api/plan stays
// with that computer's window, and nobody who is not the owner reaches
// any of it: an agent's turn, a member's device, a member's credential
// presented on the computer itself, or somebody holding an invite.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startRemoteProxy } from "../electron/remote.mjs";
import { allows } from "../server/agent-cli.ts";
import { JoinClient } from "../server/join-client.ts";
import { sealedRelay } from "./helpers/sealed-relay.ts";
import { startFakeSite, SITE_LICENCE, type FakeSite } from "./helpers/fake-site.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const OWNER_TOKEN = "fixture-owner-device-token";
const MEMBER_TOKEN = "fixture-member-device-token";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const device = (id: string, token: string, personId?: string) => ({
  id,
  name: "Fixture device",
  hash: sha(token),
  pairedAt: 1,
  ...(personId ? { personId } : {}),
});

/** A workspace that keeps the key and answers only on loopback, as
 * bloks-server does, with whatever else `config` adds. */
async function workspace(
  t: { after: (fn: () => unknown) => void },
  s: FakeSite,
  config: Record<string, unknown>,
): Promise<Harness & { configFile: string }> {
  const home = mkdtempSync(join(tmpdir(), "bloks-test-plan-remote-"));
  mkdirSync(join(home, ".bloks"));
  const configFile = join(home, ".bloks", "config.json");
  writeFileSync(configFile, JSON.stringify({ credits: { licence: SITE_LICENCE }, profile: { name: "Hamed" }, ...config }));
  const h = await startHarness({ HOME: home, BLOKS_SITE_URL: s.base, BLOKS_CREDITS_URL: `${s.base}/api/ai`, BLOKS_LOOPBACK_ONLY: "1" });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return Object.assign(h, { configFile });
}

test("the owner's own device reads the plan and opens billing, on the network and through Bloks Cloud; the rest stays here", { timeout: 120_000 }, async (t) => {
  const s = await startFakeSite();
  t.after(() => s.close());
  s.setAccount(SITE_LICENCE, { plan: "team", interval: "month", renewsAt: "2026-11-21T00:00:00Z" });
  const relay = await sealedRelay();
  t.after(() => relay.stop());
  const h = await workspace(t, s, {
    remote: { devices: [device("owner-device", OWNER_TOKEN)], memberDevices: [device("member-device", MEMBER_TOKEN, "fixture-member")] },
    relay: { enabled: true, url: relay.url, agentToken: "fixture-relay-agent" },
  });
  await relay.connection;

  // ── this computer's own window, as before, and told it is here ──
  const here = await h.json("/api/plan");
  assert.equal(here.account.plan, "team");
  assert.equal(here.sameComputer, true);
  // An owner credential remains portable, not a local-window credential.
  const ownCredential = await h.fetch("/api/plan", { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.equal(ownCredential.status, 200);
  assert.equal((await ownCredential.json()).sameComputer, false);

  // A billing link is made only when somebody presses for it, and each
  // press asks bloks.dev for one once.
  const pressed = async <T>(press: () => Promise<T>): Promise<T> => {
    const before = s.bearers.length;
    const answer = await press();
    assert.equal(s.bearers.length, before + 1, "a press asked bloks.dev other than once");
    return answer;
  };

  // ── the owner's device on the network ──
  const onNetwork = await h.fetchRemote("/api/plan", { token: OWNER_TOKEN });
  assert.equal(onNetwork.status, 200, JSON.stringify(onNetwork.body));
  assert.equal(onNetwork.body.account.plan, "team");
  assert.equal(onNetwork.body.account.interval, "month");
  assert.equal(onNetwork.body.accountState, "live");
  assert.equal(onNetwork.body.sameComputer, false, "a device elsewhere was told it keeps the key");
  assert.ok(!JSON.stringify(onNetwork.body).includes(SITE_LICENCE), "the key went to the device");
  assert.ok(!JSON.stringify(onNetwork.body).includes("/portal/"), "a billing link was made without anybody pressing for it");
  const billing = await pressed(() => h.fetchRemote("/api/plan/manage", { method: "POST", body: "{}", token: OWNER_TOKEN }));
  assert.equal(billing.status, 200, JSON.stringify(billing.body));
  assert.deepEqual(billing.body, { url: `${s.base}/portal/session-1`, manageAt: "portal" });
  assert.equal(s.bearers.filter((b) => b === SITE_LICENCE).length, s.bearers.length, "bloks.dev was asked with something other than the key");

  // ── the owner's device through Bloks Cloud, the way the Mac app reaches a server elsewhere ──
  const files = mkdtempSync(join(tmpdir(), "bloks-test-plan-remote-ui-"));
  t.after(() => rmSync(files, { recursive: true, force: true }));
  writeFileSync(join(files, "index.html"), "<!doctype html><title>Fixture</title>");
  const app = await startRemoteProxy(
    { relayUrl: relay.url, relayToken: "fixture-relay-client", deviceId: "owner-device", deviceToken: OWNER_TOKEN },
    { staticDir: files, client: "macOS 3.0" },
  );
  const member = await startRemoteProxy(
    { relayUrl: relay.url, relayToken: "fixture-relay-member", deviceId: "member-device", deviceToken: MEMBER_TOKEN },
    { staticDir: files },
  );
  t.after(() => {
    app.stop();
    member.stop();
  });
  const at = (proxy: { port: number }, path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const throughCloud = await at(app, "/api/plan");
  assert.equal(throughCloud.status, 200);
  const cloudPlan = await throughCloud.json();
  assert.equal(cloudPlan.account.plan, "team");
  assert.equal(cloudPlan.sameComputer, false);
  const cloudBilling = await pressed(() => at(app, "/api/plan/manage", { method: "POST", body: "{}" }));
  assert.equal(cloudBilling.status, 200);
  assert.deepEqual(await cloudBilling.json(), { url: `${s.base}/portal/session-1`, manageAt: "portal" });
  // Link's page, for a plan Link took the payment for, comes back the same way
  s.manageAt("link");
  const viaLink = await pressed(() => at(app, "/api/plan/manage", { method: "POST", body: "{}" }));
  assert.deepEqual(await viaLink.json(), { url: "https://app.link.com/recurring", manageAt: "link" });
  s.manageAt("portal");

  // ── what stays with this computer's window, from either way in ──
  const before = s.bearers.length;
  const localOnly: Array<[string, string]> = [
    ["DELETE", "/api/plan/licence"],
    ["POST", "/api/plan/hosting/link"],
    ["GET", "/api/plan/anything"],
    ["POST", "/api/plan"],
    ["GET", "/api/plan/manage"],
  ];
  for (const [method, path] of localOnly) {
    const network = await h.fetchRemote(path, { method, token: OWNER_TOKEN, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(network.status, 403, `${method} ${path} answered the owner's device on the network`);
    const cloud = await at(app, path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(cloud.status, 403, `${method} ${path} answered the owner's device through Bloks Cloud`);
  }
  assert.equal(s.bearers.length, before, "a local-only route reached bloks.dev for a device elsewhere");
  assert.deepEqual(s.linkKeys, [], "a hosted workspace's link was asked for a device elsewhere");
  assert.ok(readFileSync(h.configFile, "utf8").includes(SITE_LICENCE), "the key was forgotten from a device elsewhere");
  assert.equal((await h.json("/api/plan")).licence.present, true);

  // ── a member's device, either way in, and a device nobody paired ──
  for (const [method, path] of [
    ["GET", "/api/plan"],
    ["POST", "/api/plan/manage"],
  ] as const) {
    const network = await h.fetchRemote(path, { method, token: MEMBER_TOKEN, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.notEqual(network.status, 200, `${method} ${path} answered a member's device on the network`);
    assert.ok(!JSON.stringify(network.body).includes("team"), "a member's device was told the owner's plan");
    const cloud = await at(member, path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.notEqual(cloud.status, 200, `${method} ${path} answered a member's device through Bloks Cloud`);
    assert.doesNotMatch(await cloud.text(), /portal|"plan"/);
    assert.equal((await h.fetchRemote(path, { method, token: "not-a-device" })).status, 401);
    assert.equal((await h.fetchRemote(path, { method })).status, 401);
  }
  // a member's credential presented on this computer is the member, not the person at the keyboard
  for (const [method, path] of [
    ["GET", "/api/plan"],
    ["POST", "/api/plan/manage"],
    ["DELETE", "/api/plan/licence"],
  ] as const) {
    const res = await h.fetch(path, { method, headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    assert.equal(res.status, 403, `${method} ${path} answered a member's credential on this computer`);
  }
  assert.equal(s.bearers.length, before, "somebody other than the owner reached bloks.dev");

  // ── never an agent's, whatever a rule elsewhere says ──
  for (const [method, path] of [
    ["GET", "/api/plan"],
    ["POST", "/api/plan/manage"],
    ["DELETE", "/api/plan/licence"],
    ["POST", "/api/plan/hosting/link"],
  ] as const) {
    assert.equal(allows("ada", method, path).ok, false, `${method} ${path} is open to an agent`);
    assert.match(allows("ada", method, path).reason ?? "", /not something an agent can reach/);
  }
});

test("somebody holding an invite, then let in as a member, never reads the plan or opens billing", { timeout: 120_000 }, async (t) => {
  const s = await startFakeSite();
  t.after(() => s.close());
  // members are Bloks Team's
  s.setAccount(SITE_LICENCE, { plan: "team" });
  const h = await workspace(t, s, {});
  // a fresh look at the plan opens the members' door, as coming back from checkout does
  assert.equal((await h.json("/api/plan?fresh=1")).ownerPlan, "team");
  const asked = s.bearers.length;

  const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name: "Sam" }) });
  assert.ok(made.invite?.link, JSON.stringify(made));
  const client = new JoinClient(() => "http://127.0.0.1:9");
  const found = (await client.lookup(`${made.invite.link}~${new URL(h.url).host}`)) as { ok: boolean; session: string };
  assert.ok(found.ok, JSON.stringify(found));
  const waiting = (await client.claim(found.session, { name: "Sam" })) as { status: string };
  assert.equal(waiting.status, "waiting");
  // the credential the joiner made, which means nothing here until they are let in
  const pending = (client as unknown as { sessions: Map<string, { deviceToken: string }> }).sessions.get(found.session)!.deviceToken;
  for (const [method, path] of [
    ["GET", "/api/plan"],
    ["POST", "/api/plan/manage"],
  ] as const) {
    for (const token of [undefined, made.invite.link as string, pending]) {
      const res = await h.fetchRemote(path, { method, ...(token ? { token } : {}), ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(res.status, 401, `${method} ${path} answered somebody holding an invite (${token ? "with a credential" : "with none"})`);
    }
  }

  // let in, as a member: their device is somebody else's, on the network or on this computer
  assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
  const done = (await client.status(found.session)) as { status: string; credentials: { deviceToken: string } };
  assert.equal(done.status, "approved");
  const sam = done.credentials.deviceToken;
  for (const [method, path] of [
    ["GET", "/api/plan"],
    ["POST", "/api/plan/manage"],
    ["DELETE", "/api/plan/licence"],
  ] as const) {
    const remote = await h.fetchRemote(path, { method, token: sam, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(remote.status, 403, `${method} ${path} answered a member's device: ${JSON.stringify(remote.body)}`);
    const local = await h.fetch(path, { method, headers: { authorization: `Bearer ${sam}` } });
    assert.equal(local.status, 403, `${method} ${path} answered a member's credential on this computer`);
  }
  assert.equal(s.bearers.length, asked, "an invite or a member reached bloks.dev with the key");
  // and the owner's window still reads it
  assert.equal((await h.json("/api/plan")).account.plan, "team");
});
