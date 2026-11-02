// The Mac's outbound line to the relay.
//
// Pairing over the network needs both devices on it. This is the other
// half: the Mac dials out and holds one long stream open, so a phone can
// reach it from anywhere without a single inbound port, a public address,
// or anything for a router to forward. Outbound-only is also why this
// works on hotel wifi and behind carrier NAT, which is where a phone
// actually is when you need it.
//
// Three rules the rest of the file exists to keep:
//
//   Nothing readable leaves. Every payload is sealed for one paired
//   device before it goes near the relay, and arrives sealed. See
//   relay-crypto.ts for why both ends can derive the same key and the
//   relay cannot.
//
//   A phone through the relay is exactly a phone on the network: no more
//   and no less. The decrypted request is replayed against our own HTTP
//   surface as a REMOTE, paired caller, so every check that applies to a
//   LAN device applies here too. Local-only routes stay local-only.
//
//   The line is disposable. Any error closes it and it dials again with a
//   backoff; the Mac being asleep for six hours is the normal case, not
//   an incident.
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IncomingMessage } from "node:http";

import { deviceKey, inviteKey, open, peek, seal, type Envelope, type RelayRequest } from "./relay-crypto.ts";
import { linkAskValid, sealForRequester, type OwnerLink } from "./owner-link.ts";
import { markSeen, pairedDevices } from "./pairing.ts";
import type { ActivityPush, PushResult } from "./live-activities.ts";
import { thisMachine } from "./this-machine.ts";

/** Why the line went down, in words a settings screen can show. Node's
 * fetch says only "fetch failed" and keeps the reason in its cause, and
 * an abort here is the watchdog, which means nothing arrived in time.
 * Never the request itself: that carries the token. */
function lineProblem(e: unknown): string {
  if (!(e instanceof Error)) return "the line failed";
  if (e.name === "AbortError") return "nothing came back for a minute. A proxy or an antivirus that inspects secure connections can hold it back.";
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /CERT|SELF_SIGNED|ISSUER/.test(code)) {
      return "the secure connection was not trusted. A proxy or an antivirus that inspects secure connections is the usual cause.";
    }
    return typeof code === "string" ? `${cause.message} (${code})` : cause.message;
  }
  return e.message;
}

/** Proof that a replayed request came from this process, so the HTTP
 * layer can trust the device attribution without a bearer token it does
 * not have. Regenerated every boot and never written down. */
const INTERNAL = randomBytes(32).toString("hex");
const RELAY_HEADER = "x-bloks-relay";
const DEVICE_HEADER = "x-bloks-relay-device";
const INVITE_HEADER = "x-bloks-relay-invite";
const PARTS_HEADER = "x-bloks-relay-parts";

/** The invite a replayed request speaks for: somebody who has opened an
 * invite link but has no device yet. Null for anything else, and for
 * anything that did not come from this file. */
export function relayInviteFor(req: IncomingMessage): string | null {
  if (req.headers[RELAY_HEADER] !== INTERNAL) return null;
  const id = req.headers[INVITE_HEADER];
  return typeof id === "string" && id.startsWith("inv_") ? id : null;
}

/** The only requests an invite envelope may carry: asking to join, and
 * asking how that is going. Anything else under an invite key is refused
 * here, before it reaches the server at all. */
const INVITE_ROUTES = new Set(["POST /api/member/claim", "GET /api/member/claim"]);
/** The relay takes 2 MB a payload; sealing and base64 add about a third. */
const MAX_RAW_ANSWER = 1_400_000;
/** The relay counts the whole result post against its 2 MB and hangs up
 * past it, which reads here as a lost connection. Stay under with room
 * for the id and status around the payload. */
const MAX_RESULT_POST = 1_950_000;
/** One part of a file sent in parts. Bytes that do not compress grow
 * about 2.37 times on the way (base64 in the answer, again when sealed,
 * again for the trip), so a part this size is a post of about 1,865,000,
 * under MAX_RESULT_POST with room for the fields around it. */
export const RAW_PART_BYTES = 768 * 1024;
/** The most a device that takes parts is sent of one file. Each part is
 * a round trip through the relay, and past this the wait is minutes for
 * something better sent another way. */
export const RAW_PARTS_MAX_BYTES = 50 * 1024 * 1024;
/** What a device is told past RAW_PARTS_MAX_BYTES, in the same words the
 * card and the agent's share answer use. */
export const RAW_PARTS_REFUSAL = `too large to open through Bloks Cloud, which opens files up to ${RAW_PARTS_MAX_BYTES / 1024 / 1024} MB`;
/** A part asked for by a version of the file it no longer is. */
const CHANGED = { error: "the file changed while it was being opened. Open it again.", changed: true };

/** What a part says about the whole it belongs to (RelayResponse). */
type PartFields = { size?: number; parts?: number; part?: number; tag?: string };

/** Whether a path asks for a range itself, as a phone seeking a video does. */
function askedForRange(path: string): boolean {
  try {
    return new URL(path, "http://x").searchParams.has("range");
  } catch {
    return false;
  }
}

/** An answer's bytes, or null once they pass `max`: what is not going to
 * be sent is not read to the end. */
async function readAtMost(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** A tag for an answer that came with none of its own: its bytes. */
function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
}

/** Who a wake should reach: everybody (a string) or the phones registered
 * by the named relay client digests. `preview` asks for the notification's
 * real words to ride along, sealed separately for each device (see
 * publish), so a phone can show them without the relay reading them. */
export type Wake = string | { reason: string; clients?: string[]; preview?: boolean };

/** What a phone's lock screen shows for one wake, and what its buttons act
 * on. Small on purpose: it travels inside a push, which Apple caps. */
export interface WakePreview {
  title: string;
  body: string;
  /** "approval" gets Allow and Deny on the lock screen. "reply" is an
   * answer the person was waiting on (server/answer-ready.ts). */
  category?: "approval" | "question" | "mention" | "brief" | "reply";
  botId?: string;
  requestId?: string;
  threadId?: string;
  /** "brief": the brief this is about, so a tap opens that morning's and
   * not whichever is newest by then. */
  briefId?: string;
}

/** The build label a sealed request carried, as the header a request on
 * the network would have sent it in. Shaped like a header value or not at
 * all: it ends up in one. */
function clientHeader(request: RelayRequest): Record<string, string> {
  const label = request.client;
  return typeof label === "string" && label.length <= 40 && /^[\w .()+/-]+$/.test(label)
    ? { "x-bloks-client": label }
    : {};
}

/** Whether a replayed request came from a device that takes a file in
 * parts (servePart), which opens files up to RAW_PARTS_MAX_BYTES rather
 * than one answer's worth. False for anything that did not come from
 * this file. */
export function relayTakesParts(req: IncomingMessage): boolean {
  return req.headers[RELAY_HEADER] === INTERNAL && req.headers[PARTS_HEADER] === "1";
}

/** The device id a replayed relay request speaks for, or null for
 * anything that did not come from this file. */
export function relayDeviceFor(req: IncomingMessage): string | null {
  if (req.headers[RELAY_HEADER] !== INTERNAL) return null;
  const id = req.headers[DEVICE_HEADER];
  return typeof id === "string" && id ? id : null;
}

export interface RelayConfig {
  url: string;
  agentToken: string;
}

