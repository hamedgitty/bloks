// Backups of the whole workspace, and putting one back (server/backup.ts).
//
// The promises: a backup holds the workspace and nothing that is made
// again or belongs to the running server; it opens with ordinary tools;
// saved keys never go into one without a passphrase; a sealed one is noise
// without it; verifying catches a changed byte and a file cut short; and a
// restore checks everything before it changes anything, keeps what it
// replaces, and never writes outside the folder it unpacks into.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// The module reads the data folder's place from HOME as it loads, so HOME
// is a throwaway before it is imported, and every call below names its
// own folder besides. Nothing here may ever reach the real ~/.bloks.
const HOME = mkdtempSync(join(tmpdir(), "bloks-backup-home-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const backup = await import("../server/backup.ts");
const { BackupError } = backup;

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

const PASS = "a long enough passphrase";
const SECRET_VALUES = [
  "grok-key-value-0001",
  "custom-key-value-0002",
  "telegram-token-value-0003",
  "saved-secret-value-0004",
  "relay-agent-token-0005",
  "device-digest-value-0006",
  "header-value-0007",
  "corrupt-copy-key-0008",
];

/** A data folder with one of everything worth asking about. */
function workspace(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "bloks-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, ".bloks");
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(data, rel)), { recursive: true });
    writeFileSync(join(data, rel), text);
  };
  put("bots.json", JSON.stringify([{ id: "b1", name: "Ivy" }]));
  put("messages-t1.json", JSON.stringify([{ text: "hello from the workspace" }]));
  put(
    "config.json",
    JSON.stringify({
      profile: { about: "kept in every backup" },
      providers: { grok: { key: SECRET_VALUES[0], url: "http://127.0.0.1:1" } },
      custom: [{ id: "ep1", name: "Mine", url: "http://example.test", keys: [{ id: "k1", label: "main", key: SECRET_VALUES[1] }] }],
      telegram: { token: SECRET_VALUES[2], chatIds: [42], enabled: true },
      secrets: { SOME_TOKEN: SECRET_VALUES[3] },
      relay: { url: "https://relay.test", agentToken: SECRET_VALUES[4], enabled: true },
      remote: { enabled: true, devices: [{ id: "d1", name: "Phone", hash: SECRET_VALUES[5], pairedAt: 1 }] },
      mcpServers: [{ id: "m1", name: "Tools", transport: "http", url: "http://tools.test", headers: { authorization: SECRET_VALUES[6] } }],
      backups: { auto: true },
    }),
  );
  put(`config.json.corrupt-2026-01-01T00-00-00-000Z-x`, `{"providers":{"grok":{"key":"${SECRET_VALUES[7]}"`);
  put("skills/writer.md", "# Writer\n");
  put("events/t1.ndjson", '{"kind":"turn.started"}\n');
  put("rehearsals/index.json", "[]");
  put("rehearsals/r1/copy/file.txt", "a rehearsal's copy");
  put("native/claude-t1.ndjson", "raw engine traffic");
  put("browser/b1/Cookies", "a browser profile");
  put("checkpoints/index.json", "[]");
  put("checkpoints/blobs/ab/abcdef", "an old version of a file");
  put("server.lock", JSON.stringify({ pid: 1, port: 1, startedAt: 1 }));
  put("port", "8799");
  put("bots.json.123.tmp", "half a save");
  put(".DS_Store", "finder");
  put("workspaces/b1/src/main.ts", "console.log('work');\n");
  put("workspaces/b1/node_modules/left-pad/index.js", "module.exports = 1;");
  put("workspaces/b1/.git/HEAD", "ref: refs/heads/main\n");
  put(`workspaces/b1/${"deep/".repeat(25)}notes.txt`, "a long way down");
  put("workspaces/b1/caf\u00e9.txt", "accents");
  symlinkSync("/etc", join(data, "workspaces/b1/link-out"));
  return { root, data, put };
}

const tarList = (file: string) => execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split("\n");
const tarRead = (file: string, entry: string) => execFileSync("tar", ["-xzOf", file, entry], { encoding: "utf8" });
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

