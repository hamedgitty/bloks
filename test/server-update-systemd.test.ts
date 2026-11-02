// Updating a bloks-server that systemd runs, from the app (GitHub 396,
// item 3 of GitHub 430).
//
// The rules: systemd keeps the server, so the update never starts one of
// its own. It updates from the app only when the account Bloks runs as
// can write versions/ (the release folder may stay root's), the unit
// starts it again once it stops, and the install folder's launcher keeps
// a trial; each missing piece is said. The server switches versions and
// stops with EXIT_RESTART. The next start, the launcher's, gives the new
// version a window to end the trial; a new version that falls over, or
// never ends it, is switched back without anybody at the machine; a
// version that does end it is written down as running. Nothing of it
// needs root.
//
// The starts here are the real bin/bloks-server.mjs in front of fake
// servers that only answer /api/health, started again by the test the
// way systemd would, on free ports and in temp folders.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  confirmTrial,
  EXIT_RESTART,
  installOf,
  manualSteps,
  pointerOf,
  pointTo,
  readRecord,
  readTrial,
  ServerUpdater,
  switchForManager,
  tarballName,
  TRIAL_FILE,
  type InstallFacts,
  type UpdaterHooks,
} from "../server/server-update.ts";

const LAUNCHER = fileURLToPath(new URL("../bin/bloks-server.mjs", import.meta.url));
const HOME = "/opt/bloks-server";
const UNIT = "/system.slice/bloks.service";

