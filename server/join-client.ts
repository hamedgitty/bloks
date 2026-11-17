// Joining somebody else's workspace from this computer.
//
// The other half of server/members.ts's door. The window hands over what
// was pasted or typed; this finds the invite (through Bloks Cloud, or on
// this network when the link says where), asks to join sealed for the
// host's join key, and waits. Done here rather than in the page because
// the conversation is sealed with keys the page has no business holding,
// and because another computer on the network is not something a page
// may call.
//
// The device token is made here and never leaves this computer except to
// the window that saves it as the new workspace's credential: the host
// only ever receives its sha256.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import * as invites from "./invites.ts";
import { checkPhrase, joinPhrase } from "./people.ts";
import { inviteKey, open, peek, seal } from "./relay-crypto.ts";
import { machineKind, thisMachine } from "./this-machine.ts";

export type Fetch = typeof fetch;

export interface FoundInvite {
  publicId: string;
  workspace: string;
  mark: { color: string; pattern: string };
  inviter: string;
  role: "member" | "admin";
  expiresAt: number | null;
  /** Whether the workspace asks for a join password. Null when the host
   * did not say, in which case a claim without one finds out. */
  password: boolean | null;
  /** An invite into one shared room rather than a workspace: `workspace`
   * is then the room's name, and joining makes this computer a guest of
   * that room alone. */
  room?: true;
}

interface Session {
  id: string;
  code: string;
  publicId: string;
  hostKey: string;
  via: "relay" | "lan";
  relayUrl: string;
  clientToken?: string;
  lan?: string;
  invite: FoundInvite;
  key: ReturnType<typeof invites.newJoinKeyPair>;
  deviceToken: string;
  tokenHash: string;
  createdAt: number;
}

export interface JoinFailure {
  ok: false;
  status: number;
  code: string;
  error: string;
  triesLeft?: number;
  retryAfter?: number;
  /** Who sent the invite and to where, when the host said: an ended
   * invite's screen names them. */
  host?: string;
  workspace?: string;
}

const SESSION_TTL_MS = 25 * 60 * 60_000;

/** A shared room's invite, as its link carries it after the # (the room's
 * computer writes it, server/index.ts inviteLink). The browser client
 * and the phone read the same five things. */
export interface RoomInvite {
  id: string;
  relayUrl: string;
  relayToken: string;
  secret: string;
  roomName: string;
  hostName: string;
}

/** The room's invite in what was pasted or handed over by a link
 * (https://bloks.dev/join#..., bloks://join#..., either without its
 * scheme), or null when it is not one. */
export function parseRoomInvite(raw: unknown): RoomInvite | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const text = raw.trim();
  const hash = text.indexOf("#");
  if (hash < 0 || !/(^|\/)join\/?$/i.test(text.slice(0, hash))) return null;
  const fragment = text.slice(hash + 1);
  if (!/^[A-Za-z0-9_-]{40,4000}$/.test(fragment)) return null;
  try {
    const p = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as Record<string, unknown>;
    if (p.v !== 1) return null;
    const relayUrl = typeof p.r === "string" ? p.r.replace(/\/+$/, "") : "";
    if (!/^https:\/\/|^http:\/\/127\.0\.0\.1(:\d+)?$/.test(relayUrl)) return null;
    if (typeof p.t !== "string" || !p.t || typeof p.s !== "string" || !p.s) return null;
    if (typeof p.i !== "string" || !p.i.startsWith("inv_")) return null;
    const clean = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : fallback);
    return { id: p.i, relayUrl, relayToken: p.t, secret: p.s, roomName: clean(p.room, "a room"), hostName: clean(p.host, "Someone") };
  } catch {
    return null;
  }
}

interface RoomSession {
  id: string;
  invite: RoomInvite;
  /** The room's own key for this invite, from the link's secret. */
  secretHash: string;
  deviceToken: string;
  tokenHash: string;
  createdAt: number;
}

/** A room has no mark of its own; the one a workspace with none gets. */
const ROOM_MARK = { color: "#5B5F6B", pattern: "010111101" };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function readPreview(raw: unknown, fallbackPublicId: string): FoundInvite | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const mark = (p.mark ?? {}) as Record<string, unknown>;
  if (typeof p.workspace !== "string") return null;
  return {
    publicId: typeof p.publicId === "string" ? p.publicId : fallbackPublicId,
    workspace: p.workspace.slice(0, 60),
    mark: {
      color: typeof mark.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(mark.color) ? mark.color : "#5B5F6B",
      pattern: typeof mark.pattern === "string" && /^[01]{9}$/.test(mark.pattern) ? mark.pattern : "010111101",
    },
    inviter: typeof p.inviter === "string" ? p.inviter.slice(0, 60) : "Someone",
    role: p.role === "admin" ? "admin" : "member",
    expiresAt: typeof p.expiresAt === "number" ? p.expiresAt : null,
    password: typeof p.password === "boolean" ? p.password : null,
  };
}

