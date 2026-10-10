// Check-ins in the app: how the routine editor reads an interval, and
// where a check-in sits on the calendar.
//
// The schedule itself is the server's (server/routines.ts, checkInsOn);
// these only have to agree with it. A check-in's slots start where its
// active hours begin and step by its interval to where they end, so a
// day column can draw them without asking the server for every one.

/** The same bounds the server keeps, so the editor says no before the
 * server has to. */
export const MIN_EVERY = 15;
export const MAX_EVERY = 1440;

/** "HH:MM" to minutes past midnight, or null. */
function minutesOf(value: string | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes from what the editor holds: a count and its unit. Null for a
 * count that is not a number at all. */
export function everyMinutes(count: string, unit: "min" | "hour"): number | null {
  if (!count.trim()) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(unit === "hour" ? n * 60 : n);
}

/** Why the editor cannot file this check-in yet, in a few words under
 * the field, or null when it can. */
export function checkInProblem(every: number | null, hours: { from: string; to: string } | null): string | null {
  if (every === null || every < MIN_EVERY || every > MAX_EVERY) return "Every 15 minutes up to every 24 hours.";
  if (hours) {
    const from = minutesOf(hours.from);
    const to = minutesOf(hours.to);
    if (from === null || to === null || from >= to) return "The hours end after they start, on the same day.";
  }
  return null;
}

/** A routine's history with each stretch of quiet runs as one row, so a
 * check-in's twenty most recent runs read as what happened rather than as
 * twenty lines saying nothing did. Newest first, like the history. */
export function foldQuietRuns<R extends { quiet?: boolean }>(runs: readonly R[]): Array<{ run: R } | { quiet: R[] }> {
  const out: Array<{ run: R } | { quiet: R[] }> = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (run.quiet && last && "quiet" in last) last.quiet.push(run);
    else out.push(run.quiet ? { quiet: [run] } : { run });
  }
  return out;
}

/** "30m", "2h": a check-in's interval where there is no room for words. */
export function intervalShort(every: number): string {
  return every % 60 === 0 ? `${every / 60}h` : `${every}m`;
}

/**
 * Where a check-in sits in a day column drawn from `startHour` to
 * `endHour`, in minutes from the column's top: one band over its hours,
 * and a tick for each check-in inside what is drawn. Null when none of
 * its hours are on the column. One band, not a card per check-in, so a
 * check-in every quarter of an hour does not bury the week.
 */
export function checkInBand(
  routine: { every?: number; activeHours?: { from: string; to: string } },
  startHour: number,
  endHour: number,
): { top: number; height: number; ticks: number[] } | null {
  if (!routine.every) return null;
  const from = minutesOf(routine.activeHours?.from) ?? 0;
  const to = minutesOf(routine.activeHours?.to) ?? 24 * 60 - 1;
  const drawnFrom = startHour * 60;
  const drawnTo = endHour * 60;
  const top = Math.max(from, drawnFrom);
  const bottom = Math.min(to, drawnTo);
  if (bottom <= top) return null;
  const ticks: number[] = [];
  for (let at = from; at <= to; at += routine.every) {
    if (at >= drawnFrom && at <= drawnTo) ticks.push(at - top);
  }
  return { top: top - drawnFrom, height: bottom - top, ticks };
}
