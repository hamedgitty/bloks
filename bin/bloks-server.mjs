#!/usr/bin/env node
// Bloks on a computer that never sleeps.
//
// The same server the desktop app runs, without the desktop: for a small
// rented server, a Mac mini in a cupboard, a home server. It listens on
// loopback only, exactly as it does inside the app. Everything reaches it
// through Bloks Cloud, which it connects out to: the phone, the desktop app
// on your laptop, and the people you share rooms with. No port is opened
// and nothing new is exposed to the internet.
//
// Or it is reached your own way, with no Bloks Cloud at all: behind your
// reverse proxy, tunnel or VPN, at the address BLOKS_PUBLIC_URL gives,
// with BLOKS_CLOUD=off to send nothing to bloks.dev (server/self-host.ts,
// docs/SELF_HOSTING.md).
//
//   bloks-server                 run it (keep it running: systemd, Docker,
//                                tmux, whatever the machine already uses)
//   bloks-server activate KEY    turn on Bloks Cloud with a licence key
//   bloks-server pair            print a link that pairs a phone or the
//                                desktop app, from anywhere, or at the
//                                address BLOKS_PUBLIC_URL gives
//   bloks-server status          is it up, and is Cloud connected
//   bloks-server drain [--minutes 20]
//                                before restarting it: start nothing new,
//                                let what is running finish, and return
//                                once nothing is (or the minutes are up)
//   bloks-server drain cancel    never mind, start things again
//   bloks-server backup [--undo] [--encrypt]
//                                write a backup of ~/.bloks to ~/.bloks-backups.
//                                --undo adds the Undo history; --encrypt seals
//                                it with a passphrase, and only a sealed backup
//                                holds your saved keys
//   bloks-server restore FILE    put a backup back. The workspace it replaces is
//                                backed up and moved aside first, never deleted
//   bloks-server update [--check]
//                                install the latest release beside this one,
//                                switch to it and restart (through systemd
//                                when it runs this), or go back if it does
//                                not start; --check only says if there is
//                                one. The app's About page does the same
//   bloks-server import [TOOL] --dry-run [--json] [--transfer FILE]
//                                what Bring your setup would find from Claude
//                                Code, Codex, Cursor, OpenClaw, Hermes or
//                                OpenBot on this machine (and in an OpenBot
//                                transfer file), and what each becomes. Reads
//                                only; the import itself is chosen in the app
//   bloks-server stop            stop the running server
//   bloks-server export-runs [--format openai|sharegpt|trajectory] [--dry-run]
//                                write agents' runs to a file on this computer
//                                to train a model on, cleaned of keys and, by
//                                default, of emails, phone numbers, home
//                                folder paths and people's names; --help for
//                                the rest. Works with Bloks stopped too
//
// And for scripts, CI and a terminal (server/scripting-cli.ts):
//
//   bloks-server run AGENT "TASK" [--json] [--export DIR] [--timeout 30m]
//                                give an agent a job, wait until it and any
//                                teammate it handed work to are done, and
//                                print the answer
//   bloks-server team apply FILE [--dry-run]
//                                make or update a room and its agents from
//                                a team file, changing only what differs
//   bloks-server chat AGENT      talk to an agent in this terminal
//   bloks-server token --server URL --code 123456
//                                trade a pairing code for a device token,
//                                for the three above on another computer
//
// The rest talk to the running server, so run them in a second shell on
// the same machine. backup and restore work with Bloks stopped too.
// A passphrase is asked for in the terminal, or read from
// BLOKS_BACKUP_PASSPHRASE where nobody is there to type it.
//
// An update from the app unpacks the new version under versions/ in this
// folder and points versions/current at it (server/server-update.ts).
// This file, run from here, then hands over to that version, so the way
// it was started before keeps working. A newer release unpacked over this
// folder by hand wins over an older one an update put there.
//
// Under systemd the update leaves a trial beside the link, and the start
// systemd makes next is this file's: the new version gets two minutes to
// end the trial, and a start that finds it already tried switches back
// (trialStart below). This folder may be root's; versions/ is the only
// part the account Bloks runs as needs to write.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Whether one stable version is later than another. */
function newer(a, b) {
  const parts = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The version an update put beside this one, to hand over to: only from
 * the folder the release was unpacked into (a version handed over to
 * never looks again), only inside its versions/ folder, and only when it
 * is newer than this folder's own. */
function updatedCopy() {
  if (process.env.BLOKS_SERVER_HOME) return null;
  try {
    const read = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const own = read(root);
    if (own.name !== "bloks-server") return null;
    // twice if need be: macOS can fail a read that races the rename
    // switching the link, though the link is there throughout
    let there;
    for (let tries = 0; !there; tries++) {
      try {
        there = realpathSync(join(root, "versions", "current"));
      } catch (e) {
        if (e.code !== "EINVAL" || tries >= 5) throw e;
      }
    }
    if (!there.startsWith(realpathSync(join(root, "versions")) + sep)) return null;
    if (!trusted(join(root, "versions"))) return null;
    const theirs = read(there);
    const entry = join(there, "bin", "bloks-server.mjs");
    return theirs.name === "bloks-server" && newer(theirs.version, own.version) && existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}
/** Whether code in versions/ may be run as this account: a folder only
 * this account or root can change. Run as root, only root's; never one
 * anybody may write. Anything else could hand this account code another
 * one put there. */
function trusted(dir) {
  if (typeof process.getuid !== "function") return true;
  try {
    const st = statSync(dir);
    const me = process.getuid();
    if (st.mode & 0o002) return false;
    if (me === 0) return st.uid === 0 && !(st.mode & 0o020);
    return st.uid === me || st.uid === 0;
  } catch {
    return false;
  }
}
/** The data folder, the way the server decides it (server/config.ts
 * dataDirFrom): BLOKS_DATA_DIR when set, else ~/.bloks. */
function dataDir() {
  const said = process.env.BLOKS_DATA_DIR?.trim();
  if (!said) return join(homedir(), ".bloks");
  if (said === "~") return homedir();
  return said.startsWith("~/") ? join(homedir(), said.slice(2)) : resolve(said);
}
/** Where the server is: BLOKS_PORT, then the port the running server
 * wrote down, then one chosen in config.json, then the usual one. */
function knownPort() {
  const read = (file, pick) => {
    try {
      return pick(readFileSync(join(dataDir(), file), "utf8"));
    } catch {
      return null;
    }
  };
  const chosen = Number(process.env.BLOKS_PORT) || read("config.json", (text) => Number(JSON.parse(text).port));
  // starting listens where you chose; everything else talks to wherever
  // the running server said it is
  if (command === "start") return chosen || 8799;
  return chosen || read("port", (text) => Number(text.trim())) || 8799;
}
const [command = "start", ...args] = process.argv.slice(2);
const PORT = knownPort();
const BASE = `http://127.0.0.1:${PORT}`;
/** The key the running server made at its start, which says a request is
 * the owner's own command and not a stranger a tunnel delivered to
 * loopback (server/local-key.ts). Read each time: a restart makes a new
 * one. Nothing when it cannot be read, and the server then says so. */
function ownKey() {
  try {
    const key = readFileSync(join(dataDir(), "local.key"), "utf8").trim();
    return key ? { "x-bloks-local": key } : {};
  } catch {
    return {};
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...ownKey() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(`Bloks is not running on this machine (nothing answered on port ${PORT}). Start it with: bloks-server`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(json.error || `Bloks answered ${res.status}`);
  return json;
}

/** Whether a Bloks server answers, without failing when none does. */
async function answering() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    return res.ok && (await res.json())?.app === "bloks";
  } catch {
    return false;
  }
}

/** The server's own backup code, for when no server is running: its
 * source in a checkout, the compiled copy in the download. */
async function backupCode() {
  const source = join(root, "server", "backup.ts");
  return import(pathToFileURL(existsSync(source) ? source : join(root, "dist-server", "backup.js")).href);
}

/** export-runs, which reads the data folder itself, like backup. */
async function exportRuns() {
  const source = join(root, "server", "run-export-cli.ts");
  const code = await import(pathToFileURL(existsSync(source) ? source : join(root, "dist-server", "run-export-cli.js")).href);
  const exitCode = await code.exportRunsMain(args, { stdout: process.stdout, stderr: process.stderr, env: process.env, dataDir: dataDir() });
  process.stdout.write("", () => process.exit(exitCode));
}

/** run, team, chat and token, which live with the server's code so the
 * tests read them as they read the rest: its source in a checkout, the
 * compiled copy in the download. */
async function scripting(name) {
  const source = join(root, "server", "scripting-cli.ts");
  const code = await import(pathToFileURL(existsSync(source) ? source : join(root, "dist-server", "scripting-cli.js")).href);
  const exitCode = await code.main(name, args, {
    base: BASE,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      return () => process.off("SIGINT", handler);
    },
  });
  // what was written goes out before the process does
  process.stdout.write("", () => process.exit(exitCode));
}

/** Typed without showing it, the way a password prompt is. */
function hidden(prompt) {
  return new Promise((done) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let text = "";
    const take = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", take);
          process.stdout.write("\n");
          return done(text);
        }
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        text = char === "\u007f" || char === "\b" ? text.slice(0, -1) : text + char;
      }
    };
    stdin.on("data", take);
  });
}

