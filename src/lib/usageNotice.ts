// The notice beside the composer about a limit, in words: Bloks AI's own,
// or an engine's plan running out (server/plan-usage.ts). The server
// decides what applies to the conversation, how bad it is and what it is
// called; this says when it resets, and remembers which ones the person
// put away.
//
// Kept apart from the component so the wording and the remembering can
// be tested without a DOM.

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
  if (notice.source === "bloks-ai") return "Bloks AI allowance";
  const name = engines.find((engine) => engine.instanceId === notice.source)?.displayName?.trim() || "Unknown engine";
  return `${name} ${notice.kind === "spend" ? "spending limit" : "plan usage"}`;
}

/** A day as a count, for telling today from tomorrow in one time zone. */
function dayNumber(at: number, timeZone?: string): number {
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
    if (days === 0) return "Resets today";
    if (days === 1) return "Resets tomorrow";
  }
  const date = new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(resetsAt));
  return `Resets ${date}`;
}

/** Reported usage and reset/top-up timing; never invent an unavailable value. */
export function noticeLine(notice: Pick<UsageNotice, "kind" | "usedPercent" | "resetsAt">, now: number, format: { locale?: string; timeZone?: string } = {}): string {
  const used = Number.isFinite(notice.usedPercent) && notice.usedPercent >= 0 && notice.usedPercent <= 100
    ? `${Math.round(notice.usedPercent)}% used`
    : "Usage unknown";
  if (notice.kind !== "spend") return `${used} · ${resetLine(notice.resetsAt, now, format) ?? "Reset time unknown"}`;
  if (notice.resetsAt === null || !Number.isFinite(notice.resetsAt) || notice.resetsAt <= now || !Number.isFinite(new Date(notice.resetsAt).getTime())) return `${used} · Top-up time unknown`;
  const date = new Intl.DateTimeFormat(format.locale, {
    month: "short",
    day: "numeric",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(notice.resetsAt));
  return `${used} · Tops up ${date}`;
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
