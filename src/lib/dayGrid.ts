// The hours the Day and Week views of Automations draw.
//
// The grid started at six, on the guess that earlier hours are rare, and a
// routine set for any time from midnight to five was on the calendar and
// nowhere on the screen: its chip sat above the top of the grid and was
// left out. Now the grid starts at six, or at the hour of the earliest
// routine shown when that is earlier, and ends at eleven at night, or
// after the latest one, so whatever is scheduled has a place to be.

/** Where an ordinary day starts and ends on the grid, as hours. */
export const DAY_START = 6;
export const DAY_END = 23;

/** The first hour the grid draws and the hour it ends at, for routines at
 * these minutes after midnight. */
export function gridHours(minutes: readonly number[]): { start: number; end: number } {
  let start = DAY_START;
  let end = DAY_END;
  for (const at of minutes) {
    if (!Number.isFinite(at)) continue;
    const hour = Math.max(0, Math.min(23, Math.floor(at / 60)));
    start = Math.min(start, hour);
    end = Math.max(end, hour + 1);
  }
  return { start, end };
}
