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
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { IncomingMessage } from "node:http";

import { deviceKey, inviteKey, open, peek, seal, type Envelope, type RelayRequest } from "./relay-crypto.ts";
import { pairedDevices } from "./pairing.ts";

/** What to call the machine this harness runs on. Bloks ships on
 * Windows and Linux too, where "the Mac" reads as a copy-paste slip
 * rather than a description. */
function thisMachine(): string {
  return process.platform === "darwin" ? "this Mac" : process.platform === "win32" ? "this PC" : "this computer";
}

/** Proof that a replayed request came from this process, so the HTTP
 * layer can trust the device attribution without a bearer token it does
 * not have. Regenerated every boot and never written down. */
const INTERNAL = randomBytes(32).toString("hex");
const RELAY_HEADER = "x-bloks-relay";
const DEVICE_HEADER = "x-bloks-relay-device";
const INVITE_HEADER = "x-bloks-relay-invite";

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
  /** "approval" gets Allow and Deny on the lock screen. */
  category?: "approval" | "question" | "mention" | "brief";
  botId?: string;
  requestId?: string;
  threadId?: string;
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
  private seenNonces = new Set<string>();
  private nonceSweep = 0;
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
   * addressed to anyone else.
   */
  publish(frame: unknown, wake?: Wake) {
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
    if (!this.config) return null;
    try {
      const res = await fetch(`${this.config.url}/space/agent/plan`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { plan?: unknown };
      return body.plan === "team" ? "team" : body.plan === "cloud" ? "cloud" : null;
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

  /** Record a nonce and, every so often, forget the whole set. Since a
   * nonce is only accepted inside the freshness window, anything older is
   * refused on timestamp anyway, so a periodic clear is safe and bounds
   * the set without per-entry timers. */
  private rememberNonce(nonce: string) {
    this.seenNonces.add(nonce);
    if (Date.now() - this.nonceSweep > REPLAY_WINDOW_MS) {
      // keep only this generation; the previous one is now all stale
      this.seenNonces = new Set([nonce]);
      this.nonceSweep = Date.now();
    }
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

      const reader = res.body.getReader();
      // A live relay sends its own keepalive comments every 25s. Nothing
      // at all for this long is a dead socket the OS has not surfaced yet;
      // abort and redial rather than hang on undici's minutes-long default.
      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
        watchdog.unref?.();
      };
      armWatchdog();

      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (!alive()) return;
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        // Bound the buffer: a peer that streams bytes with no separator
        // must not grow this without limit.
        if (buffer.length > 1_000_000) buffer = buffer.slice(-4096);
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let frame: any;
          try {
            frame = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          // the retry clock only resets once the relay has actually said
          // hello, so an accept-then-drop relay cannot cause a tight storm
          if (frame?.kind === "hello") {
            this.retry = RETRY_MIN_MS;
            this.setState({ spaceId: frame.spaceId ?? null });
          }
          if (frame?.kind === "ask" && typeof frame.id === "string") {
            void this.serve(frame.id, String(frame.payload ?? ""));
          }
        }
      }
      throw new Error("the relay closed the line");
    } catch (e) {
      if (!alive()) return;
      const problem = e instanceof Error ? e.message : "relay link failed";
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
    const envelope = peek(payload);
    if (envelope?.d.startsWith("inv_")) return void this.serveInvite(id, envelope);
    if (envelope?.d.startsWith("pair_")) return void this.servePairLink(id, envelope);
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
      this.rememberNonce(request.nonce!);
    }
    // Only our own API, and never a path that climbs out of it.
    if (!request.path.startsWith("/api/") || request.path.includes("..")) {
      return void this.answer(id, 404, { error: "no such route" }, replyKey, device.id);
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
      this.rememberNonce(request.nonce!);
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
      const z = gzipSync(bytes).toString("base64");
      // what the relay will carry; past it, say so rather than send
      // something it would drop on the floor
      if (z.length > MAX_RAW_ANSWER) {
        return void this.answer(id, 413, { error: "too large to open through Bloks Cloud" }, replyKey, deviceId);
      }
      this.answerRaw(id, res.status, res.headers.get("content-type") ?? "application/octet-stream", z, replyKey, deviceId);
    } catch {
      this.answer(id, 502, { error: `${thisMachine()} could not answer that` }, replyKey, deviceId);
    }
  }

  private answerRaw(id: string, status: number, type: string, z: string, key: Buffer, deviceId: string) {
    if (!this.config) return;
    const payload = seal(key, deviceId, { status, type, z });
    const post = JSON.stringify({ id, status, payload });
    if (post.length > MAX_RESULT_POST) {
      return this.answer(id, 413, { error: "too large to open through Bloks Cloud" }, key, deviceId);
    }
    void this.deliver(post, 15_000);
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
    this.rememberNonce(request.nonce!);
    const claimed = this.pairClaim(linkId, request.body);
    if (!claimed) return void this.answer(id, 410, { error: "this pairing link was already used or has expired" }, replyKey, linkId);
    this.answer(id, 200, claimed, replyKey, linkId);
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
