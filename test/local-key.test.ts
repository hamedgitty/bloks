// On bloks-server the owner's own commands carry a key made at each start
// (server/local-key.ts): a proxy that adds no forwarding header, or a
// plain tunnel, delivers a stranger to loopback with any Host and Origin
// they like, and without the key that stranger is not the owner.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { carriesLocalKey, makeLocalKey, LOCAL_KEY_FILE, LOCAL_KEY_HEADER } from "../server/local-key.ts";
import { startHarness } from "./helpers/server.ts";

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
