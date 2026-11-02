// The notice beside the composer about a limit, in words: Bloks AI's own,
// or an engine's plan running out (server/plan-usage.ts). The server
// decides what applies to the conversation, how bad it is and what it is
// called; this says when it resets, and remembers which ones the person
// put away.
//
// Kept apart from the component so the wording and the remembering can
// be tested without a DOM.
//
// Plan window identity is localized when the server reports it; other
// titles remain in the server's own words.
import { formatLocale, t } from "./i18n.ts";
import { reportedPlanWindow } from "../../server/plan-window.ts";

/** How much a notice asks for: worth knowing, near a limit, at one. */
export type UsageLevel = "info" | "warn" | "stop";

/** One notice, as GET /api/usage-notices sends it. */
export interface UsageNotice {
  id: string;
  /** "bloks-ai", or the engine instance it is about. */
  source: string;
  level: UsageLevel;
  title: string;
  /** A whole percent, 0 to 100. */
  usedPercent: number;
  /** Epoch milliseconds, when known. */
  resetsAt: number | null;
  /** Present only for a plan window on a newer server. */
  planWindow?: { id: string; minutes: number | null };
  /** "spend" for a spending limit on the person's own key, whose month
   * tops up rather than a window resetting. */
  kind?: "spend";
}

const LEVELS: ReadonlySet<string> = new Set<UsageLevel>(["info", "warn", "stop"]);

/** The notices in an answer that are whole, in the order the server put
 * them (worst first). An older server, or a bad answer, is none. */
export function readNotices(body: unknown): UsageNotice[] {
  const list = (body as { notices?: unknown } | null)?.notices;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (n): n is UsageNotice =>
      Boolean(n) &&
      typeof n.id === "string" &&
      typeof n.title === "string" &&
      LEVELS.has(n.level) &&
      typeof n.usedPercent === "number" &&
      Number.isFinite(n.usedPercent) &&
      (n.resetsAt === null || (typeof n.resetsAt === "number" && Number.isFinite(n.resetsAt))),
  );
}

/** The first one the person has not put away, or null. */
export function noticeToShow(notices: UsageNotice[], dismissed: readonly string[]): UsageNotice | null {
  return notices.find((n) => !dismissed.includes(n.id)) ?? null;
}

/** Name only the reported source, not the conversation's selected engine. */
export function noticeSource(notice: Pick<UsageNotice, "source" | "kind">, engines: readonly { instanceId: string; displayName: string }[]): string {
  if (notice.source === "bloks-ai") return t("libUsageNotice.bloksAllowance");
  const name = engines.find((engine) => engine.instanceId === notice.source)?.displayName?.trim() || t("libUsageNotice.unknownEngine");
  return notice.kind === "spend" ? t("libUsageNotice.spendingLimit", { name }) : t("libUsageNotice.planUsage", { name });
}

/** Treat optional metadata from an older or malformed server as absent. */
function reportedWindow(notice: Pick<UsageNotice, "planWindow" | "kind"> & Partial<Pick<UsageNotice, "source">>): ReturnType<typeof reportedPlanWindow> {
  if (notice.kind === "spend" || notice.source === "bloks-ai") return null;
  return reportedPlanWindow(notice.planWindow);
}

/** Localize a known window without rounding a nonstandard duration. */
function noticeWindowLabel(window: NonNullable<ReturnType<typeof reportedPlanWindow>>): string {
  const { id } = window;
  const { minutes } = window;
  let label: string;
  if (id === "seven_day_opus" || id === "seven_day_sonnet") {
    label = t("contextCard.weeklyFor", { model: id === "seven_day_opus" ? "Opus" : "Sonnet" });
  } else if (id === "seven_day_overage_included") {
    label = t("contextCard.weeklyExtra");
  } else if (minutes === null) {
    label = t("contextCard.limit");
  } else if (minutes === 24 * 60) {
    label = t("contextCard.dailyLimit");
  } else if (minutes === 7 * 24 * 60) {
    label = t("contextCard.weeklyLimit");
  } else if (minutes % (24 * 60) === 0) {
    label = t("contextCard.dayLimit", { count: minutes / (24 * 60) });
  } else if (minutes % 60 === 0) {
    label = t("contextCard.hourLimit", { count: minutes / 60 });
  } else {
    label = t("contextCard.minuteLimit", { count: minutes });
  }
  const known = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"];
  if (known.includes(id)) return label;
  const name = id === "primary" ? t("libUsageNotice.primaryWindow")
    : id === "secondary" ? t("libUsageNotice.secondaryWindow")
      : window.name;
  return name ? t("libUsageNotice.namedWindow", { window: label, name }) : label;
}

/** The old title remains the fallback for other notices and older servers. */
export function noticeTitle(notice: UsageNotice, now: number): string {
  if (notice.kind === "spend" || notice.source === "bloks-ai") return notice.title;
  const window = reportedWindow(notice);
  if (!window) return notice.title;
  const status = notice.level === "stop" ? t("contextCard.limitReached") : t("libUsageNotice.approachingLimit");
  const title = t("libUsageNotice.windowTitle", { window: noticeWindowLabel(window), status });
  return notice.resetsAt !== null && Number.isFinite(new Date(notice.resetsAt).getTime()) && notice.resetsAt <= now
    ? t("libUsageNotice.lastReported", { title }) : title;
}

