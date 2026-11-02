// Updating bloks-server from the app (server/server-update.ts; GitHub 396).
//
// The rules: only a tarball install started by bloks-server, with nothing
// else that starts it, updates itself, and every other install is told
// the steps; only GitHub's latest stable release, and only a download
// that matches the checksum the release publishes; the new version is
// unpacked beside the old one and switched to in one step; and a version
// that does not come up is stopped, and the old one starts again.
//
// Everything here runs in temp folders on free ports: a fake release on
// loopback, fake installs whose servers only answer /api/health, and the
// real bin/bloks-server.mjs in front of them, so the hand over between
// versions is the one a real start takes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { allows, NEVER } from "../server/agent-cli.ts";
import {
  checksumFor,
  chosenRoot,
  downloadVerified,
  finishUpdate,
  installOf,
  isNewer,
  manualSteps,
  nodeSatisfies,
  pointerOf,
  pointTo,
  processDeps,
  readRecord,
  releaseFrom,
  ServerUpdater,
  tarballName,
  unpackBeside,
  UpdateError,
  type InstallFacts,
  type UpdatePlan,
  type UpdaterHooks,
} from "../server/server-update.ts";

const LAUNCHER = fileURLToPath(new URL("../bin/bloks-server.mjs", import.meta.url));

