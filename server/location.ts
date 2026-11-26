// Where the person is, as their own iPhone says, for their own agents.
//
// The phone shares only once its owner turns it on there, and only with a
// computer of their own: never from a member's phone, never to a hosted
// workspace. It says a place in words, worked out on the phone (the city,
// and the neighbourhood when iOS gave Bloks an exact fix), and coordinates
// only when the person also chose to share an exact position. It says it
// again when it has moved a fair way or arrived somewhere (iOS's own
// significant-change and visit services, never a running GPS), when Bloks
// is opened, and when an agent asks for a fresh reading while Bloks is
// open on it.
//
// This computer keeps the last thing said and nothing before it: no trail
// and no history. Each reading carries when the phone took it, and every
// use says how old it is, because a place that was right this morning is
// not a place that is right now.
//
// Three uses:
//
//   context  a line ahead of the owner's own turns while the reading is
//            recent: "Sam is in Toronto, as of 10 minutes ago."
//   read     `bloks location`, with its age, how exact it is, and whether
//            sharing is on, paused or off. --fresh asks the phone for a new
//            reading and says plainly when none came.
//   watch    a place watcher (server/watchers.ts): arriving at or leaving
//            a place, by its name or by coordinates and a radius.
//
// Paused is not off. The phone keeps its choice and this computer keeps
// the last place, to show its owner in Settings, but no agent hears it and
// no watcher acts on it. Off, and Forget on this computer, drop it.
//
// Only the owner's. A member's device never reaches the route that takes a
// report (server/member-access.ts answers everything a member asks), and
// nothing here is told in a conversation anybody but the owner reads.
import { randomBytes } from "node:crypto";

export type Sharing = "on" | "paused" | "off";
/** How exactly a reading says where: a position, a neighbourhood, a city. */
export type Precision = "exact" | "area" | "city";
/** What made the phone say it. */
export type Trigger = "moved" | "visit" | "opened" | "asked" | "turned-on";

const TRIGGERS: readonly Trigger[] = ["moved", "visit", "opened", "asked", "turned-on"];

/** A place in words, as the phone's geocoder named it. */
export interface PlaceWords {
  /** A neighbourhood or district: only with an exact fix on the phone. */
  area?: string;
  /** The city or town. */
  locality?: string;
  /** The province, state or county. */
  region?: string;
  country?: string;
  /** The place's own time zone, as an IANA name. */
  timeZone?: string;
}

export interface SharedLocation extends PlaceWords {
  /** Only when the person chose to share an exact position. */
  latitude?: number;
  longitude?: number;
  /** Metres, the phone's own estimate. Only with coordinates. */
  accuracy?: number;
  precision: Precision;
  /** When the phone took it, by its own clock, never later than when it
   * arrived here. */
  observedAt: number;
  receivedAt: number;
  /** The paired device that said it. */
  deviceId: string;
  trigger?: Trigger;
}

export interface DeviceSharing {
  sharing: Sharing;
  /** When it last said so. */
  at: number;
  /** Whether it says where it is with Bloks closed too: iOS allows it
   * Always, and the person turned that on. Absent when it did not say. */
  background?: boolean;
}

export interface LocationState {
  latest: SharedLocation | null;
  devices: Record<string, DeviceSharing>;
}

export const EMPTY_STATE: LocationState = { latest: null, devices: {} };

/** A reading this recent is "current": right for directions or a pickup. */
export const CURRENT_MS = 15 * 60_000;
/** A reading this recent is told ahead of the owner's turns; older, an
 * agent has to ask for it and is told its age. */
export const CONTEXT_MS = 6 * 60 * 60_000;
/** A place watcher acts only on a reading taken this recently. An arrival
 * heard later than this (a phone that was offline, a lane that was busy
 * all along) is a thing that happened, not a thing to act on now. */
export const LATE_MS = 30 * 60_000;
/** A place watcher's side of the line has to have held this long before
 * crossing it counts again, so a fix that wobbles on the boundary is not
 * a string of arrivals. The first side a watcher sees always counts. */
