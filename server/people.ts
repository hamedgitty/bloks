// People in shared rooms, and how they get in.
//
// Bloks has one owner: the person whose computer this is. Everyone else
// is a member of one or more rooms the owner has shared, and nothing
// more. A member is not a lesser owner. They cannot see the owner's solo
// chats, settings, other rooms or secrets, and the agents they talk to
// run on the owner's computer, with the owner's keys, under the owner's
// approval. See server/member-access.ts for what a member may reach.
//
// Getting in is an invite, and an invite alone is not enough. The link
// carries a secret the host only stores the digest of; the person who
// opens it proves they hold it, names themselves, and waits. The owner
// sees the request and a four word check phrase that the other person
// sees too, and lets them in or not. Someone who intercepted the link is
// stopped at that moment, because they are not who the owner is looking
// at.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export type MemberRole = "collaborator" | "viewer";

export interface Person {
  id: string;
  name: string;
  createdAt: number;
  /** The relay client token digest this person's devices use, so removing
   * them from their last room can take the relay away too. */
  relayTokenHash?: string;
  /** Set for someone who talks to the room from a linked chat channel
   * (server/chat-bridge.ts): which platform, and their id there. */
  via?: { platform: "slack" | "discord"; userId: string };
}

/** Somebody in a linked chat channel who addressed the agents and is not
 * in the room yet. The chat equivalent of a claimed invite: the owner
 * lets them in or not. */
export interface Knock {
  id: string;
  roomId: string;
  platform: "slack" | "discord";
  userId: string;
  name: string;
  at: number;
}

export interface Membership {
  personId: string;
  roomId: string;
  role: MemberRole;
  joinedAt: number;
  /** "owner", or the person id of the collaborator who sent the invite. */
  invitedBy: string;
}

export type InviteStatus = "open" | "claimed" | "approved" | "declined" | "cancelled";

export interface Invite {
  id: string;
  /** sha256 of the link's secret, hex. The secret itself is never kept. */
  secretHash: string;
  roomId: string;
  role: MemberRole;
  createdAt: number;
  expiresAt: number;
  invitedBy: string;
  status: InviteStatus;
  /** The relay client token minted for this invite, as a digest. The token
   * rides in the link; if nobody is let in, it is revoked. */
  relayTokenHash?: string;
  /** Set once someone has opened the link and asked to join. */
  claim?: {
    name: string;
    /** sha256 of the device token the joiner generated, hex. */
    tokenHash: string;
    at: number;
  };
  /** Set on approval, so the joiner's next poll learns who they are. */
  personId?: string;
  deviceId?: string;
}

interface PeopleFile {
  people: Person[];
  memberships: Membership[];
  invites: Invite[];
  knocks: Knock[];
}

/** How long an invite link works. */
export const INVITE_TTL_MS = 24 * 60 * 60_000;
/** Finished invites are kept this long so a slow joiner's last poll still
 * gets an answer, then forgotten. */
const INVITE_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_NAME = 40;

const FILE = () => join(DATA_DIR, "people.json");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

let cache: PeopleFile | null = null;

function load(): PeopleFile {
  if (cache) return cache;
  try {
    if (existsSync(FILE())) {
      const raw = JSON.parse(readFileSync(FILE(), "utf8")) as Partial<PeopleFile>;
      cache = {
        people: Array.isArray(raw.people) ? raw.people : [],
        memberships: Array.isArray(raw.memberships) ? raw.memberships : [],
        invites: Array.isArray(raw.invites) ? raw.invites : [],
        knocks: Array.isArray(raw.knocks) ? raw.knocks : [],
      };
      return cache;
    }
  } catch {
    // a torn file is treated as empty rather than fatal; the owner's own
    // access never depended on it
  }
  cache = { people: [], memberships: [], invites: [], knocks: [] };
  return cache;
}

