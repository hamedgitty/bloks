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
import type { IncomingMessage } from "node:http";

import { deviceKey, open, peek, seal, type RelayRequest } from "./relay-crypto.ts";
import { pairedDevices } from "./pairing.ts";

/** Proof that a replayed request came from this process, so the HTTP
 * layer can trust the device attribution without a bearer token it does
 * not have. Regenerated every boot and never written down. */
const INTERNAL = randomBytes(32).toString("hex");
const RELAY_HEADER = "x-bloks-relay";
const DEVICE_HEADER = "x-bloks-relay-device";

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
  spaceId: string | null;
  /** Last failure, for the settings screen. Never a secret. */
  problem: string | null;
  since: number | null;
}

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** The relay drops a link it has not heard from; speak well inside that. */
const KEEPALIVE_MS = 30_000;
/** No bytes from the relay for this long means a dead socket the OS has
 * not reported. The relay's own keepalive is every 25s, so 60s is two
 * missed beats. */
const WATCHDOG_MS = 60_000;
/** How far a mutating request's timestamp may be from now. Wide enough
 * for a slow relay hop and modest clock skew, tight enough that a
 * captured frame is useless minutes later. */
const REPLAY_WINDOW_MS = 120_000;

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
  /** Nonces of mutating requests served recently, so a hostile relay
   * cannot replay a captured "approve" or "send". Bounded and time-swept;
   * the freshness window makes unbounded growth impossible anyway. */
  private seenNonces = new Set<string>();
  private nonceSweep = 0;
  state: RelayState = { configured: false, connected: false, spaceId: null, problem: null, since: null };

  /** Where to replay a decrypted request, i.e. our own loopback port. */
  private readonly port: number;
  /** Told whenever the link's state changes, so the UI can follow. */
  private readonly onChange: (state: RelayState) => void;

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
      this.state = { ...this.state, connected: false, spaceId: null, since: null };
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
  publish(frame: unknown, wake?: string) {
    if (!this.config || !this.state.connected) return;
    const devices = pairedDevices();
    // No devices still posts an empty batch: /space/agent/events touches
    // the link before it reads the body, so this is the heartbeat that
    // keeps the relay from reaping a healthy but deviceless space.
    const frames = devices.map((d) => seal(deviceKey(d.hash, "mac-to-phone"), d.id, frame));
    void fetch(`${this.config.url}/space/agent/events`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ frames, ...(wake ? { wake } : {}) }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => {
        this.pushFailures = res.ok ? 0 : this.pushFailures + 1;
        if (this.pushFailures >= 4) this.controller?.abort();
      })
      .catch(() => {
        // A failed push is a dropped frame, not a broken link on its own.
        // But a run of them means the line is dead while its read still
        // hangs, so force the redial the read has not noticed yet.
        this.pushFailures++;
        if (this.pushFailures >= 4) this.controller?.abort();
      });
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
            problem: "The relay is not accepting this Mac yet. Retrying.",
          });
          this.retry = RETRY_MAX_MS;
          this.schedule();
          return;
        }
        throw new Error(`relay answered ${res.status}`);
      }

      this.setState({ connected: true, problem: null, since: Date.now() });
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
      this.setState({ connected: false, spaceId: null, since: null, problem });
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
    const envelope = peek(payload);
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

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}${request.path}`, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${this.port}`,
          [RELAY_HEADER]: INTERNAL,
          [DEVICE_HEADER]: device.id,
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
      this.answer(id, 502, { error: "the Mac could not answer that" }, replyKey, device.id);
    }
  }

  private answer(id: string, status: number, body: unknown, key: Buffer | null, deviceId: string | null) {
    if (!this.config) return;
    const payload = key && deviceId ? seal(key, deviceId, { status, body }) : "";
    void fetch(`${this.config.url}/space/agent/result`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ id, status, payload }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