test("a backup holds the workspace, opens with tar, and leaves out what is made again and the running server's files", async (t) => {
  const { data } = workspace(t);
  // a socket is a running process's, never a file to keep
  const sock = createServer();
  await new Promise<void>((r) => sock.listen(join(data, "perm-test.sock"), r));
  t.after(() => sock.close());

  const made = await backup.createBackup({ dataDir: data, version: "9.9.9", now: new Date(2026, 9, 10, 8, 30, 5) });
  assert.equal(made.name, "bloks-backup-2026-10-10-083005-v9.9.9.tar.gz");
  assert.equal(dirname(made.path), `${data}-backups`, "backups go beside the data folder, never in it");
  assert.equal(statSync(`${data}-backups`).mode & 0o777, 0o700);
  assert.equal(statSync(made.path).mode & 0o777, 0o600);
  assert.equal(made.kind, "manual");

  const entries = tarList(made.path);
  assert.equal(entries[0], "bloks-backup.json", "the summary comes first, so a list reads only the start");
  assert.equal(entries[entries.length - 1], "manifest.json");
  for (const kept of [
    "bloks/bots.json",
    "bloks/messages-t1.json",
    "bloks/config.json",
    "bloks/skills/writer.md",
    "bloks/events/t1.ndjson",
    "bloks/rehearsals/index.json",
    "bloks/workspaces/b1/src/main.ts",
    "bloks/workspaces/b1/.git/HEAD",
    `bloks/workspaces/b1/${"deep/".repeat(25)}notes.txt`,
  ]) {
    assert.ok(entries.includes(kept), `${kept} is missing from the backup`);
  }
  for (const gone of ["native", "browser", "rehearsals/r1", "checkpoints", "server.lock", "port", ".tmp", ".DS_Store", "node_modules", "link-out", ".sock"]) {
    assert.ok(!entries.some((e) => e.includes(gone)), `${gone} should not be in a backup`);
  }

  const manifest = JSON.parse(tarRead(made.path, "manifest.json"));
  assert.equal(manifest.version, "9.9.9");
  assert.equal(manifest.undo, false);
  const main = manifest.files.find((f: any) => f.path === "workspaces/b1/src/main.ts");
  assert.deepEqual([main.size, main.sha256], [21, sha("console.log('work');\n")]);
  assert.ok(manifest.files.some((f: any) => f.path.normalize("NFC") === "workspaces/b1/caf\u00e9.txt"), "a name with an accent was lost");
  assert.equal(tarRead(made.path, `bloks/workspaces/b1/${"deep/".repeat(25)}notes.txt`), "a long way down", "a long path did not survive");
  for (const why of ["native/ (raw engine logs)", "browser/ (browser profiles)", "checkpoints/ (Undo history, not asked for)", "rehearsals/r1/ (rehearsal copy)"]) {
    assert.ok(manifest.leftOut.includes(why), `the manifest does not say ${why}`);
  }

  const verified = await backup.verifyBackup(made.path);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.ok, true);
  assert.equal(verified.files, manifest.files.length);

  // the Undo history only when asked
  const withUndo = await backup.createBackup({ dataDir: data, undo: true });
  assert.ok(tarList(withUndo.path).includes("bloks/checkpoints/blobs/ab/abcdef"));
  assert.equal(withUndo.undo, true);
});

test("saved keys never reach a backup without a passphrase, and the manifest names what was left out", async (t) => {
  const { data } = workspace(t);
  const made = await backup.createBackup({ dataDir: data });
  assert.equal(made.secrets, false);
  // every byte of the archive, not just config.json: a key must not be
  // anywhere in it, including old copies of the config
  const everything = gunzipSync(readFileSync(made.path)).toString("utf8");
  for (const value of SECRET_VALUES) assert.ok(!everything.includes(value), `${value} is in a backup without a passphrase`);

  const config = JSON.parse(tarRead(made.path, "bloks/config.json"));
  assert.equal(config.profile.about, "kept in every backup");
  assert.deepEqual(config.telegram, { chatIds: [42], enabled: true });
  assert.equal(config.custom[0].keys[0].label, "main", "only the key goes, not what is around it");
  assert.equal(config.providers.grok.url, "http://127.0.0.1:1");
  const manifest = JSON.parse(tarRead(made.path, "manifest.json"));
  assert.equal(manifest.secrets, false);
  for (const where of ["providers.grok.key", "custom[ep1].keys[k1].key", "telegram.token", "secrets", "relay.agentToken", "remote.devices", "mcpServers[m1].headers"]) {
    assert.ok(manifest.secretsLeftOut.includes(where), `the manifest does not say ${where} was left out`);
  }
  assert.ok(manifest.leftOut.some((w: string) => w.startsWith("config.json.corrupt-")), "an old copy of the config went in");

  await assert.rejects(backup.createBackup({ dataDir: data, secrets: true }), (e: unknown) => e instanceof BackupError && e.code === "passphrase");
});