function save() {
  const data = load();
  const now = Date.now();
  data.invites = data.invites.filter((i) => i.createdAt + INVITE_KEEP_MS > now);
  data.knocks = data.knocks.filter((k) => k.at + INVITE_KEEP_MS > now);
  const next = `${FILE()}.next`;
  writeFileSync(next, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(next, FILE());
}

/** For tests: forget the in-memory copy so the next read goes to disk. */
export function resetPeopleCache() {
  cache = null;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // control characters and bidi overrides out: a name is printed next to
  // every message the person sends, and must not be able to restyle one
  const name = raw
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);
  return name || null;
}

// ── people and memberships ─────────────────────────────────────────────

export function person(id: string): Person | null {
  return load().people.find((p) => p.id === id) ?? null;
}

export function people(): Person[] {
  return [...load().people];
}

export function membershipsOf(personId: string): Membership[] {
  return load().memberships.filter((m) => m.personId === personId);
}

export function membersOf(roomId: string): Array<Membership & { person: Person }> {
  const data = load();
  return data.memberships
    .filter((m) => m.roomId === roomId)
    .map((m) => ({ ...m, person: data.people.find((p) => p.id === m.personId)! }))
    .filter((m) => m.person);
}

/** A member's role in a room, or null when they are not in it. */
export function roleIn(personId: string, roomId: string): MemberRole | null {
  return load().memberships.find((m) => m.personId === personId && m.roomId === roomId)?.role ?? null;
}

export function setRole(personId: string, roomId: string, role: MemberRole): boolean {
  const m = load().memberships.find((x) => x.personId === personId && x.roomId === roomId);
  if (!m) return false;
  m.role = role;
  save();
  return true;
}

/**
 * Takes a person out of a room. Returns whether they are now in no shared
 * room at all, which is when the caller should revoke their devices and
 * their relay token: a person with no rooms has nothing left to reach.
 */
export function removeFromRoom(personId: string, roomId: string): { removed: boolean; roomless: boolean } {
  const data = load();
  const before = data.memberships.length;
  data.memberships = data.memberships.filter((m) => !(m.personId === personId && m.roomId === roomId));
  const removed = data.memberships.length !== before;
  const roomless = !data.memberships.some((m) => m.personId === personId);
  if (roomless) data.people = data.people.filter((p) => p.id !== personId);
  if (removed || roomless) save();
  return { removed, roomless };
}

/** Everyone out of a room, e.g. when the owner stops sharing it. Returns
 * the people who are now in no room. */
export function clearRoom(roomId: string): string[] {
  const inRoom = membersOf(roomId).map((m) => m.personId);
  return inRoom.filter((id) => removeFromRoom(id, roomId).roomless);
}

// ── invites ────────────────────────────────────────────────────────────

/** Mints an invite. The secret is returned once, for the link, and only
 * its digest is kept. */
export function createInvite(input: {
  roomId: string;
  role: MemberRole;
  invitedBy: string;
  relayTokenHash?: string;
}): { invite: Invite; secret: string } {
  const secret = randomBytes(32).toString("base64url");
  const now = Date.now();
  const invite: Invite = {
    id: `inv_${randomBytes(9).toString("base64url")}`,
    secretHash: sha256(secret),
    roomId: input.roomId,
    role: input.role,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    invitedBy: input.invitedBy,
    status: "open",
    ...(input.relayTokenHash ? { relayTokenHash: input.relayTokenHash } : {}),
  };
  load().invites.push(invite);
  save();
  return { invite, secret };
}

export function invite(id: string): Invite | null {
  return load().invites.find((i) => i.id === id) ?? null;
}

export function invitesFor(roomId: string): Invite[] {
  const now = Date.now();
  return load().invites.filter(
    (i) => i.roomId === roomId && (i.status === "open" || i.status === "claimed") && i.expiresAt > now,
  );
}

export function live(inv: Invite | null): inv is Invite {
  return Boolean(inv && (inv.status === "open" || inv.status === "claimed") && inv.expiresAt > Date.now());
}

/**
 * Someone opened the link and asked to join. Only the first claim counts:
 * a link forwarded to a second person cannot replace the first request,
 * which is exactly the case the check phrase is there to catch.
 */
