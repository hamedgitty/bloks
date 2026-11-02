// Who signed in from a browser, and as whom (server/web-door.ts).
//
// Two lists, in the owner's data folder, readable by them alone:
//
//   Links: an identity at the provider (its issuer and the person claim's
//   value) and the one person of this workspace it is. One identity is
//   one person; the owner is never linked here, because who the owner is
//   comes from BLOKS_OIDC_OWNER each time, so changing that setting
//   changes who the owner's sessions belong to.
//
//   Sessions: what a browser's cookie stands for. Only the sha256 of the
//   cookie is kept, as with a paired device's token, so the file cannot
//   be replayed as anybody's browser. A session lasts two weeks at most,
//   and a person who is no longer in the workspace has none: each is
//   checked against who is in on every request, not only when it is made.
//
// A session can also be waiting: somebody who signed in to use an invite
// and is waiting for the owner to let them in. It reaches nothing but its
// own request until then.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { isRecord, readSaved, writeFileAtomic } from "./atomic-write.ts";

export interface SignInLink {
  issuer: string;
  /** The person claim's value at that issuer. */
  subject: string;
  personId: string;
  /** What the person is called there, for the Members page. */
  label: string;
  linkedAt: number;
  lastAt: number;
}

export interface WebSession {
  hash: string;
  /** "owner", a person's id, or "" while waiting on an invite. */
  personId: string;
  issuer: string;
  subject: string;
  /** What the provider calls them (an address, a user name), for "Signed
   * in as". */
  label?: string;
  createdAt: number;
  expiresAt: number;
  /** Set while the session waits for the owner to answer a request. */
  waiting?: { inviteId: string; name: string; label: string };
}

interface SignInFile {
  links: SignInLink[];
  sessions: WebSession[];
}

/** How long a browser stays signed in, at most. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
/** Sessions one person may hold at once; the oldest goes first. */
const MAX_PER_PERSON = 20;

const FILE = () => join(DATA_DIR, "web-sign-in.json");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const isLink = (l: unknown): l is SignInLink =>
  isRecord(l) && typeof l.issuer === "string" && typeof l.subject === "string" && typeof l.personId === "string" && /^p_[\w-]+$/.test(l.personId);
const isSession = (s: unknown): s is WebSession =>
  isRecord(s) && typeof s.hash === "string" && /^[0-9a-f]{64}$/.test(s.hash) && typeof s.personId === "string" && typeof s.expiresAt === "number" && typeof s.issuer === "string" && typeof s.subject === "string";

let cache: SignInFile | null = null;
/** When each session was last used, kept off disk like a device's. */
const seen = new Map<string, number>();

function load(): SignInFile {
  if (cache) return cache;
  const raw = readSaved<Partial<SignInFile>>(FILE(), {}, isRecord);
  cache = {
    links: Array.isArray(raw.links) ? raw.links.filter(isLink) : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions.filter(isSession) : [],
  };
  return cache;
}

function save() {
  const data = load();
  const now = Date.now();
  data.sessions = data.sessions.filter((s) => s.expiresAt > now);
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(FILE(), JSON.stringify(data, null, 2), 0o600);
}

/** For tests: forget the in-memory copy so the next read goes to disk. */
export function resetSignInCache() {
  cache = null;
  seen.clear();
}

// ── links ──────────────────────────────────────────────────────────────

export function linkOf(issuer: string, subject: string): SignInLink | null {
  return load().links.find((l) => l.issuer === issuer && l.subject === subject) ?? null;
}

/** Links an identity to a person, replacing whatever it was linked to. */
export function link(issuer: string, subject: string, personId: string, label: string): SignInLink {
  const data = load();
  const now = Date.now();
  data.links = data.links.filter((l) => !(l.issuer === issuer && l.subject === subject));
  const made: SignInLink = { issuer, subject, personId, label: label.slice(0, 120), linkedAt: now, lastAt: now };
  data.links.push(made);
  save();
  return made;
}

export function noteSignedIn(l: SignInLink, label: string) {
  l.lastAt = Date.now();
  l.label = label.slice(0, 120);
  save();
}

/** The identity a person signs in with, when they have one. */
export function linkFor(personId: string): SignInLink | null {
  return load().links.find((l) => l.personId === personId) ?? null;
}

/** A person out of the workspace: their links and sessions go with them. */
export function forgetPerson(personId: string): number {
  const data = load();
  const before = data.links.length + data.sessions.length;
  data.links = data.links.filter((l) => l.personId !== personId);
  for (const s of data.sessions) if (s.personId === personId) seen.delete(s.hash);
  data.sessions = data.sessions.filter((s) => s.personId !== personId);
  const gone = before - data.links.length - data.sessions.length;
  if (gone) save();
  return gone;
}

// ── sessions ───────────────────────────────────────────────────────────

/** A new session; the token is returned once, for the cookie. */
export function startSession(input: { personId: string; issuer: string; subject: string; label?: string; waiting?: WebSession["waiting"]; ttlMs?: number }): { token: string; session: WebSession } {
  const data = load();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session: WebSession = {
    hash: sha256(token),
    personId: input.personId,
    issuer: input.issuer,
    subject: input.subject,
    ...(input.label ? { label: input.label.slice(0, 120) } : {}),
    createdAt: now,
    expiresAt: now + Math.min(input.ttlMs ?? SESSION_TTL_MS, SESSION_TTL_MS),
    ...(input.waiting ? { waiting: input.waiting } : {}),
  };
  if (input.personId) {
    const mine = data.sessions.filter((s) => s.personId === input.personId).sort((a, b) => a.createdAt - b.createdAt);
    const over = new Set(mine.slice(0, Math.max(0, mine.length - MAX_PER_PERSON + 1)).map((s) => s.hash));
    data.sessions = data.sessions.filter((s) => !over.has(s.hash));
  }
  data.sessions.push(session);
  save();
  return { token, session };
}

/** The session a cookie stands for, while it lasts. */
export function sessionFor(token: string | null): WebSession | null {
  if (!token || token.length < 32 || token.length > 128) return null;
  const hash = sha256(token);
  const found = load().sessions.find((s) => s.hash === hash);
  if (!found || found.expiresAt <= Date.now()) return null;
  seen.set(found.hash, Date.now());
  return found;
}

/** A waiting session let in: it now belongs to the person. */
export function admitSession(hash: string, personId: string): WebSession | null {
  const s = load().sessions.find((x) => x.hash === hash);
  if (!s) return null;
  s.personId = personId;
  delete s.waiting;
  save();
  return s;
}

export function endSession(hash: string): boolean {
  const data = load();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.hash !== hash);
  seen.delete(hash);
  if (data.sessions.length === before) return false;
  save();
  return true;
}

/** When somebody last did anything from a browser, for the Members page. */
export function lastSeen(personId: string): number | null {
  let latest = 0;
  for (const s of load().sessions) if (s.personId === personId) latest = Math.max(latest, seen.get(s.hash) ?? 0);
  return latest || null;
}

/** How many browsers a person is signed in on. */
export function sessionCount(personId: string): number {
  const now = Date.now();
  return load().sessions.filter((s) => s.personId === personId && s.expiresAt > now).length;
}

/** For the session's own cookie: a short id that is not the token. */
export const sessionId = (s: WebSession) => s.hash.slice(0, 16);