export class JoinClient {
  private sessions = new Map<string, Session>();
  private rooms = new Map<string, RoomSession>();
  private readonly relayBase: () => string;
  private readonly fetcher: Fetch;

  /** Bloks Cloud turned off where this runs (BLOKS_CLOUD=off): an invite
   * is found on this network or not at all. */
  private readonly cloudOff: () => boolean;

  constructor(relayBase: () => string, fetcher: Fetch = fetch, cloudOff: () => boolean = () => false) {
    this.relayBase = relayBase;
    this.cloudOff = cloudOff;
    this.fetcher = fetcher;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(id);
    for (const [id, s] of this.rooms) if (now - s.createdAt > SESSION_TTL_MS) this.rooms.delete(id);
  }

  /** One sealed request to the host, and its opened answer. */
  private async ask(s: Session, path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> } | JoinFailure> {
    const shared = invites.agree(s.key.privateKey, s.hostKey);
    if (!shared) return { ok: false, status: 502, code: "bad_host", error: "That invite's computer answered with a key that does not work." };
    const d = `wjn_${s.via === "lan" ? "lan" : s.publicId}.${s.key.publicRaw}`;
    const payload = seal(invites.joinKey(shared, "joiner-to-host"), d, {
      method: "POST",
      path,
      body: { code: s.code, ...body },
      ts: Date.now(),
      nonce: randomUUID(),
    });
    let res: Response;
    try {
      if (s.via === "lan") {
        res = await this.fetcher(`http://${s.lan}/api/join/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ payload }),
          signal: AbortSignal.timeout(15_000),
        });
      } else if (s.clientToken) {
        // the way a member's phone asks: the relay client token it was given
        res = await this.fetcher(`${s.relayUrl}/space/client/ask`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.clientToken}` },
          body: JSON.stringify({ payload }),
          signal: AbortSignal.timeout(25_000),
        });
      } else {
        res = await this.fetcher(`${s.relayUrl}/invites/ask`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicId: s.publicId, payload }),
          signal: AbortSignal.timeout(25_000),
        });
      }
    } catch {
      return s.via === "lan"
        ? { ok: false, status: 503, code: "unreachable", error: `${s.invite.inviter}'s computer did not answer on this network.` }
        : { ok: false, status: 503, code: "offline", error: `Bloks Cloud could not be reached. Check ${thisMachine()}'s connection.` };
    }
    const outer = (await res.json().catch(() => ({}))) as { status?: number; payload?: string; error?: string };
    if (res.status === 503 || res.status === 504) {
      return { ok: false, status: 503, code: "unreachable", error: `${s.invite.inviter}'s computer is not reachable. It may be asleep or offline.` };
    }
    const envelope = typeof outer.payload === "string" ? peek(outer.payload) : null;
    const answer = envelope ? (open(invites.joinKey(shared, "host-to-joiner"), envelope) as { status?: number; body?: unknown } | null) : null;
    if (!answer || typeof answer.status !== "number") {
      return { ok: false, status: 502, code: "unreachable", error: outer.error ?? `${s.invite.inviter}'s computer did not answer that.` };
    }
    return { status: answer.status, body: (answer.body ?? {}) as Record<string, unknown> };
  }

  /**
   * Finds the invite behind what was pasted or typed. On this network
   * first when the link says where, then through Bloks Cloud.
   */
  async lookup(input: unknown): Promise<{ ok: true; session: string; invite: FoundInvite; via: "relay" | "lan" } | JoinFailure> {
    this.sweep();
    const room = parseRoomInvite(input);
    if (room) return this.lookupRoom(room);
    const parsed = invites.parseInviteInput(input);
    if (!parsed) return { ok: false, status: 400, code: "not_a_code", error: "That is not an invite link or code. A code has 8 letters and numbers, like K7QF-M2XR." };
    const base = () => {
      const deviceToken = randomBytes(32).toString("base64url");
      return { id: randomUUID(), code: parsed.code, key: invites.newJoinKeyPair(), deviceToken, tokenHash: sha256(deviceToken), createdAt: Date.now(), relayUrl: this.relayBase() };
    };

    if (parsed.lan) {
      try {
        const keyRes = await this.fetcher(`http://${parsed.lan}/api/join/key`, { signal: AbortSignal.timeout(4_000) });
        const keyBody = (await keyRes.json().catch(() => ({}))) as { hostKey?: unknown; workspace?: unknown };
        if (keyRes.ok && typeof keyBody.hostKey === "string") {
          const s: Session = {
            ...base(),
            publicId: parsed.publicId ?? "lan",
            hostKey: keyBody.hostKey,
            via: "lan",
            lan: parsed.lan,
            invite: { publicId: parsed.publicId ?? "lan", workspace: String(keyBody.workspace ?? "A workspace"), mark: { color: "#5B5F6B", pattern: "010111101" }, inviter: "The owner", role: "member", expiresAt: null, password: null },
          };
          const found = await this.ask(s, "/api/join/lookup", {});
          if ("ok" in found) return found;
          if (found.status !== 200) return failure(found);
          const invite = readPreview({ ...((found.body.preview as object) ?? {}), publicId: found.body.publicId }, s.publicId);
          if (!invite) return { ok: false, status: 502, code: "unreachable", error: `The invite's computer answered in a way ${thisMachine()} does not understand.` };
          s.invite = invite;
          s.publicId = invite.publicId;
          this.sessions.set(s.id, s);
          return { ok: true, session: s.id, invite, via: "lan" };
        }
      } catch {
        /* not on this network after all: Bloks Cloud may still know it */
      }
    }

    if (this.cloudOff()) {
      return { ok: false, status: 409, code: "cloud_off", error: "Bloks Cloud is off where this runs, so an invite is found only on this network. Use the invite's link from the same network as its computer." };
    }
    const relay = this.relayBase();
    let res: Response;
    try {
      res = await this.fetcher(`${relay}/invites/lookup?code=${parsed.code}`, { signal: AbortSignal.timeout(10_000) });
    } catch {
      return { ok: false, status: 503, code: "offline", error: `Bloks Cloud could not be reached. Check ${thisMachine()}'s connection, then try again.` };
    }
    if (res.status === 429) {
      const said = (await res.json().catch(() => ({}))) as { retryAfter?: unknown };
      const wait = typeof said.retryAfter === "number" && said.retryAfter > 0 ? Math.ceil(said.retryAfter) : 60;
      return { ok: false, status: 429, code: "rate_limited", error: `Too many tries. Wait ${wait < 90 ? "a minute" : `${Math.ceil(wait / 60)} minutes`}, then try again.`, retryAfter: wait } as JoinFailure;
    }
    if (res.status === 400) return { ok: false, status: 400, code: "not_a_code", error: "That is not an invite code. A code has 8 letters and numbers, like K7QF-M2XR." };
    if (res.status === 404 || res.status === 410) {
      // a link whose page still exists but whose code does not match is a
      // typo; one whose page is gone too is an invite that has ended
      if (parsed.publicId) {
        const preview = await this.fetcher(`${relay}/invites/preview/${parsed.publicId}`, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
        if (preview && preview.status === 404) return { ok: false, status: 410, code: "expired", error: "This invite has expired. Ask for a new one: it takes them a second." };
      }
      return res.status === 410
        ? { ok: false, status: 410, code: "expired", error: "This invite has expired. Ask for a new one: it takes them a second." }
        : { ok: false, status: 404, code: "wrong_code", error: "That code does not match an invite. Check each letter and try again." };
    }
    if (!res.ok) return { ok: false, status: 502, code: "offline", error: "Bloks Cloud could not look that up just now. Try again in a moment." };
    const body = (await res.json().catch(() => ({}))) as { publicId?: unknown; preview?: unknown; expiresAt?: unknown; host?: Record<string, unknown> };
    const host = body.host ?? {};
    const preview = (body.preview ?? {}) as Record<string, unknown>;
    const publicId = typeof body.publicId === "string" ? body.publicId : (parsed.publicId ?? "");
    const hostKey = typeof host.key === "string" ? host.key : null;
    const invite = readPreview({ ...preview, expiresAt: body.expiresAt }, publicId);
    if (!invite || !/^[a-z0-9]{6}$/.test(publicId)) {
      return { ok: false, status: 502, code: "offline", error: "Bloks Cloud answered without what joining needs. Try again in a moment." };
    }
    // An invite registered without a key was made by a Bloks that cannot
    // take a sealed request yet: there is nothing safe to send it.
    if (!hostKey) return { ok: false, status: 409, code: "host_outdated", error: `${invite.inviter}'s Bloks needs an update before people can join it this way.` };
    if (parsed.publicId && parsed.publicId !== publicId) return { ok: false, status: 404, code: "wrong_code", error: "That code does not match this invite link. Check each letter and try again." };
    const relayUrl = typeof host.relay === "string" && /^https:\/\/|^http:\/\/127\.0\.0\.1/.test(host.relay) ? host.relay.replace(/\/+$/, "") : relay;
    const clientToken = typeof host.token === "string" && host.token.length >= 16 ? host.token : undefined;
    const s: Session = { ...base(), relayUrl, publicId, hostKey, via: "relay", ...(clientToken ? { clientToken } : {}), invite };
    this.sessions.set(s.id, s);
    // Ask the host itself whether it wants a password: the relay does not
    // know, and the form should show the field before anyone has to guess.
    // An asleep host only means the form finds out on asking.
    const asked = await this.ask(s, "/api/join/lookup", {});
    if (!("ok" in asked) && asked.status === 200) {
      const said = readPreview(asked.body.preview, publicId);
      if (said) s.invite = { ...s.invite, password: said.password, expiresAt: said.expiresAt ?? s.invite.expiresAt };
    } else if (!("ok" in asked)) {
      // the host answered no: this invite is over, and says how
      const failed = failure(asked);
      if (["expired", "cancelled", "used", "closed", "declined"].includes(failed.code)) {
        this.sessions.delete(s.id);
        return failed;
      }
    }
    return { ok: true, session: s.id, invite: s.invite, via: "relay" };
  }

  private session(id: unknown): Session | null {
    return typeof id === "string" ? (this.sessions.get(id) ?? null) : null;
  }

  /** The four words this side shows for a session. */
  phrase(id: string): string | null {
    const s = this.sessions.get(id);
    return s ? joinPhrase(invites.codeHash(s.code), s.tokenHash, s.hostKey) : null;
  }

  /** What an approved answer becomes: the credentials to keep, shaped as
   * the remote proxy takes a profile (electron/remote.mjs). */
  private credentials(s: Session, body: Record<string, unknown>) {
    const relay = (body.relay ?? null) as { url?: unknown; clientToken?: unknown } | null;
    const relayUrl = typeof relay?.url === "string" ? relay.url : s.via === "relay" ? s.relayUrl : null;
    const relayToken = typeof relay?.clientToken === "string" ? relay.clientToken : (s.clientToken ?? null);
    return {
      relayUrl,
      relayToken,
      deviceId: body.deviceId,
      deviceToken: s.deviceToken,
      personId: body.personId,
      role: body.role,
      hostKey: s.hostKey,
      lan: typeof body.lan === "string" ? body.lan : (s.lan ?? null),
      workspace: (body.welcome as { workspace?: unknown } | undefined)?.workspace ?? null,
    };
  }

  private shape(s: Session, answer: { status: number; body: Record<string, unknown> }) {
    const b = answer.body;
    if (answer.status === 200 && b.status === "approved") {
      return { ok: true as const, status: "approved", phrase: this.phrase(s.id), welcome: b.welcome, credentials: this.credentials(s, b) };
    }
    if (answer.status === 200 && b.status === "waiting") return { ok: true as const, status: "waiting", phrase: this.phrase(s.id) };
    return failure(answer);
  }

  async claim(id: unknown, input: { name: unknown; password?: unknown }) {
    const room = typeof id === "string" ? this.rooms.get(id) : undefined;
    if (room) return this.claimRoom(room, input.name);
    const s = this.session(id);
    if (!s) return { ok: false, status: 404, code: "no_session", error: "Look the invite up again." } satisfies JoinFailure;
    const answer = await this.ask(s, "/api/join/claim", {
      name: input.name,
      ...(typeof input.password === "string" && input.password ? { password: input.password } : {}),
      tokenHash: s.tokenHash,
      device: machineKind(),
      ...(s.clientToken ? { relayClient: sha256(s.clientToken) } : {}),
    });
    return "ok" in answer ? answer : this.shape(s, answer);
  }

  async status(id: unknown) {
    const room = typeof id === "string" ? this.rooms.get(id) : undefined;
    if (room) return this.roomStatus(room);
    const s = this.session(id);
    if (!s) return { ok: false, status: 404, code: "no_session", error: "Look the invite up again." } satisfies JoinFailure;
    const answer = await this.ask(s, "/api/join/status", { tokenHash: s.tokenHash });
    return "ok" in answer ? answer : this.shape(s, answer);
  }

  async cancel(id: unknown) {
    // a room's request has no taking back on its computer: it is let go
    // here, and lapses with the invite there
    if (typeof id === "string" && this.rooms.delete(id)) return { ok: true };
    const s = this.session(id);
    if (!s) return { ok: true };
    await this.ask(s, "/api/join/cancel", { tokenHash: s.tokenHash });
    this.sessions.delete(s.id);
    return { ok: true };
  }

  // ── one shared room ──────────────────────────────────────────────────
  // The way the browser client and the phone join a room: through Bloks
  // Cloud with the pass the link carries, sealed with the key from the
  // link's secret, and only the two invite routes the room's computer
  // answers for it (server/relay-link.ts, INVITE_ROUTES). Once let in,
  // the pass and this device's token are a guest's credentials, which the
  // remote proxy takes like any joined workspace's.

  /** One sealed request about a room's invite, and its opened answer. */
  private async askRoom(r: RoomSession, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> } | JoinFailure> {
    const who = r.invite.hostName;
    const payload = seal(inviteKey(r.secretHash, "phone-to-mac"), r.invite.id, {
      method,
      path,
      ...(body ? { body } : {}),
      ...(method === "GET" ? {} : { ts: Date.now(), nonce: randomUUID() }),
    });
    let res: Response;
    try {
      res = await this.fetcher(`${r.invite.relayUrl}/space/client/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${r.invite.relayToken}` },
        body: JSON.stringify({ payload }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      return { ok: false, status: 503, code: "offline", error: `Bloks Cloud could not be reached. Check ${thisMachine()}'s connection.` };
    }
    const outer = (await res.json().catch(() => ({}))) as { status?: number; payload?: string; error?: string };
    if (res.status === 503 || res.status === 504) {
      return { ok: false, status: 503, code: "unreachable", error: `${who}'s computer is not reachable. It may be asleep or offline.` };
    }
    // the pass the link carried is no longer taken: the room stopped
    // being shared, or the invite was closed
    if (res.status === 401) return { ok: false, status: 410, code: "expired", error: "This invite has expired or was cancelled. Ask for a new one.", host: who };
    const envelope = typeof outer.payload === "string" && outer.payload ? peek(outer.payload) : null;
    const answer = envelope ? (open(inviteKey(r.secretHash, "mac-to-phone"), envelope) as { status?: number; body?: unknown } | null) : null;
    if (!answer || typeof answer.status !== "number") {
      if (outer.status === 401) return { ok: false, status: 410, code: "expired", error: "This invite has expired or was cancelled. Ask for a new one.", host: who };
      return { ok: false, status: 502, code: "unreachable", error: outer.error ?? `${who}'s computer did not answer that.` };
    }
    return { status: answer.status, body: (answer.body ?? {}) as Record<string, unknown> };
  }

  private roomPhrase(r: RoomSession): string {
    return checkPhrase(r.secretHash, r.tokenHash);
  }

  /** An invite that is over, by how its computer said it. */
  private roomEnded(r: RoomSession, status: unknown): JoinFailure | null {
    const host = r.invite.hostName;
    if (status === "declined") return { ok: false, status: 409, code: "declined", error: `${host} did not let this request in.`, host };
    if (status === "cancelled") return { ok: false, status: 410, code: "cancelled", error: "This invite was cancelled. Ask for a new one.", host };
    if (status === "expired") return { ok: false, status: 410, code: "expired", error: "This invite has expired. Ask for a new one.", host };
    return null;
  }

  private async lookupRoom(invite: RoomInvite) {
    const deviceToken = randomBytes(32).toString("base64url");
    const r: RoomSession = { id: randomUUID(), invite, secretHash: sha256(invite.secret), deviceToken, tokenHash: sha256(deviceToken), createdAt: Date.now() };
    const answer = await this.askRoom(r, "GET", "/api/member/claim");
    if ("ok" in answer) return answer;
    if (answer.status !== 200) return roomFailure(r, answer);
    const ended = this.roomEnded(r, answer.body.status);
    if (ended) return ended;
    // somebody already asked with this invite, or was let in with it
    if (answer.body.status !== "open") return { ok: false as const, status: 409, code: "used", error: "Someone has already used this invite. Ask for a new one.", host: invite.hostName };
    const said = (answer.body.room ?? {}) as { name?: unknown };
    const roomName = typeof said.name === "string" && said.name.trim() ? said.name.trim().slice(0, 60) : invite.roomName;
    const hostName = typeof answer.body.host === "string" && answer.body.host.trim() ? answer.body.host.trim().slice(0, 60) : invite.hostName;
    r.invite = { ...invite, roomName, hostName };
    this.rooms.set(r.id, r);
    const found: FoundInvite = { publicId: "room", workspace: roomName, mark: ROOM_MARK, inviter: hostName, role: "member", expiresAt: null, password: false, room: true };
    return { ok: true as const, session: r.id, invite: found, via: "relay" as const };
  }

  private async claimRoom(r: RoomSession, name: unknown) {
    if (typeof name !== "string" || !name.trim()) return { ok: false, status: 400, code: "invalid", error: "A name is needed." } satisfies JoinFailure;
    const answer = await this.askRoom(r, "POST", "/api/member/claim", { name: name.trim(), token: r.deviceToken });
    if ("ok" in answer) return answer;
    if (answer.status !== 200) return roomFailure(r, answer);
    // let in at once is still told by the next look, with who this is now
    return answer.body.status === "approved" ? this.roomStatus(r) : { ok: true as const, status: "waiting", phrase: this.roomPhrase(r) };
  }

  private async roomStatus(r: RoomSession) {
    const answer = await this.askRoom(r, "GET", "/api/member/claim");
    if ("ok" in answer) return answer;
    if (answer.status !== 200) return roomFailure(r, answer);
    const b = answer.body;
    const ended = this.roomEnded(r, b.status);
    if (ended) return ended;
    if (b.status !== "approved") return { ok: true as const, status: "waiting", phrase: this.roomPhrase(r) };
    if (typeof b.deviceId !== "string" || typeof b.personId !== "string") {
      return { ok: false, status: 502, code: "unreachable", error: `${r.invite.hostName}'s computer let you in but did not say who you are now. Open the invite link again.` } satisfies JoinFailure;
    }
    const room = (b.room ?? {}) as { id?: unknown; name?: unknown };
    const name = typeof room.name === "string" && room.name.trim() ? room.name.trim().slice(0, 60) : r.invite.roomName;
    const workspace = { id: typeof room.id === "string" ? room.id : "room", name, kind: "room", mark: ROOM_MARK };
    this.rooms.delete(r.id);
    return {
      ok: true as const,
      status: "approved",
      phrase: this.roomPhrase(r),
      welcome: { workspace, inviter: r.invite.hostName, approvedBy: r.invite.hostName, role: "member", agents: [], agentCount: 0, room: true },
      credentials: {
        relayUrl: r.invite.relayUrl,
        relayToken: r.invite.relayToken,
        deviceId: b.deviceId,
        deviceToken: r.deviceToken,
        personId: b.personId,
        role: "member",
        hostKey: "",
        lan: null,
        workspace,
      },
    };
  }
}

/** A room's computer saying no, in the words the join dialog knows. */
function roomFailure(r: RoomSession, answer: { status: number; body: Record<string, unknown> }): JoinFailure {
  const said = typeof answer.body.error === "string" ? answer.body.error : "";
  const host = r.invite.hostName;
  if (/already used/i.test(said)) return { ok: false, status: 409, code: "used", error: "Someone has already used this invite. Ask for a new one.", host };
  if (/expired|cancelled/i.test(said)) return { ok: false, status: 410, code: "expired", error: "This invite has expired or was cancelled. Ask for a new one.", host };
  if (/name/i.test(said)) return { ok: false, status: 400, code: "invalid", error: "A name is needed.", host };
  return { ok: false, status: answer.status, code: "unreachable", error: said || `${host}'s computer did not answer that.`, host };
}

function failure(answer: { status: number; body: Record<string, unknown> }): JoinFailure {
  const b = answer.body;
  return {
    ok: false,
    status: answer.status,
    code: typeof b.code === "string" ? b.code : "unreachable",
    error: typeof b.error === "string" ? b.error : "That did not work. Try again.",
    ...(typeof b.triesLeft === "number" ? { triesLeft: b.triesLeft } : {}),
    ...(typeof b.host === "string" ? { host: b.host.slice(0, 60) } : {}),
    ...(typeof b.workspace === "string" ? { workspace: b.workspace.slice(0, 60) } : {}),
  };
}
