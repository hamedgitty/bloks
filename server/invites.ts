// Invites to the workspace, and the door they open.
//
// One invite is one person: a code, a QR and a link that are all the same
// single invite. It works once, for a day, and the owner (or an admin)
// can cancel it before then. The code is short enough to read out loud,
// which also makes it guessable, so three things stand behind it:
//
//   Guessing is slow. Bloks Cloud rate limits lookups by code, and this
//   computer rate limits the same network's guesses (see joinLimiter).
//
//   A join password, when the owner sets one. It is never in the invite,
//   it is checked only here, and five wrong tries close the invite and
//   tell the owner somebody guessed.
//
//   The four words. With "Approve each person" on (the default) nobody is
//   in until the owner has read the same four words as the person asking.
//   The words are bound to the joiner's device token and to this
//   computer's join key, so a relay that swapped the key for its own to
//   read the request shows different words on the two screens.
//
// What is kept: the code's sha256 (what the relay indexes) and the code
// itself, because the owner reads it out again from the Invitations list.
// It lives in the owner's own data folder, readable by them alone, lasts a
// day, and is not enough by itself to get in. The joiner's device token
// never arrives here, only its sha256, as with pairing.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { readSaved, isRecord, writeFileAtomic } from "./atomic-write.ts";
import { cleanName, joinPhrase, type DeviceKind, type WorkspaceRole } from "./people.ts";

// ── codes ──────────────────────────────────────────────────────────────

/** No 0, O, 1, I or L: nothing two people can mishear or misread. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
const PUBLIC_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh code, uniformly from the alphabet: randomInt rejects rather
 * than folds, so no character is likelier than another. */
export function newCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** The name a link gives its preview. Separate from the code, so a link
 * page can be drawn without the code ever leaving the fragment. */
export function newPublicId(): string {
  let id = "";
  for (let i = 0; i < 6; i++) id += PUBLIC_ALPHABET[randomInt(PUBLIC_ALPHABET.length)];
  return id;
}

/** How a code is shown and read out: K7QF-M2XR. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A code as typed, in any case, with any spaces, dashes or dots a person
 * or a phone's keyboard put in it; null when it cannot be one. Hyphens of
 * every width count, since a code pasted out of a chat app often comes
 * back with the typographic kind.
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.toUpperCase().replace(/[\s\-_.\u2010-\u2015\u2212]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return null;
  return code;
}

/** What the relay indexes and what is kept here: sha256 of the eight
 * characters, uppercase, no dash, as lowercase hex. */
export function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Whatever was pasted or typed into "Invite link or code": a link
 * (https://bloks.dev/j/<publicId>#<code>, bloks://join#<code>, either
 * without its scheme) or a bare code. The fragment may also carry where
 * this computer answers on its own network, after a "~", for joining
 * without Bloks Cloud. Null when it is neither.
 */
export function parseInviteInput(raw: unknown): { code: string; publicId?: string; lan?: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const hash = text.indexOf("#");
  if (hash >= 0) {
    const before = text.slice(0, hash);
    const [fragment, lanRaw] = text.slice(hash + 1).split("~");
    const code = normalizeCode(decodeURIComponent(fragment ?? ""));
    if (!code) return null;
    const publicId = before.match(/\/j\/([a-z0-9]{6})\/?$/i)?.[1]?.toLowerCase();
    const lan = lanRaw && /^[0-9a-zA-Z.:[\]-]{3,80}$/.test(lanRaw) ? lanRaw : undefined;
    return { code, ...(publicId ? { publicId } : {}), ...(lan ? { lan } : {}) };
  }
  const code = normalizeCode(text);
  return code ? { code } : null;
}

/** The link the invite travels as. The code sits after the #, so no
 * server on the way ever sees it, bloks.dev included. */
export function inviteLink(publicId: string, code: string, lan?: string): string {
  return `https://bloks.dev/j/${publicId}#${code}${lan ? `~${lan}` : ""}`;
}

