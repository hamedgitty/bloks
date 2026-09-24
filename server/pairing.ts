// Pairing, for the case where the client is not on this machine.
//
// The loopback API carries no credential because loopback *is* the
// credential (server/http-guard.ts explains why that holds, and where it
// stops holding). The moment this server answers anything but loopback
// that argument is gone, so remote access is a different thing with its
// own boundary: a bearer token, handed out once, to somebody who could
// read a six digit code off the Mac's own screen.
//
// Two deliberate choices worth knowing before changing anything here:
//
//   Off by default, and on takes a restart. Widening what a server
//   listens on is a decision rather than a toggle, and re-binding a live
//   process that is holding open SSE streams is a good way to invent
//   bugs. Until the app restarts, nothing outside loopback can connect
//   at all, whatever the config says.
//
//   The code never touches disk and the token never comes back off it.
//   Only a SHA-256 of each token is stored, so a stolen config file
//   cannot be replayed as a paired device.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

import { loadConfig, saveConfig } from "./config.ts";

/** A device that completed pairing. The token itself is shown exactly
 * once, at claim time, and only its digest is kept. */
export interface PairedDevice {
  id: string;
  name: string;
  /** sha256 of the bearer token, hex. Never the token. */
  hash: string;
  pairedAt: number;
  /** Set on a device that belongs to a member of a shared room rather
   * than to the owner. Its presence is the whole difference: an owner's
   * device reaches the remote surface, a member's reaches only what
   * server/member-access.ts allows for their rooms. */
  personId?: string;
}

/** What the Mac shows on its pairing screen. Carries no secrets. */
export interface PairingStatus {
  enabled: boolean;
  /** What the server actually bound to, which lags `enabled` by a restart. */
  listening: "loopback" | "network";
  restartRequired: boolean;
  pending: boolean;
  devices: Array<{ id: string; name: string; pairedAt: number; lastSeen?: number }>;
  /** Addresses a phone on the same network can reach, for the QR/URL. */
  addresses: string[];
}

const CODE_TTL_MS = 5 * 60_000;
/** A six digit code is a million guesses; five tries makes that safe and
 * still forgives someone fat-fingering it on a phone keyboard. */
const MAX_ATTEMPTS = 5;
const MAX_DEVICES = 16;
const MAX_NAME = 60;

/** In memory only, and only ever one at a time. A pairing code that
 * outlived the process it was shown by is not a code, it is a hole. */
let pending: { code: string; token: string; expires: number; tries: number } | null = null;

/** Set once at startup, so the UI can tell "on" from "on after you
 * restart". Nothing here changes what a running server listens on. */
let boundToNetwork = false;

/** Last request time per device, kept off disk: writing a file on every
 * request to record that a request happened is not a trade worth making. */
const seen = new Map<string, number>();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant time compare for equal-length secrets. Length is allowed to
 * leak: the length of a code and of a hex digest are both public. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** config.json is a file a person can open and edit, so a device record
 * is checked rather than trusted. A malformed one is dropped, not
 * repaired: half a credential should never authenticate anything. */
function isDevice(value: unknown): value is PairedDevice {
  const d = value as PairedDevice | null;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.hash === "string" &&
    // a digest is 64 hex characters; anything else was not written by us
    /^[0-9a-f]{64}$/.test(d.hash) &&
    typeof d.pairedAt === "number"
  );
}

/** The paired devices, digests and all, the owner's and members' both.
 * The relay link needs the digest to derive each device's key; nothing
 * else outside this file does. */
export function pairedDevices(): PairedDevice[] {
  return [...devices(), ...memberDevices()];
}

/** Members' devices live in their own list: they do not count against the
 * owner's sixteen, and never appear on the owner's device screen, where a
 * guest's phone would read as one of the owner's own. */
const MAX_MEMBER_DEVICES = 200;

export function memberDevices(): PairedDevice[] {
  const list = loadConfig().remote?.memberDevices;
  return Array.isArray(list)
    ? list.filter((d): d is PairedDevice => isDevice(d) && typeof d.personId === "string")
    : [];
}

function putMemberDevices(list: PairedDevice[]): void {
  saveConfig({ remote: { ...loadConfig().remote, memberDevices: list } });
}

