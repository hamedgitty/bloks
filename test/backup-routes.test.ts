// Backups through the real server (server/backup.ts, the /api/backups
// routes in server/index.ts, server/pending-restore.ts).
//
// What matters here lives in the request path: only this computer may
// back up or restore, never a paired phone, another site or an agent; the
// daily backup happens on its own when Bloks is quiet; and a restore lets
// what is running finish, backs up, stops, and comes back as the backup
// with the workspace it replaced moved aside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allows } from "../server/agent-cli.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

const PASS = "a long enough passphrase";

function home(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "bloks-backup-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

const stopped = (h: Harness) =>
  waitFor(async () => {
    try {
      await fetch(`${h.url}/api/health`);
      return null;
    } catch {
      return true;
    }
  }, 20_000);

const botNames = async (h: Harness) => ((await h.json("/api/bots")).bots as any[]).map((b) => b.name);

test("backups answer this computer only: not a paired phone, not another site, not an agent", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const status = await h.json("/api/backups");
  assert.equal(status.folder, "~/.bloks-backups", "the folder is said the way a person would look for it");
  assert.equal(status.auto, true, "the daily backup is on unless turned off");

  assert.equal((await h.fetchAs("https://example.com", "/api/backups")).status, 403);
  assert.equal((await h.fetchAs("https://example.com", "/api/backups", { method: "POST", body: "{}" })).status, 403);

  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const paired = await h.fetchRemote("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Test iPhone" }) });
  assert.ok(paired.body?.token, "the fixture phone did not pair");
  assert.equal((await h.fetchRemote("/api/bots", { token: paired.body.token })).status, 200, "the paired phone is not paired");
  for (const [method, path] of [
    ["GET", "/api/backups"],
    ["POST", "/api/backups"],
    ["PUT", "/api/backups/settings"],
    ["POST", "/api/backups/bloks-backup-x.tar.gz/restore"],
    ["DELETE", "/api/backups/bloks-backup-x.tar.gz"],
  ]) {
    const res = await h.fetchRemote(path, { method, token: paired.body.token });
    assert.equal(res.status, 403, `a paired phone reached ${method} ${path}`);
  }
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    assert.equal(allows("bot-me", method, "/api/backups").ok, false, `an agent may ${method} /api/backups`);
    assert.equal(allows("bot-me", method, "/api/backups/anything/restore").ok, false);
  }
  assert.equal(readdirSync(h.home).includes(".bloks-backups"), false, "a refused request wrote a backup");
});

test("back up, list, verify and delete through the routes, and switch the daily backup off", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { backup } = await h.json("/api/backups", { method: "POST", body: "{}" });
  assert.equal(backup.kind, "manual");
  assert.equal(backup.secrets, false);
  assert.ok(existsSync(join(h.home, ".bloks-backups", backup.name)));
  const listed = (await h.json("/api/backups")).backups;
  assert.deepEqual(listed.map((b: any) => b.name), [backup.name]);
  assert.ok(listed[0].size > 0);
  assert.deepEqual(await h.json(`/api/backups/${backup.name}/verify`, { method: "POST", body: "{}" }).then((r) => [r.ok, r.problems]), [true, []]);

  const keysAlone = await h.fetch("/api/backups", { method: "POST", body: JSON.stringify({ secrets: true }) });
  assert.equal(keysAlone.status, 400);
  assert.equal((await keysAlone.json()).needsPassphrase, true);
  assert.equal((await h.fetch("/api/backups", { method: "POST", body: JSON.stringify({ passphrase: "short" }) })).status, 400);

  const sealed = (await h.json("/api/backups", { method: "POST", body: JSON.stringify({ passphrase: PASS, undo: true }) })).backup;
  assert.deepEqual([sealed.encrypted, sealed.secrets, sealed.undo], [true, true, true]);
  const locked = await h.fetch(`/api/backups/${sealed.name}/verify`, { method: "POST", body: "{}" });
  assert.equal(locked.status, 400);
  assert.equal((await locked.json()).needsPassphrase, true);
  assert.equal((await h.json(`/api/backups/${sealed.name}/verify`, { method: "POST", body: JSON.stringify({ passphrase: PASS }) })).ok, true);

  assert.equal((await h.fetch("/api/backups/bloks-backup-none.tar.gz/reveal", { method: "POST" })).status, 404);
  assert.equal((await h.fetch("/api/backups/..%2Fconfig.json/verify", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await h.fetch("/api/backups/%E0%A4%A/verify", { method: "POST", body: "{}" })).status, 400);

  assert.equal((await h.fetch(`/api/backups/${backup.name}`, { method: "DELETE" })).status, 200);
  assert.equal(existsSync(join(h.home, ".bloks-backups", backup.name)), false);
  assert.equal((await h.fetch(`/api/backups/${backup.name}`, { method: "DELETE" })).status, 404);

  assert.equal((await h.fetch("/api/backups/settings", { method: "PUT", body: JSON.stringify({ auto: "no" }) })).status, 400);
  const off = await h.json("/api/backups/settings", { method: "PUT", body: JSON.stringify({ auto: false }) });
  assert.equal(off.auto, false);
  assert.deepEqual(JSON.parse(readFileSync(join(h.home, ".bloks", "config.json"), "utf8")).backups, { auto: false });
});