// ── the join key ───────────────────────────────────────────────────────
// A request to join comes through Bloks Cloud sealed for this computer.
// The relay sees the code (it looks it up) and its hash, so a key derived
// from the code would be a key the relay holds. Instead the joiner makes
// a throwaway X25519 key, agrees a secret with this computer's join key,
// and seals with that. Raw 32 byte keys, base64url, so an iPhone's
// CryptoKit and this file speak the same bytes.

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export function rawPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
}

export function publicKeyFromRaw(raw: string): KeyObject | null {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.length !== 32) return null;
    return createPublicKey({ key: Buffer.concat([SPKI_X25519, bytes]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export type JoinDirection = "joiner-to-host" | "host-to-joiner";

/** The AES key for one direction of one join conversation. */
export function joinKey(shared: Buffer, direction: JoinDirection): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), `bloks-join-v1:${direction}`, 32));
}

/** The secret two X25519 keys agree on, or null when the other side's key
 * is not one. */
export function agree(privateKey: KeyObject, otherRaw: string): Buffer | null {
  const other = publicKeyFromRaw(otherRaw);
  if (!other) return null;
  try {
    return diffieHellman({ privateKey, publicKey: other });
  } catch {
    return null;
  }
}

export function newJoinKeyPair(): { privateKey: KeyObject; publicRaw: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey, publicRaw: rawPublicKey(publicKey) };
}

// ── what is kept ───────────────────────────────────────────────────────

export type InviteStatus =
  /** Nobody has asked with it yet. */
  | "open"
  /** Somebody asked, and the owner has not decided. */
  | "waiting"
  /** Used: they are in. */
  | "approved"
  | "declined"
  | "cancelled"
  /** Five wrong passwords closed it. */
  | "locked";

export interface WorkspaceInvite {
  id: string;
  publicId: string;
  code: string;
  codeHash: string;
  role: WorkspaceRole;
  /** Who it is for, as the inviter typed it. A label, never checked. */
  name?: string;
  /** "owner", or the person id of the admin who made it. */
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  status: InviteStatus;
  wrongPasswords: number;
  /** Whether Bloks Cloud knows this invite, so it can be found by code
   * from anywhere. "off" when this workspace is not online at all. */
  relay: "registered" | "unavailable" | "off";
  /** The relay client token minted for the invite, as a digest. The
   * relay hands the token to whoever looks the code up, so they can ask
   * through it; whoever is let in keeps it, and otherwise it is revoked. */
  relayTokenHash?: string;
  claim?: {
    name: string;
    tokenHash: string;
    device: DeviceKind;
    at: number;
    /** Whether a join password was asked for and given right. */
    password: "correct" | "none";
    /** The key the joiner sealed for, for the words. */
    hostKey: string;
    /** How the request arrived: through Bloks Cloud, or on this network. */
    via: "relay" | "lan";
    /** sha256 of the relay client token the joiner asked through, when it
     * said; whoever came through the invite's own token keeps it. */
    relayClient?: string;
  };
  personId?: string;
  deviceId?: string;
  /** A relay client token made for the person at approval, held only
   * until their next poll collects it. Only when they did not come
   * through the invite's own token (the same network, say). */
  handover?: string;
  closedAt?: number;
}

interface JoiningFile {
  invites: WorkspaceInvite[];
  /** scrypt of the join password, with this workspace's own salt. */
  password?: { salt: string; hash: string; setAt: number };
  approveEach: boolean;
  /** "Owner and admins can read members' private conversations". Off
   * unless the owner turns it on (server/access.ts). */
  privateReadable?: boolean;
  /** This workspace's join key. The private half never leaves the file. */
  key?: { public: string; private: string };
}

/** How long an invite works. */
export const INVITE_TTL_MS = 24 * 60 * 60_000;
/** How many may be outstanding at once. */
export const MAX_OUTSTANDING = 20;
/** Wrong passwords on one invite before it closes. */
export const MAX_WRONG_PASSWORDS = 5;
/** A request made in time can still be answered this long after the
 * invite would have expired: the owner may be a minute late. */