test("a sealed backup is noise without its passphrase and whole with it", async (t) => {
  const { data } = workspace(t);
  await assert.rejects(backup.createBackup({ dataDir: data, passphrase: "short" }), /at least 8 characters/);
  const sealed = await backup.createBackup({ dataDir: data, passphrase: PASS });
  assert.ok(sealed.name.endsWith(".tar.gz.enc"));
  assert.equal(sealed.encrypted, true);
  assert.equal(sealed.secrets, true, "a sealed backup keeps the keys unless told not to");
  const raw = readFileSync(sealed.path);
  assert.ok(!raw.includes("hello from the workspace"));
  assert.ok(!raw.includes(SECRET_VALUES[0]));
  assert.throws(() => gunzipSync(raw), "a sealed backup is not a plain gzip");

  // listed without the passphrase, from its clear header
  const listed = backup.listBackups(data).find((b) => b.name === sealed.name)!;
  assert.deepEqual([listed.encrypted, listed.secrets, listed.kind, listed.damaged], [true, true, "manual", undefined]);

  await assert.rejects(backup.verifyBackup(sealed.path), (e: unknown) => e instanceof BackupError && e.code === "passphrase");
  await assert.rejects(backup.verifyBackup(sealed.path, "not the passphrase"), /does not open this backup/);
  const verified = await backup.verifyBackup(sealed.path, PASS);
  assert.equal(verified.ok, true, verified.problems.join("; "));

  const keyless = await backup.createBackup({ dataDir: data, passphrase: PASS, secrets: false });
  assert.equal(keyless.secrets, false);
});

test("verifying catches a changed file, a cut-off backup and a changed sealed piece", async (t) => {
  const { data } = workspace(t);
  const dir = `${data}-backups`;
  const plain = await backup.createBackup({ dataDir: data });

  // the same bytes count, one word changed inside a file: only the
  // manifest's checksums can notice
  const tar = gunzipSync(readFileSync(plain.path));
  const at = tar.indexOf("hello from the workspace");
  tar.write("HELLO", at);
  const changed = join(dir, "bloks-backup-changed.tar.gz");
  writeFileSync(changed, gzipSync(tar));
  const result = await backup.verifyBackup(changed);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["messages-t1.json has changed since the backup was made"]);

  const whole = readFileSync(plain.path);
  const cut = join(dir, "bloks-backup-cut.tar.gz");
  writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)));
  const cutResult = await backup.verifyBackup(cut);
  assert.equal(cutResult.ok, false);
  assert.match(cutResult.problems[0], /damaged or incomplete/);

  const sealed = await backup.createBackup({ dataDir: data, passphrase: PASS });
  const bytes = readFileSync(sealed.path);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 40] ^= 0xff;
  const tampered = join(dir, "bloks-backup-flipped.tar.gz.enc");
  writeFileSync(tampered, flipped);
  const flippedResult = await backup.verifyBackup(tampered, PASS);
  assert.equal(flippedResult.ok, false, "a changed byte in a sealed backup went unnoticed");
  assert.match(flippedResult.problems[0], /changed since it was made/, "a changed piece read as a wrong passphrase");

  const short = join(dir, "bloks-backup-short.tar.gz.enc");
  writeFileSync(short, bytes.subarray(0, bytes.length - 100));
  const shortResult = await backup.verifyBackup(short, PASS);
  assert.equal(shortResult.ok, false);
  assert.match(shortResult.problems[0], /ends early/);

  // a file that is not a backup at all is listed, marked, so it can go
  writeFileSync(join(dir, "bloks-backup-junk.tar.gz"), "not a backup");
  assert.equal(backup.listBackups(data).find((b) => b.name === "bloks-backup-junk.tar.gz")?.damaged, true);
});