export function claimInvite(
  id: string,
  input: { name: unknown; token: unknown },
): { ok: true; invite: Invite } | { ok: false; reason: string } {
  const inv = invite(id);
  if (!live(inv)) return { ok: false, reason: "this invite has expired or was cancelled" };
  const name = cleanName(input.name);
  if (!name) return { ok: false, reason: "a name is needed" };
  if (typeof input.token !== "string" || input.token.length < 32 || input.token.length > 200) {
    return { ok: false, reason: "a device token is needed" };
  }
  const tokenHash = sha256(input.token);
  if (inv.claim) {
    // the same device asking again is a retry, anything else is refused
    if (inv.claim.tokenHash !== tokenHash) return { ok: false, reason: "someone has already used this invite" };
    return { ok: true, invite: inv };
  }
  inv.claim = { name, tokenHash, at: Date.now() };
  inv.status = "claimed";
  save();
  return { ok: true, invite: inv };
}

/**
 * The owner let them in. Creates the person and their membership; the
 * caller registers the device (server/pairing.ts) and records its id here
 * so the joiner's next poll can find out who they now are.
 */
export function approveInvite(id: string): { invite: Invite; person: Person } | null {
  const inv = invite(id);
  if (!live(inv) || inv.status !== "claimed" || !inv.claim) return null;
  const data = load();
  const p: Person = {
    id: `p_${randomBytes(9).toString("base64url")}`,
    name: inv.claim.name,
    createdAt: Date.now(),
    ...(inv.relayTokenHash ? { relayTokenHash: inv.relayTokenHash } : {}),
  };
  data.people.push(p);
  data.memberships.push({
    personId: p.id,
    roomId: inv.roomId,
    role: inv.role,
    joinedAt: Date.now(),
    invitedBy: inv.invitedBy,
  });
  inv.status = "approved";
  inv.personId = p.id;
  save();
  return { invite: inv, person: p };
}

export function noteInviteDevice(id: string, deviceId: string) {
  const inv = invite(id);
  if (!inv) return;
  inv.deviceId = deviceId;
  save();
}

export function closeInvite(id: string, status: "declined" | "cancelled"): Invite | null {
  const inv = invite(id);
  if (!inv || inv.status === "approved") return null;
  inv.status = status;
  save();
  return inv;
}

// ── people from a linked chat channel ──────────────────────────────────

/** The person a chat account belongs to in this room, if they are in it. */
export function personInRoomByChat(roomId: string, platform: "slack" | "discord", userId: string): Person | null {
  const data = load();
  const p = data.people.find((x) => x.via?.platform === platform && x.via.userId === userId);
  return p && data.memberships.some((m) => m.personId === p.id && m.roomId === roomId) ? p : null;
}

/** Records that a stranger asked. Returns the knock and whether it is new,
 * so the channel is told once and the owner asked once. */
export function knock(input: Omit<Knock, "id" | "at">): { knock: Knock; fresh: boolean } {
  const data = load();
  const existing = data.knocks.find(
    (k) => k.roomId === input.roomId && k.platform === input.platform && k.userId === input.userId,
  );
  if (existing) return { knock: existing, fresh: false };
  const made: Knock = { ...input, name: cleanName(input.name) ?? "Someone", id: `kn_${randomBytes(9).toString("base64url")}`, at: Date.now() };
  data.knocks.push(made);
  save();
  return { knock: made, fresh: true };
}

export function knocksFor(roomId: string): Knock[] {
  return load().knocks.filter((k) => k.roomId === roomId);
}

export function knockById(id: string): Knock | null {
  return load().knocks.find((k) => k.id === id) ?? null;
}

/** Lets a knocker in, as a collaborator. The same chat account is the
 * same person across rooms. */