export interface RelayState {
  configured: boolean;
  connected: boolean;
  /** Whether what this Mac sends is landing: answers to the phone's
   * requests and the frames it pushes. The stream coming in is a
   * separate thing, and on a lossy line it can stay open while replies
   * go nowhere, so `connected` alone is not "working". */
  delivering: boolean;
  spaceId: string | null;
  /** Last failure, for the settings screen. Never a secret. */
  problem: string | null;
  since: number | null;
}

const RETRY_MIN_MS = 2_000;
// the cap, which tests shorten to see a refused Mac try again
const RETRY_MAX_MS = Number(process.env.BLOKS_RELAY_RETRY_MAX_MS) || 60_000;
/** The relay drops a link it has not heard from; speak well inside that. */
const KEEPALIVE_MS = 30_000;
/** One push's limits, well inside the relay's 2 MB body cap. */
const BATCH_BYTES = 1_500_000;
const BATCH_FRAMES = 500;
/** Pushes held while the line is slow, before the oldest are let go. */
const OUTBOX_LIMIT = 2_000;
/** No bytes from the relay for this long means a dead socket the OS has
 * not reported. The relay's own keepalive is every 25s, so 60s is two
 * missed beats. */
const WATCHDOG_MS = 60_000;
/** How far a mutating request's timestamp may be from now. Wide enough
 * for a slow relay hop and modest clock skew, tight enough that a
 * captured frame is useless minutes later. */
const REPLAY_WINDOW_MS = 120_000;
/** The most of a followed stream (openStream) held while waiting for the
 * end of one of its events. */
const MAX_LINE_BUFFER = 5_000_000;
/** The longest frame the relay's stream is read for (FrameReader). The
 * relay refuses a request over 2,000,000 bytes before it gets here, and
 * writes each as one line, `data: {"kind":"ask","id":...,"payload":...}`,
 * whose payload is base64 that JSON adds nothing to; so the largest ask it
 * carries is that and about a hundred characters more. A quarter on top
 * is room for the frame around it to grow, and a frame past this is not
 * one the relay carries. */
export const MAX_FRAME_CHARS = 2_500_000;
/** How much of a frame too long to hold is kept: its id and the device its
 * envelope names come first, well inside this. */
const FRAME_HEAD_CHARS = 4096;
/** Event streams a paired device may follow through Bloks Cloud (see
 * serveStream): an agent's terminals, whose output is a live stream and
 * not a request and its answer. */
const STREAMABLE = [/^\/api\/bots\/[\w-]+\/terminals\/stream$/, /^\/api\/bots\/[\w-]+\/terminal\/stream$/];
/** A followed stream ends unless the device says it is still watching
 * within this long, so a window that closed without saying so does not
 * leave a stream running here for nobody. */
const STREAM_LEASE_MS = 60_000;
const STREAMS_PER_DEVICE = 8;
/** A line of a followed stream longer than this travels in pieces, so no
 * one frame outgrows what one push to the relay carries. */
const STREAM_PIECE = 256 * 1024;
/** How often the next due time is said again when it has not changed:
 * the relay forgets it once it has woken the machine for it. */
const NEXT_DUE_REPEAT_MS = 10 * 60_000;

/**
 * The nonces of mutating requests already served. Each is kept until its
 * own timestamp stops being fresh, since until then a repeat would pass
 * the freshness check. Clearing the whole set on a timer used to forget a
 * nonce while its timestamp could still pass, so a request captured just
 * before a clear could be replayed once after it. A nonce is kept at most
 * two windows (a timestamp may be a window ahead of this clock), which is
 * what bounds the set.
 */
export class SeenNonces {
  private until = new Map<string, number>();

  has(nonce: string): boolean {
    return this.until.has(nonce);
  }

  remember(nonce: string, ts: number, now = Date.now()) {
    for (const [seen, stale] of this.until) if (stale < now) this.until.delete(seen);
    this.until.set(nonce, ts + REPLAY_WINDOW_MS);
  }
}
/** How long an answer keeps trying. The relay holds a phone's request for
 * 20s and then tells it the Mac is offline, so past that a retry lands on
 * nobody; a result it no longer waits for is a harmless 202. */
const ANSWER_BUDGET_MS = 20_000;
/** Outbound posts remembered for the health reading. One lost post on a
 * rough line is noise; half of the recent ones failing is a line that
 * looks up and is not. */
const OUTBOUND_WINDOW = 10;
const OUTBOUND_RECOVER = 3;
const NOT_DELIVERING = "The line to Bloks Cloud is open, but replies are not getting through. Retrying.";

export class RelayLink {
  private config: RelayConfig | null = null;
  private controller: AbortController | null = null;
  private retry = RETRY_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  /** Bumped on every stop/configure. A dial whose generation is stale
   * finishes silently instead of stomping the live dial's state or
   * clearing a keepalive it no longer owns. */
  private generation = 0;
  /** Consecutive failed pushes; enough of them means the line is dead
   * even though its read has not returned yet, so we force a redial. */
  private pushFailures = 0;
  /** Pushes waiting their turn. They go out one POST at a time, in order:
   * the relay hands a push's frames on before it answers, so one at a
   * time keeps a reply's frames in the order they happened all the way
   * to the phone. Sent all at once, a late delta could land after the
   * turn ended and the reply showed twice. */
  private outbox: Array<{ frames: string[]; wake?: unknown }> = [];
  private pushing = false;
  /** Recent outbound posts, oldest first: true for one that landed. */
  private outbound: boolean[] = [];
  /** Nonces of mutating requests served recently, so a hostile relay
   * cannot replay a captured "approve" or "send". Bounded and time-swept;
   * the freshness window makes unbounded growth impossible anyway. */
  private seenNonces = new SeenNonces();
  /** Event streams paired devices are following through Bloks Cloud, by
   * the id each was given (serveStream). */
  private streams = new Map<string, { deviceId: string; abort: AbortController; until: number }>();
  private streamSweep: ReturnType<typeof setInterval> | null = null;
  /** When the next routine or watcher is due, as last asked to be said,
   * and what was last said and when (nextDue). */
  private nextDueWanted: number | null | undefined = undefined;
  private nextDueSent: { at: number | null; when: number } | null = null;
  state: RelayState = {
    configured: false,
    connected: false,
    delivering: false,
    spaceId: null,
    problem: null,
    since: null,
  };

  /** Where to replay a decrypted request, i.e. our own loopback port. */
  private readonly port: number;
  /** Told whenever the link's state changes, so the UI can follow. */
  private readonly onChange: (state: RelayState) => void;

  /** How a member sees a frame (server/member-access.ts), or null when
   * they may not see it at all. Owner devices get every frame as is. Set
   * by the server, which knows the rooms. */
  memberFrame: (frame: unknown, personId: string) => unknown | null = () => null;
  /** The lock screen's words for one frame, as one device is allowed to
   * see it, or null for a frame that has none. */
  previewOf: (frame: unknown) => WakePreview | null = () => null;
  /**
   * A webhook some platform sent to Bloks Cloud for this computer (a
   * WhatsApp group message, today), handed over as an ask. Answers the
   * status the relay should give the caller. Not sealed: the caller sent
   * it readable, and its own signature is what gets checked.
   */
  onHook: (hook: { platform: string; body: string; signature: string | null }) => Promise<number> = async () => 404;