test("the daily backup is made while Bloks is quiet, once a day, and not when switched off", async (t) => {
  const h = await startHarness({ BLOKS_AUTO_BACKUP_MS: "200" });
  t.after(() => h.stop());
  const made = await waitFor(async () => (await h.json("/api/backups")).backups.find((b: any) => b.kind === "automatic"));
  assert.ok(made, "no daily backup was made");
  assert.ok(made.name.includes("-auto"));
  assert.equal(made.secrets, false);
  await new Promise((r) => setTimeout(r, 1_000));
  assert.equal((await h.json("/api/backups")).backups.filter((b: any) => b.kind === "automatic").length, 1, "a second daily backup on the same day");

  const dir = home(t);
  mkdirSync(join(dir, ".bloks"), { recursive: true });
  writeFileSync(join(dir, ".bloks", "config.json"), JSON.stringify({ backups: { auto: false } }));
  const off = await startHarness({ HOME: dir, BLOKS_AUTO_BACKUP_MS: "200" });
  t.after(() => off.stop());
  await new Promise((r) => setTimeout(r, 1_500));
  assert.deepEqual((await off.json("/api/backups")).backups, [], "a daily backup was made while switched off");
});

test("a restore waits for running turns, backs up, stops, and comes back as the backup", async (t) => {
  const dir = home(t);
  const fake = await fakeProvider(t);
  const first = await startHarness({ HOME: dir });
  t.after(() => first.stop());
  const ivy = await agentOn(first, fake.port, "Ivy");
  const { backup } = await first.json("/api/backups", { method: "POST", body: "{}" });
  await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Jo" }) });
  assert.ok((await botNames(first)).includes("Jo"));

  // a turn running when the restore is asked for
  await first.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "STILL-WORKING" }) });
  await waitFor(() => fake.sent("STILL-WORKING") >= 1);
  const asked = await first.fetch(`/api/backups/${backup.name}/restore`, { method: "POST", body: JSON.stringify({ drainSeconds: 120 }) });
  assert.equal(asked.status, 202);
  const waiting = await waitFor(async () => {
    const { restore } = await first.json("/api/backups/restore");
    return restore?.phase === "draining" && restore.running === 1 ? restore : null;
  });
  assert.ok(waiting, "the restore did not wait for the running turn");
  assert.equal((await first.json("/api/maintenance/drain")).draining, true, "new work could start during a restore");
  assert.equal((await first.fetch("/api/backups", { method: "POST", body: "{}" })).status, 409, "a backup started beside a restore");
  // nothing has changed yet
  assert.ok(existsSync(join(dir, ".bloks", "bots.json")));
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".bloks.")), []);

  fake.state.held.shift()!();
  assert.ok(await stopped(first), "the server did not stop to finish the restore");
  const left = readdirSync(dir);
  assert.ok(left.includes(".bloks.restore-pending.json"), "no restore was left for the next start");

  const second = await startHarness({ HOME: dir });
  t.after(() => second.stop());
  const names = await botNames(second);
  assert.ok(names.includes("Ivy"));
  assert.ok(!names.includes("Jo"), "the restored workspace still has what came after the backup");
  const aside = readdirSync(dir).find((n) => n.startsWith(".bloks.before-restore-"));
  assert.ok(aside, "the workspace it replaced was not kept");
  assert.ok(readFileSync(join(dir, aside, "bots.json"), "utf8").includes("Jo"));
  assert.equal(existsSync(join(dir, ".bloks.restore-pending.json")), false);
  const status = await second.json("/api/backups");
  assert.equal(status.lastRestore.from, backup.name);
  assert.ok(status.backups.some((b: any) => b.kind === "before-restore" && b.name === status.lastRestore.safety), "no backup was taken before the restore");
  // the backup had no keys, so the engine key this computer had stayed
  assert.equal(JSON.parse(readFileSync(join(dir, ".bloks", "config.json"), "utf8")).providers.grok.key, "test-key");
});

test("a wrong passphrase stops a restore before anything does, and one waiting can be called off", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ivy = await agentOn(h, fake.port, "Ivy");
  const sealed = (await h.json("/api/backups", { method: "POST", body: JSON.stringify({ passphrase: PASS }) })).backup;

  const wrong = await h.fetch(`/api/backups/${sealed.name}/restore`, { method: "POST", body: JSON.stringify({ passphrase: "not the passphrase" }) });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /does not open/);
  assert.equal((await h.json("/api/backups/restore")).restore, null);
  assert.equal((await h.json("/api/maintenance/drain")).draining, false, "a refused restore started draining");

  await h.fetch(`/api/bots/${ivy.id}/messages`, { method: "POST", body: JSON.stringify({ text: "KEEP-GOING" }) });
  await waitFor(() => fake.sent("KEEP-GOING") >= 1);
  assert.equal(
    (await h.fetch(`/api/backups/${sealed.name}/restore`, { method: "POST", body: JSON.stringify({ passphrase: PASS }) })).status,
    202,
  );
  await waitFor(async () => (await h.json("/api/backups/restore")).restore?.phase === "draining");
  const called = await h.json("/api/backups/restore", { method: "DELETE" });
  assert.equal(called.restore.phase, "cancelled");
  assert.equal((await h.json("/api/maintenance/drain")).draining, false, "calling a restore off left the drain on");
  fake.state.held.shift()!();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await h.fetch("/api/health")).ok, true, "the server stopped for a restore that was called off");
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith(".bloks.")), []);
});