const DECIDE_GRACE_MS = 60 * 60_000;
/** Finished invites stay this long, so a slow joiner's last poll gets an
 * answer and the owner sees what happened, then go. */
const KEEP_MS = 7 * 24 * 60 * 60_000;
const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;

const FILE = () => join(DATA_DIR, "joining.json");
let cache: JoiningFile | null = null;
let hostPrivate: KeyObject | null = null;

function load(): JoiningFile {
  if (cache) return cache;
  const raw = readSaved<Partial<JoiningFile>>(FILE(), {}, isRecord);
  cache = {
    invites: Array.isArray(raw.invites) ? raw.invites.filter((i) => typeof i?.id === "string" && typeof i.codeHash === "string") : [],
    approveEach: raw.approveEach !== false,
    ...(raw.privateReadable === true ? { privateReadable: true } : {}),
    ...(raw.password && typeof raw.password.salt === "string" && typeof raw.password.hash === "string" ? { password: raw.password } : {}),
    ...(raw.key && typeof raw.key.public === "string" && typeof raw.key.private === "string" ? { key: raw.key } : {}),
  };
  return cache;
}

function save() {
  const data = load();
  const now = Date.now();
  data.invites = data.invites.filter((i) => (i.closedAt ?? i.expiresAt) + KEEP_MS > now);
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(FILE(), JSON.stringify(data, null, 2), 0o600);
}

/** For tests: forget the in-memory copy so the next read goes to disk. */
export function resetJoiningCache() {
  cache = null;
  hostPrivate = null;
}

