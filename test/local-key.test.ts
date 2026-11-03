// On bloks-server the owner's own commands carry a key made at each start
// (server/local-key.ts): a proxy that adds no forwarding header, or a
// plain tunnel, delivers a stranger to loopback with any Host and Origin
// they like, and without the key that stranger is not the owner.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { carriesLocalKey, makeLocalKey, LOCAL_KEY_FILE, LOCAL_KEY_HEADER } from "../server/local-key.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

test("the key is made fresh, kept where only this account reads it, and checked whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-local-key-"));
  try {
    const first = makeLocalKey(dir);
    const second = makeLocalKey(dir);
    assert.notEqual(first, second, "a new start, a new key");
    assert.equal(readFileSync(join(dir, LOCAL_KEY_FILE), "utf8"), second);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, LOCAL_KEY_FILE)).mode & 0o777, 0o600);
    const asked = (value?: string) => ({ headers: value === undefined ? {} : { [LOCAL_KEY_HEADER]: value } }) as unknown as IncomingMessage;
    assert.equal(carriesLocalKey(asked(second), second), true);
    assert.equal(carriesLocalKey(asked(first), second), false);
    assert.equal(carriesLocalKey(asked(second.slice(0, -1)), second), false);
    assert.equal(carriesLocalKey(asked(""), second), false);
    assert.equal(carriesLocalKey(asked(), second), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server started with the key: loopback alone is a stranger, the key is the owner", async (t) => {
  // as bin/bloks-server.mjs starts it: the key, and pairing on
  const h = await startHarness({ BLOKS_LOCAL_KEY: "1", BLOKS_LOOPBACK_ONLY: "1" });
  t.after(() => h.stop());
  const key = readFileSync(join(h.home, ".bloks", LOCAL_KEY_FILE), "utf8");
  // what a tunnel delivers: loopback, a loopback Host, no forwarding header
  const stranger = await fetch(`${h.url}/api/config`, { headers: { host: "127.0.0.1" } });
  assert.equal(stranger.status, 401);
  const pairing = await fetch(`${h.url}/api/pair/start`, { method: "POST", headers: { host: "127.0.0.1" } });
  assert.ok(pairing.status >= 400, `a stranger started pairing (${pairing.status})`);
  const owner = await fetch(`${h.url}/api/config`, { headers: { [LOCAL_KEY_HEADER]: key } });
  assert.equal(owner.status, 200);
  const stale = await fetch(`${h.url}/api/config`, { headers: { [LOCAL_KEY_HEADER]: "0".repeat(64) } });
  assert.equal(stale.status, 401);
});

test("the app's own server needs no key: its window is its own page", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  assert.equal((await fetch(`${h.url}/api/config`)).status, 200);
});

test("an agent's own turn credential works on a server started with the key, and nothing wider does", async (t) => {
  // #480: the agent block let the credential through, then the remote
  // surface took the request for a stranger's and sent it to pair
  const home = mkdtempSync(join(tmpdir(), "bloks-local-key-agent-"));
  const tokenFile = join(home, "turn-token");
  const release = join(home, "release");
  const cli = join(home, "claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, renameSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const send = (v) => console.log(JSON.stringify(v));
let input = "", began = false;
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (began || !input.includes("\\n")) return;
  began = true;
  writeFileSync(${JSON.stringify(tokenFile)} + ".part", process.env.BLOKS_TOKEN + "\\n" + process.env.BLOKS_URL, { mode: 0o600 });
  renameSync(${JSON.stringify(tokenFile)} + ".part", ${JSON.stringify(tokenFile)});
  send({ type: "system", subtype: "init", session_id: "s-agent", model: "claude-sonnet-5" });
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(release)})) return;
    clearInterval(wait);
    send({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s-agent", total_cost_usd: 0 });
    setTimeout(() => process.exit(0), 20);
  }, 50);
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ brief: { enabled: false }, instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home, USERPROFILE: home, BLOKS_LOCAL_KEY: "1", BLOKS_LOOPBACK_ONLY: "1" });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const key = readFileSync(join(home, ".bloks", LOCAL_KEY_FILE), "utf8");
  const owner = (path: string, init: RequestInit = {}) => h.fetch(path, { ...init, headers: { ...init.headers, [LOCAL_KEY_HEADER]: key } });
  const { bot } = await (await owner("/api/bots", { method: "POST", body: JSON.stringify({ name: "Chef" }) })).json();
  assert.equal((await owner(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Who are you?" }) })).ok, true);
  const turn = await waitFor(() => existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").split("\n") : null, 30_000);
  assert.ok(turn, h.logs().slice(-2000));
  const [token, base] = turn;
  // as bin/bloks.mjs sends it: the turn's token and the server's own origin
  const asAgent = (path: string, credential = token) => fetch(base + path, { headers: { authorization: `Bearer ${credential}`, origin: base } });
  const who = await asAgent("/api/agent/whoami");
  assert.equal(who.status, 200, await who.clone().text());
  assert.equal((await who.json()).botId, bot.id);
  const forbidden = await asAgent("/api/agent/__not_a_route__");
  assert.equal(forbidden.status, 403, "an agent's list of routes still applies");
  assert.equal((await asAgent("/api/config")).status, 403, "the owner's settings stay the owner's");
  assert.equal((await asAgent("/api/agent/whoami", "blk_not-a-credential")).status, 401);
  // the owner's own route, with no key and no credential, is still a stranger's
  assert.equal((await fetch(`${h.url}/api/config`, { headers: { host: "127.0.0.1" } })).status, 401);
  writeFileSync(release, "");
  assert.ok(await waitFor(async () => (await asAgent("/api/agent/whoami")).status === 401, 30_000), "a finished turn's credential kept working");
});