  /** The digest of an open invite's secret, for its envelope key, or null
   * when there is no such invite or it has closed. */
  inviteSecret: (inviteId: string) => string | null = () => null;
  /** Pairing through the relay (server/pairing.ts): the digest a link's
   * envelopes are keyed from, and what spending it does. */
  pairSecret: (linkId: string) => string | null = () => null;
  pairClaim: (linkId: string, body: unknown) => unknown | null = () => null;
  /** Somebody holding a workspace invite's code and nothing else
   * (server/members.ts): their sealed request in, the sealed answer out,
   * or null for an envelope that does not open. */
  joinAsk: (envelope: Envelope) => Promise<{ status: number; payload: string } | null> = async () => null;
  /** A pairing link for the owner, when Bloks Cloud asks for one on their
   * behalf (server/owner-link.ts). Only a workspace with no screen of its
   * own makes one; anywhere else this is null and the question is refused. */
  ownerLink: () => OwnerLink | null = () => null;
  /** The licence this workspace was activated with, which signs those
   * questions, or null. */
  licence: () => string | null = () => null;
  /** Called when the relay refuses this Mac's token. Another Bloks on the
   * same ~/.bloks (the app beside a headless server) may have activated
   * Cloud again and saved new tokens this process has not read yet. */
  onRejected: () => void = () => {};

  constructor(port: number, onChange: (state: RelayState) => void = () => {}) {
    this.port = port;
    this.onChange = onChange;
  }

