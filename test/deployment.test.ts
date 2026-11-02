// The machine a workspace runs on, asked as separate questions
// (server/deployment.ts; GitHub 442): where it runs, who looks after it,
// and whether the owner's own paired devices may open its terminal.
//
// What this holds: BLOKS_HOSTED=1 means what it always meant, a machine
// run for the person, terminal and all; a bloks-server of the person's
// own is self-hosted, never Hosted, and opens its terminal to the
// owner's own devices only once BLOKS_OWNER_TERMINAL=1 says so where it
// runs; a member's device and a device nobody paired never get a shell
// either way; and a refused device is told the real reason.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { deploymentKind, deploymentOf, terminalRefusal } from "../server/deployment.ts";
import { startHarness } from "./helpers/server.ts";

test("hosted is the provider's machine; a server of the person's own is self-hosted; the app is the app", () => {
  const hosted = deploymentOf({ inApp: false, env: { BLOKS_HOSTED: "1" } });
  assert.deepEqual(hosted, { runs: "server", managedBy: "provider", ownerTerminal: true, ownerTerminalFrom: "provider" });
  assert.equal(deploymentKind(hosted), "managed");
  assert.equal(deploymentOf({ inApp: false, env: { BLOKS_HOSTED: "1", BLOKS_OWNER_TERMINAL: "0" } }).ownerTerminal, true, "a hosted machine's owner keeps the terminal, as before");

  const server = deploymentOf({ inApp: false, env: {} });
  assert.deepEqual(server, { runs: "server", managedBy: "owner", ownerTerminal: false, ownerTerminalFrom: null });
  assert.equal(deploymentKind(server), "self-hosted");
  const opened = deploymentOf({ inApp: false, env: { BLOKS_OWNER_TERMINAL: "1" } });
  assert.equal(opened.ownerTerminal, true);
  assert.equal(opened.ownerTerminalFrom, "setting");
  assert.equal(opened.managedBy, "owner", "opening the terminal says nothing about who looks after the machine");
  assert.equal(deploymentOf({ inApp: false, env: { BLOKS_OWNER_TERMINAL: "yes" } }).ownerTerminal, false, "only 1 opens it");

  const app = deploymentOf({ inApp: true, env: { BLOKS_OWNER_TERMINAL: "1" } });
  assert.equal(deploymentKind(app), "app");
  assert.equal(app.ownerTerminal, false, "a paired phone is never a way into the computer running the app");

  assert.match(terminalRefusal(server), /BLOKS_OWNER_TERMINAL=1/);
  assert.doesNotMatch(terminalRefusal(app), /BLOKS_OWNER_TERMINAL/, "the app is not told to turn on what it never offers");
});

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OWNER = "fixture-owner-device-token";
const MEMBER = "fixture-member-device-token";

/** A server with pairing on, one device of the owner's and one of a
 * member's. */
async function serverWith(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "bloks-deployment-"));
  mkdirSync(join(home, ".bloks"));
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      remote: {
        enabled: true,
        devices: [{ id: "owner-laptop", name: "Owner's laptop", hash: sha(OWNER), pairedAt: 1 }],
        memberDevices: [{ id: "member-phone", name: "Member's phone", hash: sha(MEMBER), pairedAt: 1, personId: "fixture-member" }],
      },
      profile: { name: "Owner" },
    }),
  );
  const h = await startHarness({ HOME: home, BLOKS_COMPUTER_NAME: "Fixture Server", ...env });
  return {
    h,
    async stop() {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a server of the person's own says self-hosted, and keeps its terminal on the server until told", { timeout: 120_000 }, async (t) => {
  const { h, stop } = await serverWith({});
  t.after(stop);

  const config = await h.json("/api/config");
  assert.equal(config.hosted.on, false, "a server of the person's own is not Hosted");
  assert.equal(config.deployment.kind, "self-hosted");
  assert.equal(config.deployment.managedBy, "owner");
  assert.equal(config.deployment.computer, "Fixture Server");
  assert.equal(config.deployment.ownerTerminal, false);
  assert.deepEqual(config.hosted.computers.map((c: { id: string }) => c.id).includes("sandbox"), true, "the Local VM is offered as on any server");
  const health = await h.json("/api/health");
  assert.equal(health.hosted, false);
  assert.equal(health.managedBy, "owner");
  assert.equal(health.runs, "server");
  assert.equal("ownerTerminal" in health, false, "what the owner's devices may do is not said to anyone who asks");

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
  const refused = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", token: OWNER, body: "{}" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "terminal");
  assert.match(refused.body.error, /BLOKS_OWNER_TERMINAL=1/, "the owner is told how to open it");
  // the device's other routes are untouched
  assert.equal((await h.fetchRemote("/api/bots", { token: OWNER })).status, 200);
});

test("BLOKS_OWNER_TERMINAL=1 opens the terminal to the owner's own devices, and to nobody else", { timeout: 120_000 }, async (t) => {
  const { h, stop } = await serverWith({ BLOKS_OWNER_TERMINAL: "1" });
  t.after(stop);

  const config = await h.json("/api/config");
  assert.equal(config.deployment.kind, "self-hosted", "still the person's own server, not a hosted one");
  assert.equal(config.deployment.ownerTerminal, true);
  assert.equal(config.deployment.ownerTerminalFrom, "setting");
  assert.equal(config.hosted.on, false);

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
  const opened = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", token: OWNER, body: JSON.stringify({ cols: 80, rows: 24 }) });
  assert.equal(opened.status, 200, `the owner's device was refused: ${JSON.stringify(opened.body)}`);
  const listed = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { token: OWNER });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.terminals.length, 1);

  const member = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", token: MEMBER, body: "{}" });
  assert.notEqual(member.status, 200, "a member's device was given a shell");
  const nobody = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", body: "{}" });
  assert.equal(nobody.status, 401, "a device nobody paired was given a shell");
  const stranger = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", token: "not-a-device", body: "{}" });
  assert.equal(stranger.status, 401);

  // and the owner's device still gets no update rights it did not have:
  // the server's update route answers it as the owner, as before
  assert.equal((await h.fetchRemote("/api/server-update", { token: OWNER })).status, 200);
  assert.equal((await h.fetchRemote("/api/server-update", { token: MEMBER })).status === 200, false);

  await h.fetch(`/api/bots/${bot.id}/terminals/${opened.body.terminal.id}`, { method: "DELETE" });
});

test("a hosted machine is managed hosting, and its owner's devices keep the terminal", { timeout: 120_000 }, async (t) => {
  const { h, stop } = await serverWith({ BLOKS_HOSTED: "1" });
  t.after(stop);
  const config = await h.json("/api/config");
  assert.equal(config.hosted.on, true);
  assert.equal(config.deployment.kind, "managed");
  assert.equal(config.deployment.managedBy, "provider");
  assert.equal(config.deployment.ownerTerminalFrom, "provider");
  assert.equal((await h.json("/api/health")).managedBy, "provider");
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Hal" }) });
  const opened = await h.fetchRemote(`/api/bots/${bot.id}/terminals`, { method: "POST", token: OWNER, body: "{}" });
  assert.equal(opened.status, 200);
  await h.fetch(`/api/bots/${bot.id}/terminals/${opened.body.terminal.id}`, { method: "DELETE" });
});
