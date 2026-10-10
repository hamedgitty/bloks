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
//   bloks-server                 run it (keep it running: systemd, Docker,
//                                tmux, whatever the machine already uses)
//   bloks-server activate KEY    turn on Bloks Cloud with a licence key
//   bloks-server pair            print a link that pairs a phone or the
//                                desktop app, from anywhere
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
//
// The rest talk to the running server, so run them in a second shell on
// the same machine. backup and restore work with Bloks stopped too.
// A passphrase is asked for in the terminal, or read from
// BLOKS_BACKUP_PASSPHRASE where nobody is there to type it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the server is: BLOKS_PORT, then the port the running server
 * wrote down, then one chosen in config.json, then the usual one. */
function knownPort() {
  const read = (file, pick) => {
    try {
      return pick(readFileSync(join(homedir(), ".bloks", file), "utf8"));
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

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
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

async function status(waitMs = 0) {
  let relay = await call("GET", "/api/relay");
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

switch (command) {
  case "start": {
    // Loopback, always: a server on a public machine must not be the one
    // place Bloks listens on the network.
    process.env.BLOKS_LOOPBACK_ONLY = "1";
    process.env.BLOKS_PORT = String(PORT);
    const ui = join(root, "dist");
    if (!process.env.BLOKS_STATIC_DIR && existsSync(join(ui, "index.html"))) process.env.BLOKS_STATIC_DIR = ui;
    // a checkout runs its source; the packaged download ships only the
    // compiled server, which is what a checkout's dist-server may be a
    // stale copy of
    const source = join(root, "server", "index.ts");
    const entry = existsSync(source) ? source : join(root, "dist-server", "index.js");
    console.log(`Starting Bloks on this computer (loopback port ${PORT}). Data lives in ~/.bloks.`);
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
    const { link, expiresAt } = await call("POST", "/api/pair/link");
    console.log("Open this link on the phone or computer you want to pair. It works once, for 15 minutes:\n");
    console.log(`  ${link}\n`);
    // a QR code for the phone, when the terminal library is to hand
    try {
      const qr = await import("qrcode");
      console.log(await qr.default.toString(link, { type: "terminal", small: true }));
    } catch {}
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
      const state = await fetch(`${BASE}/api/backups/restore`)
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
  default:
    fail("Commands: bloks-server [start], activate KEY, pair, status, drain, backup, restore FILE");
}