/** Registers a member's device from the digest of a token the device made
 * itself: the token never crosses to this machine, only its hash. */
export function addMemberDevice(personId: string, name: unknown, hash: string): PairedDevice {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("not a token digest");
  const device: PairedDevice = {
    id: randomBytes(8).toString("hex"),
    name: cleanName(name),
    hash,
    pairedAt: Date.now(),
    personId,
  };
  putMemberDevices([...memberDevices(), device].slice(-MAX_MEMBER_DEVICES));
  return device;
}

/** Every device a person has, gone at once. Returns how many. */
export function revokePerson(personId: string): number {
  const list = memberDevices();
  const left = list.filter((d) => d.personId !== personId);
  if (left.length !== list.length) putMemberDevices(left);
  for (const d of list) if (d.personId === personId) seen.delete(d.id);
  return list.length - left.length;
}

function devices(): PairedDevice[] {
  const list = loadConfig().remote?.devices;
  return Array.isArray(list) ? list.filter(isDevice) : [];
}

function putDevices(list: PairedDevice[]): void {
  saveConfig({ remote: { ...loadConfig().remote, devices: list } });
}

export function remoteEnabled(): boolean {
  // bloks-server: no screen to flip the switch on, and nothing but the
  // relay can reach it (bindHost below keeps it on loopback), so the
  // remote surface is on and the relay is its only door
  if (process.env.BLOKS_LOOPBACK_ONLY === "1") return true;
  return loadConfig().remote?.enabled === true;
}

export function setRemoteEnabled(on: boolean): void {
  saveConfig({ remote: { ...loadConfig().remote, enabled: on } });
  // Turning it off should mean off right now, not at the next restart.
  // The bind cannot narrow without one, so drop the pending code and let
  // the guard refuse everything remote in the meantime.
  if (!on) pending = null;
}

/** Which interface to bind. Read once, at startup, by design. */
export function bindHost(): string {
  // bloks-server sets this: on a machine with a public address, Bloks
  // Cloud is the only way in, whatever the pairing switch says
  if (process.env.BLOKS_LOOPBACK_ONLY === "1") return "127.0.0.1";
  return remoteEnabled() ? "0.0.0.0" : "127.0.0.1";
}

/** Records what the server actually bound, so status can be honest about
 * a toggle that has not taken effect yet. */
export function noteBound(host: string): void {
  boundToNetwork = host !== "127.0.0.1";
}

/** Opens a pairing window. The ttl is a parameter so the expiry can be
 * tested without a fake clock; callers should leave it alone. */
export function startPairing(ttlMs: number = CODE_TTL_MS): {
  code: string;
  token: string;
  expiresAt: number;
} {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  // the QR carries this instead of the code: real entropy, no typing.
  // Scanning replaces typing, never consent; the phone still confirms.
  const token = `bloks_pair_${randomBytes(24).toString("base64url")}`;
  pending = { code, token, expires: Date.now() + ttlMs, tries: 0 };
  return { code, token, expiresAt: pending.expires };
}

export function cancelPairing(): void {
  pending = null;
}

export function pairingPending(): boolean {
  return Boolean(pending && Date.now() <= pending.expires);
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (name || "A device").slice(0, MAX_NAME);
}

/**
 * Trades a correct code for a bearer token, once. Wrong guesses burn an
 * attempt; the fifth one closes the window rather than merely failing,
 * so a code cannot be ground down.
 */
export function claimPairing(
  code: unknown,
  name: unknown,
): { token: string; device: Omit<PairedDevice, "hash"> } | null {
  if (!pending || Date.now() > pending.expires) {
    pending = null;
    return null;
  }
  if (++pending.tries > MAX_ATTEMPTS) {
    pending = null;
    return null;
  }
  const offered = typeof code === "string" ? code : "";
  // either credential opens the door; both burn together on success
  const matches =
    (offered.length === pending.code.length && sameSecret(offered, pending.code)) ||
    (offered.length === pending.token.length && sameSecret(offered, pending.token));
  if (!matches) return null;

  pending = null; // single use, spent on success
  const token = randomBytes(32).toString("base64url");
  const device: PairedDevice = {
    id: randomBytes(8).toString("hex"),
    name: cleanName(name),
    hash: sha256(token),
    pairedAt: Date.now(),
  };
  // Oldest out first. An unbounded list is a config file that grows
  // forever and a revoke screen nobody can read.
  const list = [...devices(), device].slice(-MAX_DEVICES);
  putDevices(list);
  const { hash: _hash, ...safe } = device;
  return { token, device: safe };
}