test("the daily backups keep the newest seven, and manual ones stay", async (t) => {
  const { data } = workspace(t);
  const day = 24 * 60 * 60_000;
  const start = new Date(2026, 8, 1, 3, 0, 0).getTime();
  for (let i = 0; i < 9; i++) await backup.createBackup({ dataDir: data, kind: "automatic", now: new Date(start + i * day) });
  await backup.createBackup({ dataDir: data, now: new Date(start - day) });
  await backup.createBackup({ dataDir: data, kind: "before-restore", now: new Date(start - 2 * day) });
  const stale = join(`${data}-backups`, "bloks-backup-x.tar.gz.partial");
  writeFileSync(stale, "half");
  utimesSync(stale, new Date(Date.now() - 2 * day), new Date(Date.now() - 2 * day));

  const gone = backup.pruneAutomatic(data);
  assert.equal(gone.length, 2);
  const left = backup.listBackups(data);
  const automatic = left.filter((b) => b.kind === "automatic");
  assert.equal(automatic.length, 7);
  assert.equal(automatic[automatic.length - 1].created, start + 2 * day, "the oldest two went, not others");
  assert.ok(left.some((b) => b.kind === "manual"), "a manual backup was pruned");
  assert.ok(left.some((b) => b.kind === "before-restore"), "the backup taken before a restore was pruned");
  assert.ok(automatic.every((b) => b.name.includes("-auto")));
  assert.equal(existsSync(stale), false, "a half-written backup from a day ago stayed");
  assert.equal(backup.newestAutomatic(data), start + 8 * day);
});

test("the daily backup waits for a quiet Bloks, a day since the last, and its switch", () => {
  const now = Date.UTC(2026, 9, 10, 12);
  const hour = 60 * 60_000;
  const due = (over: Partial<Parameters<typeof backup.autoBackupDue>[0]>) =>
    backup.autoBackupDue({ enabled: true, idle: true, newestAt: now - 25 * hour, now, ...over });
  assert.equal(due({}), true);
  assert.equal(due({ newestAt: null }), true, "never backed up");
  assert.equal(due({ newestAt: now - 23 * hour }), false, "one was made today");
  assert.equal(due({ idle: false }), false, "something is running");
  assert.equal(due({ enabled: false }), false, "switched off");
  assert.equal(due({ newestAt: now + 48 * hour }), true, "a clock that went back must not stop backups for days");
});