/** Whether the line under this notice is a plan countdown, which changes
 * every minute. Every other line changes only when what it reports does. */
export function noticeCountsDown(notice: Pick<UsageNotice, "kind" | "planWindow" | "resetsAt"> & Partial<Pick<UsageNotice, "source">>): boolean {
  return reportedWindow(notice) !== null && notice.resetsAt !== null && Number.isFinite(new Date(notice.resetsAt).getTime());
}

/** Remaining time for a reported plan reset, never zero before it arrives.
 * Rounded up throughout, so it never reads as sooner than it is. */
export function planResetLine(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(new Date(now).getTime()) || !Number.isFinite(new Date(resetsAt).getTime())) return null;
  const left = resetsAt - now;
  if (left <= 0) return t("libUsageNotice.resetPassed");
  if (left < 60_000) return t("libUsageNotice.resetsWithinMinute");
  if (left < 24 * 60 * 60_000) {
    const minutes = Math.ceil(left / 60_000);
    if (minutes < 60) return t("contextCard.resetsInMinutes", { minutes });
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? t("contextCard.resetsInHoursMinutes", { hours, minutes: rest }) : t("contextCard.resetsInHours", { hours });
  }
  const hours = Math.ceil(left / (60 * 60_000));
  return t("libUsageNotice.resetsInDaysHours", { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** A day as a count, for telling today from tomorrow in one time zone. */
function dayNumber(at: number, timeZone?: string): number {
  // read as numbers, never shown, so the locale here is fixed
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / (24 * 60 * 60_000);
}

/**
 * The quieter line under the title: when the limit starts again, as a
 * day. "Resets today" or "Resets tomorrow" while it is under a day away,
 * the date after that ("Resets Nov 1"), all in the person's own time
 * zone. Null when nobody said, or the reset has already gone by.
 */
export function resetLine(resetsAt: number | null, now: number, format: { locale?: string; timeZone?: string } = {}): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now || !Number.isFinite(new Date(resetsAt).getTime())) return null;
  if (resetsAt - now < 24 * 60 * 60_000) {
    const days = dayNumber(resetsAt, format.timeZone) - dayNumber(now, format.timeZone);
    if (days === 0) return t("libUsageNotice.resetsToday");
    if (days === 1) return t("libUsageNotice.resetsTomorrow");
  }
  const date = new Intl.DateTimeFormat(format.locale ?? formatLocale(), {
    month: "short",
    day: "numeric",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(resetsAt));
  return t("libUsageNotice.resetsOn", { date });
}

/** Reported usage and reset/top-up timing; never invent an unavailable value. */
export function noticeLine(notice: Pick<UsageNotice, "kind" | "usedPercent" | "resetsAt" | "planWindow"> & Partial<Pick<UsageNotice, "source">>, now: number, format: { locale?: string; timeZone?: string } = {}): string {
  const used = Number.isFinite(notice.usedPercent) && notice.usedPercent >= 0 && notice.usedPercent <= 100
    ? t("libUsageNotice.percentUsed", { percent: Math.round(notice.usedPercent) })
    : t("libUsageNotice.usageUnknown");
  if (notice.kind !== "spend") {
    const when = reportedWindow(notice) ? planResetLine(notice.resetsAt, now) : resetLine(notice.resetsAt, now, format);
    return t("libUsageNotice.line", { used, when: when ?? t("libUsageNotice.resetUnknown") });
  }
  if (notice.resetsAt === null || !Number.isFinite(notice.resetsAt) || notice.resetsAt <= now || !Number.isFinite(new Date(notice.resetsAt).getTime())) {
    return t("libUsageNotice.line", { used, when: t("libUsageNotice.topUpUnknown") });
  }
  const date = new Intl.DateTimeFormat(format.locale ?? formatLocale(), {
    month: "short",
    day: "numeric",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(notice.resetsAt));
  return t("libUsageNotice.line", { used, when: t("libUsageNotice.topsUpOn", { date }) });
}

// ── put away ───────────────────────────────────────────────────────────

/** Kept on this device: what one window has already been told. A notice
 * comes back on its own when it says something new, since its id
 * carries the window, the level and the reset. */
const DISMISSED_KEY = "bloks-usage-notices-dismissed";
/** Enough for every engine's windows for a long while; the oldest go. */
const KEEP = 50;

/** Ids put away, oldest first. */
export function readDismissed(storage: Pick<Storage, "getItem"> | null = safeStorage()): string[] {
  try {
    const parsed = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(-KEEP) : [];
  } catch {
    return [];
  }
}

/** The list with one more put away, newest last, at most KEEP long. */
export function withDismissed(dismissed: readonly string[], id: string): string[] {
  return [...dismissed.filter((d) => d !== id), id].slice(-KEEP);
}

/** Keeps the list on this device. Nothing kept (private mode) still
 * holds for this visit, since the list in memory is what is shown. */
export function saveDismissed(dismissed: readonly string[], storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify(dismissed.slice(-KEEP)));
  } catch {
    /* holds for this visit */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