function scratch(t: { after: (fn: () => void) => void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bloks-systemd-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A release folder root owns, with a versions/ folder the service
 * account owns, started by systemd with Restart=always. */
function facts(over: Partial<InstallFacts> & { env?: NodeJS.ProcessEnv } = {}): InstallFacts {
  return {
    platform: "linux",
    desktop: false,
    hosted: false,
    codeRoot: HOME,
    container: false,
    cgroup: UNIT,
    exists: (path) => path === `${HOME}/versions`,
    writable: (path) => path === `${HOME}/versions`,
    packageOf: () => ({ name: "bloks-server", version: "3.2.0" }),
    restartPolicy: () => "always",
    ...over,
    env: { BLOKS_SERVER_ROOT: HOME, BLOKS_SERVER_HOME: HOME, ...over.env },
  };
}

test("under systemd it updates from the app once versions/ is the service account's and the unit restarts it", () => {
  const ready = installOf(facts());
  assert.equal(ready.kind, "service");
  assert.equal(ready.manager, "systemd");
  assert.equal(ready.unit, "bloks.service");
  assert.equal(ready.canInstall, true, ready.why);
  assert.equal(ready.via, "manager");
  assert.equal(ready.home, HOME);
  assert.match(ready.why, /systemd starts it/);

  assert.equal(installOf(facts({ restartPolicy: () => "on-failure" })).canInstall, true, "on-failure restarts an EXIT_RESTART too");
  const user = installOf(facts({ cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/bloks.service" }));
  assert.equal(user.canInstall, true);
  assert.equal(user.user, true);
  // a version an update put beside it, handed over to: the same install
  const beside = installOf(facts({ codeRoot: `${HOME}/versions/3.2.1`, env: { BLOKS_SERVER_ROOT: `${HOME}/versions/3.2.1` } }));
  assert.equal(beside.canInstall, true);
  assert.equal(beside.home, HOME);
  // the release folder written by its own account is fine too
  assert.equal(installOf(facts({ writable: () => true, exists: () => false })).canInstall, true);
});

test("under systemd each missing piece is said, with the way to fix it, and nothing is offered", () => {
  const cases: Array<[string, InstallFacts, RegExp]> = [
    ["a launcher from before trials", facts({ packageOf: () => ({ name: "bloks-server", version: "3.1.1" }) }), /older than 3\.2\.0[\s\S]*by hand once/],
    ["Restart=no", facts({ restartPolicy: () => "no" }), /Restart=no in bloks\.service[\s\S]*Restart=always/],
    ["Restart=on-abnormal", facts({ restartPolicy: () => "on-abnormal" }), /Restart=on-abnormal/],
    ["systemd not answering", facts({ restartPolicy: () => null }), /couldn't ask it[\s\S]*Restart=always/],
    ["no way to ask", facts({ restartPolicy: undefined }), /couldn't ask it/],
    ["a versions folder root owns", facts({ writable: () => false }), /can't write to \/opt\/bloks-server\/versions[\s\S]*SELF_HOSTING/],
    ["no versions folder, and a release folder root owns", facts({ exists: () => false, writable: () => false }), /can't write to \/opt\/bloks-server\/versions/],
  ];
  for (const [what, given, why] of cases) {
    const install = installOf(given);
    assert.equal(install.kind, "service", what);
    assert.equal(install.canInstall, false, what);
    assert.equal(install.via, undefined, what);
    assert.match(install.why, /^systemd runs this server/, what);
    assert.match(install.why, why, what);
  }
  // still told the steps by hand, restart and all
  const steps = manualSteps(installOf(facts({ restartPolicy: () => "no" })), { version: "3.2.1", platform: "linux" }).join("\n");
  assert.match(steps, /sha256sum -c[\s\S]*sudo systemctl restart bloks\.service/);
  // and a hosted machine is still the image's, systemd or not
  assert.equal(installOf(facts({ hosted: true })).kind, "hosted");
  assert.equal(installOf(facts({ env: { BLOKS_SERVER_UPDATES: "off" } })).kind, "disabled");
});

/** A bloks-server folder as the release packs it, with the real launcher
 * and a server that only answers /api/health, or one that stops while
 * starting. */
function fakeServerFolder(dir: string, version: string, o: { crash?: boolean } = {}) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "dist-server"), { recursive: true });
  copyFileSync(LAUNCHER, join(dir, "bin", "bloks-server.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bloks-server", version, type: "module", engines: { node: ">=22.6" } }));
  writeFileSync(join(dir, "dist-server", "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    join(dir, "dist-server", "index.js"),
    o.crash
      ? `console.error("this version does not start"); process.exit(3);\n`
      : `import { createServer } from "node:http";
const version = ${JSON.stringify(version)};
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health") return res.end(JSON.stringify({ app: "bloks", version, pid: process.pid }));
  if (req.url === "/api/relay") return res.end(JSON.stringify({ enabled: false }));
  res.statusCode = 404;
  res.end("{}");
});
server.listen(Number(process.env.BLOKS_PORT), "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

async function health(port: number): Promise<{ version: string; pid: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as { version: string; pid: number }) : null;
  } catch {
    return null;
  }
}

/** An install systemd would run: the release at 3.2.0, an update's 3.2.1
 * beside it, and a start that is the unit's ExecStart, which the test
 * repeats as Restart=always would. */
async function unitInstall(t: { after: (fn: () => unknown) => void }, name: string, o: { crash?: boolean } = {}) {
  const work = scratch(t, name);
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.2.0");
  fakeServerFolder(join(home, "versions", "3.2.1"), "3.2.1", o);
  chmodSync(join(home, "versions"), 0o755);
  const port = await freePort();
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: work, BLOKS_PORT: String(port), BLOKS_DATA_DIR: dataDir };
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    const left = await health(port);
    if (left) {
      try {
        process.kill(left.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  /** One start, the way systemd makes it, and how it ended once it does. */
  const start = () => {
    const child = spawn(process.execPath, [join(home, "bin", "bloks-server.mjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    let err = "";
    child.stderr!.on("data", (c) => (err += c));
    const ended = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    return { child, ended, err: () => err };
  };
  const answering = async (version: string, ms = 10_000) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if ((await health(port))?.version === version) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  return { home, dataDir, port, start, answering };
}

test("a new version that falls over while starting is switched back on systemd's next start", { timeout: 60_000 }, async (t) => {
  const at = await unitInstall(t, "crash", { crash: true });
  switchForManager(at.home, at.dataDir, { from: { version: "3.2.0", pointer: null }, to: "3.2.1", manager: "systemd", unit: "bloks.service" });
  assert.equal(pointerOf(at.home), "3.2.1");
  assert.equal(readRecord(at.dataDir)?.pending, true, "under way until the new version says otherwise");

  const first = at.start();
  assert.equal(await first.ended, 3, "the new version fell over");
  assert.equal(readTrial(at.home)?.tries, 1, "the launcher counted the try");
  assert.equal(pointerOf(at.home), "3.2.1", "one try is not yet a failure");

  // Restart=always: systemd starts the unit again
  const second = at.start();
  assert.ok(await at.answering("3.2.0"), `the version before did not come back: ${second.err()}`);
  assert.equal(pointerOf(at.home), null, "switched back to the release folder's own version");
  assert.equal(existsSync(join(at.home, "versions", TRIAL_FILE)), false);
  const record = readRecord(at.dataDir)!;
  assert.equal(record.ok, false);
  assert.equal(record.rolledBack, true);
  assert.equal(record.to, "3.2.1");
  assert.equal(record.from, "3.2.0");
  assert.match(record.error ?? "", /3\.2\.1 stopped while starting/);
  assert.equal(record.log, "journalctl -u bloks.service");
  assert.equal(record.manager, "systemd");
});

test("a new version that never ends its trial is switched back, and the start stops for systemd to start the old one", { timeout: 60_000 }, async (t) => {
  const at = await unitInstall(t, "hang");
  switchForManager(at.home, at.dataDir, { from: { version: "3.2.0", pointer: null }, to: "3.2.1", manager: "systemd", unit: "bloks.service", withinMs: 1_500 });
  const first = at.start();
  assert.ok(await at.answering("3.2.1"), "the new version answers, but a fake one never ends its trial");
  assert.equal(await first.ended, EXIT_RESTART, "stopped for systemd to start it again");
  assert.match(first.err(), /did not answer within 2 seconds/);
  assert.equal(pointerOf(at.home), null);
  assert.match(readRecord(at.dataDir)?.error ?? "", /did not answer within/);

  at.start();
  assert.ok(await at.answering("3.2.0"), "the version before runs again");
});

test("the new version ends its trial once up as itself, and is written down as running", (t) => {
  const work = scratch(t, "confirm");
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.2.0");
  for (const v of ["3.1.9", "3.2.1", "3.2.2"]) fakeServerFolder(join(home, "versions", v), v);
  pointTo(home, "3.2.1");
  switchForManager(home, dataDir, { from: { version: "3.2.1", pointer: "3.2.1" }, to: "3.2.2", manager: "systemd", unit: "bloks.service" });
  assert.equal(pointerOf(home), "3.2.2");
  // the version switched to: the trial ends, the version before is kept
  const record = confirmTrial(home, dataDir, "3.2.2")!;
  assert.equal(record.ok, true);
  assert.equal(record.running, "3.2.2");
  assert.equal(readTrial(home), null);
  assert.deepEqual(readRecord(dataDir), record);
  assert.deepEqual(readdirSync(join(home, "versions")).filter((n) => !n.startsWith(".")).sort(), ["3.2.1", "3.2.2", "current"], "older versions are cleared");
  assert.equal(confirmTrial(home, dataDir, "3.2.2"), null, "nothing left to end");
});

test("a version other than the one switched to, started under a trial, switches back and says so", (t) => {
  const work = scratch(t, "other");
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.2.0");
  fakeServerFolder(join(home, "versions", "3.2.1"), "3.2.1");
  switchForManager(home, dataDir, { from: { version: "3.2.0", pointer: null }, to: "3.2.1", manager: "systemd", unit: "bloks.service" });
  const record = confirmTrial(home, dataDir, "3.2.0")!;
  assert.equal(record.ok, false);
  assert.equal(record.rolledBack, true);
  assert.match(record.error ?? "", /3\.2\.1 was switched to, but 3\.2\.0 started instead/);
  assert.equal(pointerOf(home), null);
  assert.equal(readTrial(home), null);

  // a trial whose switch was undone by hand since is simply dropped
  switchForManager(home, dataDir, { from: { version: "3.2.0", pointer: null }, to: "3.2.1", manager: "systemd" });
  pointTo(home, null);
  assert.equal(confirmTrial(home, dataDir, "3.2.0"), null);
  assert.equal(readTrial(home), null);
});

test("the launcher runs nothing from a versions folder another account could change", { timeout: 60_000 }, async (t) => {
  const at = await unitInstall(t, "trust");
  pointTo(at.home, "3.2.1");
  chmodSync(join(at.home, "versions"), 0o777);
  at.start();
  assert.ok(await at.answering("3.2.0"), "a versions folder anybody may write was handed over to");
});

/** A release on loopback: GitHub's answer about the latest and its
 * files, checksum included. */
async function fakeRelease(t: { after: (fn: () => unknown) => void }, work: string, version: string) {
  const stage = mkdtempSync(join(work, "pack-"));
  fakeServerFolder(join(stage, "bloks-server"), version);
  const tarball = join(stage, "out.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stage, "bloks-server"]);
  const bytes = readFileSync(tarball);
  const name = tarballName(version);
  const files = new Map<string, Buffer>([
    [`/download/v${version}/${name}`, bytes],
    [`/download/v${version}/${name}.sha256`, Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`)],
  ]);
  const server = createServer((req, res) => {
    if (req.url === "/releases/latest") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false, body: "notes", assets: [{ name, size: bytes.length }, { name: `${name}.sha256`, size: 90 }] }),
      );
    }
    const file = files.get(req.url ?? "");
    res.statusCode = file ? 200 : 404;
    res.end(file ?? "");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api: `${base}/releases/latest`, downloads: `${base}/download` };
}