export const SETTLE_MS = 10 * 60_000;
/** How far ahead of this computer's clock a phone's may run. */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** A reading older than this when it arrives is refused, not kept. */
export const OLDEST_REPORT_MS = 7 * 24 * 60 * 60_000;
/** Reports one device may make in an hour, asked for or not. */
export const REPORTS_PER_HOUR = 120;
/** How long `bloks location --fresh` waits for the phone. */
export const FRESH_WAIT_MS = 15_000;
/** A second ask this soon joins the first rather than asking again. */
export const ASK_REUSE_MS = 10_000;
/** An answer later than this is no answer to that ask. */
export const ANSWER_WINDOW_MS = 60_000;
/** How much earlier than the ask an answer's reading may have been taken,
 * for two clocks that do not quite agree. More than this and it is a
 * reading the phone already had, which is not a fresh one. */
export const ANSWER_SKEW_MS = 30_000;

/** A place watcher's radius, in metres. */
export const DEFAULT_RADIUS = 500;
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 50_000;

const WORD_MAX = 80;
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,3}$/;
const REQUEST = /^[A-Za-z0-9_-]{16,64}$/;

function own(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const field = Object.getOwnPropertyDescriptor(raw, key);
  return field && "value" in field ? field.value : undefined;
}

/** One name, as a line of plain words or nothing. */
function word(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= WORD_MAX ? text : undefined;
}

const finite = (raw: unknown): raw is number => typeof raw === "number" && Number.isFinite(raw);

export type CleanReport =
  | { ok: true; sharing: Sharing; background?: boolean; location: Omit<SharedLocation, "deviceId" | "receivedAt"> | null; request?: string }
  | { ok: false; error: string };

/**
 * What a phone said, checked field by field. The body decides nothing
 * about who said it: the device is the guard's to name. A paused or
 * stopped phone sends no place, and one that does is refused rather than
 * half believed.
 */
export function cleanReport(raw: unknown, now: number): CleanReport {
  const sharing = own(raw, "sharing");
  if (sharing !== "on" && sharing !== "paused" && sharing !== "off") return { ok: false, error: "sharing is on, paused or off" };
  const rawRequest = own(raw, "request");
  if (rawRequest !== undefined && (typeof rawRequest !== "string" || !REQUEST.test(rawRequest))) return { ok: false, error: "that is not a request this computer made" };
  const request = rawRequest as string | undefined;
  const rawBackground = own(raw, "background");
  const background = typeof rawBackground === "boolean" ? { background: rawBackground } : {};
  const rawLocation = own(raw, "location");
  if (rawLocation === undefined || rawLocation === null) return { ok: true, sharing, ...background, location: null, ...(request ? { request } : {}) };
  if (sharing !== "on") return { ok: false, error: "a phone that is not sharing sends no place" };

  const observed = own(rawLocation, "observedAt");
  if (!finite(observed)) return { ok: false, error: "observedAt is when the phone took it, in milliseconds" };
  if (observed > now + CLOCK_SKEW_MS) return { ok: false, error: "that reading is from later than now" };
  if (observed < now - OLDEST_REPORT_MS) return { ok: false, error: "that reading is too old to keep" };

  const place = own(rawLocation, "place");
  const words: PlaceWords = {};
  for (const key of ["area", "locality", "region", "country"] as const) {
    const value = word(own(place, key));
    if (value) words[key] = value;
  }
  const zone = own(place, "timeZone");
  if (typeof zone === "string" && zone.length <= 64 && ZONE.test(zone)) words.timeZone = zone;

  const coordinate = own(rawLocation, "coordinate");
  let position: Pick<SharedLocation, "latitude" | "longitude" | "accuracy"> = {};
  if (coordinate !== undefined && coordinate !== null) {
    const latitude = own(coordinate, "latitude");
    const longitude = own(coordinate, "longitude");
    const accuracy = own(coordinate, "accuracy");
    if (!finite(latitude) || !finite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return { ok: false, error: "a coordinate is a latitude and a longitude in degrees" };
    }
    if (!finite(accuracy) || accuracy <= 0 || accuracy > 100_000) return { ok: false, error: "a coordinate carries its accuracy in metres" };
    // a metre is as close as anyone needs, and as close as a phone means
    position = { latitude: Math.round(latitude * 1e5) / 1e5, longitude: Math.round(longitude * 1e5) / 1e5, accuracy: Math.max(1, Math.round(accuracy)) };
  }
  if (!words.locality && !words.region && !words.country && position.latitude === undefined) {
    return { ok: false, error: "a reading names a place or carries a coordinate" };
  }
  const trigger = own(rawLocation, "trigger") ?? own(raw, "trigger");
  return {
    ok: true,
    sharing,
    ...background,
    location: {
      ...words,
      ...position,
      precision: position.latitude !== undefined ? "exact" : words.area ? "area" : "city",
      observedAt: Math.min(Math.round(observed), now),
      ...(TRIGGERS.includes(trigger as Trigger) ? { trigger: trigger as Trigger } : {}),
    },
    ...(request ? { request } : {}),
  };
}

