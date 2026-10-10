// Routines: work an agent does on a schedule instead of when you ask.
//
// An agent that checks something every morning is worth more than one you
// have to remember to ask, which is the whole reason this exists.
//
// The schedule is deliberately a time of day plus days of the week rather
// than cron. Cron is more expressive and nobody can read it on a phone at
// arm's length, and "every weekday at 09:00" covers essentially every
// routine anyone actually writes. The one shape it does not cover is the
// check-in, "every 30 minutes, nine to six", which is still a sentence,
// so it is the one other shape there is (`every`, `activeHours`).
//
// Two behaviours are worth understanding before changing anything here:
//
//   A missed run fires once, not N times. The Mac sleeps. When it wakes,
//   the routine fires for the slot it missed rather than once per slot
//   since the machine went down, which is how you get an agent doing your
//   morning brief eleven times.
//
//   A run missed by more than the grace window is skipped entirely. A
//   "brief me at 09:00" that fires at 23:40 because the lid was shut all
//   day is not a brief, it is a surprise. The next one comes tomorrow.
//   A check-in's window is half its interval: by then the next one is
//   nearly due, and two back to back would be the same look twice.
//
// A check-in is also quiet (`quiet`, which a time-of-day routine can ask
// for too): the agent is told that when nothing needs the person it
// answers QUIET, and a quiet answer is kept out of the way rather than
// announced. Something every half hour that pinged every half hour would
// be switched off by lunchtime.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { readSaved, writeFileAtomic } from "./atomic-write.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface Routine {
  id: string;
  /** The agent or room this wakes. */
  targetId: string;
  targetKind: "agent" | "room";
  /** A short label for the calendar. Absent means the prompt stands in. */
  name?: string;
  /** What gets said to them when the routine runs. */
  prompt: string;
  /** Local time of day on the Mac, "HH:MM", 24 hour. For a check-in
   * (`every`), its first of the day: where its active hours begin, or
   * midnight, so a client that does not know `every` still reads a time
   * that is true. */
  time: string;
  /** A check-in: it runs every this many minutes, MIN_EVERY to
   * MAX_EVERY, instead of at a time of day. Counted from the start of
   * its active hours on each day it runs, so the slots fall at the same
   * times every day and a calendar can show them. */
  every?: number;
  /** The local hours a check-in keeps to, both ends included, within one
   * day ("from" before "to"). Absent means the whole day. */
  activeHours?: { from: string; to: string };
  /** The agent is told it may answer QUIET when nothing needs the
   * person, and a run that does is kept out of the way: no unread, no
   * notification, one muted line in the chat. Always on for a check-in,
   * off unless asked for on a time of day, and never on a room's
   * routine, where several agents answer and a channel may be reading. */
  quiet?: boolean;
  /** Days it runs, 0 = Sunday through 6 = Saturday. Empty means daily. */
  days: number[];
  /** Weekly is the default. A once routine runs on `date` and then
   * disables itself, staying on the books as a record. */
  repeat?: "weekly" | "once";
  /** The one day a once routine runs, "YYYY-MM-DD" local. */
  date?: string;
  /** How long the calendar blocks out for it, minutes. Display only. */
  durationMin?: number;
  /** Where the turn runs, overriding the agent's own computer setting:
   * "cloud" its cloud computer, "local" this Mac, "off" no computer.
   * Absent means wherever the agent normally runs. */
  runsOn?: "cloud" | "local" | "off";
  /** The conversation it runs in, by title or by id. Absent means the
   * agent's first, General, where the person talks to it too (GitHub
   * 237); routines from before that were given "Routines", the lane they
   * shared. Two routines that name different lanes run side by side,
   * each with its own context; naming a lane the person already has puts
   * the routine's turns in that conversation. */
  thread?: string;
  enabled: boolean;
  createdAt: number;
  /** When its schedule was last set: made, retimed, or switched back on.
   * A slot before this was never this routine's to run, so the grace for
   * a missed slot does not reach back past it (GitHub 142). */
  scheduledAt?: number;
  /** When it last actually fired. Absent until the first run. */
  lastRunAt?: number;
  /** Filed or last changed from an agent's turn: the place in a chain
   * of agents' messages its turns take (MAX_AGENT_CHAIN in
   * server/index.ts), so an agent cannot keep itself going through
   * routines it files. Absent once the person has filed, changed or run
   * it. Set by the server, never from a request body. */
  chain?: number;
  /** The last few runs, newest first. A routine you cannot inspect is a
   * routine you cannot trust: "did my 9am brief run, and what did it
   * say" is the first question anybody asks, and until now the honest
   * answer was that nobody knew. */
  runs?: RoutineRun[];
  /** What its last run that was not quiet said, and when. Kept apart
   * from `runs` because a check-in every quarter of an hour would push
   * it out of a list of twenty by lunchtime, and the next run is told it
   * (see lastReportNote) so a run that lands in a fresh session, or one
   * summarised since, still knows what it reported before. */
  lastReport?: { at: number; summary: string };
}

