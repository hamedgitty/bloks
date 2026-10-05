// When something was said, in the words a conversation shows it.
//
// A bare clock time is only honest about today: on a message from last
// week, "9:41 AM" reads as this morning. So a stamp carries the date as
// soon as the day is not today, and the year once the year is not this
// one. The shapes come from the reader's locale and never from a format
// written here, so 14:15 stays 14:15 for the people who read it that way.
//
// The formatters are made once. A long conversation stamps every message
// it renders and renders again on every streamed word, and a fresh
// Intl.DateTimeFormat for each of them would cost more than the row.

const SHAPES = {
  time: { hour: "numeric", minute: "2-digit" },
  date: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  dateYear: { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
  day: { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  dayYear: { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const made = new Map<string, Intl.DateTimeFormat>();

/** `locale` is for tests; the app always says it the reader's way. */
function format(at: number, shape: keyof typeof SHAPES, locale?: string): string {
  const key = `${locale ?? ""}:${shape}`;
  let formatter = made.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale ?? [], SHAPES[shape]);
    made.set(key, formatter);
  }
  return formatter.format(at);
}

/** Local midnight at the start of the day `at` falls on. */
function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sameDay(a: number, b: number): boolean {
  return dayStart(a) === dayStart(b);
}

function sameYear(a: number, b: number): boolean {
  return new Date(a).getFullYear() === new Date(b).getFullYear();
}

/** A message's own time: the clock alone for today, the date with it
 * for any other day. */
export function stamp(at: number, now = Date.now(), locale?: string): string {
  if (sameDay(at, now)) return format(at, "time", locale);
  return format(at, sameYear(at, now) ? "date" : "dateYear", locale);
}

/** The line above a conversation: the day it started, said the way a
 * person would say it, and the time. */
export function dayLine(at: number, now = Date.now(), locale?: string): string {
  const day = dayStart(at);
  const today = new Date(now);
  // The calendar day before, not the last 24 hours: at ten past
  // midnight, twenty minutes ago was yesterday, and a day the clocks
  // change on is still one day long.
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime();
  if (day === dayStart(now)) return `Today ${format(at, "time", locale)}`;
  if (day === yesterday) return `Yesterday ${format(at, "time", locale)}`;
  return format(at, sameYear(at, now) ? "day" : "dayYear", locale);
}

/** What a bubble needs for the question below. */
interface Said {
  at?: number;
  role?: string;
  kind?: string;
  deleted?: boolean;
  agent?: unknown;
  deliveredAt?: number;
}

/** Whether a bubble can leave its time to the one after it. A run of
 * bubbles from one side inside the same minute says the time once, under
 * the last of them: four identical stamps read as clutter, not as four
 * facts. A queued message keeps its own line, which says more. */
export function timeSaidBelow(message: Said, next: Said | undefined, now = Date.now()): boolean {
  if (!next || !message.at || !next.at || next.deleted || next.agent) return false;
  if (message.kind !== "text" || next.kind !== "text" || message.role !== next.role) return false;
  if (message.deliveredAt || next.deliveredAt) return false;
  return stamp(message.at, now) === stamp(next.at, now);
}

/** A message that waited for a turn to finish: when it came in, and
 * when it went to the agent. The second leaves out a date the first has
 * just said. */
export function queuedLine(queuedAt: number, sentAt: number, now = Date.now(), locale?: string): string {
  const sent = sameDay(queuedAt, sentAt) ? format(sentAt, "time", locale) : stamp(sentAt, now, locale);
  return `Queued at ${stamp(queuedAt, now, locale)}, sent at ${sent}`;
}
