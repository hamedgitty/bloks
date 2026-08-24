// The remote boundary.
//
// Once the server answers the local network, the Host check that carries
// server/http-guard.ts stops meaning anything: a phone legitimately sends
// Host: 192.168.1.20. These are the cases that decide whether the thing
// that replaces it actually holds. They run against the real server over
// HTTP, with a forged Host, because that is where the guard lives.
import { test } from "node:test";
import assert from "node:assert/strict";

import { startHarness, type Harness } from "./helpers/server.ts";

/** Turns pairing on and trades a code for a token, the way a phone does. */
async function pairADevice(h: Harness, name = "Test iPhone") {
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.fetchRemote("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code, device: name }),
  });
  return { code: started.code, ...claimed };
}

test("off by default: the network gets nothing", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const status = await h.json("/api/pair");
  assert.equal(status.enabled, false);
  assert.equal(status.listening, "loopback");
  assert.deepEqual(status.devices, []);

  // no route, not even the open ones, before somebody opts in
  for (const path of ["/api/bots", "/api/health", "/api/pair"]) {
    const res = await h.fetchRemote(path);
    assert.equal(res.status, 403, `${path} should be refused`);
  }
});

test("turning it on needs a restart before it binds", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const status = await h.json("/api/pair", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(status.enabled, true);
  // the running process is still on loopback, and says so
  assert.equal(status.listening, "loopback");
  assert.equal(status.restartRequired, true);
});

test("an unpaired device is refused, and told what to do", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });

  const res = await h.fetchRemote("/api/bots");
  assert.equal(res.status, 401);
  assert.match(res.body.error, /pair/i);
});

test("a paired device gets in, and an invented token does not", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const paired = await pairADevice(h);
  assert.equal(paired.status, 200);
  assert.equal(typeof paired.body.token, "string");
  assert.ok(paired.body.token.length >= 40, "a token should be long");
  assert.equal(paired.body.device.name, "Test iPhone");
  // the digest is the server's business and must not come back out
  assert.equal(paired.body.device.hash, undefined);

  const ok = await h.fetchRemote("/api/bots", { token: paired.body.token });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.bots));

  const forged = await h.fetchRemote("/api/bots", { token: "not-a-real-token" });
  assert.equal(forged.status, 401);
});

test("health is reachable before pairing, so a phone can find the Mac", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });

  const res = await h.fetchRemote("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.app, "bloks");
});

test("a code is six digits, single use, and dies after five wrong tries", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });

  const started = await h.json("/api/pair/start", { method: "POST" });
  assert.match(started.code, /^\d{6}$/);
  assert.ok(started.expiresAt > Date.now());

  const claim = (code: string) =>
    h.fetchRemote("/api/pair/claim", {
      method: "POST",
      body: JSON.stringify({ code, device: "Phone" }),
    });

  const first = await claim(started.code);
  assert.equal(first.status, 200);
  // spent: the same code cannot be redeemed twice
  const again = await claim(started.code);
  assert.equal(again.status, 401);

  // a fresh window, ground down by wrong guesses
  const second = await h.json("/api/pair/start", { method: "POST" });
  for (let i = 0; i < 5; i++) assert.equal((await claim("000000".slice(0, 6))).status, 401);
  // the fifth wrong guess closes the window, so even the right code fails
  const tooLate = await claim(second.code);
  assert.equal(tooLate.status, 401);
});

test("revoking a device locks it out immediately", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const paired = await pairADevice(h);
  const token = paired.body.token;
  assert.equal((await h.fetchRemote("/api/bots", { token })).status, 200);

  const status = await h.json("/api/pair");
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].name, "Test iPhone");

  const gone = await h.fetch(`/api/pair/devices/${status.devices[0].id}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.equal((await h.fetchRemote("/api/bots", { token })).status, 401);
});

test("a paired device cannot let another device in, or throw one out", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const token = (await pairADevice(h)).body.token;
  // opening the door has to happen at the Mac, by someone who can see it
  for (const [method, path] of [
    ["POST", "/api/pair/start"],
    ["PUT", "/api/pair"],
    ["GET", "/api/pair"],
    ["DELETE", "/api/pair/devices"],
  ] as const) {
    const res = await h.fetchRemote(path, {
      method,
      token,
      body: method === "PUT" ? JSON.stringify({ enabled: false }) : undefined,
    });
    assert.equal(res.status, 403, `${method} ${path} should be loopback only`);
  }
});

test("a website on the same wifi cannot use a stolen token", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const token = (await pairADevice(h)).body.token;
  // a real token, but carried by a page some other site served
  const res = await h.fetchRemote("/api/bots", { token, origin: "https://evil.example" });
  assert.equal(res.status, 403);

  // the page this server served itself is fine, which is what a mobile
  // web client will be
  const same = await h.fetchRemote("/api/bots", {
    token,
    origin: `http://192.168.1.20:${new URL(h.url).port}`,
  });
  assert.equal(same.status, 200);
});

test("switching pairing off shuts the remote surface at once", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const token = (await pairADevice(h)).body.token;
  assert.equal((await h.fetchRemote("/api/bots", { token })).status, 200);

  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: false }) });
  // no waiting for a restart to close: narrowing takes effect now
  assert.equal((await h.fetchRemote("/api/bots", { token })).status, 403);
});

test("pairing cannot start while it is switched off", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const res = await h.fetch("/api/pair/start", { method: "POST" });
  assert.equal(res.status, 409);
});

test("a device name is cleaned up, and a missing one still works", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const long = await pairADevice(h, `   ${"n".repeat(200)}   `);
  assert.equal(long.body.device.name.length, 60);

  const started = await h.json("/api/pair/start", { method: "POST" });
  const nameless = await h.fetchRemote("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code }),
  });
  assert.equal(nameless.status, 200);
  assert.equal(nameless.body.device.name, "A device");
});
