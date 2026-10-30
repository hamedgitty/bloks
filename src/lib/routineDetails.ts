import { formatDate, formatList, t } from "./i18n.ts";

/** Actual elapsed time, never the calendar block's intended height. */
export function runElapsed(run: { state: string; startedAt: number; endedAt?: number }): string {
  if (run.state === "running") return t("routineDetails.running");
  if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.endedAt) || run.endedAt! < run.startedAt) {
    return t("routineDetails.durationUnavailable");
  }
  const seconds = Math.round((run.endedAt! - run.startedAt) / 1000);
  if (seconds < 1) return t("routineDetails.lessThanASecond");
  if (seconds < 60) return t("routineDetails.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return seconds % 60
      ? t("routineDetails.minutesSeconds", { minutes, seconds: seconds % 60 })
      : t("routineDetails.minutes", { minutes });
  }
  const hours = Math.floor(minutes / 60);
  return minutes % 60
    ? t("routineDetails.hoursMinutes", { hours, minutes: minutes % 60 })
    : t("routineDetails.hours", { hours });
}

type Source = { kind: "agent"; id: string; taskId: string } | { kind: "room"; id: string };

/** Only the conversation recorded for this run. A missing lane must not
 * quietly become the agent's current conversation or a newly made one. */
export function runSource(
  routine: { targetKind: "agent" | "room"; targetId: string },
  run: { threadId?: string },
  bots: readonly { id: string; threadId: string; tasks?: readonly { id: string }[] }[],
  rooms: readonly { id: string }[],
): Source | null {
  if (!run.threadId) return null;
  if (routine.targetKind === "room") {
    return run.threadId === routine.targetId && rooms.some((room) => room.id === routine.targetId)
      ? { kind: "room", id: routine.targetId }
      : null;
  }
  const bot = bots.find((bot) => bot.id === routine.targetId);
  return bot && (bot.tasks?.some((task) => task.id === run.threadId) || bot.threadId === run.threadId)
    ? { kind: "agent", id: bot.id, taskId: run.threadId }
    : null;
}

/** What the editor and the lists know about a routine's schedule. */
export interface ScheduleShape {
  time: string;
  days: number[];
  repeat?: "weekly" | "once";
  date?: string;
  every?: number;
  activeHours?: { from: string; to: string };
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** A day of the week by its number, Sunday 0, in the reader's words:
 * any Sunday will do, and 2 January 2000 was one. */
export function weekdayName(day: number, width: "long" | "short" | "narrow" = "long"): string {
  return formatDate(new Date(2000, 0, 2 + day), { weekday: width });
}

/** Days as a short list, "Mon, Wed, Fri", the reader's separator. */
function shortDays(days: readonly number[]): string {
  return formatList(
    days.map((d) => weekdayName(d, "short")),
    { type: "unit", style: "short" },
  );
}

/** "Every 30 min", "Every hour", "Every 2 hours": how often a check-in runs. */
function frequency(every: number): string {
  if (every % 60 !== 0) return t("routineDetails.frequency.minutes", { count: every });
  return every === 60 ? t("routineDetails.frequency.hour") : t("routineDetails.frequency.hours", { count: every / 60 });
}

/**
 * A routine's schedule in a line: "Weekdays at 09:00", "Every 30 min,
 * 09:00 to 18:00 on weekdays". The same sentences the server's describe
 * (server/routines.ts) writes in English, said here so they are said in
 * the reader's language, one whole sentence per shape.
 */
export function describeSchedule(routine: ScheduleShape): string {
  const time = routine.time;
  if (routine.repeat === "once") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(routine.date ?? "");
    const clock = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!match || !clock) return t("routineDetails.schedule.onceAt", { time });
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(clock[1]), Number(clock[2]));
    return t("routineDetails.schedule.onceOn", { date: formatDate(at, { month: "short", day: "numeric" }), time });
  }
  if (routine.every) {
    const every = frequency(routine.every);
    const hours = routine.activeHours;
    const from = hours?.from ?? "";
    const to = hours?.to ?? "";
    const days = routine.days;
    if (days.length === 0) return hours ? t("routineDetails.schedule.checkInHours", { every, from, to }) : every;
    if (same(days, WEEKDAYS)) {
      return hours
        ? t("routineDetails.schedule.checkInHoursWeekdays", { every, from, to })
        : t("routineDetails.schedule.checkInWeekdays", { every });
    }
    if (same(days, WEEKEND)) {
      return hours
        ? t("routineDetails.schedule.checkInHoursWeekends", { every, from, to })
        : t("routineDetails.schedule.checkInWeekends", { every });
    }
    if (days.length === 1) {
      const day = weekdayName(days[0]);
      return hours
        ? t("routineDetails.schedule.checkInHoursOneDay", { every, from, to, day })
        : t("routineDetails.schedule.checkInOneDay", { every, day });
    }
    return hours
      ? t("routineDetails.schedule.checkInHoursDays", { every, from, to, days: shortDays(days) })
      : t("routineDetails.schedule.checkInDays", { every, days: shortDays(days) });
  }
  if (routine.days.length === 0) return t("routineDetails.schedule.everyDay", { time });
  if (same(routine.days, WEEKDAYS)) return t("routineDetails.schedule.weekdays", { time });
  if (same(routine.days, WEEKEND)) return t("routineDetails.schedule.weekends", { time });
  if (routine.days.length === 1) return t("routineDetails.schedule.oneDay", { day: weekdayName(routine.days[0]), time });
  return t("routineDetails.schedule.days", { days: shortDays(routine.days), time });
}

/** What the routine form files: the body of POST /api/routines. */
export type RoutineDraft = {
  targetId: string;
  targetKind: "agent" | "room";
  name?: string;
  prompt: string;
  time?: string;
  days: number[];
  repeat?: "once";
  date?: string;
  durationMin?: number;
  runsOn?: "cloud" | "local" | "off";
  thread?: string;
  every?: number;
  activeHours?: { from: string; to: string };
  quiet?: boolean;
};

/** The fields PATCH /api/routines/:id changes, and what each sends to
 * clear itself: the server keeps a field that is left out or null. */
const CLEARED = {
  name: "",
  prompt: undefined,
  time: undefined,
  days: undefined,
  repeat: "weekly",
  // the server drops a date, a duration and a time of its own when the
  // schedule they belong to goes
  date: undefined,
  durationMin: undefined,
  runsOn: null,
  thread: null,
  every: null,
  activeHours: null,
  quiet: false,
} as const satisfies Record<Exclude<keyof RoutineDraft, "targetId" | "targetKind">, unknown>;

/** The body of an edit: only the fields the person changed between the
 * form as it opened and as it is saved, so the rest keep their value.
 * Empty when nothing changed. The target is not one of them. */
export function routinePatch(before: RoutineDraft, after: RoutineDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(CLEARED) as Array<keyof typeof CLEARED>) {
    // days are a set: the same days picked in another order are no change
    const [was, now] = [before[key], after[key]].map((v) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v));
    if (was === now) continue;
    const value = after[key] ?? CLEARED[key];
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}
