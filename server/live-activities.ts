// Live Activities on a paired phone, for the turns the person is waiting on.
//
// A Live Activity is the agent on the Lock Screen: who is working, on
// which conversation, for how long. It is only worth that space while the
// person is actually waiting, so the rule is narrow (GitHub 280): one per
// turn the owner's own message started or joined, from any device, and
// none for a turn another agent, a routine, a watcher or a webhook
// started. It ends when the turn ends, however it ends.
//
// The phone can end an activity itself only while it runs. Once it is
// suspended, nothing on the phone hears that a turn ended, so the end has
// to come from here, as an ActivityKit push through Bloks Cloud, which is
// the only thing that can push to a phone at all. That needs a token per
// activity, and the phone hands each one over on the ordinary paired
// channel (POST /api/live-activities). A phone on iOS 17.2 or later also
// hands over a push-to-start token, so a turn the person started at this
// computer can put an activity on their phone too.
//
// What the relay can read is kept to nothing: a state word, a time and
// two opaque ids. The agent's name and the conversation's ride in
// `sealed`, under the same per-device key as a notification preview,
// and only the phone's own widget opens them. A phone on the same network
// without Bloks Cloud keeps the activities it starts itself, and ends
// them itself; there is no other road to it.
//
// The tokens are kept like the relay keeps device tokens: per paired
// device, on disk only so a restart can still end what it started, never
// logged, and gone with the device's pairing.
import { readSaved, writeFileAtomic } from "./atomic-write.ts";

export type ActivityEnv = "sandbox" | "production";
export type ActivityState = "working" | "needs-you";

/** One ActivityKit push, as the relay is asked to send it. */
export interface ActivityPush {
  token: string;
  env: ActivityEnv;
  event: "start" | "update" | "end";
  state?: ActivityState;
  /** When the turn began, in epoch milliseconds, for the elapsed timer. */
  startedAt?: number;
  /** The words below, sealed for the one device the token belongs to. */
  sealed?: string;
  agentId?: string;
  laneId?: string;
}

/** "off" is no relay, or one that cannot send these yet. */
export type PushResult = "ok" | "gone" | "failed" | "off";

/** What the Lock Screen says about one turn, before it is sealed. */
export interface ActivityWords {
  name: string;
  color: string;
  shape: string;
  /** The conversation: the lane's title, or the room's name. */
  task: string;
  question?: string;
}

/** A running turn, as an activity shows it. `where` is the conversation
 * its cards land in: the room for a room's turn, the lane otherwise. */
export interface ActivityTurn {
  agentId: string;
  startedAt: number;
  where: string;
  words: ActivityWords;
  /** A card in `where` already waiting for the person, if there is one. */
  asking?: { messageId: string; question: string };
}

interface Tracked {
  agentId: string;
  laneId: string;
  /** Null from the moment a push started it until the phone reports the
   * token iOS gave the new activity. */
  token: string | null;
  env: ActivityEnv;
  /** When this device's activity began, so the oldest is the one replaced. */
  at: number;
  /** The card it shows as waiting for the person, if any, and what the
   * card asks. Kept even before the token is known, so an activity whose
   * token arrives after its card still shows it. */
  waitingOn?: string;
  asking?: string;
  /** The card a push-started activity already showed when it started. */
  startedOn?: string;
  /** Ended because the person sat down at a computer, before its token
   * came: when the token does come, it ends at once. */
  quieted?: boolean;
}

interface DeviceRecord {
  start?: { token: string; env: ActivityEnv; at: number };
  activities: Tracked[];
}

export interface LiveActivityDeps {
  /** Where the tokens are kept, or null to keep them in memory only. */
  file: string | null;
  /** The owner's paired devices. A member's phone never gets one: an
   * activity is for the person whose agents these are. */
  devices: () => Array<{ id: string }>;
  /** Whether a lane's turn is still running. */
  running: (laneId: string) => boolean;
  /** The lane an agent is working in now, for a phone that did not say. */
  laneOf: (agentId: string) => string | null;
  turn: (laneId: string) => ActivityTurn | null;
  seal: (deviceId: string, words: ActivityWords) => string | null;
  send: (push: ActivityPush) => Promise<PushResult>;
  /** Whether the owner is actively using Bloks on a computer right now
   * (server/presence.ts), when no new activity starts on a phone. */
  quiet?: () => boolean;
  /** How long a turn runs before other devices are given an activity for
   * it. A turn over in a moment is not one anybody waits on, and the
   * phone that sent the message has started its own by then and said so. */
  startDelayMs?: number;
  /** How long a lane must stay settled before its activities end. A
   * failed turn asked again, or handed to the backup engine, goes on
   * after a beat, and is still the same wait for the person. */
  endDelayMs?: number;
  now?: () => number;
}