/** The place in a few words: "Queen West, Toronto, Canada". */
export function placeWords(at: PlaceWords & Pick<SharedLocation, "latitude" | "longitude">): string {
  const parts: string[] = [];
  for (const part of [at.area, at.locality ?? at.region, at.country]) {
    if (part && !parts.some((p) => p.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  if (parts.length) return parts.join(", ");
  return at.latitude !== undefined && at.longitude !== undefined ? `${at.latitude}, ${at.longitude}` : "somewhere unnamed";
}

/** How long ago, said the way a person says it. */
export function agoWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "a moment ago";
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** What "approximate" means for this reading, in a clause. */
export function precisionWords(at: Pick<SharedLocation, "precision" | "accuracy">): string {
  if (at.precision === "exact") return `exact to about ${at.accuracy ?? "a few"} metres`;
  return at.precision === "area" ? "approximate: the neighbourhood and city, no exact position" : "approximate: the city, no exact position";
}

export type Freshness = "current" | "recent" | "old";

export function freshness(age: number): Freshness {
  return age <= CURRENT_MS ? "current" : age <= CONTEXT_MS ? "recent" : "old";
}

/** Who a turn is for, as far as where the owner is goes. */
export interface TurnFor {
  /** The owner asked for it, or something the owner set up did. */
  owner: boolean;
  /** A member asked for it, or it runs on a member's own agent. */
  member: boolean;
  /** A Telegram person or a stranger's mail. */
  outsider: boolean;
  /** Other people read the conversation: a team agent's shared one, a
   * member's private one, or a shared room. */
  othersRead: boolean;
}

/** Whether a turn may be told where the owner is: the owner's own turn,
 * in a conversation only the owner reads, and nobody else's, ever. */
export function hearsWhere(turn: TurnFor): boolean {
  return turn.owner && !turn.member && !turn.outsider && !turn.othersRead;
}

// ── places, for watchers ───────────────────────────────────────────────

export type PlaceTarget =
  | { kind: "name"; parts: string[] }
  | { kind: "point"; latitude: number; longitude: number };

/** Names compared the way a person reads them: any case, no accents. */
export function normal(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const POINT = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** A watcher's place: "latitude,longitude", or a name as the phone would
 * put it (a city, a neighbourhood, a region or a country), with more of
 * it after commas to narrow it ("Paris, France"). Null when it is neither. */
export function parsePlace(target: string): PlaceTarget | null {
  const point = target.match(POINT);
  if (point) {
    const latitude = Number(point[1]);
    const longitude = Number(point[2]);
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { kind: "point", latitude, longitude };
  }
  const parts = target.split(",").map(normal).filter(Boolean);
  if (!parts.length || parts.length > 4 || parts.some((p) => p.length > WORD_MAX)) return null;
  return { kind: "name", parts };
}

/** Metres between two points on the Earth. */
export function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How far past the radius a reading has to be before it counts as gone,
 * so a fix that wobbles across the line does not leave and come back. */
export const leaveMargin = (radius: number) => Math.max(150, radius / 2);

/**
 * Which side of a place a reading is on: "in", "out", or null when it
 * cannot say. A name is in when every part of it is one of the names the
 * phone gave. A point needs a reading with coordinates, accurate enough to
 * tell, and is in within the radius, out past the radius and its margin,
 * and undecided in between.
 */
export function sideOf(target: PlaceTarget, radius: number, at: SharedLocation): "in" | "out" | null {
  if (target.kind === "name") {
    const names = [at.area, at.locality, at.region, at.country].filter((n): n is string => Boolean(n)).map(normal);
    if (!names.length) return null;
    return target.parts.every((part) => names.includes(part)) ? "in" : "out";
  }
  if (at.latitude === undefined || at.longitude === undefined) return null;
  if ((at.accuracy ?? Infinity) > Math.max(1_000, radius * 2)) return null;
  const away = metresBetween(target, { latitude: at.latitude, longitude: at.longitude });
  if (away <= radius) return "in";
  return away >= radius + leaveMargin(radius) ? "out" : null;
}

/** What a place watcher keeps between readings: the side it last saw and
 * since when, by the phone's clock. `base` marks the side it started on. */
export interface PlaceSeen {
  side: "in" | "out";
  since: number;
  base?: true;
}

export function readSeen(raw: string | undefined): PlaceSeen | undefined {
  if (!raw) return undefined;
  try {
    const seen = JSON.parse(raw) as PlaceSeen;
    return (seen.side === "in" || seen.side === "out") && finite(seen.since) ? seen : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One reading, for one watcher. The first side seen is the baseline and
 * never fires, as every watcher's first look. Crossing to the side the
 * watcher waits for fires when the side it left had held for SETTLE_MS
 * (or was where it started) and the reading is no older than LATE_MS.
 * A crossing that does not fire still moves the side, so a late or a
 * wobbling one is never acted on afterwards either.
 */
export function placeStep(
  prev: PlaceSeen | undefined,
  side: "in" | "out" | null,
  observedAt: number,
  now: number,
  when: "arrive" | "leave",
): { next: PlaceSeen | undefined; fire: boolean; late: boolean } {
  if (side === null) return { next: prev, fire: false, late: false };
  if (!prev) return { next: { side, since: observedAt, base: true }, fire: false, late: false };
  // older than what this watcher has already seen: nothing new
  if (observedAt < prev.since || side === prev.side) return { next: prev, fire: false, late: false };
  const wanted = when === "arrive" ? side === "in" : side === "out";
  const settled = Boolean(prev.base) || observedAt - prev.since >= SETTLE_MS;
  const late = now - observedAt > LATE_MS;
  return { next: { side, since: observedAt }, fire: wanted && settled && !late, late: wanted && settled && late };
}

/** Whether a reading would change what a place watcher has seen: the one
 * cheap question asked of every place watcher as a reading arrives and
 * once a minute, so only a watcher with something to do is looked at. */
export function placePending(target: string, radius: number | undefined, seen: string | undefined, at: SharedLocation | null): boolean {
  if (!at) return false;
  const place = parsePlace(target);
  if (!place) return false;
  const side = sideOf(place, radius ?? DEFAULT_RADIUS, at);
  if (side === null) return false;
  const prev = readSeen(seen);
  return !prev || (prev.side !== side && at.observedAt >= prev.since);
}

const metres = (m: number) => (m >= 1_000 ? `${Math.round(m / 100) / 10} km` : `${Math.round(m)} m`);

/** What crossing a watcher's place means, after the person's name: "has
 * arrived in Toronto", "is now more than 500 m from 43.6777, -79.6248". */
export function crossingWords(target: string, radius: number | undefined, when: "arrive" | "leave"): string {
  const place = parsePlace(target);
  if (place?.kind === "point") {
    const r = metres(radius ?? DEFAULT_RADIUS);
    return when === "leave" ? `is now more than ${r} from ${place.latitude}, ${place.longitude}` : `is now within ${r} of ${place.latitude}, ${place.longitude}`;
  }
  return when === "leave" ? `has left ${target.trim()}` : `has arrived in ${target.trim()}`;
}

// ── the store ──────────────────────────────────────────────────────────

type Ask = { id: string; at: number; answered: SharedLocation | null; listeners: Set<() => void> };

/** Who is asking, for the words: the owner's name, or nobody named. */
export interface Speaker {
  /** The owner's name, when they gave one. */
  name?: string | null;
  /** The command an agent runs, when it has one. */
  cli?: string | null;
}

export class Whereabouts {
  private state: LocationState;
  private readonly reports = new Map<string, number[]>();
  private ask_: Ask | null = null;
  private readonly persist: (state: LocationState) => void;
  private readonly clock: () => number;

  constructor(initial: LocationState, persist: (state: LocationState) => void = () => {}, clock: () => number = Date.now) {
    this.state = cleanState(initial);
    this.persist = persist;
    this.clock = clock;
  }

  /** Sharing as a whole: the device the last reading came from decides,
   * and with no reading, any device that is on. */
  sharing(): Sharing {
    const { latest, devices } = this.state;
    if (latest) return devices[latest.deviceId]?.sharing ?? "off";
    const all = Object.values(devices).map((d) => d.sharing);
    return all.includes("on") ? "on" : all.includes("paused") ? "paused" : "off";
  }

  /** Whether the phone sharing says where it is with Bloks closed too, or
   * null when no phone shares or it did not say. */
  background(): boolean | null {
    const { latest, devices } = this.state;
    const sharing = latest ? devices[latest.deviceId] : Object.values(devices).find((d) => d.sharing === "on");
    return sharing?.sharing === "on" && typeof sharing.background === "boolean" ? sharing.background : null;
  }

  /** The reading agents and watchers may use: only while sharing is on. */
  usable(): SharedLocation | null {
    return this.sharing() === "on" ? this.state.latest : null;
  }

  /** Everything, for the owner's own screens. */
  snapshot(): LocationState {
    return structuredClone(this.state);
  }

  /**
   * A report from a paired owner device. A reading older than the one
   * already kept is the past and changes nothing kept; sharing turned off
   * forgets what that device said. `changed` is true when the reading
   * agents and watchers use is not what it was.
   */
  report(deviceId: string, raw: unknown): { ok: true; changed: boolean; answered: boolean } | { ok: false; status: number; error: string } {
    const now = this.clock();
    const recent = (this.reports.get(deviceId) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= REPORTS_PER_HOUR) return { ok: false, status: 429, error: "this phone has said where it is many times this hour; it is heard again shortly" };
    recent.push(now);
    this.reports.set(deviceId, recent);
    const clean = cleanReport(raw, now);
    if (!clean.ok) return { ok: false, status: 400, error: clean.error };
    const before = this.usable();
    // whether it shares with Bloks closed is kept until it says otherwise
    const background = clean.background ?? this.state.devices[deviceId]?.background;
    this.state.devices[deviceId] = { sharing: clean.sharing, at: now, ...(background !== undefined ? { background } : {}) };
    if (clean.sharing === "off" && this.state.latest?.deviceId === deviceId) this.state.latest = null;
    let kept: SharedLocation | null = null;
    if (clean.location) {
      kept = { ...clean.location, receivedAt: now, deviceId };
      const latest = this.state.latest;
      if (!latest || kept.observedAt >= latest.observedAt) this.state.latest = kept;
    }
    const answered = this.answer(clean.request, kept);
    this.persist(this.state);
    return { ok: true, changed: before !== this.usable(), answered };
  }

  /** Forget what is kept: the owner's Forget, pairing off, or every
   * device revoked. Who is sharing stays, so the next reading is kept. */
  forget(): void {
    this.state.latest = null;
    this.persist(this.state);
  }

  /** A revoked device: its word and its reading are gone. */
  forgetDevice(deviceId: string): void {
    delete this.state.devices[deviceId];
    if (this.state.latest?.deviceId === deviceId) this.state.latest = null;
    this.reports.delete(deviceId);
    this.persist(this.state);
  }

  /** Every device forgotten, as with pairing switched off. */
  forgetDevices(): void {
    this.state = { latest: null, devices: {} };
    this.reports.clear();
    this.persist(this.state);
  }

  // ── asking the phone ────────────────────────────────────────────────

  /** An ask for a fresh reading, sent by `deliver` to the owner's open
   * windows and phones, or the one already out a moment ago. */
  ask(deliver: (frame: { kind: "location-request"; request: string }) => void): Ask {
    const now = this.clock();
    if (this.ask_ && now - this.ask_.at < ASK_REUSE_MS && !this.ask_.answered) return this.ask_;
    const ask: Ask = { id: randomBytes(24).toString("base64url"), at: now, answered: null, listeners: new Set() };
    this.ask_ = ask;
    deliver({ kind: "location-request", request: ask.id });
    return ask;
  }

  /** Until the phone answers the ask, or the wait ends. */
  async wait(ask: Ask, ms = FRESH_WAIT_MS): Promise<SharedLocation | null> {
    if (ask.answered) return ask.answered;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    try {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        listener = resolve;
        ask.listeners.add(listener);
      });
    } finally {
      clearTimeout(timer);
      if (listener) ask.listeners.delete(listener);
    }
    return ask.answered;
  }

  /** A reading that answers the ask has to have been taken after it was
   * made: a phone that answers with what it already had is not fresh. */
  private answer(request: string | undefined, kept: SharedLocation | null): boolean {
    const ask = this.ask_;
    if (!request || !ask || ask.id !== request || !kept) return false;
    if (this.clock() - ask.at > ANSWER_WINDOW_MS || kept.observedAt < ask.at - ANSWER_SKEW_MS) return false;
    ask.answered = kept;
    for (const listener of [...ask.listeners]) listener();
    return true;
  }

  // ── what is said ────────────────────────────────────────────────────

  /** The line ahead of the owner's own turn, or null: only while sharing
   * is on and the reading is recent enough to be worth a sentence. */
  contextLine(who: Speaker): string | null {
    const at = this.usable();
    if (!at) return null;
    const age = this.clock() - at.observedAt;
    if (age > CONTEXT_MS) return null;
    const name = who.name?.trim() || "The person you work for";
    const exact = at.precision === "exact" ? "" : ", approximately";
    const more = who.cli ? ` \`${who.cli} location\` says how exact that is, and \`${who.cli} location --fresh\` asks the phone for a new reading.` : "";
    return `(${name} is in ${placeWords(at)}${exact}, as of ${agoWords(age)}, from their phone.${more})`;
  }

  /** What `bloks location` answers. */
  forAgent(who: Speaker): Record<string, unknown> {
    const sharing = this.sharing();
    const at = this.usable();
    const fresh = who.cli ? `\`${who.cli} location --fresh\`` : "a fresh reading";
    if (sharing === "paused") {
      return { sharing, location: null, note: "Location sharing is paused on their phone, so where they are is not shared. Do not guess; ask them, or ask them to resume it in the Bloks app." };
    }
    if (sharing === "off") {
      return { sharing, location: null, note: "Location sharing is off. They can turn it on in the Bloks app on their phone (Settings, Location). Do not guess where they are; ask." };
    }
    if (!at) return { sharing, location: null, note: `Sharing is on, but their phone has not said where it is yet. Ask with ${fresh}, or ask them.` };
    const age = this.clock() - at.observedAt;
    const fresh_ = freshness(age);
    const closed = this.background();
    const when = `Observed ${agoWords(age)} (${new Date(at.observedAt).toISOString()}).`;
    const how = `It is ${precisionWords(at)}.${closed === false ? " Their phone says where it is only while Bloks is open on it, so it may be a while before the next reading." : ""}`;
    const advice =
      fresh_ === "current"
        ? at.precision === "exact"
          ? ""
          : " Fine for weather, time zones or what is near; not for directions or a pickup point."
        : fresh_ === "recent"
          ? ` They may have moved since. For directions, a pickup or anything that needs where they are right now, ask with ${fresh}, and say its age if you use this one.`
          : ` That is too old to treat as where they are now. Ask with ${fresh}, or ask them.`;
    return {
      sharing,
      location: {
        place: placeWords(at),
        ...(at.area ? { area: at.area } : {}),
        ...(at.locality ? { locality: at.locality } : {}),
        ...(at.region ? { region: at.region } : {}),
        ...(at.country ? { country: at.country } : {}),
        ...(at.timeZone ? { timeZone: at.timeZone } : {}),
        precision: at.precision,
        ...(at.latitude !== undefined ? { latitude: at.latitude, longitude: at.longitude, accuracyMeters: at.accuracy } : {}),
        observedAt: new Date(at.observedAt).toISOString(),
        ageMinutes: Math.floor(age / 60_000),
        freshness: fresh_,
      },
      ...(closed !== null ? { sharesWithBloksClosed: closed } : {}),
      note: `${when} ${how}${advice}`,
    };
  }
}

/** A saved state, kept only where every field reads right. */
export function cleanState(raw: unknown): LocationState {
  const devices: Record<string, DeviceSharing> = {};
  const saved = own(raw, "devices");
  if (saved && typeof saved === "object") {
    for (const [id, entry] of Object.entries(saved as Record<string, unknown>)) {
      const sharing = own(entry, "sharing");
      const at = own(entry, "at");
      const background = own(entry, "background");
      if (/^[\w-]{1,64}$/.test(id) && (sharing === "on" || sharing === "paused" || sharing === "off") && finite(at)) {
        devices[id] = { sharing, at, ...(typeof background === "boolean" ? { background } : {}) };
      }
    }
  }
  const latest = own(raw, "latest") as SharedLocation | undefined;
  const keep =
    latest &&
    typeof latest.deviceId === "string" &&
    finite(latest.observedAt) &&
    finite(latest.receivedAt) &&
    (latest.precision === "exact" || latest.precision === "area" || latest.precision === "city") &&
    devices[latest.deviceId]
      ? structuredClone(latest)
      : null;
  return { latest: keep, devices };
}