  /** Point the link at a relay, or at nothing. Safe to call repeatedly;
   * an unchanged config is not a reason to drop a working line. */
  configure(config: RelayConfig | null) {
    const same =
      this.config?.url === config?.url && this.config?.agentToken === config?.agentToken;
    if (same && !this.stopped) return;
    this.stop();
    this.config = config?.url && config?.agentToken ? config : null;
    // another relay, or the same one updated: ask it afresh
    this.activitiesMissingUntil = 0;
    this.state = {
      configured: Boolean(this.config),
      connected: false,
      delivering: false,
      spaceId: null,
      problem: null,
      since: null,
    };
    this.onChange(this.state);
    if (this.config) {
      this.stopped = false;
      void this.dial();
    }
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.endStreams();
    this.controller?.abort();
    this.controller = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.state.connected) {
      this.state = { ...this.state, connected: false, delivering: false, spaceId: null, since: null };
      this.onChange(this.state);
    }
  }

  /**
   * Push one broadcast frame out to whatever phones are listening.
   *
   * Sealed once per paired device, because each device holds a different
   * key and the relay is a dumb fan-out. A phone silently drops envelopes
   * addressed to anyone else. `ownersOnly` keeps a frame meant for the
   * owner's own devices off members' phones entirely, rather than trusting
   * member-access.ts to drop a kind it has never heard of. `onlyPerson`
   * is the opposite: a frame about one member's own conversation, sealed
   * for nobody else's devices. `onlyDevice` narrows it to one device.
   */
  publish(frame: unknown, wake?: Wake, ownersOnly = false, onlyPerson?: string, onlyDevice?: string) {
    if (!this.config || !this.state.connected) return;
    const devices = pairedDevices();
    // No devices still posts an empty batch: /space/agent/events touches
    // the link before it reads the body, so this is the heartbeat that
    // keeps the relay from reaping a healthy but deviceless space.
    //
    // A member's device gets the frame as member-access.ts shapes it for
    // them, or not at all: it is sealed only for devices that may read
    // it, so nothing about another room is even delivered as ciphertext.
    const frames: string[] = [];
    // The notification's own words, one sealed copy per device that may
    // see the frame, built from the frame as that device sees it: a
    // member's lock screen never says more than their app would.
    const sealed: Record<string, string> = {};
    const wantsPreview = typeof wake === "object" && wake.preview === true;
    for (const d of devices) {
      if (ownersOnly && d.personId) continue;
      // a member's own conversation goes to that member's devices alone,
      // the owner's included among those it does not go to
      if (onlyPerson && d.personId !== onlyPerson) continue;
      // a stream one device is following is that device's alone
      if (onlyDevice && d.id !== onlyDevice) continue;
      const shown = d.personId ? this.memberFrame(frame, d.personId) : frame;
      if (shown === null || shown === undefined) continue;
      frames.push(seal(deviceKey(d.hash, "mac-to-phone"), d.id, shown));
      if (wantsPreview) {
        const preview = this.previewOf(shown);
        if (preview) sealed[d.id] = seal(deviceKey(d.hash, "mac-to-phone"), d.id, { kind: "preview", ...preview });
      }
    }
    const sent =
      typeof wake === "object"
        ? { reason: wake.reason, ...(wake.clients ? { clients: wake.clients } : {}), ...(Object.keys(sealed).length ? { sealed } : {}) }
        : wake;
    this.outbox.push({ frames, ...(sent ? { wake: sent } : {}) });
    // a dead line is caught by the failures below; until then, the oldest
    // frames are the ones worth least to a phone that catches up anyway
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.splice(0, this.outbox.length - OUTBOX_LIMIT);
    void this.pump();
  }

  /** Sends what is waiting, one POST at a time. Whatever piled up while one
   * was in flight goes as one batch, up to the first push that wakes a
   * phone (a batch carries one wake). */
  private async pump() {
    if (this.pushing) return;
    this.pushing = true;
    try {
      while (this.outbox.length && this.config && this.state.connected) {
        const frames: string[] = [];
        let wake: unknown;
        let bytes = 0;
        while (this.outbox.length) {
          const next = this.outbox[0];
          const size = next.frames.reduce((n, f) => n + f.length, 0);
          if (frames.length && (bytes + size > BATCH_BYTES || frames.length + next.frames.length > BATCH_FRAMES)) break;
          this.outbox.shift();
          frames.push(...next.frames);
          bytes += size;
          if (next.wake !== undefined) {
            wake = next.wake;
            break;
          }
        }
        const ok = await fetch(`${this.config.url}/space/agent/events`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ frames, ...(wake !== undefined ? { wake } : {}) }),
          signal: AbortSignal.timeout(10_000),
        })
          .then((res) => res.ok)
          .catch(() => false);
        // A failed push is a dropped frame, not a broken link on its own.
        // But a run of them means the line is dead while its read still
        // hangs, so force the redial the read has not noticed yet. A line
        // that drops every other post never makes a run, which is what
        // the health reading is for.
        this.pushFailures = ok ? 0 : this.pushFailures + 1;
        this.noteOutbound(ok);
        if (this.pushFailures >= 4) {
          this.outbox = [];
          this.controller?.abort();
        }
      }
    } finally {
      this.pushing = false;
    }
  }

  /** Until when the relay is believed not to send Live Activity pushes,
   * having said it has no such route: a relay older than this Mac. */
  private activitiesMissingUntil = 0;

  /**
   * One ActivityKit push (server/live-activities.ts). Unlike a frame it is
   * not sealed whole, because Apple reads it: what it carries is chosen
   * there so the relay can read nothing but a state word and a time. Sent
   * on its own rather than in the outbox, since its answer matters: a
   * token Apple has retired is dropped, and a relay that cannot send these
   * is not asked again for a while.
   */
  async activity(push: ActivityPush): Promise<PushResult> {
    if (!this.config || Date.now() < this.activitiesMissingUntil) return "off";
    try {
      const res = await fetch(`${this.config.url}/space/agent/activity`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(push),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return "ok";
      if (res.status === 410) return "gone";
      if (res.status === 404) {
        this.activitiesMissingUntil = Date.now() + 10 * 60_000;
        return "off";
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  /** A relay token of its own for one member, so removing them later does
   * not mean re-pairing anybody else. Null when the relay is not set up,
   * is unreachable, or does not know this route yet. */
  async mintClient(): Promise<string | null> {
    if (!this.config) return null;
    try {
      const res = await fetch(`${this.config.url}/space/agent/clients`, {
        method: "POST",
        headers: this.headers(),
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status !== 201) return null;
      const body = (await res.json()) as { clientToken?: unknown };
      return typeof body.clientToken === "string" ? body.clientToken : null;
    } catch {
      return null;
    }
  }

  /**
   * Tells Bloks Cloud about a workspace invite, so whoever has the code
   * can find this computer from anywhere. `preview` is what the link page
   * may show. `host.token` is a member client token minted for this
   * invite, which the relay hands whoever looks the code up so they can
   * ask through it (and drops the invite with, if it is revoked);
   * `host.key` is the public join key the joiner seals for. False when the
   * relay is off, unreachable, or refuses: the invite still works on this
   * network.
   */
  async registerInvite(body: {
    codeHash: string;
    publicId: string;
    preview: { workspace: string; mark: { color: string; pattern: string }; inviter: string; role: string };
    expiresAt: number;
    host: { token: string; key: string };
  }): Promise<boolean> {
    if (!this.config) return false;
    try {
      const res = await fetch(`${this.config.url}/space/agent/invites`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Takes an invite back out of Bloks Cloud's index. Best effort: an
   * entry left behind expires there on its own, and this computer refuses
   * a closed invite whatever the relay still says. */
  async cancelInvite(publicId: string): Promise<boolean> {
    if (!this.config) return false;
    try {
      const res = await fetch(`${this.config.url}/space/agent/invites/${encodeURIComponent(publicId)}`, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }

  /** Takes a member's relay token away, which also hangs up their stream. */
  async revokeClient(tokenHash: string): Promise<boolean> {
    if (!this.config) return false;
    try {
      const res = await fetch(`${this.config.url}/space/agent/clients`, {
        method: "DELETE",
        headers: this.headers(),
        body: JSON.stringify({ tokenHash }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Which plan this space is on, per the licence the relay last checked.
   * Null when it could not be asked. */
  async plan(): Promise<"cloud" | "team" | null> {
    return (await this.planDetail())?.plan ?? null;
  }

  /** The plan and whether it holds a shared room of its own (Cloud
   * licences from before rooms became Team's do; Team always does).
   * `sharedRoom` is null when the relay is too old to say. Null when the
   * relay could not be asked. */
  async planDetail(): Promise<{ plan: "cloud" | "team"; sharedRoom: boolean | null } | null> {
    if (!this.config) return null;
    try {
      const res = await fetch(`${this.config.url}/space/agent/plan`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { plan?: unknown; sharedRoom?: unknown };
      const plan = body.plan === "team" ? "team" : body.plan === "cloud" ? "cloud" : null;
      if (!plan) return null;
      return { plan, sharedRoom: typeof body.sharedRoom === "boolean" ? body.sharedRoom : null };
    } catch {
      return null;
    }
  }

  /**
   * Asks Bloks Cloud for a public address a platform can call with its
   * webhooks for this computer, and tells it the token the platform will
   * echo while the webhook is being set up. The same address each time.
   */
  async hookUrl(platform: "whatsapp", verifyToken: string): Promise<string> {
    if (!this.config) throw new Error("Turn on Bloks Cloud first: WhatsApp reaches this computer through it.");
    const res = await fetch(`${this.config.url}/space/agent/hook`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platform, verifyToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
    if (!res.ok || typeof body.url !== "string") {
      throw new Error(typeof body.error === "string" ? body.error : "Bloks Cloud could not make a webhook address.");
    }
    return body.url;
  }

  /** This computer's part of every agent's email address, made once by
   * Bloks Cloud and kept. */
  async mailId(): Promise<{ id: string; domain: string }> {
    if (!this.config) throw new Error("Turn on Bloks Cloud first: email reaches this computer through it.");
    const res = await fetch(`${this.config.url}/space/agent/hook`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platform: "email" }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: unknown; domain?: unknown; error?: unknown };
    if (!res.ok || typeof body.id !== "string" || typeof body.domain !== "string") {
      throw new Error(typeof body.error === "string" ? body.error : "Bloks Cloud could not make an email address.");
    }
    return { id: body.id, domain: body.domain };
  }

  /** An agent's reply to somebody who emailed it. Bloks Cloud checks that
   * they wrote in, and sends it. */
  async sendEmail(mail: { to: string; replyTo: string; fromName: string; subject: string; text: string; inReplyTo?: string }): Promise<void> {
    if (!this.config) throw new Error("Bloks Cloud is off");
    const res = await fetch(`${this.config.url}/space/agent/email`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new Error(typeof body.error === "string" ? body.error : `the reply was not sent (${res.status})`);
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config!.agentToken}`,
      "content-type": "application/json",
    };
  }



  private schedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.dial(), this.retry);
    this.timer.unref?.();
    this.retry = Math.min(RETRY_MAX_MS, Math.round(this.retry * 1.8));
  }

  private setState(patch: Partial<RelayState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Hold the agent stream open and serve whatever arrives on it. */
  private async dial() {
    if (this.stopped || !this.config) return;
    const gen = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    // Keepalive and the dead-socket watchdog are dial-local, so a later
    // dial can never clear an earlier one's timers or vice versa.
    let keepalive: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      if (keepalive) clearInterval(keepalive);
      if (watchdog) clearTimeout(watchdog);
      keepalive = watchdog = null;
    };
    const alive = () => !this.stopped && gen === this.generation;
    // A live relay sends its own keepalive comments every 25s. Nothing
    // at all for this long is a dead socket the OS has not surfaced yet;
    // abort and redial rather than hang on undici's minutes-long default.
    // Armed before the request too: a proxy or a scanning antivirus that
    // holds the answer back would otherwise leave the dial waiting for
    // headers forever, with nothing on the screen to say why.
    let heard = false;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
      watchdog.unref?.();
    };
    armWatchdog();
    try {
      const res = await fetch(`${this.config.url}/space/agent/stream`, {
        headers: { authorization: `Bearer ${this.config.agentToken}` },
        signal: controller.signal,
      });
      if (!alive()) return;
      if (!res.ok || !res.body) {
        // 401/403 usually means a wrong token, but it also means the relay
        // lost its state in a restart, and a memory-only relay does that.
        // So do not give up: back off hard and keep trying, with an honest
        // status in the meantime. A truly wrong token just retries slowly.
        if (res.status === 401 || res.status === 403) {
          this.setState({
            connected: false,
            delivering: false,
            // The usual cause by far: Cloud was activated again with the
            // same licence, which retires the space this token belonged to.
            problem: `Bloks Cloud does not recognise ${thisMachine()}'s space. If Cloud was activated again with this licence, here or elsewhere, activate it again on the computer that should keep it. Retrying.`,
          });
          this.retry = RETRY_MAX_MS;
          this.schedule();
          this.onRejected();
          return;
        }
        throw new Error(`relay answered ${res.status}`);
      }

      // a fresh line starts trusted; what it sends decides from there
      this.outbound = [];
      this.setState({ connected: true, delivering: true, problem: null, since: Date.now() });
      this.pushFailures = 0;
      keepalive = setInterval(() => this.publish({ kind: "ping" }), KEEPALIVE_MS);
      keepalive.unref?.();

      heard = true;
      const reader = res.body.getReader();
      armWatchdog();

      const decoder = new TextDecoder();
      const frames = new FrameReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (!alive()) return;
        if (done) break;
        armWatchdog();
        for (const read of frames.read(decoder.decode(value, { stream: true }))) {
          if ("tooLarge" in read) {
            this.refuseTooLarge(read.tooLarge.id, read.tooLarge.deviceId);
            continue;
          }
          const frame = read.frame;
          // the retry clock only resets once the relay has actually said
          // hello, so an accept-then-drop relay cannot cause a tight storm
          if (frame?.kind === "hello") {
            this.retry = RETRY_MIN_MS;
            this.setState({ spaceId: frame.spaceId ?? null });
            // a fresh line, perhaps after a sleep: say it again
            void this.sendNextDue(true);
          }
          if (frame?.kind === "ask" && typeof frame.id === "string") {
            void this.serve(frame.id, String(frame.payload ?? ""));
          }
        }
      }
      throw new Error("the relay closed the line");
    } catch (e) {
      if (!alive()) return;
      const problem = heard ? lineProblem(e) : `Bloks Cloud could not be reached from ${thisMachine()}: ${lineProblem(e)}`;
      this.setState({ connected: false, delivering: false, spaceId: null, since: null, problem });
      this.schedule();
    } finally {
      clearTimers();
    }
  }

  /**
   * One request from a phone: unseal it, replay it against our own HTTP
   * surface as the device that sent it, and seal the answer back.
   */
  private async serve(id: string, payload: string) {
    if (payload.startsWith("hook:")) return void this.serveHook(id, payload.slice(5));
    if (payload.startsWith("pair-link:")) return void this.serveOwnerLink(id, payload.slice("pair-link:".length));
    const envelope = peek(payload);
    if (envelope?.d.startsWith("inv_")) return void this.serveInvite(id, envelope);
    if (envelope?.d.startsWith("pair_")) return void this.servePairLink(id, envelope);
    if (envelope?.d.startsWith("wjn_")) return void this.serveJoin(id, envelope);
    const device = envelope ? pairedDevices().find((d) => d.id === envelope.d) : null;
    // An envelope for an unknown device is a revoked phone or a forgery,
    // and both get the same nothing.
    if (!envelope || !device) return void this.answer(id, 401, null, null, null);

    // one key reads what the phone sealed; a different one seals what
    // goes back, so neither side's frames can ever stand in for the other's
    const readKey = deviceKey(device.hash, "phone-to-mac");
    const replyKey = deviceKey(device.hash, "mac-to-phone");
    const request = open(readKey, envelope) as RelayRequest | null;
    if (!request || typeof request.method !== "string" || typeof request.path !== "string") {
      return void this.answer(id, 400, null, replyKey, device.id);
    }
    // Anti-replay: the phone stamps each request with a fresh nonce and a
    // timestamp, both inside the sealed body. AES-GCM proves authenticity
    // but not freshness, so a hostile relay could otherwise re-run a
    // captured "approve" or "send" verbatim. A stale timestamp or a nonce
    // seen before is refused; only mutating methods are guarded, so a
    // retried GET after a dropped answer still works.
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating) {
      const fresh =
        typeof request.ts === "number" &&
        Math.abs(Date.now() - request.ts) <= REPLAY_WINDOW_MS &&
        typeof request.nonce === "string" &&
        request.nonce.length > 0;
      if (!fresh || this.seenNonces.has(request.nonce!)) {
        return void this.answer(id, 409, { error: "stale or replayed request" }, replyKey, device.id);
      }
      this.seenNonces.remember(request.nonce!, request.ts!);
    }
    // Only our own API, and never a path that climbs out of it.
    if (!request.path.startsWith("/api/") || request.path.includes("..")) {
      return void this.answer(id, 404, { error: "no such route" }, replyKey, device.id);
    }
    // Only a request that opened with this device's key and cleared the
    // checks above counts as the device being here. Without this, a phone
    // that only ever came through Bloks Cloud never had a last seen time.
    markSeen(device.id);

    if (request.path === "/api/relay/streams" || request.path.startsWith("/api/relay/streams/")) {
      return void this.serveStream(id, request, replyKey, device.id);
    }
    if (request.raw) return void this.serveRaw(id, request, replyKey, device.id);
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${request.path}`, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${this.port}`,
          [RELAY_HEADER]: INTERNAL,
          [DEVICE_HEADER]: device.id,
          ...clientHeader(request),
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      this.answer(id, res.status, body, replyKey, device.id);
    } catch {
      this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, replyKey, device.id);
    }
  }

  /**
   * A request from somebody holding an invite link and nothing else. Keyed
   * from the invite's secret, limited to asking to join and asking how it
   * is going, and replayed as that invite rather than as any device.
   */
  private async serveInvite(id: string, envelope: Envelope) {
    const inviteId = envelope.d;
    const secretHash = this.inviteSecret(inviteId);
    if (!secretHash) return void this.answer(id, 401, null, null, null);
    const readKey = inviteKey(secretHash, "phone-to-mac");
    const replyKey = inviteKey(secretHash, "mac-to-phone");
    const request = open(readKey, envelope) as RelayRequest | null;
    if (!request || typeof request.method !== "string" || typeof request.path !== "string") {
      return void this.answer(id, 400, null, replyKey, inviteId);
    }
    if (!INVITE_ROUTES.has(`${request.method} ${request.path}`)) {
      return void this.answer(id, 404, { error: "no such route" }, replyKey, inviteId);
    }
    if (request.method !== "GET") {
      const fresh =
        typeof request.ts === "number" &&
        Math.abs(Date.now() - request.ts) <= REPLAY_WINDOW_MS &&
        typeof request.nonce === "string" &&
        request.nonce.length > 0;
      if (!fresh || this.seenNonces.has(request.nonce!)) {
        return void this.answer(id, 409, { error: "stale or replayed request" }, replyKey, inviteId);
      }
      this.seenNonces.remember(request.nonce!, request.ts!);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${request.path}`, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${this.port}`,
          [RELAY_HEADER]: INTERNAL,
          [INVITE_HEADER]: inviteId,
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      this.answer(id, res.status, body, replyKey, inviteId);
    } catch {
      this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, replyKey, inviteId);
    }
  }

  /**
   * A request that wants bytes back, from an owner's device. Same checks
   * as any other by the time it gets here; what differs is only the
   * shape: any body type in, the answer gzipped, and a longer wait,
   * because a file takes longer than a JSON answer.
   */
  private async serveRaw(id: string, request: RelayRequest, replyKey: Buffer, deviceId: string) {
    // A range the device asked for itself (?range=, which a phone seeks a
    // video with) is its own business: answered whole, as it always was.
    if (request.parts === true && request.method === "GET" && !askedForRange(request.path)) {
      return void this.servePart(id, request, replyKey, deviceId);
    }
    try {
      const body =
        typeof request.bodyB64 === "string"
          ? Buffer.from(request.bodyB64, "base64")
          : request.body === undefined
            ? undefined
            : JSON.stringify(request.body);
      const res = await fetch(`http://127.0.0.1:${this.port}${request.path}`, {
        method: request.method,
        headers: {
          "content-type": typeof request.type === "string" ? request.type : "application/json",
          origin: `http://127.0.0.1:${this.port}`,
          [RELAY_HEADER]: INTERNAL,
          [DEVICE_HEADER]: deviceId,
          ...clientHeader(request),
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      this.answerBytes(id, res.status, res.headers.get("content-type") ?? "application/octet-stream", bytes, replyKey, deviceId);
    } catch {
      this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, replyKey, deviceId);
    }
  }

  /**
   * A raw answer in parts, for a device that said it takes them, so a
   * file larger than one answer still opens (GitHub 366). Each part is an
   * ordinary ask and answer under the relay's limits, so the relay never
   * knows a file came in pieces.
   *
   * The route is asked for that part's bytes alone, by a Range header, so
   * a large file is never read whole for one piece of it. A route that
   * does not answer ranges is read whole, and sent whole when that fits,
   * which keeps a large answer that compresses well (a transcript) the
   * one answer it always was; it is cut only when it does not fit. Every
   * part says which version of the file it is from, its tag, and a part
   * asked for by a tag the file no longer has is refused: half of one
   * version joined to half of another is a file that never existed.
   */
  private async servePart(id: string, request: RelayRequest, replyKey: Buffer, deviceId: string) {
    const part = request.part ?? 0;
    const tag = typeof request.tag === "string" ? request.tag : undefined;
    if (!Number.isSafeInteger(part) || part < 0 || part * RAW_PART_BYTES >= RAW_PARTS_MAX_BYTES || (part > 0 && !tag)) {
      return void this.answer(id, 416, { error: "there is no such part" }, replyKey, deviceId);
    }
    const start = part * RAW_PART_BYTES;
    const tooLarge = { error: RAW_PARTS_REFUSAL, limit: RAW_PARTS_MAX_BYTES };
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${request.path}`, {
        method: "GET",
        headers: {
          origin: `http://127.0.0.1:${this.port}`,
          range: `bytes=${start}-${start + RAW_PART_BYTES - 1}`,
          [RELAY_HEADER]: INTERNAL,
          [DEVICE_HEADER]: deviceId,
          [PARTS_HEADER]: "1",
          ...clientHeader(request),
        },
        signal: AbortSignal.timeout(60_000),
      });
      const type = res.headers.get("content-type") ?? "application/octet-stream";
      const etag = res.headers.get("etag");
      if (res.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
        const size = Number(range?.[3]);
        const now = etag ?? `size:${size}`;
        const refused =
          !range || Number(range[1]) !== start
            ? ([502, { error: `${thisMachine()} could not answer that` }] as const)
            : size > RAW_PARTS_MAX_BYTES
              ? ([413, tooLarge] as const)
              : tag !== undefined && tag !== now
                ? ([412, CHANGED] as const)
                : null;
        if (refused) {
          await res.body?.cancel().catch(() => {});
          return void this.answer(id, refused[0], refused[1], replyKey, deviceId);
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        return void this.answerPart(id, type, bytes, { size, part, tag: now }, replyKey, deviceId);
      }
      // Past the end. For the first part that is an empty file, which no
      // range can be asked of, so it is asked for whole; for a later one
      // the file is shorter than it was.
      if (res.status === 416) {
        await res.body?.cancel().catch(() => {});
        if (part > 0) return void this.answer(id, 412, CHANGED, replyKey, deviceId);
        return void this.serveRaw(id, { ...request, parts: undefined }, replyKey, deviceId);
      }
      // a refusal or a missing file goes back as it came
      if (res.status !== 200) {
        return void this.answerBytes(id, res.status, type, Buffer.from(await res.arrayBuffer()), replyKey, deviceId);
      }
      const whole = await readAtMost(res, RAW_PARTS_MAX_BYTES);
      if (!whole) return void this.answer(id, 413, tooLarge, replyKey, deviceId);
      const now = etag ?? digestOf(whole);
      if (tag === undefined) {
        const z = gzipSync(whole).toString("base64");
        const post = z.length <= MAX_RAW_ANSWER ? this.rawPost(id, 200, { type, z, size: whole.length, parts: 1, part: 0, tag: now }, replyKey, deviceId) : null;
        if (post && post.length <= MAX_RESULT_POST) return void this.deliver(post, 15_000);
      } else if (tag !== now) {
        return void this.answer(id, 412, CHANGED, replyKey, deviceId);
      }
      if (start >= whole.length) return void this.answer(id, 416, { error: "there is no such part" }, replyKey, deviceId);
      this.answerPart(id, type, whole.subarray(start, start + RAW_PART_BYTES), { size: whole.length, part, tag: now }, replyKey, deviceId);
    } catch {
      this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, replyKey, deviceId);
    }
  }

  /** One part of a file sent in parts, with what the device needs to ask
   * for the rest and put them back together. */
  private answerPart(id: string, type: string, bytes: Buffer, at: { size: number; part: number; tag: string }, key: Buffer, deviceId: string) {
    const parts = Math.max(1, Math.ceil(at.size / RAW_PART_BYTES));
    this.answerBytes(id, 200, type, bytes, key, deviceId, { size: at.size, parts, part: at.part, tag: at.tag });
  }

  /** Bytes as a raw answer: gzipped, and refused in words when even that
   * is more than the relay will carry. */
  private answerBytes(id: string, status: number, type: string, bytes: Buffer, key: Buffer, deviceId: string, more?: PartFields) {
    const z = gzipSync(bytes).toString("base64");
    // what the relay will carry; past it, say so rather than send
    // something it would drop on the floor
    if (z.length > MAX_RAW_ANSWER) {
      return void this.answer(id, 413, { error: "too large to open through Bloks Cloud" }, key, deviceId);
    }
    this.answerRaw(id, status, type, z, key, deviceId, more);
  }

  private answerRaw(id: string, status: number, type: string, z: string, key: Buffer, deviceId: string, more?: PartFields) {
    if (!this.config) return;
    const post = this.rawPost(id, status, { type, z, ...more }, key, deviceId);
    if (post.length > MAX_RESULT_POST) {
      return this.answer(id, 413, { error: "too large to open through Bloks Cloud" }, key, deviceId);
    }
    void this.deliver(post, 15_000);
  }

  /** A raw answer sealed and wrapped for the relay, as it will be posted. */
  private rawPost(id: string, status: number, fields: { type: string; z: string } & PartFields, key: Buffer, deviceId: string): string {
    return JSON.stringify({ id, status, payload: seal(key, deviceId, { status, ...fields }) });
  }

  /**
   * Somebody holding a pairing link (server/pairing.ts) and nothing else.
   * One thing can be asked: to be paired. Answered here rather than by
   * replaying HTTP, since there is no route a link could reach anyway.
   */
  private servePairLink(id: string, envelope: Envelope) {
    const linkId = envelope.d;
    const secretHash = this.pairSecret(linkId);
    if (!secretHash) return void this.answer(id, 401, null, null, null);
    const readKey = inviteKey(secretHash, "phone-to-mac");
    const replyKey = inviteKey(secretHash, "mac-to-phone");
    const request = open(readKey, envelope) as RelayRequest | null;
    if (!request || request.method !== "POST" || request.path !== "/api/pair/link/claim") {
      return void this.answer(id, 404, { error: "no such route" }, replyKey, linkId);
    }
    const fresh =
      typeof request.ts === "number" &&
      Math.abs(Date.now() - request.ts) <= REPLAY_WINDOW_MS &&
      typeof request.nonce === "string" &&
      request.nonce.length > 0 &&
      !this.seenNonces.has(request.nonce);
    if (!fresh) return void this.answer(id, 409, { error: "stale or replayed request" }, replyKey, linkId);
    this.seenNonces.remember(request.nonce!, request.ts!);
    const claimed = this.pairClaim(linkId, request.body);
    if (!claimed) return void this.answer(id, 410, { error: "this pairing link was already used or has expired" }, replyKey, linkId);
    this.answer(id, 200, claimed, replyKey, linkId);
  }

  /**
   * Bloks Cloud asking, for the owner, for a pairing link to this
   * workspace (server/owner-link.ts). Not sealed, since it comes from the
   * relay rather than a device; signed with the licence instead, which a
   * device or a member does not hold, so nobody holding only a relay token
   * can dress a request up as one. The link goes back sealed for the app
   * that asked, and each question is answered once.
   */
  private serveOwnerLink(id: string, raw: string) {
    let ask: { key?: unknown; at?: unknown; mac?: unknown };
    try {
      ask = JSON.parse(raw);
    } catch {
      return this.answer(id, 400, null, null, null);
    }
    if (!linkAskValid(this.licence(), ask) || this.seenNonces.has(`link:${ask.mac}`)) return this.answer(id, 401, null, null, null);
    this.seenNonces.remember(`link:${ask.mac}`, ask.at);
    const made = this.ownerLink();
    if (!made) return this.answer(id, 404, null, null, null);
    let sealed: unknown;
    try {
      sealed = sealForRequester(ask.key, made);
    } catch {
      return this.answer(id, 400, null, null, null);
    }
    if (!this.config) return;
    void this.deliver(JSON.stringify({ id, status: 200, payload: JSON.stringify(sealed) }), 8_000);
  }

  /**
   * An event stream a paired device follows through Bloks Cloud.
   *
   * The relay carries a request and its answer, and an event stream never
   * answers: it is opened and then talks. So the device asks for one
   * (POST /api/relay/streams with the route it wants), this opens that
   * route here, as that device, so every check the route makes applies,
   * and each event it sends goes on to that device alone, sealed, on the
   * line every frame takes. The device says it is still watching now and
   * then (POST /api/relay/streams/<id>) and says when it stops (DELETE);
   * a stream nobody has renewed for a minute is ended here.
   */
  private serveStream(id: string, request: RelayRequest, key: Buffer, deviceId: string) {
    const m = /^\/api\/relay\/streams(?:\/([A-Za-z0-9_-]{12}))?$/.exec(request.path);
    if (!m) return this.answer(id, 404, { error: "no such route" }, key, deviceId);
    if (!m[1]) {
      if (request.method !== "POST") return this.answer(id, 405, { error: "POST a path to follow" }, key, deviceId);
      const body = requestBody(request) as { path?: unknown } | null;
      const path = typeof body?.path === "string" ? body.path : "";
      if (!STREAMABLE.some((route) => route.test(path))) {
        return this.answer(id, 404, { error: "that cannot be followed through Bloks Cloud" }, key, deviceId);
      }
      if ([...this.streams.values()].filter((s) => s.deviceId === deviceId).length >= STREAMS_PER_DEVICE) {
        return this.answer(id, 429, { error: "too many streams open from this device" }, key, deviceId);
      }
      return void this.openStream(id, path, key, deviceId);
    }
    const stream = this.streams.get(m[1]);
    if (!stream || stream.deviceId !== deviceId) return this.answer(id, 404, { error: "no such stream" }, key, deviceId);
    if (request.method === "DELETE") {
      stream.abort.abort();
      this.streams.delete(m[1]);
      return this.answer(id, 200, { ok: true }, key, deviceId);
    }
    stream.until = Date.now() + STREAM_LEASE_MS;
    return this.answer(id, 200, { ok: true }, key, deviceId);
  }

  private async openStream(id: string, path: string, key: Buffer, deviceId: string) {
    const abort = new AbortController();
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        headers: {
          accept: "text/event-stream",
          origin: `http://127.0.0.1:${this.port}`,
          [RELAY_HEADER]: INTERNAL,
          [DEVICE_HEADER]: deviceId,
        },
        signal: abort.signal,
      });
    } catch {
      return this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, key, deviceId);
    }
    if (res.status !== 200 || !res.body) {
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return this.answer(id, res.status === 200 ? 502 : res.status, body ?? { error: "that stream did not open" }, key, deviceId);
    }
    const sid = randomBytes(9).toString("base64url");
    this.streams.set(sid, { deviceId, abort, until: Date.now() + STREAM_LEASE_MS });
    this.armStreamSweep();
    this.answer(id, 200, { stream: sid }, key, deviceId);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n");
          // a keepalive comment carries nothing to pass on
          if (data) this.streamData(sid, deviceId, data);
        }
        if (buffer.length > MAX_LINE_BUFFER) buffer = "";
      }
    } catch {
      /* ended here, or the route went away */
    } finally {
      if (this.streams.get(sid)?.abort === abort) this.streams.delete(sid);
      this.publish({ kind: "stream", stream: sid, end: true }, undefined, false, undefined, deviceId);
    }
  }

  private streamData(sid: string, deviceId: string, data: string) {
    for (let at = 0; at < data.length; at += STREAM_PIECE) {
      const more = at + STREAM_PIECE < data.length;
      this.publish({ kind: "stream", stream: sid, data: data.slice(at, at + STREAM_PIECE), ...(more ? { more: true } : {}) }, undefined, false, undefined, deviceId);
    }
  }

  private armStreamSweep() {
    if (this.streamSweep) return;
    this.streamSweep = setInterval(() => {
      const now = Date.now();
      for (const [sid, stream] of this.streams) {
        if (stream.until > now) continue;
        stream.abort.abort();
        this.streams.delete(sid);
      }
      if (!this.streams.size && this.streamSweep) {
        clearInterval(this.streamSweep);
        this.streamSweep = null;
      }
    }, 15_000);
    this.streamSweep.unref?.();
  }

  private endStreams() {
    for (const stream of this.streams.values()) stream.abort.abort();
    this.streams.clear();
  }

  /**
   * When this workspace next has a routine or a watcher due, or null for
   * none (server/next-due.ts), for Bloks Cloud to wake the machine it runs
   * on if that machine sleeps. Said when it changes, again every ten
   * minutes (the relay forgets it once it has acted on it), and again on
   * every fresh line, since a line that comes back may be a machine that
   * just woke up.
   */
  nextDue(at: number | null) {
    this.nextDueWanted = at;
    void this.sendNextDue(false);
  }

  private async sendNextDue(force: boolean) {
    if (!this.config || !this.state.connected || this.nextDueWanted === undefined) return;
    const at = this.nextDueWanted;
    const now = Date.now();
    if (!force && this.nextDueSent && this.nextDueSent.at === at && now - this.nextDueSent.when < NEXT_DUE_REPEAT_MS) return;
    this.nextDueSent = { at, when: now };
    const ok = await fetch(`${this.config.url}/space/agent/next-due`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ at }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.ok)
      .catch(() => false);
    // not said after all: the next look tries again
    if (!ok && this.nextDueSent?.when === now) this.nextDueSent = null;
  }

  /** Somebody asking to join the workspace with an invite's code. The
   * opening, the checks and the sealed answer are server/members.ts's;
   * this only carries them. */
  private async serveJoin(id: string, envelope: Envelope) {
    const answered = await this.joinAsk(envelope).catch(() => null);
    if (!answered) return void this.answer(id, 401, null, null, null);
    if (!this.config) return;
    void this.deliver(JSON.stringify({ id, status: answered.status, payload: answered.payload }), 8_000);
  }

  private async serveHook(id: string, raw: string) {
    let hook: { platform?: unknown; body?: unknown; signature?: unknown };
    try {
      hook = JSON.parse(raw);
    } catch {
      return this.answer(id, 400, null, null, null);
    }
    if (typeof hook.platform !== "string" || typeof hook.body !== "string") return this.answer(id, 400, null, null, null);
    const status = await this.onHook({
      platform: hook.platform,
      body: hook.body,
      signature: typeof hook.signature === "string" ? hook.signature : null,
    }).catch(() => 500);
    this.answer(id, status, null, null, null);
  }

  /**
   * An ask too long to have been read (FrameReader), answered rather than
   * left for the relay's twenty seconds to run out on, which the app shows
   * as this computer not answering. Sealed for the device its envelope
   * names when that is one paired here, so the app can say why; bare for
   * anything else, as an envelope for an unknown device always is.
   */
  private refuseTooLarge(id: string, deviceId: string | null) {
    const device = deviceId ? pairedDevices().find((d) => d.id === deviceId) : undefined;
    if (!device) return this.answer(id, 413, null, null, null);
    this.answer(id, 413, { error: "too large to send through Bloks Cloud" }, deviceKey(device.hash, "mac-to-phone"), device.id);
  }

  private answer(id: string, status: number, body: unknown, key: Buffer | null, deviceId: string | null): void {
    if (!this.config) return;
    const payload = key && deviceId ? seal(key, deviceId, { status, body }) : "";
    const post = JSON.stringify({ id, status, payload });
    // Too big for the relay: sending it would only be cut off, retried
    // and cut off again while the phone waits. Say so in a few bytes
    // instead, so the phone hears why rather than "did not answer".
    if (post.length > MAX_RESULT_POST && status !== 413) {
      return this.answer(id, 413, { error: "too large to send through Bloks Cloud" }, key, deviceId);
    }
    void this.deliver(post, 8_000);
  }

  /**
   * Hand one answer to the relay, and keep at it while the phone is still
   * waiting. Safe to repeat: the relay settles an ask once and answers any
   * later copy with a 202. Only a refusal (a 4xx other than a timeout or
   * a rate limit) stops early, since sending it again changes nothing.
   */
  private async deliver(body: string, attemptMs: number): Promise<boolean> {
    const config = this.config;
    if (!config) return false;
    const deadline = Date.now() + ANSWER_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      // pointed elsewhere or switched off since: this answer belongs to
      // a line that no longer exists
      if (left <= 0 || this.config !== config) break;
      try {
        const res = await fetch(`${config.url}/space/agent/result`, {
          method: "POST",
          headers: this.headers(),
          body,
          signal: AbortSignal.timeout(Math.min(attemptMs, left)),
        });
        if (res.ok) {
          this.noteOutbound(true);
          return true;
        }
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break;
      } catch {
        // lost on the way; the next attempt may not be
      }
      const wait = Math.min(500 * 2 ** attempt, deadline - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait).unref?.());
    }
    // A phone just went without its answer. That is not noise to average
    // away: say so now, and let the next posts that land clear it.
    if (this.config === config) this.noteOutbound(false, true);
    return false;
  }

  /** Keep `delivering` honest. It drops when half the recent posts failed,
   * or at once when an answer was lost outright, and comes back after a
   * short run that landed, so one lucky post does not paper over a bad
   * line. */
  private noteOutbound(ok: boolean, lost = false) {
    this.outbound.push(ok);
    if (this.outbound.length > OUTBOUND_WINDOW) this.outbound.shift();
    if (!this.state.connected) return;
    const failed = this.outbound.filter((x) => !x).length;
    const recent = this.outbound.slice(-OUTBOUND_RECOVER);
    const delivering = this.state.delivering
      ? !lost && failed * 2 < OUTBOUND_WINDOW
      : recent.length === OUTBOUND_RECOVER && recent.every(Boolean);
    if (delivering === this.state.delivering) return;
    this.setState({
      delivering,
      problem: delivering ? (this.state.problem === NOT_DELIVERING ? null : this.state.problem) : NOT_DELIVERING,
    });
  }
}