/** The phone's own rule: two at once, the newest replacing the oldest. */
const AT_ONCE = 2;
/** Room for activities whose end is still in flight. */
const MAX_PER_DEVICE = 4;
/** A report is a handful of activities; anything longer was built to be. */
const MAX_REPORTED = 8;
/** iOS ends an activity after eight hours and clears it four after that;
 * nothing older can still be on a screen. */
const LONGEST_MS = 12 * 60 * 60_000;
/** ActivityKit tokens are hex, longer than a device token can be. */
const TOKEN = /^(?:[0-9a-f]{2}){32,256}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const isEnv = (value: unknown): value is ActivityEnv => value === "sandbox" || value === "production";

function isTracked(value: unknown): value is Tracked {
  const a = value as Tracked | null;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.agentId === "string" &&
    ID.test(a.agentId) &&
    typeof a.laneId === "string" &&
    ID.test(a.laneId) &&
    (a.token === null || (typeof a.token === "string" && TOKEN.test(a.token))) &&
    isEnv(a.env) &&
    typeof a.at === "number" &&
    (a.waitingOn === undefined || typeof a.waitingOn === "string") &&
    (a.asking === undefined || typeof a.asking === "string")
  );
}

/** A file somebody could edit is checked rather than trusted: a malformed
 * record is dropped, never half kept. */
function parseRecords(value: unknown): Map<string, DeviceRecord> {
  const out = new Map<string, DeviceRecord>();
  const devices = (value as { devices?: unknown } | null)?.devices;
  if (!devices || typeof devices !== "object" || Array.isArray(devices)) return out;
  for (const [id, raw] of Object.entries(devices)) {
    if (!ID.test(id) || !raw || typeof raw !== "object") continue;
    const r = raw as { start?: unknown; activities?: unknown };
    const s = r.start as DeviceRecord["start"] | undefined;
    const start = s && typeof s.token === "string" && TOKEN.test(s.token) && isEnv(s.env) && typeof s.at === "number" ? s : undefined;
    const activities = Array.isArray(r.activities) ? r.activities.filter(isTracked).slice(-MAX_PER_DEVICE) : [];
    if (start || activities.length) out.set(id, { ...(start ? { start } : {}), activities });
  }
  return out;
}

export class LiveActivities {
  private readonly deps: LiveActivityDeps;
  private records: Map<string, DeviceRecord>;
  private starting = new Map<string, ReturnType<typeof setTimeout>>();
  private ending = new Map<string, ReturnType<typeof setTimeout>>();
  /** Turns the person waits on whose activities were held back, or ended,
   * because they were at a computer: given one when they leave it, if the
   * turn is still going. Never written down; a restart forgets them. */
  private held = new Set<string>();