/** One firing: when it went out, how it ended, and what came back. */
export interface RoutineRun {
  id: string;
  startedAt: number;
  /** Absent while it is still running. */
  endedAt?: number;
  /** "running" until a turn completes; then how it ended. */
  state: "running" | "ok" | "failed";
  /** The first part of what the agent said, so the row means something
   * without opening the lane. */
  summary?: string;
  /** It ended with the agent answering QUIET: it ran, and nothing needed
   * the person. A flag on an "ok" run rather than a state of its own, so
   * a client that does not know it still reads a run that went fine. */
  quiet?: boolean;
  error?: string;
  /** Where to look for the whole thing. */
  threadId?: string;
}

/** How many runs a routine remembers. Enough to see a pattern, not
 * enough to turn a settings file into a log store. */
export const MAX_RUNS = 20;

/** A routine spends the user's tokens unattended, so the caps are tight. */
export const MAX_ROUTINES = 50;
export const MAX_ROUTINE_PROMPT = 4_000;

/** How late a missed run may still fire. See the header. */
export const GRACE_MS = 2 * 60 * 60_000;

/** A check-in's interval, minutes. Under a quarter of an hour is an agent
 * spending the person's tokens to watch a pot; a day is the longest
 * interval that is not simply a time of day. */
export const MIN_EVERY = 15;
export const MAX_EVERY = 1440;

/** How much of what a routine said last time its next run is told. A few
 * sentences: enough to know what was reported and not say it again, not
 * so much that it becomes a second prompt. */
export const LAST_REPORT_MAX = 600;

const ROUTINES_FILE = join(DATA_DIR, "routines.json");

// ── schedule maths, kept pure so it is testable without a clock ────────

/** "HH:MM" to minutes past midnight, or null if it is not a valid time. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** The single instant a once routine runs, or null if malformed. */
function onceInstant(routine: Routine): Date | null {
  const minutes = parseTime(routine.time);
  const match = routine.date?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (minutes === null || !match) return null;
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return at;
}

/** Whether a routine checks in every so often rather than at a time. */
export function isCheckIn(routine: Pick<Routine, "every">): boolean {
  return typeof routine.every === "number";
}

/** Whether a routine's agent may answer QUIET (see the header). */
export function isQuiet(routine: Pick<Routine, "every" | "quiet" | "targetKind">): boolean {
  return routine.targetKind === "agent" && (isCheckIn(routine) || routine.quiet === true);
}

/** Every instant a check-in runs on the day `day` falls on, in order, and
 * none on a day it does not run. The slots start where its active hours
 * do and step by `every` to where they end, so they land at the same
 * times every day. */
export function checkInsOn(routine: Pick<Routine, "every" | "activeHours" | "days">, day: Date): Date[] {
  if (!routine.every || (routine.days.length > 0 && !routine.days.includes(day.getDay()))) return [];
  const from = parseTime(routine.activeHours?.from) ?? 0;
  const to = parseTime(routine.activeHours?.to) ?? 24 * 60 - 1;
  const out: Date[] = [];
  for (let minutes = from; minutes <= to; minutes += routine.every) {
    const at = new Date(day);
    at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    out.push(at);
  }
  return out;
}

/** How late this routine's missed slot may still fire. See the header. */
export function graceFor(routine: Pick<Routine, "every">): number {
  return routine.every ? Math.min(GRACE_MS, (routine.every * 60_000) / 2) : GRACE_MS;
}

/**
 * The most recent instant this routine was scheduled to run, at or before
 * `now`. Searches back a week, which is as far as any weekly schedule can
 * be from its last occurrence.
 */