export function approveKnock(id: string): { knock: Knock; person: Person } | null {
  const data = load();
  const k = data.knocks.find((x) => x.id === id);
  if (!k) return null;
  let p = data.people.find((x) => x.via?.platform === k.platform && x.via.userId === k.userId);
  if (!p) {
    p = { id: `p_${randomBytes(9).toString("base64url")}`, name: k.name, createdAt: Date.now(), via: { platform: k.platform, userId: k.userId } };
    data.people.push(p);
  }
  if (!data.memberships.some((m) => m.personId === p!.id && m.roomId === k.roomId)) {
    data.memberships.push({ personId: p.id, roomId: k.roomId, role: "collaborator", joinedAt: Date.now(), invitedBy: "owner" });
  }
  data.knocks = data.knocks.filter((x) => x.id !== id);
  save();
  return { knock: k, person: p };
}

/** Turns a knocker away. The caller remembers them on the room's link so
 * they are not asked about again. */
export function dropKnock(id: string): Knock | null {
  const data = load();
  const k = data.knocks.find((x) => x.id === id) ?? null;
  if (!k) return null;
  data.knocks = data.knocks.filter((x) => x.id !== id);
  save();
  return k;
}

/** Every knock for a room gone, e.g. when its channel is unlinked. */
export function clearKnocks(roomId: string) {
  const data = load();
  const before = data.knocks.length;
  data.knocks = data.knocks.filter((k) => k.roomId !== roomId);
  if (data.knocks.length !== before) save();
}

// ── the check phrase ───────────────────────────────────────────────────

/** 256 short, common, easily spoken words: one byte each, so four words
 * carry 32 bits, which is plenty for two people comparing out loud. */
const WORDS = (
  "acorn actor agent album amber anchor angel apple april arrow atlas autumn " +
  "badge bagel baker bamboo banjo barley basil beach beacon bean bell berry " +
  "bishop blossom boat bonus book border bottle brave bread breeze brick " +
  "bridge brook brush bucket butter button cabin cactus camel candle canoe canyon " +
  "carbon carpet castle cedar cello chalk cherry chess chief cider circle citrus " +
  "cloud clover coast cobalt cocoa comet copper coral cotton cousin cradle crane " +
  "crater cricket crystal dancer daisy delta desert diamond dinner dolphin dragon " +
  "dream drum eagle earth echo elbow ember engine falcon feather fern fiddle " +
  "field finch flame flute forest fossil fox galaxy garden garnet ginger " +
  "glacier globe goose grape gravel guitar harbor harvest hazel helmet heron hill " +
  "honey horizon husky igloo island ivory jacket jasmine jelly jewel jungle kayak " +
  "kettle kitten koala ladder lagoon lantern lark lava lemon lettuce lily linen " +
  "lion lotus magnet mango maple marble meadow melon meteor mint mirror monkey " +
  "moss mountain muffin music needle nest nickel noodle oak oasis ocean olive " +
  "onion opal orange orbit orchid otter owl paddle palace panda paper parrot " +
  "peach pearl pebble pepper piano pickle pilot pine planet plum pocket pond " +
  "poppy potato prairie puzzle quartz quill rabbit radar radish rain raven reef " +
  "ribbon river robin rocket saddle sail salmon sand saturn scarf shell silver " +
  "sketch sky slate snow socket sparrow spider spruce squid star stone storm " +
  "sugar summit sunset swan tango teapot thunder tiger timber toast tomato topaz " +
  "tower trumpet tulip tundra turtle valley velvet violin volcano wagon walnut " +
  "whale willow window winter wizard wolf yarn zebra"
)
  .split(" ")
  .filter(Boolean);

/**
 * Four words both ends can compute: the host from the digests it keeps,
 * the joiner from the secret and token it holds (hashing each first).
 * Deterministic, so the two screens agree, and bound to both the link and
 * the device, so a second device on the same link shows different words.
 */
export function checkPhrase(secretHash: string, tokenHash: string): string {
  const mac = createHmac("sha256", Buffer.from(secretHash, "hex")).update(`bloks-check-v1:${tokenHash}`).digest();
  return [0, 1, 2, 3].map((i) => WORDS[mac[i] % WORDS.length]).join(" ");
}

export const CHECK_WORDS = WORDS;
