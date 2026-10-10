// bloks-server backup and restore, for a Bloks with no window
// (bin/bloks-server.mjs, server/backup.ts).
//
// With Bloks stopped the command does the whole thing itself. With it
// running, a restore is handed to the server, which has to be the one to
// stop: only it can let what is running finish, and only a fresh start
// can swap the folder before anything reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const CLI = fileURLToPath(new URL("../bin/bloks-server.mjs", import.meta.url));
const PASS = "a long enough passphrase";

function home(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "bloks-backup-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function cli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, BLOKS_BACKUP_PASSPHRASE: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
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

test("bloks-server backup and restore work with Bloks stopped", async (t) => {
  const dir = home(t);
  const data = join(dir, ".bloks");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "b1", name: "Before" }]));
  // a port nothing listens on, so the commands know Bloks is not running
  const env = { HOME: dir, USERPROFILE: dir, BLOKS_PORT: "1" };

  const plain = await cli(["backup"], env);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /Backed up to .*\.tar\.gz \(/);
  assert.match(plain.out, /saved keys were left out/);
  const sealed = await cli(["backup", "--encrypt"], { ...env, BLOKS_BACKUP_PASSPHRASE: PASS });
  assert.equal(sealed.code, 0, sealed.out);
  const files = readdirSync(join(dir, ".bloks-backups"));
  const plainFile = join(dir, ".bloks-backups", files.find((f) => f.endsWith(".tar.gz"))!);
  const sealedFile = join(dir, ".bloks-backups", files.find((f) => f.endsWith(".tar.gz.enc"))!);

  writeFileSync(join(data, "bots.json"), JSON.stringify([{ id: "b2", name: "After" }]));
  const restored = await cli(["restore", plainFile], env);
  assert.equal(restored.code, 0, restored.out);
  assert.match(restored.out, /Restored from/);
  assert.ok(readFileSync(join(data, "bots.json"), "utf8").includes("Before"));
  assert.ok(readdirSync(dir).some((n) => n.startsWith(".bloks.before-restore-")), "the workspace it replaced was not kept");

  const refused = await cli(["restore", sealedFile], { ...env, BLOKS_BACKUP_PASSPHRASE: "not the passphrase" });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /does not open/);
  const unsealed = await cli(["restore", sealedFile], { ...env, BLOKS_BACKUP_PASSPHRASE: PASS });
  assert.equal(unsealed.code, 0, unsealed.out);
  assert.match(unsealed.out, /Saved keys came back/);

  const missing = await cli(["restore", join(dir, "nothing-here.tar.gz")], env);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /There is no file/);
});

test("bloks-server restore hands the restore to a running Bloks, which stops to finish it", async (t) => {
  const dir = home(t);
  const first = await startHarness({ HOME: dir });
  t.after(() => first.stop());
  await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Kept" }) });
  const { backup } = await first.json("/api/backups", { method: "POST", body: "{}" });
  // a backup from somewhere else is copied in, then restored by name
  const elsewhere = join(dir, "my backup copy.tgz");
  writeFileSync(elsewhere, readFileSync(backup.path));
  await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Later" }) });

  const port = new URL(first.url).port;
  const ran = await cli(["restore", elsewhere], { HOME: dir, USERPROFILE: dir, BLOKS_PORT: port });
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /Checked and ready/);
  assert.ok(await stopped(first));
  assert.ok(readdirSync(join(dir, ".bloks-backups")).some((n) => n.startsWith("bloks-backup-imported-")), "the file was not copied in");

  const second = await startHarness({ HOME: dir });
  t.after(() => second.stop());
  const names = ((await second.json("/api/bots")).bots as any[]).map((b) => b.name);
  assert.ok(names.includes("Kept"));
  assert.ok(!names.includes("Later"), "the restored workspace still has what came after the backup");
});