export function lastScheduledBefore(routine: Routine, now: Date): Date | null {
  if (isCheckIn(routine)) {
    for (let back = 0; back <= 7; back++) {
      const day = new Date(now);
      day.setDate(day.getDate() - back);
      const passed = checkInsOn(routine, day).filter((at) => at.getTime() <= now.getTime());
      if (passed.length) return passed[passed.length - 1];
    }
    return null;
  }
  if (routine.repeat === "once") {
    const at = onceInstant(routine);
    return at && at.getTime() <= now.getTime() ? at : null;
  }
  const minutes = parseTime(routine.time);
  if (minutes === null) return null;
  const runsOn = (day: number) => routine.days.length === 0 || routine.days.includes(day);

  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (day.getTime() <= now.getTime() && runsOn(day.getDay())) return day;
  }
  return null;
}

/** The next instant this routine will run, for showing "next: tomorrow 09:00". */
export function nextScheduledAfter(routine: Routine, now: Date): Date | null {
  if (isCheckIn(routine)) {
    for (let ahead = 0; ahead <= 7; ahead++) {
      const day = new Date(now);
      day.setDate(day.getDate() + ahead);
      const next = checkInsOn(routine, day).find((at) => at.getTime() > now.getTime());
      if (next) return next;
    }
    return null;
  }
  if (routine.repeat === "once") {
    const at = onceInstant(routine);
    return at && at.getTime() > now.getTime() ? at : null;
  }
  const minutes = parseTime(routine.time);
  if (minutes === null) return null;
  const runsOn = (day: number) => routine.days.length === 0 || routine.days.includes(day);

  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now);
    day.setDate(day.getDate() + ahead);
    day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (day.getTime() > now.getTime() && runsOn(day.getDay())) return day;
  }
  return null;
}

/**
 * Whether this routine should fire right now.
 *
 * True exactly once per scheduled slot: `lastRunAt` is what stops a tick
 * every thirty seconds from firing the same slot repeatedly.
 */
export function isDue(routine: Routine, now: Date, graceMs: number = graceFor(routine)): boolean {
  if (!routine.enabled) return false;
  const slot = lastScheduledBefore(routine, now);
  if (!slot) return false;
  // Missed by too much to be useful. Wait for the next one.
  if (now.getTime() - slot.getTime() > graceMs) return false;
  // A slot from before the routine had this schedule was not missed; it
  // never existed. Made at 19:01 for 18:00 means tomorrow at 18:00.
  if (routine.scheduledAt !== undefined && slot.getTime() < routine.scheduledAt) return false;
  // Already served this slot.
  if (routine.lastRunAt !== undefined && routine.lastRunAt >= slot.getTime()) return false;
  return true;
}

/**
 * Why a prompt is too long to file, or null when it fits. Refused rather
 * than cut: a routine that quietly loses the end of its instructions runs
 * them wrong every time, and nobody sees why. The prompt itself is left
 * out of the message, since it can be long and is not ours to repeat.
 */
export function promptTooLong(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const length = prompt.trim().length;
  return length > MAX_ROUTINE_PROMPT
    ? `routine prompt is too long: maximum ${MAX_ROUTINE_PROMPT}, received ${length}`
    : null;
}

/** Whether an agent's answer is the quiet word: QUIET in any case, with
 * nothing else but the full stop or exclamation a model adds out of
 * habit. Anything more is something said, and is shown. */
export function isQuietReply(text: string | undefined): boolean {
  return /^quiet[.!…]*$/i.test((text ?? "").trim());
}

/** What a quiet routine's turn adds to the line that says where it came
 * from. In the turn's own words rather than the system prompt, which a
 * resumed session keeps byte for byte (server/standing-prompt.ts). */
export const QUIET_ASK =
  "If nothing in it needs the person right now, answer with exactly QUIET and nothing else; a quiet answer is not brought to their attention.";

/** The note a routine's next run carries about what it said last time,
 * or null before it has said anything. One line, cut to LAST_REPORT_MAX
 * with an ellipsis, so it reads as a reminder and not as instructions. */
export function lastReportNote(report: Routine["lastReport"]): string | null {
  const said = report?.summary.replace(/\s+/g, " ").trim();
  if (!said) return null;
  const cut = said.length > LAST_REPORT_MAX ? `${said.slice(0, LAST_REPORT_MAX - 1).trimEnd()}…` : said;
  return `(Last time this routine reported: ${cut})`;
}

