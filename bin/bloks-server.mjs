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
//
// The last three talk to the running server, so run them in a second
// shell on the same machine.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BLOKS_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const [command = "start", ...args] = process.argv.slice(2);

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
  console.log(
    relay.connected
      ? "Bloks is running and connected to Bloks Cloud."
      : `Bloks is running. Bloks Cloud is on but not connected${relay.problem ? `: ${relay.problem}` : ""}.`,
  );
}

switch (command) {
  case "start": {
    // Loopback, always: a server on a public machine must not be the one
    // place Bloks listens on the network.
    process.env.BLOKS_LOOPBACK_ONLY = "1";
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
  default:
    fail("Commands: bloks-server [start], activate KEY, pair, status");
}