/** One thing read off the relay's stream: a frame, or an ask too long to
 * hold, by the id the relay gave it and the device its envelope names. */
export type StreamRead = { frame: any } | { tooLarge: { id: string; deviceId: string | null } };

/**
 * The relay's stream, cut at its blank lines into frames.
 *
 * Only the frame still arriving is held, and the bound is on that frame
 * alone, counted once every whole frame ahead of it has been taken out.
 * Cutting the buffer before looking for the end of a frame lost every ask
 * longer than the cut, and any that only arrived in the same read as the
 * bytes that tipped it over (GitHub 333): an upload went nowhere, nothing
 * answered it, and the app said this computer had not answered in time.
 *
 * A frame that does outgrow the bound is not dropped in silence. Its start
 * says whose it is, which is handed back to be answered, and the rest goes
 * past unkept up to the frame's end. A peer that streams bytes with no
 * separator at all costs a character held, not the bytes it sent.
 */
export class FrameReader {
  private buffer = "";
  /** Passing over the rest of a frame too long to hold. */
  private skipping = false;
  private readonly limit: number;

  constructor(limit = MAX_FRAME_CHARS) {
    this.limit = limit;
  }

  /** How much of the stream is held now, which never stays past the limit. */
  get held(): number {
    return this.buffer.length;
  }