/** A check-in's interval as sent, when it is one we run. */
function everyOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_EVERY && value <= MAX_EVERY
    ? value
    : undefined;
}

/** Active hours as sent, normalised, or null when they are not a stretch
 * of one day: both real times, the start before the end. A window over
 * midnight is two check-ins, which is easier to read than one that wraps. */
export function activeHoursOf(value: unknown): { from: string; to: string } | null {
  if (!value || typeof value !== "object") return null;
  const { from, to } = value as Record<string, unknown>;
  const start = parseTime(from);
  const end = parseTime(to);
  if (start === null || end === null || start >= end) return null;
  return { from: formatTime(start), to: formatTime(end) };
}

/**
 * Why a check-in or a quiet run cannot be filed as asked, or null when it
 * can. Said rather than clamped or dropped, like an over-long prompt: a
 * check-in asked for every five minutes that became every fifteen is not
 * what anybody asked for either, and a person can fix what they are told.
 */
export function scheduleProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const checkIn = o.every !== undefined && o.every !== null;
  if (checkIn && everyOf(o.every) === undefined) {
    return `a check-in runs every ${MIN_EVERY} to ${MAX_EVERY} minutes, a whole number of them`;
  }
  if (checkIn && o.activeHours !== undefined && o.activeHours !== null && !activeHoursOf(o.activeHours)) {
    return 'active hours are { "from": "HH:MM", "to": "HH:MM" }, within one day, the start before the end';
  }
  if (checkIn && o.repeat === "once") return "a check-in repeats, so it cannot also run once";
  if ((checkIn || o.quiet === true) && o.targetKind === "room") {
    return "a room's routine runs at a time of day and speaks every time: check-ins and quiet runs are for an agent";
  }
  return null;
}

/** Clamps whatever a client sent into something we are willing to store. */
export function normalize(raw: unknown): Omit<Routine, "id" | "createdAt"> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const targetId = typeof o.targetId === "string" ? o.targetId.trim() : "";
  if (!targetId) return null;
  const targetKind = o.targetKind === "room" ? "room" : "agent";

  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt || promptTooLong(prompt)) return null;

  if (scheduleProblem({ ...o, targetKind })) return null;
  const every = everyOf(o.every);
  // only a check-in keeps to hours; a time of day already says when
  const activeHours = every ? (activeHoursOf(o.activeHours) ?? undefined) : undefined;
  // A check-in has no time of its own to ask for; its first slot of the
  // day stands in, so `time` stays true for every client that reads it.
  const minutes = every ? (parseTime(activeHours?.from) ?? 0) : parseTime(o.time);
  if (minutes === null) return null;

  const days = Array.isArray(o.days)
    ? [...new Set(o.days.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6))].sort()
    : [];

  const name = typeof o.name === "string" ? o.name.trim().slice(0, 60) : "";
  const repeat = o.repeat === "once" ? ("once" as const) : undefined;
  const date =
    typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : undefined;
  // a once routine with no day to run on is not a routine
  if (repeat === "once" && !date) return null;
  const durationMin =
    typeof o.durationMin === "number" && Number.isFinite(o.durationMin)
      ? Math.max(15, Math.min(480, Math.round(o.durationMin / 15) * 15))
      : undefined;
  const runsOn =
    o.runsOn === "cloud" || o.runsOn === "local" || o.runsOn === "off" ? o.runsOn : undefined;
  // a lane title or id: one line, as short as any other lane's
  const thread =
    typeof o.thread === "string" ? o.thread.replace(/\s+/g, " ").trim().slice(0, 40) || undefined : undefined;

  // every optional field is named, present-or-cleared, so a PATCH can
  // genuinely turn a once routine weekly or drop a name
  return {
    targetId,
    targetKind,
    prompt,
    time: formatTime(minutes),
    days,
    enabled: o.enabled !== false,
    name: name || undefined,
    repeat,
    date: repeat === "once" ? date : undefined,
    // a block on the calendar for an appointment; a check-in is not one
    durationMin: every ? undefined : durationMin,
    runsOn,
    thread: targetKind === "agent" ? thread : undefined,
    every,
    activeHours,
    quiet: targetKind === "agent" && (every !== undefined || o.quiet === true) ? true : undefined,
  };
}

/** A check-in's interval the way a person says it: "30 min", "2 hours",
 * and minutes for anything that is not whole hours, since "90 min" is
 * read faster than "1 hour 30 min". */
