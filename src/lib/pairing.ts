// What the Phone access card says about where its phones reach, and when
// it could not ask (src/components/DevicesSection.tsx).
//
// The desktop app can be a window onto a workspace on another computer,
// a server with no screen among them, and the card used to say "this Mac"
// about it and show an older server's bare refusal (GitHub 403). The
// server now says which computer it is and whether that is this one; this
// is the reading of that, kept apart so it can be tested without a window.

import { inEnglish, t } from "./i18n.ts";

/** The fields of the server's pairing status this reads. A server from
 * before 3.0.15 sends none of `computer`, `here` and `thisDevice`. */
export interface PairingWhere {
  enabled: boolean;
  restartRequired?: boolean;
  listening?: "loopback" | "network";
  computer?: string;
  here?: boolean;
}

/** Said instead of an older server's refusal of the owner's own device,
 * in English; pairingTrouble says it in the reader's language. */
export const PAIRING_ELSEWHERE = inEnglish("pairing.elsewhere", { version: "3.0.15", command: "bloks-server pair" });

/** The line the card shows for an answer that was not a success. `said`
 * is the answer's error, if it had one; `fallback` is for one that said
 * nothing. Only the bare refusal is replaced: everything else the server
 * says is already in words meant for the person. */
export function pairingTrouble(status: number, said: unknown, fallback: string): string {
  if (status === 403 && said === "not from here") return t("pairing.elsewhere", { version: "3.0.15", command: "bloks-server pair" });
  return typeof said === "string" && said.trim() ? said : fallback;
}

/** The computer the phones reach, by its name, when it is not the one this
 * window is on; null when it is, or when the server did not say. */
export function pairingAway(status: PairingWhere | null): string | null {
  if (!status || status.here !== false) return null;
  return status.computer?.trim() || t("pairing.workspacesComputer");
}

/** On, and reached through Bloks Cloud alone: a server that answers
 * nothing on its network (bloks-server), where no restart would change
 * that, so a six digit code is one no phone could trade in and a link is
 * the way. */
export function cloudOnly(status: PairingWhere | null): boolean {
  return Boolean(status?.enabled && !status.restartRequired && status.listening === "loopback");
}

/** The deep link a phone camera understands. Built defensively: any
 * field that fails its shape check kills the link rather than shipping
 * something malformed to a camera. */
export function pairLink(address: string, port: number, token: string, code: string, computer?: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (!/^bloks_pair_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  // The computer's own name, as the server reads it: the window's address
  // is always this machine's loopback and would have the phone ask to pair
  // with "127.0.0.1". Left out, the phone says "your computer".
  const name = computer?.trim() ? `&name=${encodeURIComponent(computer.trim().slice(0, 60))}` : "";
  return `bloks://pair?address=${encodeURIComponent(`${host}:${port}`)}&token=${token}&code=${code}${name}`;
}

/** Tailscale's addresses (100.64.0.0/10, and its fd7a:115c:a1e0::/48),
 * named beside the address so the choice reads as a choice of network. */
export function isOverlayAddress(address: string): boolean {
  const v4 = /^100\.(\d{1,3})\./.exec(address);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}