test("a restore puts the backup in place on the next start, keeps what it replaced, and keeps this computer's keys", async (t) => {
  const { root, data, put } = workspace(t);
  const before = await backup.createBackup({ dataDir: data });
  // the workspace moves on after the backup
  put("bots.json", JSON.stringify([{ id: "b1", name: "Ivy" }, { id: "b2", name: "Jo" }]));
  put("messages-t2.json", "[]");
  const current = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  current.providers.grok.key = "a-newer-key-0009";
  current.profile.about = "changed since";
  put("config.json", JSON.stringify(current));

  const { safety, pending } = await backup.restoreBackup(before.path, { dataDir: data });
  assert.ok(safety && safety.kind === "before-restore", "no backup was taken of the workspace it replaces");
  assert.ok(tarRead(safety.path, "bloks/bots.json").includes("Jo"), "the fresh backup is not of the workspace as it was");
  assert.equal(pending.keys, "kept");
  assert.ok(existsSync(pending.staging));
  assert.deepEqual(backup.pendingRestore(data)?.from, before.name);
  assert.ok(readFileSync(join(data, "bots.json"), "utf8").includes("Jo"), "the data folder changed before the next start");

  const applied = backup.applyPendingRestore({ dataDir: data, log: () => {} });
  assert.ok(applied);
  assert.equal(applied.from, before.name);
  assert.ok(!readFileSync(join(data, "bots.json"), "utf8").includes("Jo"), "the backup was not put in place");
  assert.equal(existsSync(join(data, "messages-t2.json")), false);
  assert.ok(applied.aside.startsWith(`${data}.before-restore-`));
  assert.ok(readFileSync(join(applied.aside, "bots.json"), "utf8").includes("Jo"), "the workspace it replaced is gone");
  assert.equal(existsSync(join(applied.aside, "server.lock")), false);
  assert.equal(statSync(data).mode & 0o777, 0o700);
  const restored = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  assert.equal(restored.profile.about, "kept in every backup", "settings did not come back");
  assert.equal(restored.providers.grok.key, "a-newer-key-0009", "the keys this computer has were lost");
  assert.equal(restored.telegram.token, SECRET_VALUES[2]);
  assert.equal(restored.custom[0].keys[0].key, SECRET_VALUES[1]);
  assert.equal(statSync(join(data, "config.json")).mode & 0o777, 0o600);
  assert.equal(backup.pendingRestore(data), null);
  assert.equal(backup.lastRestore(data)?.from, before.name);
  assert.deepEqual(readdirSync(root).filter((n) => n.includes(".restoring-")), [], "the unpacked copy was left behind");
  // and nothing waits now
  assert.equal(backup.applyPendingRestore({ dataDir: data, log: () => {} }), null);
});

test("a sealed backup with keys brings its own keys back", async (t) => {
  const { data, put } = workspace(t);
  const sealed = await backup.createBackup({ dataDir: data, passphrase: PASS });
  put("config.json", JSON.stringify({ providers: { grok: { key: "another-key-0010" } } }));
  await assert.rejects(backup.restoreBackup(sealed.path, { dataDir: data }), (e: unknown) => e instanceof BackupError && e.code === "passphrase");
  await assert.rejects(backup.restoreBackup(sealed.path, { dataDir: data, passphrase: "wrong passphrase" }), /does not open/);
  const { pending } = await backup.restoreBackup(sealed.path, { dataDir: data, passphrase: PASS });
  assert.equal(pending.keys, "restored");
  backup.applyPendingRestore({ dataDir: data, log: () => {} });
  const restored = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  assert.equal(restored.providers.grok.key, SECRET_VALUES[0]);
  assert.equal(restored.remote.devices[0].hash, SECRET_VALUES[5]);
});

test("a backup that does not check out is never staged, and nothing changes", async (t) => {
  const { root, data } = workspace(t);
  const plain = await backup.createBackup({ dataDir: data });
  const tar = gunzipSync(readFileSync(plain.path));
  tar.write("HELLO", tar.indexOf("hello from the workspace"));
  const changed = join(`${data}-backups`, "bloks-backup-changed.tar.gz");
  writeFileSync(changed, gzipSync(tar));
  const bots = readFileSync(join(data, "bots.json"), "utf8");

  await assert.rejects(backup.restoreBackup(changed, { dataDir: data }), /did not check out, so nothing was changed/);
  assert.equal(backup.pendingRestore(data), null, "a restore was left waiting");
  assert.deepEqual(readdirSync(root).filter((n) => n.includes(".restoring-")), []);
  assert.equal(readFileSync(join(data, "bots.json"), "utf8"), bots);
});

