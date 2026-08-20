// The relay is only content-blind if both ends really encrypt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { deviceKey, keyFromToken, open, peek, seal } from "../server/relay-crypto.ts";

describe("relay envelopes", () => {
  const token = "a-paired-phone-token-0123456789";
  const hash = createHash("sha256").update(token).digest("hex");

  test("the Mac and the phone derive the same key from what each already has", () => {
    // the phone holds the token; the Mac keeps only the digest
    assert.deepEqual(keyFromToken(token, "phone-to-mac"), deviceKey(hash, "phone-to-mac"));
    assert.deepEqual(keyFromToken(token, "mac-to-phone"), deviceKey(hash, "mac-to-phone"));
    // and the two directions are genuinely different keys
    assert.notDeepEqual(deviceKey(hash, "phone-to-mac"), deviceKey(hash, "mac-to-phone"));
  });

  test("a sealed request round-trips, and carries only the device id in clear", () => {
    const key = deviceKey(hash, "phone-to-mac");
    const payload = seal(key, "device-1", { method: "POST", path: "/api/bots", body: { name: "Scout" } });

    // what the relay can see: an id it already routes by, and nothing else
    const envelope = peek(payload);
    assert.equal(envelope?.d, "device-1");
    assert.ok(!payload.includes("Scout"));
    assert.ok(!Buffer.from(payload, "base64").toString("utf8").includes("Scout"));

    assert.deepEqual(open(key, envelope!), {
      method: "POST",
      path: "/api/bots",
      body: { name: "Scout" },
    });
  });

  test("another device's key opens nothing", () => {
    const mine = deviceKey(hash, "phone-to-mac");
    const theirs = keyFromToken("a-different-phone-entirely", "phone-to-mac");
    const payload = seal(mine, "device-1", { method: "GET", path: "/api/bots" });
    assert.equal(open(theirs, peek(payload)!), null);
  });

  test("a tampered envelope is refused rather than half-read", () => {
    const key = deviceKey(hash, "phone-to-mac");
    const envelope = peek(seal(key, "device-1", { method: "GET", path: "/api/bots" }))!;
    const bytes = Buffer.from(envelope.c, "base64");
    bytes[2] ^= 0xff;
    assert.equal(open(key, { ...envelope, c: bytes.toString("base64") }), null);
  });

  test("garbage in is null out, never a throw", () => {
    assert.equal(peek("not base64 at all !!"), null);
    assert.equal(peek(Buffer.from('{"d":1}').toString("base64")), null);
    assert.equal(open(deviceKey(hash, "phone-to-mac"), { d: "x", n: "AAAA", c: "AAAA" }), null);
  });

  test("two seals of the same value differ, so traffic is not a fingerprint", () => {
    const key = deviceKey(hash, "phone-to-mac");
    const value = { method: "GET", path: "/api/bots" };
    assert.notEqual(seal(key, "d", value), seal(key, "d", value));
  });
});
