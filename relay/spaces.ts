// Spaces, links, and the in-flight request table.
//
// A space is one user's Bloks: one Mac that dials in, and the phones that
// belong to it. Everything here is routing. Nothing in this file can read
// a payload, and nothing in this file should ever learn how.
//
// Kept separate from the HTTP layer so the interesting behaviour (a Mac
// that is offline, a request nobody answers, a token that is wrong) can be
// tested without sockets.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** How long a client request waits for the Mac before giving up. Agent
 * turns are long, but this is only the round trip for ACCEPTING the
 * command, not for finishing the work: the harness answers 202 quickly and
 * the actual reply arrives later on the event stream. */
export const REQUEST_TIMEOUT_MS = 20_000;

/** An idle Mac link is dropped after this. It sends a keepalive well
 * inside the window; anything quieter than this is a dead socket holding a
 * space open. */
export const LINK_IDLE_MS = 90_000;

/** Ciphertext only, but a cap all the same: a space that can push
 * unbounded blobs through a shared relay is a denial of service. */
export const MAX_PAYLOAD_BYTES = 2_000_000;

export type Role = "agent" | "client";

export interface Space {
  id: string;
  /** sha256 of the token the Mac authenticates with. Never the token. */
  agentTokenHash: string;
  /** sha256 of each paired phone's token. */
  clientTokenHashes: string[];
  createdAt: number;
}

/** A command travelling phone to Mac. `payload` is opaque ciphertext. */
export interface Ask {
  id: string;
  payload: string;
  at: number;
}

/** What the Mac sends back for an ask. */
export interface Answer {
  id: string;
  status: number;
  payload: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Constant time compare. Length may leak; both sides are hex digests. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class SpaceRegistry {
  private spaces = new Map<string, Space>();
  /** Macs currently holding a command stream open, by space id. */
  private links = new Map<string, { lastSeen: number; deliver: (ask: Ask) => void }>();
  /** Asks waiting for the Mac to answer, by ask id. */
  private waiting = new Map<
    string,
    { spaceId: string; settle: (answer: Answer) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Phones listening for events, by space id. */
  private listeners = new Map<string, Set<(payload: string) => void>>();

  create(): { space: Space; agentToken: string; clientToken: string } {
    const agentToken = newToken();
    const clientToken = newToken();
    const space: Space = {
      id: randomBytes(9).toString("base64url"),
      agentTokenHash: sha256(agentToken),
      clientTokenHashes: [sha256(clientToken)],
      createdAt: Date.now(),
    };
    this.spaces.set(space.id, space);
    return { space, agentToken, clientToken };
  }

  get(id: string): Space | null {
    return this.spaces.get(id) ?? null;
  }

  /** Adds another phone to an existing space. */
  addClient(spaceId: string): string | null {
    const space = this.spaces.get(spaceId);
    if (!space) return null;
    const token = newToken();
    space.clientTokenHashes.push(sha256(token));
    return token;
  }

  revokeClients(spaceId: string): void {
    const space = this.spaces.get(spaceId);
    if (space) space.clientTokenHashes = [];
  }

  /**
   * The space a token belongs to, and as what.
   *
   * Deliberately returns the role rather than a boolean: an agent token
   * must never be usable to read the client stream, or a stolen Mac
   * credential would also be a listening device.
   */
  authenticate(token: string | null): { space: Space; role: Role } | null {
    if (!token) return null;
    const digest = sha256(token);
    for (const space of this.spaces.values()) {
      if (sameDigest(digest, space.agentTokenHash)) return { space, role: "agent" };
      for (const hash of space.clientTokenHashes) {
        if (sameDigest(digest, hash)) return { space, role: "client" };
      }
    }
    return null;
  }

  // ── the Mac's command stream ────────────────────────────────────────

  openLink(spaceId: string, deliver: (ask: Ask) => void): void {
    // One Mac per space. A second connection replaces the first rather
    // than racing it: two Macs answering the same ask is worse than a
    // reconnect losing one. The deliver fn doubles as the link's identity,
    // so a stale socket's close handler cannot reap the fresh one.
    this.links.set(spaceId, { lastSeen: Date.now(), deliver });
  }

  /** Close a link only if `deliver` still owns the record. Without the
   * identity check, a zombie socket's late close handler would delete the
   * healthy replacement link a reconnect just installed. */
  closeLink(spaceId: string, deliver?: (ask: Ask) => void): void {
    const link = this.links.get(spaceId);
    if (!link) return;
    if (deliver && link.deliver !== deliver) return;
    this.links.delete(spaceId);
  }

  touchLink(spaceId: string): void {
    const link = this.links.get(spaceId);
    if (link) link.lastSeen = Date.now();
  }

  isOnline(spaceId: string): boolean {
    const link = this.links.get(spaceId);
    if (!link) return false;
    // Report stale as offline, but do NOT delete: the Mac's stream may be
    // healthy and simply between keepalives, and deleting here would leave
    // touchLink a no-op forever, so a resumed keepalive could never
    // revive the link. Reaping belongs to closeLink alone.
    return Date.now() - link.lastSeen <= LINK_IDLE_MS;
  }

  // ── phone to Mac and back ───────────────────────────────────────────

  /**
   * Hands an ask to the Mac and resolves when it answers.
   *
   * Rejects immediately when the Mac is not connected, rather than hanging
   * for the timeout: "your Mac is not online" is a useful thing to tell
   * somebody, and twenty seconds of spinner is not.
   */
  ask(spaceId: string, payload: string): Promise<Answer> {
    if (!this.isOnline(spaceId)) {
      return Promise.reject(new Error("offline"));
    }
    const id = randomBytes(8).toString("hex");
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("timeout"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.waiting.set(id, { spaceId, settle: resolve, timer });
      this.links.get(spaceId)?.deliver({ id, payload, at: Date.now() });
    });
  }

  /** The Mac answering an ask. Ignores anything it was not asked. */
  answer(spaceId: string, answer: Answer): boolean {
    const pending = this.waiting.get(answer.id);
    // The space check matters: without it, one space could settle another
    // space's request by guessing an id.
    if (!pending || pending.spaceId !== spaceId) return false;
    this.waiting.delete(answer.id);
    clearTimeout(pending.timer);
    pending.settle(answer);
    return true;
  }

  // ── Mac to phones ───────────────────────────────────────────────────

  listen(spaceId: string, send: (payload: string) => void): () => void {
    let set = this.listeners.get(spaceId);
    if (!set) {
      set = new Set();
      this.listeners.set(spaceId, set);
    }
    set.add(send);
    return () => {
      set!.delete(send);
      if (set!.size === 0) this.listeners.delete(spaceId);
    };
  }

  /** Fans an opaque event frame out to every phone on this space. */
  broadcast(spaceId: string, payload: string): number {
    const set = this.listeners.get(spaceId);
    if (!set) return 0;
    for (const send of [...set]) {
      try {
        send(payload);
      } catch {
        set.delete(send);
      }
    }
    return set.size;
  }

  listenerCount(spaceId: string): number {
    return this.listeners.get(spaceId)?.size ?? 0;
  }
}
