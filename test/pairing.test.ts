// The remote boundary.
//
// Once the server answers the local network, the Host check that carries
// server/http-guard.ts stops meaning anything: a phone legitimately sends
// Host: 192.168.1.20. These are the cases that decide whether the thing
// that replaces it actually holds. They run against the real server over
// HTTP, with a forged Host, because that is where the guard lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

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

// The owner's own device may let another device in, which a server with
// no screen has no other way to do (test/pairing-remote.test.ts), but
// closing the door on everyone cuts that device off too, so it waits for
// somebody at the Mac.
test("a paired device cannot switch pairing off, or throw every device out", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const token = (await pairADevice(h)).body.token;
  for (const [method, path] of [
    ["PUT", "/api/pair"],
    ["DELETE", "/api/pair/devices"],
  ] as const) {
    const res = await h.fetchRemote(path, {
      method,
      token,
      body: method === "PUT" ? JSON.stringify({ enabled: false }) : undefined,
    });
    assert.equal(res.status, 403, `${method} ${path} should be loopback only`);
  }
  const status = await h.json("/api/pair");
  assert.equal(status.enabled, true);
  assert.equal(status.devices.length, 1);
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

test("the pairing link names the computer, never the window's loopback address", async (t) => {
  const h = await startHarness({ BLOKS_COMPUTER_NAME: "Elena's MacBook Air" });
  t.after(() => h.stop());
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  assert.equal(started.name, "Elena's MacBook Air");
});

test("without a name given, the computer goes by its host name, .local dropped", async () => {
  const { computerName } = await import("../server/pairing.ts");
  assert.equal(computerName({ BLOKS_COMPUTER_NAME: "  Studio Mac  " }), "Studio Mac");
  const plain = computerName({}, "linux");
  assert.ok(plain.length > 0 && plain.length <= 60);
  assert.doesNotMatch(plain, /\.local$/i);
});

/** A request as it comes off the wire: headers as sent and the body's raw
 * bytes, still gzipped if they were. `host` decides where it seems to come
 * from: a phone names the computer, the app names loopback. */
function raw(
  h: Harness,
  path: string,
  { headers = {}, token, host, method = "GET", headOnly = false }: { headers?: Record<string, string>; token?: string; host?: string; method?: string; headOnly?: boolean } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> {
  const port = Number(new URL(h.url).port);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { host: host ?? `192.168.1.20:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        // an event stream never ends: its head is the answer
        if (headOnly) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.alloc(0) });
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes: Buffer.concat(chunks) }));
      },
    );
    req.on("error", (e) => (headOnly ? undefined : reject(e)));
    req.end();
  });
}

test("a paired device on the network gets bounded transcripts and gzipped JSON; this machine gets neither", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());

  const paired = await pairADevice(h);
  const token = paired.body.token as string;
  const bot = (await h.json("/api/bots")).bots[0];
  const chunk = "m".repeat(12_000);
  for (let i = 0; i < 20; i++) {
    await h.fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: `${i}: ${chunk}` }),
    });
  }

  // every answer in before anything is counted, or a late one moves the
  // count between two looks at the same conversation
  // (idle, and the same for two looks running, since a queue goes turn by turn)
  const settled = async () => {
    const b = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    return b.busy ? null : `${b.messages.length}:${b.messages.at(-1)?.id}`;
  };
  const deadline = Date.now() + 60_000;
  for (let last = await settled(); ; ) {
    assert.ok(Date.now() < deadline, "the agent never finished answering");
    await new Promise((r) => setTimeout(r, 300));
    const now = await settled();
    if (now && now === last) break;
    last = now;
  }

  // the newest part, and how much more there is to page back through
  const remote = await h.fetchRemote("/api/bots", { token });
  assert.equal(remote.status, 200);
  const remoteBot = remote.body.bots.find((b: any) => b.id === bot.id);
  assert.ok(remoteBot.olderMessages > 0, "a paired device should receive a bounded transcript tail with olderMessages");
  const earlier = await h.fetchRemote(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&before=${remoteBot.messages[0].id}`, { token });
  assert.equal(earlier.status, 200);
  assert.ok(earlier.body.messages.length > 0, "the older messages are there to page back to");
  // the app on this machine still has the whole conversation
  const here = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  assert.ok(!here.olderMessages);
  assert.equal(here.messages.filter((m: any) => m.role === "user").length, 20);

  // big enough to be squeezed off the event loop, and still whole
  const big = await raw(h, "/api/bots", { token, headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(big.status, 200);
  assert.equal(big.headers["content-encoding"], "gzip");
  assert.equal(big.headers.vary, "accept-encoding");
  // its head went before the squeeze was done, so it has no length
  assert.equal(big.headers["content-length"], undefined);
  assert.ok(big.bytes.length < JSON.stringify(remote.body).length / 4);
  const unpacked = JSON.parse(gunzipSync(big.bytes).toString("utf8"));
  assert.equal(unpacked.bots.find((b: any) => b.id === bot.id).olderMessages, remoteBot.olderMessages);

  // small enough to be squeezed in place
  const list = await raw(h, "/api/bots?messages=1", { token, headers: { "accept-encoding": "gzip" } });
  assert.equal(list.headers["content-encoding"], "gzip");
  assert.equal(Number(list.headers["content-length"]), list.bytes.length);
  assert.ok(Array.isArray(JSON.parse(gunzipSync(list.bytes).toString("utf8")).bots));

  // a client that says no to gzip, or never asks, reads it as it is
  for (const accept of ["gzip;q=0", "identity", ""]) {
    const plain = await raw(h, "/api/bots?messages=1", { token, headers: accept ? { "accept-encoding": accept } : {} });
    assert.equal(plain.headers["content-encoding"], undefined, `accept-encoding: ${accept}`);
    assert.equal(plain.headers.vary, "accept-encoding");
    assert.ok(Array.isArray(JSON.parse(plain.bytes.toString("utf8")).bots));
  }

  // nothing to gain on this machine: the app's own window gets it plain
  const port = new URL(h.url).port;
  const local = await raw(h, "/api/bots", { host: `127.0.0.1:${port}`, headers: { "accept-encoding": "gzip" } });
  assert.equal(local.status, 200);
  assert.equal(local.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(local.bytes.toString("utf8")).bots.length, remote.body.bots.length);

  // and the event stream is never gzipped, or each frame would wait
  const events = await raw(h, "/api/events", { token, headOnly: true, headers: { "accept-encoding": "gzip", accept: "text/event-stream" } });
  assert.equal(events.status, 200);
  assert.match(String(events.headers["content-type"]), /text\/event-stream/);
  assert.equal(events.headers["content-encoding"], undefined);
});

test("the built interface goes gzipped to a paired device, images as they are", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-static-"));
  mkdirSync(join(dir, "assets"));
  const script = `console.log(${JSON.stringify("x".repeat(200_000))});\n`;
  writeFileSync(join(dir, "index.html"), `<!doctype html><title>Bloks</title>${"<!-- page -->".repeat(200)}`);
  writeFileSync(join(dir, "assets", "app.js"), script);
  writeFileSync(join(dir, "assets", "icon.png"), Buffer.alloc(4096, 7));
  const h = await startHarness({ BLOKS_STATIC_DIR: dir });
  t.after(async () => {
    await h.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const token = (await pairADevice(h)).body.token as string;
  const gzip = { "accept-encoding": "gzip" };

  const first = await raw(h, "/assets/app.js", { token, headers: gzip });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-type"], "text/javascript");
  assert.equal(first.headers["content-encoding"], "gzip");
  assert.equal(first.headers.vary, "accept-encoding");
  assert.ok(first.headers["content-security-policy"], "the page's own headers still go with it");
  assert.equal(gunzipSync(first.bytes).toString("utf8"), script);
  // squeezed once: the next answer is the same bytes, whole, with a length
  const again = await raw(h, "/assets/app.js", { token, headers: gzip });
  assert.equal(Number(again.headers["content-length"]), again.bytes.length);
  assert.equal(gunzipSync(again.bytes).toString("utf8"), script);
  // and a new build of the file is read again, not the old squeeze
  const rebuilt = `console.log("rebuilt ${"y".repeat(5_000)}");\n`;
  writeFileSync(join(dir, "assets", "app.js"), rebuilt);
  const fresh = await raw(h, "/assets/app.js", { token, headers: gzip });
  assert.equal(gunzipSync(fresh.bytes).toString("utf8"), rebuilt);

  const image = await raw(h, "/assets/icon.png", { token, headers: gzip });
  assert.equal(image.headers["content-encoding"], undefined);
  assert.equal(image.bytes.length, 4096);

  // any other page of the app is the index, gzipped the same way
  const page = await raw(h, "/some/page", { token, headers: gzip });
  assert.equal(page.headers["content-type"], "text/html");
  assert.match(gunzipSync(page.bytes).toString("utf8"), /<title>Bloks<\/title>/);

  // the app on this machine reads its files as they are
  const port = new URL(h.url).port;
  const local = await raw(h, "/assets/app.js", { host: `127.0.0.1:${port}`, headers: gzip });
  assert.equal(local.headers["content-encoding"], undefined);
  assert.equal(local.bytes.toString("utf8"), rebuilt);
});

test("gzip is taken only where Accept-Encoding gives it a weight", async () => {
  const { acceptsGzip } = await import("../server/compress.ts");
  assert.equal(acceptsGzip("gzip, deflate, br"), true);
  assert.equal(acceptsGzip("br;q=1.0, gzip;q=0.8, *;q=0.1"), true);
  assert.equal(acceptsGzip("GZIP"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("gzip;q=0.000, *"), false);
  assert.equal(acceptsGzip("identity"), false);
  assert.equal(acceptsGzip("*"), true);
  assert.equal(acceptsGzip("*;q=0"), false);
  assert.equal(acceptsGzip("x-gzipped"), false);
  assert.equal(acceptsGzip(""), false);
  assert.equal(acceptsGzip(undefined), false);
});