/** The device a token belongs to, or null. Compares digests, not tokens,
 * so nothing reversible is held in memory either. */
export function deviceForToken(token: string | null): PairedDevice | null {
  if (!token) return null;
  const digest = sha256(token);
  for (const device of pairedDevices()) {
    if (typeof device?.hash === "string" && sameSecret(digest, device.hash)) {
      seen.set(device.id, Date.now());
      return device;
    }
  }
  return null;
}

export function revokeDevice(id: string): boolean {
  const list = devices();
  const left = list.filter((d) => d.id !== id);
  if (left.length === list.length) return false;
  putDevices(left);
  seen.delete(id);
  return true;
}

export function revokeAll(): void {
  putDevices([]);
  seen.clear();
}

/** Addresses on this machine a phone could actually reach: IPv4, not
 * loopback, not link-local. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push(entry.address);
    }
  }
  return out;
}

export function pairingStatus(): PairingStatus {
  const enabled = remoteEnabled();
  return {
    enabled,
    listening: boundToNetwork ? "network" : "loopback",
    restartRequired: enabled !== boundToNetwork,
    pending: pairingPending(),
    devices: devices().map((d) => ({
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      ...(seen.has(d.id) ? { lastSeen: seen.get(d.id) } : {}),
    })),
    addresses: enabled ? lanAddresses() : [],
  };
}

// ── pairing through the relay ──────────────────────────────────────────
// A computer with no screen of its own (a server in a cupboard, a VPS)
// cannot show a six digit code to a phone on the same wifi, and usually
// is not on the same wifi at all. So it prints a link instead: the relay,
// the owner's relay pass, and a one time secret, all after the # where no
// server ever reads them. Whoever opens it in Bloks becomes one of the
// owner's devices.
//
// That is the same trust the six digit code carries, and it holds for the
// same reason: the link is only ever shown to whoever is at the host's own
// terminal or screen. It works once, for fifteen minutes, and like the code
// it never touches disk: a restart forgets every link that was not used.

export const PAIR_LINK_TTL_MS = 15 * 60_000;

interface PairLink {
  id: string;
  secretHash: string;
  expiresAt: number;
}

const pairLinks = new Map<string, PairLink>();

/** Mints a link. The secret is returned once, and only its digest kept. */
export function createPairLink(ttlMs: number = PAIR_LINK_TTL_MS): { id: string; secret: string; expiresAt: number } {
  const now = Date.now();
  for (const [id, link] of pairLinks) if (link.expiresAt < now) pairLinks.delete(id);
  const id = `pair_${randomBytes(9).toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  const link = { id, secretHash: sha256(secret), expiresAt: now + ttlMs };
  pairLinks.set(id, link);
  return { id, secret, expiresAt: link.expiresAt };
}

/** The digest the relay link needs to open an envelope for this link, or
 * null once it is used, expired or unknown. */
export function pairLinkSecret(id: string): string | null {
  const link = pairLinks.get(id);
  if (!link) return null;
  if (Date.now() > link.expiresAt) {
    pairLinks.delete(id);
    return null;
  }
  return link.secretHash;
}

/** Spends a link on the device that opened it. The device made its own
 * token and sends only that token's digest, so nothing that could be
 * replayed crosses the relay. */
export function claimPairLink(id: string, name: unknown, tokenHash: unknown): Omit<PairedDevice, "hash"> | null {
  if (!pairLinkSecret(id)) return null;
  if (typeof tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  pairLinks.delete(id);
  const device: PairedDevice = {
    id: randomBytes(8).toString("hex"),
    name: cleanName(name),
    hash: tokenHash,
    pairedAt: Date.now(),
  };
  putDevices([...devices(), device].slice(-MAX_DEVICES));
  const { hash: _hash, ...safe } = device;
  return safe;
}
