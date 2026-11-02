// The key that says a request is from this server's own machine.
//
// http-guard.ts takes a request as the person at the keyboard when it
// arrives on loopback, with a loopback Host, no foreign Origin and no
// header saying a proxy passed it on. In the desktop app that is right:
// the window is the app's own page. On bloks-server it is not enough. A
// proxy that adds no forwarding header (NGINX with a bare proxy_pass,
// which also rewrites Host to 127.0.0.1) or a plain TCP tunnel (ssh -R,
// socat, `tailscale serve --tcp`) delivers somebody out on the internet
// to loopback with whatever Host and Origin they chose to send, and
// nothing in the request itself can tell them from the owner's own
// terminal.
//
// So on a server the owner's own commands carry a key. It is made fresh
// each time the server starts and written beside the port file, readable
// only by the account the server runs as: `bloks-server`, `bloks` and the
// MCP bridge read it there and send it, and nothing that comes in from
// outside can. A browser on the server itself is a device like any other
// there, paired or signed in at the web door.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

export const LOCAL_KEY_HEADER = "x-bloks-local";
export const LOCAL_KEY_FILE = "local.key";

/** A new key, written where the owner's commands read it. */
export function makeLocalKey(dataDir: string): string {
  const key = randomBytes(32).toString("hex");
  const file = join(dataDir, LOCAL_KEY_FILE);
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, key, { mode: 0o600 });
  // a file left by an older start may be wider; this one never is
  chmodSync(draft, 0o600);
  renameSync(draft, file);
  return key;
}

/** Whether the request carries this start's key. */
export function carriesLocalKey(req: IncomingMessage, key: string): boolean {
  const sent = req.headers[LOCAL_KEY_HEADER];
  if (typeof sent !== "string" || sent.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(sent), Buffer.from(key));
}