/** One tar entry, written by hand so it can be anything an attacker likes. */
function entry(name: string, body: string, type = "0", link = ""): Buffer {
  const data = Buffer.from(body);
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  block.write("00000000000\0", 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write(link, 157, 100);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

test("an archive cannot write outside the folder it unpacks into, or through a link", async (t) => {
  const { root, data } = workspace(t);
  const summary = JSON.stringify({ format: 1, app: "bloks", version: "x", created: Date.now(), kind: "manual", undo: false, secrets: false });
  const files = [
    { path: "../escaped.txt", body: "out" },
    { path: "ok.txt", body: "fine" },
  ];
  const manifest = JSON.stringify({
    format: 1,
    app: "bloks",
    files: files.map((f) => ({ path: f.path, size: f.body.length, sha256: sha(f.body), mode: 0o644, mtime: 0 })),
  });
  const evil = join(`${data}-backups`, "bloks-backup-evil.tar.gz");
  mkdirSync(dirname(evil), { recursive: true });
  writeFileSync(
    evil,
    gzipSync(
      Buffer.concat([
        entry("bloks-backup.json", summary),
        entry("bloks/../escaped.txt", "out"),
        entry("bloks/link", "", "2", "/etc"),
        entry("bloks/ok.txt", "fine"),
        entry("bloks/sub/../../escaped-too.txt", "out"),
        entry("manifest.json", manifest),
        Buffer.alloc(1024),
      ]),
    ),
  );
  const result = await backup.verifyBackup(evil);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith("bloks/../escaped.txt would land outside")));
  assert.ok(result.problems.some((p) => p.startsWith("link is a link")));

  await assert.rejects(backup.stageRestore(evil, { dataDir: data }), /did not check out/);
  for (const where of [root, dirname(root), data]) {
    assert.equal(existsSync(join(where, "escaped.txt")), false, `an entry escaped into ${where}`);
    assert.equal(existsSync(join(where, "escaped-too.txt")), false, `an entry escaped into ${where}`);
  }
  assert.equal(backup.pendingRestore(data), null);
  for (const name of ["bloks/../x", "bloks//x", "bloks/./x", "elsewhere/x", "bloks/a\\..\\x", "bloks/"]) {
    assert.equal(backup.safeEntryPath(name), null, `${name} was taken as safe`);
  }
  assert.equal(backup.safeEntryPath("bloks/workspaces/a.txt"), "workspaces/a.txt");
});

test("a waiting restore is left alone while another Bloks holds the folder", async (t) => {
  const { data, put } = workspace(t);
  const made = await backup.createBackup({ dataDir: data });
  put("bots.json", "[]");
  await backup.restoreBackup(made.path, { dataDir: data });
  // a live process whose command names Bloks, as a running server's does
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "bloks-lock-holder"], { stdio: "ignore" });
  t.after(() => holder.kill());
  await new Promise((r) => setTimeout(r, 200));
  put("server.lock", JSON.stringify({ pid: holder.pid, port: 1, startedAt: Date.now() }));

  assert.equal(backup.applyPendingRestore({ dataDir: data, log: () => {} }), null, "the folder was swapped under a running server");
  assert.ok(backup.pendingRestore(data), "the waiting restore was dropped");
  assert.equal(readFileSync(join(data, "bots.json"), "utf8"), "[]");

  holder.kill();
  await new Promise((r) => holder.once("exit", r));
  assert.ok(backup.applyPendingRestore({ dataDir: data, log: () => {} }), "the restore never happened once the folder was free");
  assert.ok(readFileSync(join(data, "bots.json"), "utf8").includes("Ivy"));
});

test("names a route may act on, and how each system shows a file", () => {
  assert.equal(backup.isBackupName("bloks-backup-2026-10-10-083005-v2.6.0.tar.gz"), true);
  assert.equal(backup.isBackupName("bloks-backup-2026-10-10-083005-v2.6.0-auto.tar.gz.enc"), true);
  for (const bad of ["../config.json", "../x.tar.gz", ".hidden.tar.gz", "a/b.tar.gz", "bots.json", ""]) {
    assert.equal(backup.isBackupName(bad), false, `${bad} was taken as a backup name`);
  }
  assert.equal(backup.backupFileName(new Date(2026, 0, 2, 3, 4, 5), "2.6.0", "automatic", true), "bloks-backup-2026-01-02-030405-v2.6.0-auto.tar.gz.enc");
  assert.deepEqual(backup.revealCommand("/b/x.tar.gz", "darwin"), { command: "open", args: ["-R", "/b/x.tar.gz"] });
  assert.deepEqual(backup.revealCommand("C:\\b\\x.tar.gz", "win32"), { command: "explorer.exe", args: ["/select,C:\\b\\x.tar.gz"] });
  assert.equal(backup.revealCommand("/b/x.tar.gz", "linux").command, "xdg-open");
});
