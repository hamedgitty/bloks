// Pairing through the relay: a link a headless computer prints, spent once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-pairlink-"));
let pairing: typeof import("../server/pairing.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

before(async () => {
  process.env.HOME = home;
  mkdirSync(join(home, ".bloks"), { recursive: true });
  pairing = await import("../server/pairing.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("a link keeps only its secret's digest and pairs one device, once", () => {
  const { id, secret } = pairing.createPairLink();
  assert.ok(id.startsWith("pair_"));
  assert.equal(pairing.pairLinkSecret(id), digest(secret));
  const device = pairing.claimPairLink(id, "Laptop", digest("device token"));
  assert.ok(device);
  assert.equal(device!.name, "Laptop");
  // the device is recognised by its token, which never crossed the relay
  assert.equal(pairing.deviceForToken("device token")?.id, device!.id);
  // spent
  assert.equal(pairing.pairLinkSecret(id), null);
  assert.equal(pairing.claimPairLink(id, "Someone else", digest("other")), null);
});

test("an expired link opens nothing", () => {
  const { id } = pairing.createPairLink(-1);
  assert.equal(pairing.pairLinkSecret(id), null);
  assert.equal(pairing.claimPairLink(id, "Late", digest("x")), null);
});

test("only a real digest is accepted as the device's", () => {
  const { id } = pairing.createPairLink();
  assert.equal(pairing.claimPairLink(id, "Bad", "not-a-digest"), null);
  // a refusal for a malformed digest does not spend the link
  assert.ok(pairing.pairLinkSecret(id));
});

test("a headless server listens on loopback and treats the relay as its door", () => {
  process.env.BLOKS_LOOPBACK_ONLY = "1";
  try {
    assert.equal(pairing.bindHost(), "127.0.0.1");
    assert.equal(pairing.remoteEnabled(), true);
  } finally {
    delete process.env.BLOKS_LOOPBACK_ONLY;
  }
  assert.equal(pairing.remoteEnabled(), false);
});