export function intervalWords(every: number): string {
  if (every % 60 !== 0) return `${every} min`;
  return every === 60 ? "hour" : `${every / 60} hours`;
}

/** Human summary, used by the clients so both agree on the wording. */
export function describe(routine: Routine): string {
  if (routine.repeat === "once") {
    const at = onceInstant(routine);
    return at
      ? `Once on ${at.toLocaleDateString([], { month: "short", day: "numeric" })} at ${routine.time}`
      : `Once at ${routine.time}`;
  }
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekdays = [1, 2, 3, 4, 5];
  const weekend = [0, 6];
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((d, i) => d === b[i]);

  if (routine.every) {
    const hours = routine.activeHours ? `, ${routine.activeHours.from} to ${routine.activeHours.to}` : "";
    const on =
      routine.days.length === 0
        ? ""
        : same(routine.days, weekdays)
          ? " on weekdays"
          : same(routine.days, weekend)
            ? " on weekends"
            : routine.days.length === 1
              ? ` on ${names[routine.days[0]]}s`
              : ` on ${routine.days.map((d) => names[d].slice(0, 3)).join(", ")}`;
    return `Every ${intervalWords(routine.every)}${hours}${on}`;
  }
  if (routine.days.length === 0) return `Every day at ${routine.time}`;
  if (same(routine.days, weekdays)) return `Weekdays at ${routine.time}`;
  if (same(routine.days, weekend)) return `Weekends at ${routine.time}`;
  if (routine.days.length === 1) return `Every ${names[routine.days[0]]} at ${routine.time}`;
  return `${routine.days.map((d) => names[d].slice(0, 3)).join(", ")} at ${routine.time}`;
}

// ── storage ───────────────────────────────────────────────────────────

export class RoutineStore {
  routines: Routine[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    this.routines = readSaved<Routine[]>(ROUTINES_FILE, [], Array.isArray).filter(isRoutine);
  }

  private save() {
    writeFileAtomic(ROUTINES_FILE, JSON.stringify(this.routines, null, 2), 0o600);
  }

  get(id: string): Routine | null {
    return this.routines.find((r) => r.id === id) ?? null;
  }

  /** Routines pointed at a thread that no longer exists are dead weight. */
  forTarget(targetId: string): Routine[] {
    return this.routines.filter((r) => r.targetId === targetId);
  }

  create(input: Omit<Routine, "id" | "createdAt">): Routine | null {
    if (this.routines.length >= MAX_ROUTINES) return null;
    const now = Date.now();
    const routine: Routine = { ...input, id: newId(), createdAt: now, scheduledAt: now };
    this.routines.push(routine);
    this.save();
    return routine;
  }

  patch(id: string, patch: Partial<Routine>): Routine | null {
    const routine = this.get(id);
    if (!routine) return null;
    // Spelled out rather than looped over a key list: the cast that makes
    // the loop compile also lets a typo write a field that does not exist.
    // a schedule that changes, or a routine switched back on, starts
    // counting its slots from now
    const rescheduled =
      (patch.time !== undefined && patch.time !== routine.time) ||
      (patch.days !== undefined && patch.days.join(",") !== routine.days.join(",")) ||
      ("repeat" in patch && patch.repeat !== routine.repeat) ||
      ("date" in patch && patch.date !== routine.date) ||
      ("every" in patch && patch.every !== routine.every) ||
      ("activeHours" in patch && JSON.stringify(patch.activeHours) !== JSON.stringify(routine.activeHours)) ||
      (patch.enabled === true && !routine.enabled);
    if (rescheduled) routine.scheduledAt = Date.now();
    if (patch.prompt !== undefined) routine.prompt = patch.prompt;
    if (patch.time !== undefined) routine.time = patch.time;
    if (patch.days !== undefined) routine.days = patch.days;
    if (patch.enabled !== undefined) routine.enabled = patch.enabled;
    if (patch.lastRunAt !== undefined) routine.lastRunAt = patch.lastRunAt;
    if ("name" in patch) routine.name = patch.name || undefined;
    if ("durationMin" in patch) routine.durationMin = patch.durationMin;
    if ("runsOn" in patch) routine.runsOn = patch.runsOn;
    if ("thread" in patch) routine.thread = patch.thread;
    if ("repeat" in patch) routine.repeat = patch.repeat;
    if ("date" in patch) routine.date = patch.date;
    if ("every" in patch) routine.every = patch.every;
    if ("activeHours" in patch) routine.activeHours = patch.activeHours;
    if ("quiet" in patch) routine.quiet = patch.quiet || undefined;
    if ("chain" in patch) routine.chain = patch.chain || undefined;
    this.save();
    return routine;
  }