async function passphrase(prompt, { twice = false } = {}) {
  if (process.env.BLOKS_BACKUP_PASSPHRASE) return process.env.BLOKS_BACKUP_PASSPHRASE;
  if (!process.stdin.isTTY) fail("This needs a passphrase. Run it in a terminal, or set BLOKS_BACKUP_PASSPHRASE.");
  const first = await hidden(prompt);
  if (twice && (await hidden("Once more, to be sure: ")) !== first) fail("The two passphrases differ, so nothing was written.");
  return first;
}

const sizeOf = (bytes) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;

/** A running server restores from its own backups folder, by name, so a
 * file from anywhere else is copied in first; it then shows in the list
 * like any other backup. */
function intoBackups(code, file, sealed) {
  const dir = code.backupsDirFor();
  if (dirname(file) === dir && code.isBackupName(basename(file))) return basename(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let name = basename(file);
  if (!code.isBackupName(name) || existsSync(join(dir, name))) {
    name = `bloks-backup-imported-${Date.now()}${sealed ? ".tar.gz.enc" : ".tar.gz"}`;
  }
  copyFileSync(file, join(dir, name));
  chmodSync(join(dir, name), 0o600);
  return name;
}

/** How the running server says it is reached (server/self-host.ts), or
 * null from a server too old to say, which is Bloks Cloud alone. */
async function reachOf() {
  try {
    const res = await fetch(`${BASE}/api/config`, { headers: ownKey() });
    return res.ok ? ((await res.json())?.deployment?.reach ?? null) : null;
  } catch {
    return null;
  }
}

async function status(waitMs = 0) {
  let relay = await call("GET", "/api/relay");
  // reached at an address of the owner's own (server/self-host.ts), with
  // or without Bloks Cloud beside it
  const reach = await reachOf();
  const own = reach?.direct === true ? (reach.publicUrls ?? []) : null;
  if (own) {
    console.log(own.length ? `Bloks is running, for your devices at ${own.join(", ")}.` : "Bloks is running, and listens beyond loopback for your paired devices.");
  }
  if (relay.cloud === "off") {
    console.log(own ? "Bloks Cloud is turned off here (BLOKS_CLOUD=off), so nothing goes to it." : "Bloks is running. Bloks Cloud is turned off here (BLOKS_CLOUD=off), and no address of your own is set, so nothing outside this machine can reach it.");
    if (!own) console.log("Give it one with BLOKS_PUBLIC_URL (see docs/SELF_HOSTING.md), then restart it.");
    return;
  }
  if (own && !relay.enabled) return;
  // just started: give the line to Cloud a moment before calling it down
  for (let waited = 0; relay.enabled && !relay.connected && waited < waitMs; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    relay = await call("GET", "/api/relay");
  }
  if (!relay.enabled) {
    console.log("Bloks is running. Bloks Cloud is off, so nothing outside this machine can reach it yet.");
    console.log("Turn it on with: bloks-server activate blok_live_...");
    return;
  }
  // Connected means the stream from Cloud is open. Working means replies
  // land too; a lossy line can have the first without the second, and a
  // status that says "connected" then is the one that sends people hunting.
  // An older server has no `delivering`, so only an explicit false counts.
  console.log(
    !relay.connected
      ? `Bloks is running. Bloks Cloud is on but not connected${relay.problem ? `: ${relay.problem}` : ""}.`
      : relay.delivering === false
        ? "Bloks is running and hears Bloks Cloud, but its replies are not getting through. Retrying."
        : "Bloks is running and connected to Bloks Cloud.",
  );
}

/** Where a trial is kept, beside versions/current
 * (server/server-update.ts TRIAL_FILE). Its shape never changes: this
 * file reads it as an older release unpacked it. */
const TRIAL = join(root, "versions", ".trial.json");
/** What a server stops with to be started again (EXIT_RESTART). */
const EXIT_RESTART = 75;

/** Points versions/current at `version`, or at nothing, in one rename. */
function pointBack(version) {
  const link = join(root, "versions", "current");
  if (!version) {
    try {
      unlinkSync(link);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return;
  }
  const temp = join(root, "versions", `.current-back-${process.pid}`);
  rmSync(temp, { force: true });
  symlinkSync(version, temp);
  renameSync(temp, link);
}

/** Writes what happened for the app to say, where the server keeps it. */
function recordTrial(trial, error) {
  const record = {
    from: trial.from?.version,
    to: trial.to,
    at: Date.now(),
    ok: false,
    rolledBack: true,
    error,
    log: trial.manager === "systemd" ? `journalctl ${trial.user ? "--user " : ""}-u ${trial.unit ?? "bloks"}` : `${trial.manager}'s log`,
    manager: trial.manager,
    ...(trial.unit ? { unit: trial.unit } : {}),
  };
  try {
    const file = join(dataDir(), "server-update.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch {
    /* the app says the version that answers, at least */
  }
}

/** Switches back to the version a trial came from, and says why. */
function goBack(trial, why) {
  const from = trial.from?.version ?? "the version before";
  console.error(`[bloks update] ${why} Going back to ${from}.`);
  try {
    pointBack(typeof trial.from?.pointer === "string" ? trial.from.pointer : null);
  } catch (e) {
    console.error(`[bloks update] switching back failed: ${e.message}`);
  }
  recordTrial(trial, why);
  rmSync(TRIAL, { force: true });
}

/**
 * A start under a trial: the first start of the version an update
 * switched to gets its window to end the trial, which that version does
 * once it has stayed up a moment; a start that finds the trial already
 * tried means the last one fell over, and goes back. Only the install
 * folder's own start does this, never a version handed over to.
 */
function trialStart() {
  if (command !== "start" || process.env.BLOKS_SERVER_HOME) return;
  let trial;
  try {
    trial = JSON.parse(readFileSync(TRIAL, "utf8"));
  } catch {
    return;
  }
  let pointer = null;
  try {
    pointer = readlinkSync(join(root, "versions", "current"));
  } catch {
    /* pointing nowhere */
  }
  // switched by hand since: nothing of the trial's to judge
  if (!trial || typeof trial.to !== "string" || pointer !== trial.to) {
    rmSync(TRIAL, { force: true });
    return;
  }
  if ((Number(trial.tries) || 0) >= 1) {
    goBack(trial, `Bloks ${trial.to} stopped while starting.`);
    return;
  }
  trial.tries = 1;
  try {
    writeFileSync(`${TRIAL}.tmp`, `${JSON.stringify(trial, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${TRIAL}.tmp`, TRIAL);
  } catch {
    // a trial that can't be counted can't be trusted to end: go back now
    goBack(trial, `Bloks ${trial.to} couldn't be tried, since its trial couldn't be written.`);
    return;
  }
  const within = Math.max(1_000, Math.min(Number(trial.withinMs) || 120_000, 30 * 60_000));
  setTimeout(() => {
    if (!existsSync(TRIAL)) return;
    goBack(trial, `Bloks ${trial.to} did not answer within ${Math.round(within / 1000)} seconds.`);
    // for the service manager to start the version switched back to
    process.exit(EXIT_RESTART);
  }, within).unref();
}

trialStart();
// From the folder the release was unpacked into, a newer version an
// update put beside it runs instead of this one; otherwise this one does.
const handOver = updatedCopy();
if (handOver) {
  process.env.BLOKS_SERVER_HOME = root;
  await import(pathToFileURL(handOver).href);
} else switch (command) {
  case "start": {
    // Loopback, unless whoever runs it says otherwise where it runs: a
    // server on a public machine must not be the one place Bloks listens
    // on the network by surprise. BLOKS_LISTEN=0.0.0.0 is for a container,
    // whose published port decides who reaches it, and even then nothing
    // but a paired device's token gets past /api/health
    // (server/self-host.ts).
    process.env.BLOKS_LOOPBACK_ONLY = "1";
    // and the owner's own commands here carry a key it makes at each start
    // (server/local-key.ts), since loopback alone is not the owner on a
    // machine that may have a tunnel or proxy pointed at it
    process.env.BLOKS_LOCAL_KEY = "1";
    process.env.BLOKS_PORT = String(PORT);
    // which folder this version is, and the folder updates go beside, so
    // the server can tell it was started here and may restart itself
    process.env.BLOKS_SERVER_HOME ||= root;
    process.env.BLOKS_SERVER_ROOT = root;
    const ui = join(root, "dist");
    if (!process.env.BLOKS_STATIC_DIR && existsSync(join(ui, "index.html"))) {
      process.env.BLOKS_STATIC_DIR = ui;
      // set here for this version's own page, so the next version is not
      // handed this one's
      process.env.BLOKS_SERVER_STATIC = "1";
    }
    // a checkout runs its source; the packaged download ships only the
    // compiled server, which is what a checkout's dist-server may be a
    // stale copy of
    const source = join(root, "server", "index.ts");
    const entry = existsSync(source) ? source : join(root, "dist-server", "index.js");
    const wide = ["0.0.0.0", "::", "[::]"].includes(process.env.BLOKS_LISTEN?.trim() ?? "");
    console.log(`Starting Bloks on this computer (${wide ? `port ${PORT} on every interface` : `loopback port ${PORT}`}). Data lives in ${dataDir()}.`);
    await import(pathToFileURL(entry).href);
    // once it answers, say what to do next
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
      if (!up) continue;
      await status(10_000).catch(() => {});
      console.log("Pair your phone or the desktop app with: bloks-server pair");
      break;
    }
    break;
  }
  case "activate": {
    const key = (args[0] ?? "").trim();
    if (!key) fail("Usage: bloks-server activate blok_live_...");
    await call("POST", "/api/relay/activate", { key });
    await status(10_000);
    break;
  }
  case "pair": {
    // a QR code for the phone, when the terminal library is to hand
    const drawn = async (link) => {
      try {
        const qr = await import("qrcode");
        console.log(await qr.default.toString(link, { type: "terminal", small: true }));
      } catch {}
    };
    // At an address of the owner's own first (server/self-host.ts), where
    // the device talks to this server directly from then on; then through
    // Bloks Cloud, when it is on, for a device that is somewhere else.
    const reach = await reachOf();
    const relay = await call("GET", "/api/relay");
    const own = reach?.direct === true;
    if (own) {
      const started = await call("POST", "/api/pair/start");
      const links = started.links ?? [];
      if (links.length) {
        console.log("Open one of these on the phone or computer you want to pair, the one for the address it reaches this server at:\n");
        for (const { url, link } of links) console.log(`  ${url}\n  ${link}\n`);
        await drawn(links[0].link);
      } else {
        console.log("No address is set for your devices to reach this server at. Set BLOKS_PUBLIC_URL and restart it for a link, or trade the code below for a token in a terminal:");
        console.log(`  bloks-server token --server https://your.address --code ${started.code}\n`);
      }
      console.log(`The code is ${started.code}. It works once, until ${new Date(started.expiresAt).toLocaleTimeString()}. Whoever has it first becomes one of your devices, so keep it to yourself.`);
      if (!relay.enabled) break;
      console.log("\nFrom anywhere else, through Bloks Cloud:\n");
    }
    if (!own && relay.cloud === "off") fail("Bloks Cloud is turned off here (BLOKS_CLOUD=off), so pairing goes to an address of your own: set BLOKS_PUBLIC_URL to it (see docs/SELF_HOSTING.md) and restart Bloks.");
    const { link, expiresAt } = await call("POST", "/api/pair/link");
    if (!own) console.log("Open this link on the phone or computer you want to pair. It works once, for 15 minutes:\n");
    console.log(`  ${link}\n`);
    await drawn(link);
    console.log(`Anyone who opens it before ${new Date(expiresAt).toLocaleTimeString()} becomes one of your devices, so keep it to yourself.`);
    break;
  }
  case "status":
    await status();
    break;
  case "drain": {
    if (args[0] === "cancel") {
      await call("DELETE", "/api/maintenance/drain");
      console.log("Called off. Bloks starts new work again, and what waited goes now.");
      break;
    }
    const at = args.indexOf("--minutes");
    const minutes = at >= 0 ? Number(args[at + 1]) : 20;
    if (!(minutes > 0)) fail("Usage: bloks-server drain [--minutes 20], or bloks-server drain cancel");
    let state = await call("POST", "/api/maintenance/drain", { seconds: minutes * 60 });
    console.log(
      `Draining: nothing new starts, and what arrives waits until Bloks is back. Waiting for what is running until ${new Date(state.deadline).toLocaleTimeString()}.`,
    );
    // Ctrl-C stops the waiting, not the drain: that lasts until Bloks
    // restarts, until drain cancel, or ten minutes past its deadline
    let said = -1;
    while (!state.done) {
      if (state.running.length !== said) {
        said = state.running.length;
        console.log(`${said} ${said === 1 ? "turn" : "turns"} still running`);
      }
      await new Promise((r) => setTimeout(r, 2000));
      state = await call("GET", "/api/maintenance/drain");
      if (!state.draining) fail("The drain was called off.");
    }
    console.log(
      state.idle
        ? "Nothing is running. Restart Bloks now."
        : `Out of time with ${state.running.length} still running. Restart Bloks now; they pick up where they left off when it is back.`,
    );
    break;
  }
  case "backup": {
    const undo = args.includes("--undo");
    const sealed = args.includes("--encrypt");
    const secret = sealed ? await passphrase("Passphrase for this backup: ", { twice: true }) : undefined;
    // Written from here whether or not Bloks is running. Reading the
    // folder beside a running server is safe, since every store replaces
    // its file whole, and a long backup is not cut off by a request that
    // gave up waiting.
    const code = await backupCode();
    let backup;
    try {
      backup = await code.createBackup({ undo, passphrase: secret });
    } catch (e) {
      fail(e.message);
    }
    console.log(`Backed up to ${backup.path} (${sizeOf(backup.size)}).`);
    console.log(
      backup.secrets
        ? "It is sealed with your passphrase, and your saved keys are in it."
        : sealed
          ? "It is sealed with your passphrase."
          : "Your saved keys were left out. Back up with --encrypt to keep them too.",
    );
    break;
  }
  case "restore": {
    const given = args.find((arg) => !arg.startsWith("--"));
    if (!given) fail("Usage: bloks-server restore FILE");
    const file = resolve(given);
    if (!existsSync(file)) fail(`There is no file at ${file}.`);
    const code = await backupCode();
    let encrypted = false;
    try {
      encrypted = code.readBackupSummary(file).encrypted;
    } catch (e) {
      fail(e.message);
    }
    const secret = encrypted ? await passphrase("Passphrase for this backup: ") : undefined;
    if (!(await answering())) {
      // Nothing running, so nothing holds the folder in memory: back up,
      // unpack and check, then swap, all here.
      try {
        const { safety, pending } = await code.restoreBackup(file, { passphrase: secret });
        const applied = code.applyPendingRestore({ log: () => {} });
        if (!applied) {
          console.log("A Bloks server is using ~/.bloks, so the restore is ready and is put in place when it next starts.");
          break;
        }
        console.log(`Restored from ${basename(file)}.`);
        if (applied.aside) {
          console.log(`The workspace it replaced is at ${applied.aside}${safety ? `, and backed up as ${safety.name}` : ""}.`);
        }
        console.log(
          pending.keys === "kept"
            ? "The backup had no saved keys, so the ones on this computer were kept."
            : "Saved keys came back with the backup.",
        );
      } catch (e) {
        fail(`${e.message}`);
      }
      break;
    }
    // The running server restores: it has to stop for the swap, and only
    // it can let what is running finish first.
    const name = intoBackups(code, file, encrypted);
    await call("POST", `/api/backups/${encodeURIComponent(name)}/restore`, secret ? { passphrase: secret } : {});
    let last = "draining";
    let said = "";
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const state = await fetch(`${BASE}/api/backups/restore`, { headers: ownKey() })
        .then((r) => r.json())
        .then((body) => body.restore)
        .catch(() => null);
      // no answer: the server has stopped, which is the last step, unless
      // it never got that far
      const phase = state?.phase ?? (last === "staging" || last === "restarting" ? "restarting" : "gone");
      const line =
        phase === "draining"
          ? `Waiting for ${state.running ?? 0} running ${state.running === 1 ? "turn" : "turns"} to finish first.`
          : phase === "backing-up"
            ? "Backing up the workspace as it is now."
            : phase === "staging"
              ? "Unpacking the backup and checking every file."
              : "";
      if (line && line !== said) console.log((said = line));
      if (phase === "failed") fail(`The restore stopped: ${state.error} Nothing was changed.`);
      if (phase === "cancelled") fail("The restore was called off. Nothing was changed.");
      if (phase === "gone") fail("Bloks stopped before the restore was ready, so nothing was changed.");
      if (phase === "restarting") {
        console.log("Checked and ready. Bloks is stopping so the restore can be put in place as it starts again.");
        console.log("If nothing starts it for you, start it with: bloks-server");
        break;
      }
      last = phase;
    }
    break;
  }
  case "update": {
    let state = await call("POST", "/api/server-update/check");
    if (state.check?.error) fail(state.check.error);
    const latest = state.check?.latest;
    if (!state.check?.newer || !latest) {
      console.log(`Bloks ${state.version} is the latest.`);
      break;
    }
    console.log(`Bloks ${latest.version} is out. This server runs ${state.version}.`);
    console.log(`Release notes: ${latest.page}`);
    if (args.includes("--check")) break;
    if (!state.install.canInstall) {
      console.log(`\n${state.install.why}`);
      if (state.steps?.length) console.log(`\n${state.steps.map((line) => `  ${line}`).join("\n")}`);
      process.exit(1);
    }
    state = await call("POST", "/api/server-update/install", { version: latest.version });
    let said = "";
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await fetch(`${BASE}/api/server-update`, { headers: ownKey() })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const job = now?.job;
      // no answer: it has stopped to hand over, which is the last step
      if (!now || job?.phase === "restarting") break;
      const line =
        job?.phase === "downloading"
          ? `Downloading ${job.version}${job.percent ? ` (${job.percent}%)` : ""}`
          : job?.phase === "unpacking"
            ? "Checked. Unpacking it beside this version."
            : job?.phase === "draining"
              ? `Waiting for ${job.running ?? 0} running ${job.running === 1 ? "turn" : "turns"} to finish first.`
              : "";
      if (line && line !== said) console.log((said = line));
      if (job?.phase === "failed") fail(`The update stopped: ${job.error} Nothing was changed.`);
      if (job?.phase === "cancelled") fail("The update was called off. Nothing was changed.");
    }
    console.log(`Restarting into ${latest.version}. Waiting for it to answer.`);
    // the helper writes down how it went once the new version answers, or
    // once it has gone back to this one
    for (let waited = 0; waited < 300; waited++) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await fetch(`${BASE}/api/server-update`, { headers: ownKey() })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const last = now?.last;
      if (!last || last.to !== latest.version || last.pending) continue;
      if (last.ok) {
        console.log(
          last.manager
            ? `Bloks ${last.to} is running, started by ${last.manager}. Read its output with ${last.log}.`
            : `Bloks ${last.to} is running. Its output goes to ${last.log}.`,
        );
        break;
      }
      fail(`${last.error}${last.rolledBack ? ` Bloks ${last.from} is running again.` : ""}`);
    }
    break;
  }
  case "stop": {
    const health = await fetch(`${BASE}/api/health`)
      .then((r) => r.json())
      .catch(() => null);
    if (health?.app !== "bloks" || !Number.isInteger(health.pid)) fail(`Bloks is not running on this machine (nothing answered on port ${PORT}).`);
    process.kill(health.pid, "SIGTERM");
    for (let i = 0; i < 40 && (await answering()); i++) await new Promise((r) => setTimeout(r, 250));
    console.log((await answering()) ? "Asked Bloks to stop. It is still finishing up." : "Bloks has stopped.");
    break;
  }
  case "export-runs":
    await exportRuns();
    break;
  case "run":
  case "team":
  case "chat":
  case "token":
    await scripting(command);
    break;
  case "import": {
    // What bringing a setup over would find in this machine's home
    // folder, read here with the server's own reader and nothing written.
    // The import itself is a list to tick in the app, where each value a
    // server or a chat app needs is typed or copied on purpose, so from
    // here there is only the look.
    const sources = ["claude", "codex", "cursor", "openclaw", "hermes", "openbot"];
    // an OpenBot transfer file to read as well, named the way it is given
    const at = args.indexOf("--transfer");
    const transfer = at >= 0 ? args[at + 1] : undefined;
    if (at >= 0 && (!transfer || transfer.startsWith("-"))) fail("Which file? bloks-server import openbot --dry-run --transfer FILE.zip");
    const source = args.find((a, i) => !a.startsWith("-") && (at < 0 || i !== at + 1));
    if (source && source !== "all" && !sources.includes(source)) fail(`Which tool? One of: ${sources.join(", ")}, or all.`);
    if (!args.includes("--dry-run")) {
      fail("Only a look from here: bloks-server import [claude|codex|cursor|openclaw|hermes|openbot] --dry-run [--transfer FILE.zip]. To bring things over, open Bloks, Settings, Bring your setup.");
    }
    if (transfer && !existsSync(transfer)) fail(`There is no file at ${transfer}.`);
    const file = join(root, "server", "setup-import.ts");
    const code = await import(pathToFileURL(existsSync(file) ? file : join(root, "dist-server", "setup-import.js")).href);
    const scan = code.detectSetup(homedir(), source && source !== "all" ? source : undefined, {
      ...(transfer ? { openbotTransfer: { path: resolve(transfer), name: basename(transfer) } } : {}),
    });
    if (args.includes("--json")) {
      // the same shape the app's review is made from, which holds no values
      console.log(JSON.stringify(scan, null, 2));
    } else process.stdout.write(code.dryRunReport(scan));
    break;
  }
  default:
    fail("Commands: bloks-server [start], activate KEY, pair, status, drain, backup, restore FILE, update, import --dry-run, stop, export-runs, run AGENT TASK, team apply FILE, chat AGENT, token");
}