test("the running server downloads, drains, switches and stops for systemd, and starts nothing itself", async (t) => {
  const work = scratch(t, "job");
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.2.0");
  const release = await fakeRelease(t, work, "3.2.1");
  const calls: string[] = [];
  const hooks: UpdaterHooks = {
    busy: () => null,
    drainStart: () => void calls.push("drainStart"),
    drainStatus: () => ({ done: true, running: 0 }),
    drainEnd: () => void calls.push("drainEnd"),
    handOver: () => void calls.push("handOver"),
    restart: () => void calls.push("restart"),
  };
  const install = installOf(facts({ codeRoot: home, env: { BLOKS_SERVER_ROOT: home, BLOKS_SERVER_HOME: home }, exists: () => false, writable: () => true }));
  assert.equal(install.via, "manager");
  const updater = new ServerUpdater({ version: "3.2.0", install, dataDir, port: 1, hooks, api: release.api, downloads: release.downloads });
  updater.start("3.2.1", 1000);
  for (const end = Date.now() + 15_000; Date.now() < end && !["restarting", "failed"].includes(updater.job?.phase ?? ""); ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(updater.job?.phase, "restarting", updater.job?.error ?? "");
  assert.deepEqual(calls, ["drainStart", "restart"], "no helper, and no server started by Bloks itself");
  assert.equal(pointerOf(home), "3.2.1", "switched before stopping, for systemd's start to find");
  const trial = readTrial(home)!;
  assert.deepEqual(trial.from, { version: "3.2.0", pointer: null });
  assert.equal(trial.to, "3.2.1");
  assert.equal(trial.tries, 0);
  assert.equal(trial.unit, "bloks.service");
  const record = readRecord(dataDir)!;
  assert.equal(record.pending, true);
  assert.equal(record.manager, "systemd");
  assert.equal(readFileSync(join(home, "versions", TRIAL_FILE), "utf8").includes("BLOKS_"), false, "no environment written down");
  assert.equal(updater.status().install.via, "manager");
});
