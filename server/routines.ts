// Routines: work an agent does on a schedule instead of when you ask.
//
// An agent that checks something every morning is worth more than one you
// have to remember to ask, which is the whole reason this exists.
//
// The schedule is deliberately a time of day plus days of the week rather
// than cron. Cron is more expressive and nobody can read it on a phone at
// arm's length, and "every weekday at 09:00" covers essentially every
// routine anyone actually writes.
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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface Routine {
  id: string;
  /** The agent or room this wakes. */
  targetId: string;
  targetKind: "agent" | "room";
  /** A short label for the calendar. Absent means the prompt stands in. */
  name?: string;
  /** What gets said to them, as though you had typed it. */
  prompt: string;
  /** Local time of day on the Mac, "HH:MM", 24 hour. */
  time: string;
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
  enabled: boolean;
  createdAt: number;
  /** When it last actually fired. Absent until the first run. */
  lastRunAt?: number;
  /** The last few runs, newest first. A routine you cannot inspect is a
   * routine you cannot trust: "did my 9am brief run, and what did it
   * say" is the first question anybody asks, and until now the honest
   * answer was that nobody knew. */
  runs?: RoutineRun[];
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
  error?: string;
  /** Where to look for the whole thing. */
  threadId?: string;
}

/** How many runs a routine remembers. Enough to see a pattern, not
 * enough to turn a settings file into a log store. */
export const MAX_RUNS = 20;

/** A routine spends the user's tokens unattended, so the caps are tight. */
export const MAX_ROUTINES = 50;
export const MAX_ROUTINE_PROMPT = 2_000;

/** How late a missed run may still fire. See the header. */
export const GRACE_MS = 2 * 60 * 60_000;

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

/**
 * The most recent instant this routine was scheduled to run, at or before
 * `now`. Searches back a week, which is as far as any weekly schedule can
 * be from its last occurrence.
 */
export function lastScheduledBefore(routine: Routine, now: Date): Date | null {
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
export function isDue(routine: Routine, now: Date, graceMs: number = GRACE_MS): boolean {
  if (!routine.enabled) return false;
  const slot = lastScheduledBefore(routine, now);
  if (!slot) return false;
  // Missed by too much to be useful. Wait for the next one.
  if (now.getTime() - slot.getTime() > graceMs) return false;
  // Already served this slot.
  if (routine.lastRunAt !== undefined && routine.lastRunAt >= slot.getTime()) return false;
  return true;
}

/** Clamps whatever a client sent into something we are willing to store. */
export function normalize(raw: unknown): Omit<Routine, "id" | "createdAt"> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const targetId = typeof o.targetId === "string" ? o.targetId.trim() : "";
  if (!targetId) return null;
  const targetKind = o.targetKind === "room" ? "room" : "agent";

  const prompt = typeof o.prompt === "string" ? o.prompt.trim().slice(0, MAX_ROUTINE_PROMPT) : "";
  if (!prompt) return null;

  const minutes = parseTime(o.time);
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
    durationMin,
    runsOn,
  };
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
    try {
      const parsed = JSON.parse(readFileSync(ROUTINES_FILE, "utf8"));
      this.routines = Array.isArray(parsed) ? parsed.filter(isRoutine) : [];
    } catch {
      this.routines = [];
    }
  }

  private save() {
    writeFileSync(ROUTINES_FILE, JSON.stringify(this.routines, null, 2), { mode: 0o600 });
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
    const routine: Routine = { ...input, id: newId(), createdAt: Date.now() };
    this.routines.push(routine);
    this.save();
    return routine;
  }

  patch(id: string, patch: Partial<Routine>): Routine | null {
    const routine = this.get(id);
    if (!routine) return null;
    // Spelled out rather than looped over a key list: the cast that makes
    // the loop compile also lets a typo write a field that does not exist.
    if (patch.prompt !== undefined) routine.prompt = patch.prompt;
    if (patch.time !== undefined) routine.time = patch.time;
    if (patch.days !== undefined) routine.days = patch.days;
    if (patch.enabled !== undefined) routine.enabled = patch.enabled;
    if (patch.lastRunAt !== undefined) routine.lastRunAt = patch.lastRunAt;
    if ("name" in patch) routine.name = patch.name || undefined;
    if ("durationMin" in patch) routine.durationMin = patch.durationMin;
    if ("runsOn" in patch) routine.runsOn = patch.runsOn;
    if ("repeat" in patch) routine.repeat = patch.repeat;
    if ("date" in patch) routine.date = patch.date;
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
    outcome: { state: "ok" | "failed"; summary?: string; error?: string },
  ): void {
    const routine = this.get(routineId);
    const run = routine?.runs?.find((r) => r.id === runId);
    if (!routine || !run) return;
    run.state = outcome.state;
    run.endedAt = Date.now();
    if (outcome.summary) run.summary = outcome.summary.slice(0, 300);
    if (outcome.error) run.error = outcome.error.slice(0, 300);
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
    typeof r.enabled === "boolean"
  );
}
