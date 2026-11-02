// Which of this computer's addresses a phone is offered, and who may
// connect now that the network bind takes IPv6 too (GitHub 449): iOS
// talks plain HTTP to an IPv6 unique local address, Tailscale's among
// them, and refuses Tailscale's IPv4 one, so the home network comes
// first, then Tailscale's IPv6, and a global IPv6 peer is never let in.
import assert from "node:assert/strict";
import type { networkInterfaces } from "node:os";
import { test } from "node:test";
import { lanAddresses, reachablePeer } from "../server/pairing.ts";
import { isOverlayAddress, pairLink } from "../src/lib/pairing.ts";

const v4 = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "", mac: "", cidr: null });
const v6 = (address: string) => ({ address, family: "IPv6" as const, internal: false, netmask: "", mac: "", cidr: null, scopeid: 0 });

test("the home network comes first, then Tailscale's IPv6, then its IPv4, then the rest", () => {
  const found = {
    utun4: [v4("100.101.102.103"), v6("fd7a:115c:a1e0::1a2b"), v6("fe80::1")],
    en5: [v4("203.0.113.9"), v6("2001:db8::5")],
    lo0: [v4("127.0.0.1", true)],
    en0: [v4("192.168.1.20"), v4("169.254.10.1"), v6("fd00:1::7")],
  } as unknown as ReturnType<typeof networkInterfaces>;
  assert.deepEqual(lanAddresses(found), ["192.168.1.20", "fd7a:115c:a1e0::1a2b", "fd00:1::7", "100.101.102.103", "203.0.113.9"]);
});

test("IPv4 peers connect as before, and of IPv6 only local ones", () => {
  for (const peer of ["192.168.1.5", "100.101.102.103", "203.0.113.9", "::ffff:192.168.1.5", "::1", "fd7a:115c:a1e0::9", "fd00:1::2", "fe80::1%en0"]) {
    assert.equal(reachablePeer(peer), true, peer);
  }
  for (const peer of ["2001:db8::1", "2a00:1450:4009::200e", undefined, ""]) {
    assert.equal(reachablePeer(peer), false, String(peer));
  }
});

test("the code brackets an IPv6 address inside the encoded address", () => {
  const token = `bloks_pair_${"a".repeat(32)}`;
  assert.equal(
    pairLink("fd7a:115c:a1e0::1a2b", 8799, token, "123456", "Studio"),
    `bloks://pair?address=${encodeURIComponent("[fd7a:115c:a1e0::1a2b]:8799")}&token=${token}&code=123456&name=Studio`,
  );
  assert.equal(pairLink("192.168.1.20", 8799, token, "123456"), `bloks://pair?address=192.168.1.20%3A8799&token=${token}&code=123456`);
  assert.equal(pairLink("192.168.1.20", 0, token, "123456"), null);
});

test("Tailscale's addresses are named as Tailscale's", () => {
  assert.equal(isOverlayAddress("100.101.102.103"), true);
  assert.equal(isOverlayAddress("100.63.0.1"), false, "below Tailscale's range");
  assert.equal(isOverlayAddress("100.128.0.1"), false, "above it");
  assert.equal(isOverlayAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isOverlayAddress("fd00:1::7"), false);
  assert.equal(isOverlayAddress("192.168.1.20"), false);
});