  constructor(deps: LiveActivityDeps) {
    this.deps = deps;
    this.records = deps.file ? readSaved(deps.file, new Map<string, DeviceRecord>(), () => true, (text) => parseRecords(JSON.parse(text))) : new Map();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * What a phone reported: its push-to-start token (a string to keep, null
   * to drop), and the activities it has with each one's token. Only a
   * paired owner device is heard.
   */
  register(deviceId: string, body: unknown): { ok: true } | { error: string } {
    if (!this.owners().has(deviceId)) return { error: "only a paired phone keeps Live Activities" };
    const b = (body ?? {}) as { env?: unknown; start?: unknown; activities?: unknown };
    const env: ActivityEnv = b.env === "sandbox" ? "sandbox" : "production";
    if (b.start !== undefined && b.start !== null && (typeof b.start !== "string" || !TOKEN.test(b.start.toLowerCase()))) {
      return { error: "that is not a push token" };
    }
    if (b.activities !== undefined && !Array.isArray(b.activities)) return { error: "activities must be a list" };
    const record = this.records.get(deviceId) ?? { activities: [] };
    if (typeof b.start === "string") record.start = { token: b.start.toLowerCase(), env, at: this.now() };
    else if (b.start === null) delete record.start;
    const settle: string[] = [];
    for (const raw of ((b.activities as unknown[] | undefined) ?? []).slice(0, MAX_REPORTED)) {
      const a = (raw ?? {}) as { token?: unknown; agentId?: unknown; laneId?: unknown };
      const token = typeof a.token === "string" ? a.token.toLowerCase() : "";
      if (!TOKEN.test(token) || typeof a.agentId !== "string" || !ID.test(a.agentId)) continue;
      const laneId = typeof a.laneId === "string" && ID.test(a.laneId) ? a.laneId : this.deps.laneOf(a.agentId);
      if (!laneId) continue;
      // One activity per agent, which is how the phone keys them too: a
      // report for an agent already here is that same activity, whether
      // the phone started it or a push did and this is its new token.
      const known = record.activities.find((t) => t.agentId === a.agentId);
      if (known) {
        const first = known.token === null;
        Object.assign(known, { token, laneId, env });
        // ended for the computer while it waited for this token
        if (first && known.quieted) {
          this.end(record, known);
          continue;
        }
        // a card came while the push-started activity had no token yet
        if (first && known.waitingOn && known.waitingOn !== known.startedOn && this.deps.running(laneId)) this.update(deviceId, known);
      } else record.activities.push({ agentId: a.agentId, laneId, token, env, at: this.now() });
      settle.push(laneId);
    }
    record.activities = record.activities.slice(-MAX_PER_DEVICE);
    if (record.start || record.activities.length) this.records.set(deviceId, record);
    else this.records.delete(deviceId);
    this.save();
    // A token can arrive after its turn already ended: a phone woken by
    // the start push reports it a moment later. Its end is due now.
    for (const laneId of settle) if (!this.deps.running(laneId)) this.settled(laneId);
    return { ok: true };
  }

  /** The person's own message started or joined this lane's turn. */
  started(laneId: string) {
    if (this.starting.has(laneId)) return;
    const timer = setTimeout(() => {
      this.starting.delete(laneId);
      void this.startNow(laneId);
    }, this.deps.startDelayMs ?? 3_000);
    timer.unref?.();
    this.starting.set(laneId, timer);
  }

  private async startNow(laneId: string) {
    if (!this.deps.running(laneId)) return;
    // at a computer: no new activity anywhere, but the turn is kept in
    // mind, so leaving the computer while it runs still gives the phone one
    if (this.deps.quiet?.()) {
      this.held.add(laneId);
      return;
    }
    const turn = this.deps.turn(laneId);
    if (!turn) return;
    const owners = this.owners();
    for (const [deviceId, record] of this.records) {
      if (!owners.has(deviceId) || !record.start) continue;
      // The phone the message came from started its own, and so did any
      // phone a push already reached for this agent.
      if (record.activities.some((a) => a.laneId === laneId || a.agentId === turn.agentId)) continue;
      while (record.activities.length >= AT_ONCE) {
        const oldest = record.activities.reduce((a, b) => (b.at < a.at ? b : a));
        this.end(record, oldest);
      }
      const tracked: Tracked = {
        agentId: turn.agentId,
        laneId,
        token: null,
        env: record.start.env,
        at: this.now(),
        // a question asked in the moments before the start went out
        ...(turn.asking
          ? { waitingOn: turn.asking.messageId, asking: turn.asking.question.slice(0, 120), startedOn: turn.asking.messageId }
          : {}),
      };
      record.activities.push(tracked);
      const words = tracked.asking ? { ...turn.words, question: tracked.asking } : turn.words;
      const sealed = this.deps.seal(deviceId, words) ?? undefined;
      const result = await this.deps.send({
        token: record.start.token,
        env: record.start.env,
        event: "start",
        state: tracked.waitingOn ? "needs-you" : "working",
        startedAt: turn.startedAt,
        ...(sealed ? { sealed } : {}),
        agentId: turn.agentId,
        laneId,
      });
      if (result === "ok") continue;
      record.activities = record.activities.filter((a) => a !== tracked);
      // Apple says that token will never work again; the phone sends a
      // new one when it has one.
      if (result === "gone") delete record.start;
    }
    this.save();
  }

  /**
   * The person sat down at a computer. Every activity on their phones
   * ends, in silence (an end push alerts nobody), and the turns they were
   * for are kept in mind for when the person leaves again.
   */
  present() {
    let changed = false;
    for (const record of this.records.values()) {
      for (const a of [...record.activities]) {
        if (this.deps.running(a.laneId)) this.held.add(a.laneId);
        if (a.token) this.end(record, a);
        else a.quieted = true;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** The person left the computer. A turn still going that an activity
   * was held back or ended for gets one now; nothing is replayed for a
   * turn that finished meanwhile. */
  away() {
    const lanes = [...this.held];
    this.held.clear();
    for (const laneId of lanes) if (this.deps.running(laneId)) void this.startNow(laneId);
  }

  /** A lane stopped being busy. Its activities end unless it is busy
   * again by the time the wait is over. */
  settled(laneId: string) {
    if (!this.deps.running(laneId)) this.held.delete(laneId);
    const pending = this.starting.get(laneId);
    if (pending && !this.deps.running(laneId)) {
      clearTimeout(pending);
      this.starting.delete(laneId);
    }
    if (this.ending.has(laneId) || !this.tracks(laneId)) return;
    const timer = setTimeout(() => {
      this.ending.delete(laneId);
      if (this.deps.running(laneId)) return;
      for (const record of this.records.values()) {
        for (const a of record.activities.filter((t) => t.laneId === laneId)) this.end(record, a);
      }
      this.save();
    }, this.deps.endDelayMs ?? 5_000);
    timer.unref?.();
    this.ending.set(laneId, timer);
  }

  /**
   * A card in `where` asks the person something (on), or the card the
   * activity showed as asking was answered (off). Only an activity whose
   * turn's cards land there changes, and only when its state does.
   */
  waiting(where: string, messageId: string, on: boolean, question?: string) {
    const owners = this.owners();
    for (const [deviceId, record] of this.records) {
      if (!owners.has(deviceId)) continue;
      for (const a of record.activities) {
        if (on ? a.waitingOn === messageId : a.waitingOn !== messageId) continue;
        const turn = this.deps.turn(a.laneId);
        if (!turn || turn.where !== where || !this.deps.running(a.laneId)) continue;
        if (on) Object.assign(a, { waitingOn: messageId, asking: question?.slice(0, 120) });
        else {
          delete a.waitingOn;
          delete a.asking;
        }
        this.update(deviceId, a);
      }
    }
  }

  /** Tells one activity what it shows now: waiting on a card, or working. */
  private update(deviceId: string, a: Tracked) {
    if (!a.token) return;
    const turn = this.deps.turn(a.laneId);
    if (!turn) return;
    const words = a.waitingOn && a.asking ? { ...turn.words, question: a.asking } : turn.words;
    const sealed = this.deps.seal(deviceId, words) ?? undefined;
    void this.deps.send({
      token: a.token,
      env: a.env,
      event: "update",
      state: a.waitingOn ? "needs-you" : "working",
      startedAt: turn.startedAt,
      ...(sealed ? { sealed } : {}),
    });
  }

  /** The device was unpaired: everything it handed over goes with it. */
  forget(deviceId: string) {
    if (this.records.delete(deviceId)) this.save();
  }

  /**
   * Catches what the events missed: an activity whose turn ended while
   * this computer was restarting, or whose end could not be sent. Also
   * where a device unpaired some other way (an edited config) loses its
   * tokens.
   */
  sweep() {
    const owners = this.owners();
    const now = this.now();
    let changed = false;
    for (const [deviceId, record] of this.records) {
      if (!owners.has(deviceId)) {
        this.records.delete(deviceId);
        changed = true;
        continue;
      }
      const before = record.activities.length;
      record.activities = record.activities.filter((a) => now - a.at < LONGEST_MS);
      changed ||= record.activities.length !== before;
      for (const a of [...record.activities]) {
        // a moment's grace, for a token reported just before its turn shows
        if (now - a.at < (this.deps.endDelayMs ?? 5_000) * 2) continue;
        if (this.deps.running(a.laneId) || this.ending.has(a.laneId)) continue;
        this.end(record, a);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** What a device has handed over, without the tokens themselves. */
  describe(deviceId: string): { start: boolean; activities: Array<{ agentId: string; laneId: string; reported: boolean }> } {
    const record = this.records.get(deviceId);
    return {
      start: Boolean(record?.start),
      activities: (record?.activities ?? []).map((a) => ({ agentId: a.agentId, laneId: a.laneId, reported: a.token !== null })),
    };
  }

  stop() {
    for (const timer of [...this.starting.values(), ...this.ending.values()]) clearTimeout(timer);
    this.starting.clear();
    this.ending.clear();
  }

  private tracks(laneId: string): boolean {
    for (const record of this.records.values()) if (record.activities.some((a) => a.laneId === laneId)) return true;
    return false;
  }

  /** Drops one activity, and ends it on the phone when its token is known.
   * One still waiting for its token cannot be reached; when the token
   * comes, its turn is over and register() ends it then. */
  private end(record: DeviceRecord, a: Tracked) {
    record.activities = record.activities.filter((t) => t !== a);
    if (a.token) void this.deps.send({ token: a.token, env: a.env, event: "end" });
  }

  private owners(): Set<string> {
    return new Set(this.deps.devices().map((d) => d.id));
  }

  private save() {
    if (!this.deps.file) return;
    const devices: Record<string, DeviceRecord> = {};
    for (const [id, record] of this.records) devices[id] = record;
    try {
      writeFileAtomic(this.deps.file, JSON.stringify({ devices }), 0o600, { flush: false });
    } catch {
      // Kept in memory regardless; a sweep after a restart that lost the
      // file only means an activity iOS ends on its own clock instead.
    }
  }
}
