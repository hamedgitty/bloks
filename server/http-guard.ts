// Guard for the loopback API.
//
// The harness listens on 127.0.0.1, which is *not* a security boundary in
// a browser: any page you visit can send cross-origin requests to it. And
// because the body reader parses JSON regardless of content-type, an
// attacker can use a CORS "simple" request (text/plain + no-cors) that
// skips preflight entirely, the request executes even though the
// response is unreadable. Without a check, a random website could rewrite
// your stored credentials and your global agent instructions.
//
// Two checks close it:
//   Origin, must be absent (Electron, curl, same-origin) or loopback.
//   Host, must be loopback, which defeats DNS rebinding (evil.com
//            resolving to 127.0.0.1 still sends Host: evil.com).
//
// When pairing is switched on the server also answers the local network,
// and that Host check no longer says anything: a phone legitimately
// sends Host: 192.168.1.20. So remote requests get a different boundary
// entirely, built from the two helpers at the bottom of this file, 
// a bearer token they were handed during pairing (server/pairing.ts),
// plus a same-origin rule that keeps browsers off the remote surface
// even when they share the wifi.
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(value: string): string {
  // strip the port; keep bracketed IPv6 intact
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.lastIndexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

/** Whether the request actually arrived on the loopback interface. The
 * Host header is a claim the client makes; this is the kernel's account
 * of where the bytes came from, and it cannot be forged from off-box.
 * IPv4-mapped IPv6 ("::ffff:127.0.0.1") is how a dual-stack listener
 * reports a v4 loopback peer, so it counts too. */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress;
  if (!addr) return false;
  const bare = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return bare === "127.0.0.1" || bare === "::1" || bare.startsWith("127.");
}

export function isLocalRequest(req: IncomingMessage): boolean {
  // The peer must genuinely be on loopback. Without this, the Host and
  // Origin checks below are only a browser defense: a non-browser LAN
  // attacker forges Host: localhost with no Origin and would otherwise
  // be handed the entire local-only surface with no pairing token.
  if (!isLoopbackPeer(req)) return false;

  // Host must name the loopback interface, blocks DNS rebinding, where a
  // hostile domain resolves to 127.0.0.1 but still carries its own Host.
  const host = req.headers.host;
  if (!host || !LOOPBACK_HOSTS.has(hostnameOf(host))) return false;

  // No Origin: not a browser-initiated cross-site request (Electron's
  // file://, curl, same-origin navigations). Browsers always attach one
  // to cross-origin fetches, including no-cors simple requests.
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;

  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** The bearer token a request carries, if it carries a well formed one. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== "bearer") return null;
  return header.slice(space + 1).trim() || null;
}

/**
 * Whether a request came from the page this server served, or from
 * something that is not a browser at all.
 *
 * This is what keeps a hostile page on the same wifi from borrowing a
 * paired phone's network position. A native client sends no Origin. A
 * page we served ourselves sends our own host. Anything else is some
 * other site's script, and it does not get to speak to the API even
 * though it can reach the port.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