/** This workspace's join key, made the first time anybody needs it. */
export function hostKey(): { publicRaw: string; privateKey: KeyObject } {
  const data = load();
  if (!data.key) {
    const pair = newJoinKeyPair();
    data.key = {
      public: pair.publicRaw,
      private: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    save();
    hostPrivate = pair.privateKey;
  }
  hostPrivate ??= createPrivateKey({ key: Buffer.from(data.key.private, "base64"), format: "der", type: "pkcs8" });
  return { publicRaw: data.key.public, privateKey: hostPrivate };
}

// ── invites ────────────────────────────────────────────────────────────

/** Expired, as of now, for an invite nobody finished with. */
export function expired(inv: WorkspaceInvite, now = Date.now()): boolean {
  if (inv.status === "open") return now > inv.expiresAt;
  if (inv.status === "waiting") return now > inv.expiresAt + DECIDE_GRACE_MS;
  return false;
}

/** The status a person is shown: what is kept, with expiry worked out. */
export function shownStatus(inv: WorkspaceInvite, now = Date.now()): InviteStatus | "expired" {
  return expired(inv, now) ? "expired" : inv.status;
}

/** Open or waiting and still in time: what counts against the cap and
 * what the Invitations list shows. */
export function outstanding(now = Date.now()): WorkspaceInvite[] {
  return load()
    .invites.filter((i) => (i.status === "open" || i.status === "waiting") && !expired(i, now))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function invite(id: string): WorkspaceInvite | null {
  return load().invites.find((i) => i.id === id) ?? null;
}

export function inviteByPublicId(publicId: string): WorkspaceInvite | null {
  return load().invites.find((i) => i.publicId === publicId) ?? null;
}

/** The invite a code names, compared as digests in constant time. */
export function inviteByCode(code: string): WorkspaceInvite | null {
  const want = Buffer.from(codeHash(code), "hex");
  for (const inv of load().invites) {
    const have = Buffer.from(inv.codeHash, "hex");
    if (have.length === want.length && timingSafeEqual(have, want)) return inv;
  }
  return null;
}

export type CreateRefusal = { error: string; code: "too_many" };

/** Makes an invite. The code is returned with it, once, for the sheet. */
export function createInvite(input: {
  role: WorkspaceRole;
  name?: unknown;
  invitedBy: string;
  relay?: WorkspaceInvite["relay"];
  relayTokenHash?: string;
}): WorkspaceInvite | CreateRefusal {
  if (outstanding().length >= MAX_OUTSTANDING) {
    return { code: "too_many", error: `There are already ${MAX_OUTSTANDING} invites waiting. Cancel one you no longer need, or wait for some to be used.` };
  }
  const data = load();
  // a fresh code and id that no kept invite has, however unlikely
  let code = newCode();
  while (data.invites.some((i) => i.code === code)) code = newCode();
  let publicId = newPublicId();
  while (data.invites.some((i) => i.publicId === publicId)) publicId = newPublicId();
  const now = Date.now();
  const name = cleanName(input.name);
  const inv: WorkspaceInvite = {
    id: `wi_${randomBytes(9).toString("base64url")}`,
    publicId,
    code,
    codeHash: codeHash(code),
    role: input.role,
    ...(name ? { name } : {}),
    invitedBy: input.invitedBy,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    status: "open",
    wrongPasswords: 0,
    relay: input.relay ?? "off",
    ...(input.relayTokenHash ? { relayTokenHash: input.relayTokenHash } : {}),
  };
  data.invites.push(inv);
  save();
  return inv;
}

/** Records what Bloks Cloud said about an invite after it was made. */
export function noteRelay(id: string, relay: WorkspaceInvite["relay"], relayTokenHash?: string) {
  const inv = invite(id);
  if (!inv) return;
  inv.relay = relay;
  if (relayTokenHash) inv.relayTokenHash = relayTokenHash;
  else if (relay !== "registered") delete inv.relayTokenHash;
  save();
}

/** Renames an invite or changes its role while nobody has used it: the
 * invite sheet makes the invite as it opens, and the person filling it in
 * is still deciding. Null when it can no longer change. */
export function updateInvite(id: string, patch: { name?: unknown; role?: unknown }): WorkspaceInvite | null {
  const inv = invite(id);
  if (!inv || inv.status !== "open" || expired(inv)) return null;
  if (patch.role === "member" || patch.role === "admin") inv.role = patch.role;
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (name) inv.name = name;
    else delete inv.name;
  }
  save();
  return inv;
}

/** Cancels an invite that has not been used. Null when there is none to
 * cancel. A waiting request goes with it. */
export function cancelInvite(id: string): WorkspaceInvite | null {
  const inv = invite(id);
  if (!inv || (inv.status !== "open" && inv.status !== "waiting")) return null;
  inv.status = "cancelled";
  inv.closedAt = Date.now();
  save();
  return inv;
}

// ── the join password and the approval switch ──────────────────────────

export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 200;

export function joiningSettings(): { password: { setAt: number } | null; approveEach: boolean; privateReadable: boolean } {
  const data = load();
  return { password: data.password ? { setAt: data.password.setAt } : null, approveEach: data.approveEach, privateReadable: data.privateReadable === true };
}

export function setPrivateReadable(on: boolean) {
  const data = load();
  if (on) data.privateReadable = true;
  else delete data.privateReadable;
  save();
}

/** Sets or changes the join password. Its own salt each time, so the same
 * password set twice is stored two different ways. */
export function setPassword(raw: unknown): { ok: true } | { ok: false; error: string } {
  const password = typeof raw === "string" ? raw : "";
  if (password.trim().length < MIN_PASSWORD) return { ok: false, error: `A join password needs at least ${MIN_PASSWORD} characters.` };
  if (password.length > MAX_PASSWORD) return { ok: false, error: "That password is too long." };
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFC"), salt, 32, SCRYPT);
  load().password = { salt: salt.toString("base64"), hash: hash.toString("base64"), setAt: Date.now() };
  save();
  return { ok: true };
}

export function clearPassword(): boolean {
  const data = load();
  if (!data.password) return false;
  delete data.password;
  save();
  return true;
}

/** Whether this is the join password. False when none is set. */
export function checkPassword(raw: unknown): boolean {
  const stored = load().password;
  if (!stored || typeof raw !== "string" || raw.length > MAX_PASSWORD) return false;
  const hash = scryptSync(raw.normalize("NFC"), Buffer.from(stored.salt, "base64"), 32, SCRYPT);
  const want = Buffer.from(stored.hash, "base64");
  return want.length === hash.length && timingSafeEqual(hash, want);
}

export function setApproveEach(on: boolean) {
  load().approveEach = on;
  save();
}

// ── asking to join ─────────────────────────────────────────────────────

/** Every way a request to join can be turned away, each with its own
 * screen on the joiner's side (design: Edge-States). */
export type JoinError =
  | "wrong_code"
  | "expired"
  | "cancelled"
  | "used"
  | "declined"
  | "closed"
  | "password_required"
  | "wrong_password"
  | "already_member"
  | "full"
  | "team_required"
  | "invalid";

/** The HTTP status each answers with. */
export const JOIN_STATUS: Record<JoinError, number> = {
  wrong_code: 404,
  expired: 410,
  cancelled: 410,
  used: 410,
  declined: 403,
  closed: 410,
  password_required: 401,
  wrong_password: 401,
  already_member: 409,
  full: 402,
  team_required: 402,
  invalid: 400,
};

export interface ClaimInput {
  name: unknown;
  password?: unknown;
  /** sha256 of the token the joiner made, hex. Never the token. */
  tokenHash: unknown;
  device?: unknown;
  /** sha256 of the relay client token they asked through, if any. */
  relayClient?: unknown;
}

export type ClaimResult =
  | { ok: true; invite: WorkspaceInvite; fresh: boolean }
  | { ok: false; error: JoinError; invite?: WorkspaceInvite; triesLeft?: number; locked?: boolean };

const DEVICES: readonly DeviceKind[] = ["iphone", "mac", "pc", "computer", "browser"];

/**
 * Somebody with the code asks to join. Checks run in the order a person
 * would want to hear about them: the invite itself first (its state is
 * the same for anyone holding it), then who is asking, then the password.
 * Only the password costs a try, and asking without one (the form had no
 * field for it yet) costs nothing.
 *
 * `isMember` says whether a device token already belongs to somebody in
 * the workspace; `full` whether the plan has room for one more. Both are
 * passed in so this stays testable without a server.
 */
export function claim(
  inv: WorkspaceInvite | null,
  input: ClaimInput,
  ctx: { hostKey: string; via?: "relay" | "lan"; isMember: (tokenHash: string) => boolean; full: () => boolean },
): ClaimResult {
  if (!inv) return { ok: false, error: "wrong_code" };
  const tokenHash = typeof input.tokenHash === "string" ? input.tokenHash.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return { ok: false, error: "invalid", invite: inv };
  const same = inv.claim?.tokenHash === tokenHash;
  // the same device asking again after an answer hears that answer
  if (inv.status === "approved") return same ? { ok: true, invite: inv, fresh: false } : { ok: false, error: "used", invite: inv };
  if (inv.status === "declined") return { ok: false, error: same ? "declined" : "used", invite: inv };
  if (inv.status === "cancelled") return { ok: false, error: "cancelled", invite: inv };
  if (inv.status === "locked") return { ok: false, error: "closed", invite: inv };
  if (expired(inv)) return { ok: false, error: "expired", invite: inv };
  if (ctx.isMember(tokenHash)) return { ok: false, error: "already_member", invite: inv };
  if (inv.status === "waiting") {
    // a retry from the device that asked; anyone else is too late
    return same ? { ok: true, invite: inv, fresh: false } : { ok: false, error: "used", invite: inv };
  }
  const name = cleanName(input.name);
  if (!name) return { ok: false, error: "invalid", invite: inv };
  const data = load();
  let password: "correct" | "none" = "none";
  if (data.password) {
    if (typeof input.password !== "string" || input.password === "") return { ok: false, error: "password_required", invite: inv };
    if (!checkPassword(input.password)) {
      inv.wrongPasswords += 1;
      if (inv.wrongPasswords >= MAX_WRONG_PASSWORDS) {
        inv.status = "locked";
        inv.closedAt = Date.now();
        save();
        return { ok: false, error: "closed", invite: inv, locked: true, triesLeft: 0 };
      }
      save();
      return { ok: false, error: "wrong_password", invite: inv, triesLeft: MAX_WRONG_PASSWORDS - inv.wrongPasswords };
    }
    password = "correct";
  }
  if (ctx.full()) return { ok: false, error: "full", invite: inv };
  const device = DEVICES.includes(input.device as DeviceKind) ? (input.device as DeviceKind) : "iphone";
  const relayClient = typeof input.relayClient === "string" && /^[0-9a-f]{64}$/.test(input.relayClient) ? input.relayClient : undefined;
  inv.claim = { name, tokenHash, device, at: Date.now(), password, hostKey: ctx.hostKey, via: ctx.via ?? "relay", ...(relayClient ? { relayClient } : {}) };
  inv.status = "waiting";
  save();
  return { ok: true, invite: inv, fresh: true };
}

/** The four words for a request, on this side. */
export function phraseOf(inv: WorkspaceInvite): string | null {
  return inv.claim ? joinPhrase(inv.codeHash, inv.claim.tokenHash, inv.claim.hostKey) : null;
}

/** The joiner took their request back. The invite is theirs to use again,
 * or anyone's who holds it. */
export function withdraw(inv: WorkspaceInvite, tokenHash: unknown): boolean {
  if (inv.status !== "waiting" || inv.claim?.tokenHash !== tokenHash) return false;
  delete inv.claim;
  inv.status = "open";
  save();
  return true;
}

export function decline(id: string): WorkspaceInvite | null {
  const inv = invite(id);
  if (!inv || inv.status !== "waiting" || expired(inv)) return null;
  inv.status = "declined";
  inv.closedAt = Date.now();
  save();
  return inv;
}

/** Marks a waiting request let in, once the person and their device
 * exist. Null when there is no request left to let in. */
export function markApproved(id: string, admitted: { personId: string; deviceId: string; handover?: string }): WorkspaceInvite | null {
  const inv = invite(id);
  if (!inv || inv.status !== "waiting" || expired(inv)) return null;
  inv.status = "approved";
  inv.closedAt = Date.now();
  inv.personId = admitted.personId;
  inv.deviceId = admitted.deviceId;
  if (admitted.handover) inv.handover = admitted.handover;
  save();
  return inv;
}

/** Hands a relay token made at approval over, once. */
export function takeHandover(inv: WorkspaceInvite): string | undefined {
  const token = inv.handover;
  if (!token) return undefined;
  delete inv.handover;
  save();
  return token;
}

/** Invites that ran out since the last look, so their relay tokens can be
 * revoked. Each is reported once. */
export function sweepExpired(now = Date.now()): WorkspaceInvite[] {
  const gone: WorkspaceInvite[] = [];
  for (const inv of load().invites) {
    if ((inv.status === "open" || inv.status === "waiting") && expired(inv, now) && !inv.closedAt) {
      inv.closedAt = now;
      gone.push(inv);
    }
  }
  if (gone.length) save();
  return gone;
}

// ── guesses on the same network ────────────────────────────────────────

/**
 * Asking this computer directly, without Bloks Cloud, gets the limit the
 * relay would have applied: ten tries in ten minutes from one address.
 * In memory, since a restart is not a guessing strategy worth defending.
 */
export class JoinLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 10, windowMs = 10 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  allow(who: string, now = Date.now()): boolean {
    const recent = (this.hits.get(who) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(who, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(who, recent);
    if (this.hits.size > 1_000) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }
}