  /** One read's text in; what it finished, in order, out. */
  read(text: string): StreamRead[] {
    const out: StreamRead[] = [];
    // only the new text can end a frame, with the character before it in
    // case the blank line falls across two reads
    let from = Math.max(0, this.buffer.length - 1);
    this.buffer += text;
    if (this.skipping) {
      const end = this.buffer.indexOf("\n\n");
      if (end === -1) {
        this.buffer = this.buffer.slice(-1);
        return out;
      }
      this.buffer = this.buffer.slice(end + 2);
      this.skipping = false;
      from = 0;
    }
    let cut: number;
    while ((cut = this.buffer.indexOf("\n\n", from)) !== -1) {
      const chunk = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      from = 0;
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try {
        out.push({ frame: JSON.parse(line.slice(5).trim()) });
      } catch {
        continue;
      }
    }
    if (this.buffer.length > this.limit) {
      const ask = askOf(this.buffer.slice(0, FRAME_HEAD_CHARS));
      if (ask) out.push({ tooLarge: ask });
      this.buffer = this.buffer.slice(-1);
      this.skipping = true;
    }
    return out;
  }
}

/** Whose ask a frame is, from its first characters: the relay's id, which
 * it writes ahead of the payload, and the device the sealed envelope
 * names in the clear (relay-crypto.ts), which comes first inside it. Null
 * for a start that does not read as an ask. */
function askOf(head: string): { id: string; deviceId: string | null } | null {
  const at = head.indexOf("data:");
  if (at === -1) return null;
  const start = head.slice(at + 5);
  if (!/"kind"\s*:\s*"ask"/.test(start)) return null;
  const id = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(start)?.[1];
  if (!id) return null;
  const b64 = /"payload"\s*:\s*"([A-Za-z0-9+/]*)/.exec(start)?.[1] ?? "";
  const envelope = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), "base64").toString("utf8");
  return { id, deviceId: /^\{"d"\s*:\s*"([^"\\]{1,200})"/.exec(envelope)?.[1] ?? null };
}

/** A sealed request's body, whether it came as JSON or as raw bytes. */
function requestBody(request: RelayRequest): unknown {
  if (typeof request.bodyB64 === "string") {
    try {
      return JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
  return request.body ?? null;
}
