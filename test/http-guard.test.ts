// The security boundary, and the reason it exists.
//
// The harness listens on loopback, which is not a boundary in a browser:
// any page you visit can POST to 127.0.0.1, and a CORS "simple" request
// skips preflight entirely. These are the cases that must keep failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

import { bearerToken, isLocalRequest, isSameOrigin } from "../server/http-guard.ts";

// A request from loopback, the common case: the peer address is what the
// kernel reports, which is the part an off-box attacker cannot forge.
const req = (headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

test("a request with no Origin is allowed", () => {
  // curl, the packaged app's own fetches, and top-level navigations
  assert.equal(isLocalRequest(req({ host: "127.0.0.1:8799" })), true);
});

test("the dev server's origin is allowed", () => {
  assert.equal(
    isLocalRequest(req({ host: "127.0.0.1:8799", origin: "http://localhost:5199" })),
    true,
  );
  assert.equal(
    isLocalRequest(req({ host: "localhost:8799", origin: "http://127.0.0.1:5199" })),
    true,
  );
});

test("a website cannot post to the harness", () => {
  for (const origin of [
    "https://evil.example",
    "http://evil.example:8799",
    // a hostname that merely contains the loopback name
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example",
    // and one that only looks like it after a parse mistake
    "http://evil.example/#127.0.0.1",
  ]) {
    assert.equal(
      isLocalRequest(req({ host: "127.0.0.1:8799", origin })),
      false,
      `${origin} should be rejected`,
    );
  }
});

test("a rebound DNS name cannot reach the harness", () => {
  // DNS rebinding points an attacker-controlled name at 127.0.0.1. The
  // connection succeeds, so the Host header is the only tell.
  assert.equal(isLocalRequest(req({ host: "attacker.example:8799" })), false);
  assert.equal(isLocalRequest(req({ host: "attacker.example" })), false);
});

test("a forged Host from off-loopback is rejected on the peer address", () => {
  // The attack the peer check exists for: a non-browser LAN host opens a
  // TCP connection and sends Host: localhost with no Origin. The headers
  // look local; the socket does not, and the socket is what counts.
  assert.equal(
    isLocalRequest(req({ host: "localhost:8799" }, "192.168.1.50")),
    false,
    "a forged Host from a LAN peer must not be treated as local",
  );
  assert.equal(
    isLocalRequest(req({ host: "127.0.0.1:8799" }, "10.0.0.9")),
    false,
  );
  // IPv4-mapped IPv6 loopback still counts as loopback
  assert.equal(isLocalRequest(req({ host: "127.0.0.1:8799" }, "::ffff:127.0.0.1")), true);
});

test("a request with no Host is rejected", () => {
  assert.equal(isLocalRequest(req({})), false);
  assert.equal(isLocalRequest(req({ host: "" })), false);
});

test("an opaque origin is allowed, since it cannot be a site", () => {
  // sandboxed frames and file:// pages send "null"
  assert.equal(isLocalRequest(req({ host: "127.0.0.1:8799", origin: "null" })), true);
});

test("a malformed Origin is rejected rather than ignored", () => {
  assert.equal(isLocalRequest(req({ host: "127.0.0.1:8799", origin: "not a url" })), false);
});

test("IPv6 loopback is recognised on both sides", () => {
  assert.equal(isLocalRequest(req({ host: "[::1]:8799", origin: "http://[::1]:5199" })), true);
});

// ── the remote boundary ──
// Once pairing is on, Host stops being evidence of anything and these two
// take over. See server/pairing.ts.

test("a bearer token is read, and anything else is not", () => {
  assert.equal(bearerToken(req({ authorization: "Bearer abc123" })), "abc123");
  // schemes are case insensitive per RFC 7235
  assert.equal(bearerToken(req({ authorization: "bearer abc123" })), "abc123");
  assert.equal(bearerToken(req({ authorization: "Bearer   abc123  " })), "abc123");

  assert.equal(bearerToken(req({})), null);
  assert.equal(bearerToken(req({ authorization: "" })), null);
  assert.equal(bearerToken(req({ authorization: "abc123" })), null);
  assert.equal(bearerToken(req({ authorization: "Basic abc123" })), null);
  assert.equal(bearerToken(req({ authorization: "Bearer" })), null);
  assert.equal(bearerToken(req({ authorization: "Bearer " })), null);
});

test("same origin means the page we served, or no page at all", () => {
  // a native client sends no Origin
  assert.equal(isSameOrigin(req({ host: "192.168.1.20:8799" })), true);
  assert.equal(isSameOrigin(req({ host: "192.168.1.20:8799", origin: "null" })), true);
  // a web client we served ourselves
  assert.equal(
    isSameOrigin(req({ host: "192.168.1.20:8799", origin: "http://192.168.1.20:8799" })),
    true,
  );
});

test("another site's script is not same origin, whatever it carries", () => {
  const host = "192.168.1.20:8799";
  assert.equal(isSameOrigin(req({ host, origin: "https://evil.example" })), false);
  // the same host on a different port is a different origin
  assert.equal(isSameOrigin(req({ host, origin: "http://192.168.1.20:9999" })), false);
  // and a near miss on the address is still a miss
  assert.equal(isSameOrigin(req({ host, origin: "http://192.168.1.200:8799" })), false);
  assert.equal(isSameOrigin(req({ host, origin: "not a url" })), false);
});