  remove(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) return false;
    this.save();
    return true;
  }

  /** Every agent's routine that names no conversation is given this
   * one, once, on the upgrade that made the first conversation the
   * default (GitHub 237), so what is filed keeps running where it ran. */
  nameUnnamed(thread: string): void {
    const unnamed = this.routines.filter((r) => r.targetKind === "agent" && !r.thread);
    for (const routine of unnamed) routine.thread = thread;
    if (unnamed.length) this.save();
  }

  /** Drop every routine aimed at a deleted agent or room. */
  removeForTarget(targetId: string): void {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.targetId !== targetId);
    if (this.routines.length !== before) this.save();
  }

  markRan(id: string, at: number): void {
    const routine = this.get(id);
    if (!routine) return;
    routine.lastRunAt = at;
    // a once routine has now happened; it stays on the books, disabled
    if (routine.repeat === "once") routine.enabled = false;
    this.save();
  }

  /** Opens a run and hands back its id, so whoever finishes it can find
   * it again. Runs are kept newest first and capped. */
  beginRun(id: string, threadId?: string): RoutineRun | null {
    const routine = this.get(id);
    if (!routine) return null;
    const run: RoutineRun = {
      id: newId(),
      startedAt: Date.now(),
      state: "running",
      ...(threadId ? { threadId } : {}),
    };
    routine.runs = [run, ...(routine.runs ?? [])].slice(0, MAX_RUNS);
    this.save();
    return run;
  }

  /** Closes a run. Unknown ids are ignored: a restart between the start
   * and the end of a turn is normal, and inventing a row for it would
   * be worse than the gap. */
  endRun(
    routineId: string,
    runId: string,
    outcome: { state: "ok" | "failed"; summary?: string; error?: string; quiet?: boolean },
  ): void {
    const routine = this.get(routineId);
    const run = routine?.runs?.find((r) => r.id === runId);
    if (!routine || !run) return;
    run.state = outcome.state;
    run.endedAt = Date.now();
    // a quiet run said one word, which is not a summary of anything
    if (outcome.quiet && outcome.state === "ok") run.quiet = true;
    else if (outcome.summary) run.summary = outcome.summary.slice(0, 300);
    if (outcome.error) run.error = outcome.error.slice(0, 300);
    // kept a little longer than the note tells, so the note knows where
    // it cut and says so
    if (outcome.state === "ok" && !outcome.quiet && outcome.summary?.trim()) {
      routine.lastReport = { at: run.endedAt, summary: outcome.summary.trim().slice(0, LAST_REPORT_MAX * 2) };
    }
    this.save();
  }

  /** A run left open by a crash is not running; it is unknown. Called at
   * boot so the list never shows a spinner that will never resolve. */
  settleOrphanRuns(): void {
    let touched = false;
    for (const routine of this.routines) {
      for (const run of routine.runs ?? []) {
        if (run.state === "running") {
          run.state = "failed";
          run.endedAt = run.startedAt;
          run.error = "Bloks closed before this run finished.";
          touched = true;
        }
      }
    }
    if (touched) this.save();
  }

  due(now: Date): Routine[] {
    return this.routines.filter((r) => isDue(r, now));
  }
}

/** routines.json is a file a person can open and edit, so it is checked
 * rather than trusted. A malformed entry is dropped, not repaired. */
function isRoutine(value: unknown): value is Routine {
  const r = value as Routine | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.id === "string" &&
    typeof r.targetId === "string" &&
    (r.targetKind === "agent" || r.targetKind === "room") &&
    typeof r.prompt === "string" &&
    parseTime(r.time) !== null &&
    Array.isArray(r.days) &&
    typeof r.enabled === "boolean" &&
    // an interval typed in by hand is held to the same floor as one
    // filed: a check-in every minute is a bill, not a routine
    (r.every === undefined || everyOf(r.every) !== undefined) &&
    (r.activeHours === undefined || activeHoursOf(r.activeHours) !== null)
  );
}