function scratch(t: { after: (fn: () => void) => void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bloks-update-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── versions ───────────────────────────────────────────────────────────

test("versions compare as numbers, and only stable ones count", () => {
  assert.equal(isNewer("3.0.14", "3.0.13"), true);
  assert.equal(isNewer("3.0.10", "3.0.9"), true);
  assert.equal(isNewer("v3.1.0", "3.0.99"), true);
  assert.equal(isNewer("3.0.13", "3.0.13"), false);
  assert.equal(isNewer("3.0.12", "3.0.13"), false);
  assert.equal(isNewer("3.0.14-beta.1", "3.0.13"), false);
  assert.equal(isNewer("", "3.0.13"), false);
  assert.equal(nodeSatisfies(">=22.6", "22.23.2"), true);
  assert.equal(nodeSatisfies(">=22.6", "22.5.9"), false);
  assert.equal(nodeSatisfies(">=24", "22.23.2"), false);
  assert.equal(nodeSatisfies("^22", "18.0.0"), true, "a range it does not read is not its to refuse");
});

// ── how it was installed ───────────────────────────────────────────────

const HOME = "/opt/bloks-server";

function facts(over: Partial<InstallFacts> & { env?: NodeJS.ProcessEnv } = {}): InstallFacts {
  return {
    platform: "linux",
    desktop: false,
    hosted: false,
    codeRoot: HOME,
    container: false,
    cgroup: "/user.slice/user-1000.slice/session-3.scope",
    exists: (path) => path === `${HOME}/versions`,
    writable: () => true,
    packageOf: () => ({ name: "bloks-server", version: "3.0.14" }),
    ...over,
    env: { BLOKS_SERVER_ROOT: HOME, BLOKS_SERVER_HOME: HOME, ...over.env },
  };
}

test("only a tarball install bloks-server started, with nothing else that runs it, updates itself", () => {
  const self = installOf(facts());
  assert.equal(self.kind, "self");
  assert.equal(self.canInstall, true);
  assert.equal(self.home, HOME);
  // a version an update put beside it, handed over to from the install folder
  const beside = installOf(facts({ codeRoot: `${HOME}/versions/3.0.15`, env: { BLOKS_SERVER_ROOT: `${HOME}/versions/3.0.15` } }));
  assert.equal(beside.kind, "self");
  assert.equal(beside.home, HOME);
  // tmux, screen, an ssh login or a desktop terminal: a scope, not a service
  for (const cgroup of [
    "/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope",
    "/user.slice/user-1000.slice/user@1000.service/tmux-spawn-2.scope",
    null,
  ]) {
    assert.equal(installOf(facts({ cgroup })).kind, "self", String(cgroup));
  }
  assert.equal(installOf(facts({ platform: "darwin", cgroup: null, env: { XPC_SERVICE_NAME: "0" } })).kind, "self", "Terminal");
  assert.equal(installOf(facts({ platform: "darwin", cgroup: null, env: { XPC_SERVICE_NAME: "application.com.googlecode.iterm2.1" } })).kind, "self");
});

test("every other install is told why, and never offered the install", () => {
  const cases: Array<[string, InstallFacts, string, string?]> = [
    ["desktop", facts({ desktop: true }), "desktop"],
    ["hosted", facts({ hosted: true }), "hosted"],
    ["turned off", facts({ env: { BLOKS_SERVER_UPDATES: "off" } }), "disabled"],
    ["not started by bloks-server", facts({ env: { BLOKS_SERVER_ROOT: "" } }), "unknown"],
    ["told another folder than its code's", facts({ env: { BLOKS_SERVER_ROOT: "/elsewhere" } }), "unknown"],
    ["not the release's package", facts({ packageOf: () => ({ name: "bloks" }) }), "unknown"],
    ["a version folder outside the install's versions", facts({ codeRoot: "/tmp/3.0.15", env: { BLOKS_SERVER_ROOT: "/tmp/3.0.15" } }), "unknown"],
    ["a source checkout", facts({ exists: (path) => path === `${HOME}/server/index.ts` }), "checkout"],
    ["a container", facts({ container: true }), "container"],
    ["Windows", facts({ platform: "win32" }), "windows"],
    ["systemd", facts({ cgroup: "/system.slice/bloks-server.service" }), "service", "systemd"],
    ["systemd, the person's own", facts({ cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/bloks.service" }), "service", "systemd"],
    ["launchd", facts({ platform: "darwin", cgroup: null, env: { XPC_SERVICE_NAME: "dev.bloks.server" } }), "service", "launchd"],
    ["pm2", facts({ env: { pm_id: "0", name: "bloks" } }), "service", "pm2"],
    ["supervisord", facts({ env: { SUPERVISOR_ENABLED: "1", SUPERVISOR_PROCESS_NAME: "bloks" } }), "service", "supervisord"],
    ["a folder it cannot write", facts({ writable: () => false }), "readonly"],
    ["a versions folder it cannot write", facts({ writable: (path) => path === HOME }), "readonly"],
  ];
  for (const [what, given, kind, manager] of cases) {
    const install = installOf(given);
    assert.equal(install.kind, kind, what);
    assert.equal(install.canInstall, false, what);
    assert.ok(install.why.length > 20, `${what} says why`);
    if (manager) assert.equal(install.manager, manager, what);
  }
  // and what each is told to do instead
  const steps = (given: InstallFacts) => manualSteps(installOf(given), { version: "3.0.15", platform: "linux" }).join("\n");
  assert.match(steps(facts({ cgroup: "/system.slice/bloks-server.service" })), /sha256sum -c bloks-server-3\.0\.15\.tar\.gz\.sha256[\s\S]*sudo systemctl restart bloks-server\.service/);
  assert.match(steps(facts({ cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/bloks.service" })), /systemctl --user restart bloks\.service/);
  assert.match(steps(facts({ container: true })), /docker build[\s\S]*docker run/);
  assert.match(steps(facts({ exists: (path) => path === `${HOME}/server/index.ts` })), /git pull/);
  assert.equal(steps(facts({ desktop: true })), "", "the app's own server is the app's to update");
  assert.equal(steps(facts({ hosted: true })), "");
});

test("an agent can never reach it", () => {
  assert.ok(NEVER.includes("/api/server-update"));
  for (const [method, path] of [["GET", "/api/server-update"], ["POST", "/api/server-update/check"], ["POST", "/api/server-update/install"], ["DELETE", "/api/server-update/install"]]) {
    assert.equal(allows("some-agent", method, path).ok, false, `${method} ${path}`);
  }
});

// ── the release ────────────────────────────────────────────────────────

const SUM = "a".repeat(64);

function githubRelease(version: string, o: { checksum?: boolean; digest?: string; draft?: boolean } = {}) {
  const name = tarballName(version);
  return {
    tag_name: `v${version}`,
    draft: o.draft ?? false,
    prerelease: false,
    body: `What changed in ${version}.`,
    html_url: `https://github.com/hamedgitty/bloks/releases/tag/v${version}`,
    published_at: "2026-10-25T00:00:00Z",
    assets: [
      { name: `Bloks-${version}.dmg`, size: 1 },
      { name, size: 10, browser_download_url: "https://evil.example.com/x.tar.gz", ...(o.digest ? { digest: `sha256:${o.digest}` } : {}) },
      ...(o.checksum === false ? [] : [{ name: `${name}.sha256`, size: 90 }]),
    ],
  };
}

test("a release is read for its server, fetched from the official download path only", () => {
  const release = releaseFrom(githubRelease("3.0.15", { digest: SUM }), "https://github.com/hamedgitty/bloks/releases/download");
  assert.equal(release.version, "3.0.15");
  assert.equal(release.tarball.url, "https://github.com/hamedgitty/bloks/releases/download/v3.0.15/bloks-server-3.0.15.tar.gz");
  assert.equal(release.checksum?.url, "https://github.com/hamedgitty/bloks/releases/download/v3.0.15/bloks-server-3.0.15.tar.gz.sha256");
  assert.equal(release.tarball.digest, SUM);
  assert.equal(release.notes, "What changed in 3.0.15.");
  assert.equal(releaseFrom(githubRelease("3.0.13", { checksum: false })).checksum, undefined, "a release from before checksums has none");
  assert.throws(() => releaseFrom(githubRelease("3.0.15", { draft: true })), UpdateError);
  assert.throws(() => releaseFrom({ ...githubRelease("3.0.15"), assets: [] }), /no server download/);
  assert.throws(() => releaseFrom({ ...githubRelease("3.0.15"), tag_name: "nightly" }), UpdateError);
});

test("a checksum file is read the way sha256sum writes it", () => {
  const name = "bloks-server-3.0.15.tar.gz";
  assert.equal(checksumFor(`${SUM}  ${name}\n`, name), SUM);
  assert.equal(checksumFor(`${"b".repeat(64)}  other.tar.gz\n${SUM} *${name}\n`, name), SUM);
  assert.equal(checksumFor(`${SUM.toUpperCase()}\n`, name), SUM, "one bare hash is the file's");
  assert.equal(checksumFor(`${"b".repeat(64)}  other.tar.gz\n`, name), null);
  assert.equal(checksumFor("not a checksum", name), null);
});

/** A release on loopback: GitHub's answer about the latest, its files
 * under /download, and a count of what was asked for. */
async function fakeReleases(t: { after: (fn: () => unknown) => void }) {
  const files = new Map<string, Buffer>();
  const asked: string[] = [];
  let latest: unknown = null;
  const server: Server = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.url === "/releases/latest") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(latest));
    }
    const file = files.get(req.url ?? "");
    if (!file) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("content-length", String(file.length));
    res.end(file);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    api: `${base}/releases/latest`,
    downloads: `${base}/download`,
    asked,
    /** Publishes `tarball` as `version`, with a checksum of `sumOf` (the
     * tarball itself unless a test says otherwise). */
    publish(version: string, tarball: Buffer, o: { sumOf?: Buffer; checksum?: boolean; digest?: string } = {}) {
      const name = tarballName(version);
      files.set(`/download/v${version}/${name}`, tarball);
      const sum = createHash("sha256").update(o.sumOf ?? tarball).digest("hex");
      if (o.checksum !== false) files.set(`/download/v${version}/${name}.sha256`, Buffer.from(`${sum}  ${name}\n`));
      latest = githubRelease(version, { checksum: o.checksum, digest: o.digest });
    },
  };
}

/** A bloks-server folder as the release packs it, with a server that only
 * answers /api/health (and /api/relay, which a start asks), or one that
 * stops while starting. The launcher is the real one. */
function fakeServerFolder(dir: string, version: string, o: { crash?: boolean; engines?: string } = {}) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "dist-server"), { recursive: true });
  copyFileSync(LAUNCHER, join(dir, "bin", "bloks-server.mjs"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "bloks-server", version, type: "module", engines: { node: o.engines ?? ">=22.6" } }),
  );
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

/** The release's tarball of a fake server folder. */
function fakeTarball(work: string, version: string, o: { crash?: boolean; engines?: string; extra?: string } = {}): Buffer {
  const stage = mkdtempSync(join(work, "pack-"));
  fakeServerFolder(join(stage, "bloks-server"), version, o);
  if (o.extra) writeFileSync(join(stage, o.extra), "outside");
  const file = join(stage, "out.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", stage, "bloks-server", ...(o.extra ? [o.extra] : [])]);
  const bytes = readFileSync(file);
  rmSync(stage, { recursive: true, force: true });
  return bytes;
}

test("a download that matches the published checksum is kept; anything else is thrown away", async (t) => {
  const work = scratch(t, "download");
  const releases = await fakeReleases(t);
  const good = fakeTarball(work, "3.0.15");
  const into = join(work, "incoming");

  releases.publish("3.0.15", good);
  const release = releaseFrom(await (await fetch(releases.api)).json(), releases.downloads);
  const file = await downloadVerified(release, into);
  assert.deepEqual(readFileSync(file), good);

  // the file changed after the checksum was made
  rmSync(into, { recursive: true, force: true });
  releases.publish("3.0.15", Buffer.concat([good, Buffer.from("tampered")]), { sumOf: good });
  const swapped = releaseFrom(await (await fetch(releases.api)).json(), releases.downloads);
  await assert.rejects(downloadVerified(swapped, into), /doesn't match the checksum/);
  assert.deepEqual(existsSync(into) ? readdirSync(into) : [], [], "a rejected download is not left behind");

  // GitHub's own record of the file and the published checksum disagree
  releases.publish("3.0.15", good, { digest: "c".repeat(64) });
  const disagreeing = releaseFrom(await (await fetch(releases.api)).json(), releases.downloads);
  const before = releases.asked.length;
  await assert.rejects(downloadVerified(disagreeing, into), /disagree/);
  assert.ok(!releases.asked.slice(before).some((url) => url.endsWith(".tar.gz")), "nothing was downloaded");

  // no checksum at all: refused before anything is downloaded
  releases.publish("3.0.15", good, { checksum: false });
  const unchecked = releaseFrom(await (await fetch(releases.api)).json(), releases.downloads);
  const asked = releases.asked.length;
  await assert.rejects(downloadVerified(unchecked, into), /publishes no checksum/);
  assert.equal(releases.asked.length, asked, "nothing was asked for");
});

// ── beside the version that runs ───────────────────────────────────────

test("a version is unpacked beside the one that runs, and only if it is what it says", (t) => {
  const work = scratch(t, "unpack");
  const home = join(work, "bloks-server");
  fakeServerFolder(home, "3.0.14");
  const write = (name: string, bytes: Buffer) => {
    const file = join(work, name);
    writeFileSync(file, bytes);
    return file;
  };

  const target = unpackBeside(home, write("good.tar.gz", fakeTarball(work, "3.0.15")), "3.0.15");
  assert.equal(target, join(home, "versions", "3.0.15"));
  assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version, "3.0.15");
  assert.equal(pointerOf(home), null, "unpacking switches nothing");

  assert.throws(() => unpackBeside(home, write("liar.tar.gz", fakeTarball(work, "3.0.16")), "3.0.17"), /is not bloks-server 3\.0\.17/);
  assert.throws(() => unpackBeside(home, write("outside.tar.gz", fakeTarball(work, "3.0.18", { extra: "stray.txt" })), "3.0.18"), /outside the server's folder/);
  assert.throws(() => unpackBeside(home, write("node.tar.gz", fakeTarball(work, "3.0.19", { engines: ">=99" })), "3.0.19"), /needs Node 99/);
  assert.deepEqual(readdirSync(join(home, "versions")), ["3.0.15"], "nothing refused was left, half unpacked or whole");
});

test("switching versions is one rename: a start at any moment finds one version or the other", async (t) => {
  const work = scratch(t, "switch");
  const home = join(work, "bloks-server");
  fakeServerFolder(home, "3.0.14");
  for (const version of ["3.0.15", "3.0.16"]) fakeServerFolder(join(home, "versions", version), version);
  pointTo(home, "3.0.15");
  assert.equal(readlinkSync(join(home, "versions", "current")), "3.0.15");

  // Another process looks as fast as it can while the link is switched
  // back and forth. It must never find it missing, never find anything
  // but a link, and read one version or the other. (macOS can fail a
  // readlink racing a rename with EINVAL while the name itself is there
  // all along, which is why bin/bloks-server.mjs reads it twice.)
  const reader = join(work, "reader.mjs");
  writeFileSync(
    reader,
    `import { existsSync, lstatSync, readlinkSync } from "node:fs";
const link = process.argv[2];
let reads = 0, misses = 0, odd = 0;
const until = Date.now() + 1500;
const read = () => {
  for (let i = 0; ; i++) {
    try { return readlinkSync(link); } catch (e) { if (e.code !== "EINVAL" || i >= 20) throw e; }
  }
};
while (Date.now() < until && !existsSync(process.argv[3])) {
  try {
    if (!lstatSync(link).isSymbolicLink()) { odd++; continue; }
    const to = read();
    reads++;
    if (to !== "3.0.15" && to !== "3.0.16") odd++;
  } catch { misses++; }
}
console.log(JSON.stringify({ reads, misses, odd }));
`,
  );
  const stop = join(work, "stop");
  const child = spawn(process.execPath, [reader, join(home, "versions", "current"), stop], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const ended = new Promise((r) => child.once("exit", r));
  await new Promise((r) => setTimeout(r, 100));
  for (let i = 0; i < 400; i++) pointTo(home, i % 2 ? "3.0.15" : "3.0.16");
  writeFileSync(stop, "");
  await ended;
  const seen = JSON.parse(out);
  assert.ok(seen.reads > 0, "the reader read nothing");
  assert.equal(seen.misses, 0, "the link was missing while it switched");
  assert.equal(seen.odd, 0);
  assert.deepEqual(
    readdirSync(join(home, "versions")).filter((name) => name.startsWith(".")),
    [],
    "no temporary link was left behind",
  );

  // which runs: the newer of the link's and the folder's own
  pointTo(home, "3.0.16");
  assert.equal(chosenRoot(home), join(home, "versions", "3.0.16"));
  pointTo(home, null);
  assert.equal(chosenRoot(home), home);
  // a newer release unpacked over the folder by hand wins over the link
  pointTo(home, "3.0.15");
  fakeServerFolder(home, "3.0.20");
  assert.equal(chosenRoot(home), home);
});

// ── the hand over, with real processes ─────────────────────────────────

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

/** An install the way a person has one: the release unpacked into a
 * folder, started with bloks-server from it, on its own port and data
 * folder. Returns what the helper needs to take it over. */
async function installed(t: { after: (fn: () => unknown) => void }, name: string) {
  const work = scratch(t, name);
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.0.14");
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: work,
    BLOKS_PORT: String(port),
    BLOKS_DATA_DIR: dataDir,
  };
  const started: number[] = [];
  t.after(async () => {
    // whatever is still answering, whichever version
    const now = await health(port);
    for (const pid of [...started, now?.pid ?? 0]) {
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  const old = spawn(process.execPath, [join(home, "bin", "bloks-server.mjs")], { env, stdio: "ignore" });
  started.push(old.pid!);
  for (let i = 0; i < 100 && !(await health(port)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await health(port))?.version, "3.0.14");
  const plan = (to: string): UpdatePlan => ({
    home,
    dataDir,
    port,
    oldPid: old.pid!,
    from: { version: "3.0.14", pointer: pointerOf(home) },
    to: { version: to, pointer: to },
    launcher: join(home, "bin", "bloks-server.mjs"),
    cwd: work,
    log: join(dataDir, "server.log"),
    startedAt: Date.now(),
  });
  const deps = processDeps(env);
  const tracked = { ...deps, healthyWithinMs: 15_000, say: () => {}, start: (p: UpdatePlan) => {
    const s = deps.start(p);
    started.push(s.pid);
    return s;
  } };
  return { home, dataDir, port, old, plan, deps: tracked };
}

test("the helper switches to the new version and sees it answer, keeping the data folder", { timeout: 90_000 }, async (t) => {
  const at = await installed(t, "finish");
  writeFileSync(join(at.dataDir, "keep.json"), "{}");
  fakeServerFolder(join(at.home, "versions", "3.0.15"), "3.0.15");
  fakeServerFolder(join(at.home, "versions", "3.0.10"), "3.0.10");
  at.old.kill("SIGTERM");

  const record = await finishUpdate(at.plan("3.0.15"), at.deps);
  assert.equal(record.ok, true, record.error ?? "");
  assert.equal(record.running, "3.0.15");
  const now = await health(at.port);
  assert.equal(now?.version, "3.0.15");
  assert.notEqual(now?.pid, at.old.pid);
  assert.equal(pointerOf(at.home), "3.0.15");
  assert.deepEqual(readRecord(at.dataDir), record, "written down for the app to say");
  assert.ok(existsSync(join(at.dataDir, "keep.json")), "the data folder was touched");
  assert.deepEqual(readdirSync(join(at.home, "versions")).sort(), ["3.0.15", "current"], "older versions are cleared");
});

test("a version that does not start is stopped, and the old one starts again", { timeout: 90_000 }, async (t) => {
  const at = await installed(t, "rollback");
  fakeServerFolder(join(at.home, "versions", "3.0.15"), "3.0.15", { crash: true });
  at.old.kill("SIGTERM");

  const record = await finishUpdate(at.plan("3.0.15"), at.deps);
  assert.equal(record.ok, false);
  assert.equal(record.rolledBack, true);
  assert.equal(record.running, "3.0.14");
  assert.match(record.error ?? "", /3\.0\.15 stopped while starting/);
  assert.equal((await health(at.port))?.version, "3.0.14");
  assert.equal(pointerOf(at.home), null, "switched back to the folder's own version");
  assert.match(readFileSync(join(at.dataDir, "server.log"), "utf8"), /this version does not start/, "its reason is in the log");
});

// ── the update, from the running server ────────────────────────────────

function hooks(over: Partial<UpdaterHooks> = {}) {
  const calls: string[] = [];
  let handed: { planFile: string; plan: UpdatePlan; env: Record<string, string> } | null = null;
  const h: UpdaterHooks = {
    busy: () => null,
    drainStart: () => void calls.push("drainStart"),
    drainStatus: () => ({ done: true, running: 0 }),
    drainEnd: () => void calls.push("drainEnd"),
    handOver: (planFile, plan, env) => {
      calls.push("handOver");
      handed = { planFile, plan, env };
    },
    restart: () => void calls.push("restart"),
    ...over,
  };
  return { h, calls, handed: () => handed };
}

async function until(check: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out");
}

test("the running server checks, downloads, unpacks, drains and hands over, with nothing of the old version's own", async (t) => {
  const work = scratch(t, "job");
  const home = join(work, "bloks-server");
  const dataDir = join(work, "data");
  mkdirSync(dataDir);
  fakeServerFolder(home, "3.0.14");
  const releases = await fakeReleases(t);
  releases.publish("3.0.15", fakeTarball(work, "3.0.15"));
  const self = installOf(facts({ codeRoot: home, env: { BLOKS_SERVER_ROOT: home, BLOKS_SERVER_HOME: home } }));
  const { h, calls, handed } = hooks();
  const updater = new ServerUpdater({
    version: "3.0.14",
    install: { ...self, home },
    dataDir,
    port: 1,
    hooks: h,
    api: releases.api,
    downloads: releases.downloads,
    env: { BLOKS_SERVER_HOME: home, BLOKS_SERVER_ROOT: home, BLOKS_SERVER_STATIC: "1", BLOKS_STATIC_DIR: join(home, "dist"), BLOKS_PORT: "1", SOME_KEY: "kept" },
  });

  const check = await updater.checkNow();
  assert.equal(check.newer, true);
  assert.equal(check.latest?.version, "3.0.15");
  assert.equal(check.latest?.notes, "What changed in 3.0.15.");
  assert.throws(() => updater.start("3.0.14", 1000), /already runs 3\.0\.14/);

  updater.start("3.0.15", 1000);
  await until(() => updater.job?.phase === "restarting" || updater.job?.phase === "failed");
  assert.equal(updater.job?.phase, "restarting", updater.job?.error ?? "");
  assert.deepEqual(calls, ["drainStart", "handOver"]);
  const given = handed()!;
  assert.ok(existsSync(join(home, "versions", "3.0.15", "bin", "bloks-server.mjs")));
  assert.equal(pointerOf(home), null, "the switch is the helper's, after this one stops");
  assert.deepEqual(given.plan.to, { version: "3.0.15", pointer: "3.0.15" });
  assert.equal(given.plan.launcher, join(home, "bin", "bloks-server.mjs"));
  assert.equal(given.env.SOME_KEY, "kept");
  for (const name of ["BLOKS_SERVER_HOME", "BLOKS_SERVER_ROOT", "BLOKS_SERVER_STATIC", "BLOKS_STATIC_DIR"]) {
    assert.equal(given.env[name], undefined, `${name} went to the next version`);
  }
  assert.equal(given.env.BLOKS_DATA_DIR, dataDir);
  const onDisk = readFileSync(given.planFile, "utf8");
  assert.equal(onDisk.includes("SOME_KEY"), false, "the environment was written down");
  assert.throws(() => updater.start("3.0.15", 1000), /already under way/);
});

test("a download that fails its checksum stops the update before anything is drained or switched", async (t) => {
  const work = scratch(t, "job-bad");
  const home = join(work, "bloks-server");
  fakeServerFolder(home, "3.0.14");
  const releases = await fakeReleases(t);
  const good = fakeTarball(work, "3.0.15");
  releases.publish("3.0.15", Buffer.concat([good, Buffer.from("x")]), { sumOf: good });
  const { h, calls } = hooks();
  const updater = new ServerUpdater({
    version: "3.0.14",
    install: { kind: "self", canInstall: true, home, why: "" },
    dataDir: work,
    port: 1,
    hooks: h,
    api: releases.api,
    downloads: releases.downloads,
  });
  updater.start("3.0.15", 1000);
  await until(() => updater.job?.phase === "failed");
  assert.match(updater.job?.error ?? "", /doesn't match the checksum/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(home, "versions", "3.0.15")), false);
});

test("an update waiting on running work can be called off, and the drain with it", async (t) => {
  const work = scratch(t, "job-cancel");
  const home = join(work, "bloks-server");
  fakeServerFolder(home, "3.0.14");
  const releases = await fakeReleases(t);
  releases.publish("3.0.15", fakeTarball(work, "3.0.15"));
  const { h, calls } = hooks({ drainStatus: () => ({ done: false, running: 2 }) });
  const updater = new ServerUpdater({
    version: "3.0.14",
    install: { kind: "self", canInstall: true, home, why: "" },
    dataDir: work,
    port: 1,
    hooks: h,
    api: releases.api,
    downloads: releases.downloads,
  });
  updater.start("3.0.15", 1000);
  await until(() => updater.job?.phase === "draining" && updater.job.running === 2);
  updater.cancel();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(updater.job?.phase, "cancelled");
  assert.deepEqual(calls, ["drainStart", "drainEnd"]);
});

test("an install that does not update itself refuses to start one, and says why", () => {
  const updater = new ServerUpdater({
    version: "3.0.14",
    install: installOf(facts({ cgroup: "/system.slice/bloks-server.service" })),
    dataDir: tmpdir(),
    port: 1,
    hooks: hooks().h,
  });
  assert.throws(() => updater.start("3.0.15", 1000), /systemd runs this server/);
  assert.equal(updater.job, null);
});
