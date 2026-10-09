// How full a conversation is, and what the engine's plan has left, in
// words: the composer's ring and its card, the conversation chips, the
// sidebar rows and Activity (GitHub 224).
//
// Kept apart from the components so the wording and the arithmetic can
// be tested without a DOM. Every number here is the engine's own, sent
// by the server (server/context.ts, server/plan-usage.ts); this only
// decides how to say it, and when there is nothing honest to say.

/** How full a lane is, as the server sends it with each lane and with
 * each of Activity's running rows. */
export interface Fill {
  used: number;
  limit: number;
  fraction: number;
  /** False when nothing measured this lane on the engine and model it is
   * on now. A server from before readings were kept leaves it out. */
  measured?: boolean;
  /** "engine" when the window is the engine's own word, "table" when it
   * is Bloks' guess from the model's name. */
  window?: "engine" | "table";
}

/** A lane's fill, and whether Bloks has summarised its earlier part. */
export interface LaneContext extends Fill {
  summarised: boolean;
}

/** One limit of an engine's plan, as GET /api/plan-usage sends it. */
export interface PlanWindow {
  id: string;
  minutes: number | null;
  /** The share used, from 0; past 1 when usage ran over the cap. */
  used: number;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  status?: "warning" | "rejected";
}

export interface PlanUsage {
  windows: PlanWindow[];
  plan: string | null;
  at: number;
}

/**
 * Whether a fill is a measurement: on the chips and the sidebar, where a
 * server that does not say keeps showing what it always showed.
 */
export function measuredContext(context: Fill | null | undefined): boolean {
  return Boolean(context && context.measured !== false && context.used > 0 && context.limit > 0);
}

/**
 * The fill the composer's ring may show, or null for none. Stricter than
 * the chips: the ring is where a person decides what to send, so it is
 * drawn only from a reading the server vouches for, made by the engine
 * and model the conversation is on now. No ring rather than a guess.
 */
export function composerContext(context: LaneContext | null | undefined): LaneContext | null {
  if (!context || context.measured !== true) return null;
  if (!(context.used > 0) || !(context.limit > 0) || !Number.isFinite(context.fraction)) return null;
  return context;
}

/** A token count the short way: 842, 9.6k, 141k, 1.2M. */
export function shortTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A share as a percent. A conversation that has only begun is under 1%
 * rather than 0%, which would read as empty. */
export function percent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  if (fraction < 0.005) return "under 1%";
  return `${Math.round(fraction * 100)}%`;
}

const SUMMARISED = "Bloks summarised the earlier part of this conversation.";

/** What the card says about the window: how full, in what, and whether
 * the earlier part was summarised. "About" when the window is a guess. */
export function contextCard(context: LaneContext): { share: string; tokens: string; summarised: string | null } {
  const about = context.window === "table";
  return {
    share: `${about ? "About " : ""}${percent(context.fraction)} full`,
    tokens: `${shortTokens(context.used)} of ${about ? "about " : ""}${shortTokens(context.limit)} tokens`,
    summarised: context.summarised ? SUMMARISED : null,
  };
}

/** The ring's name for a screen reader, which cannot see the ring. */
export function ringLabel(context: LaneContext): string {
  return `Context window ${context.window === "table" ? "about " : ""}${percent(context.fraction)} full`;
}

/** What a chip or a sidebar row says on hover. */
export function contextTitle(context: LaneContext): string {
  if (!measuredContext(context)) return "The earlier part has been summarised";
  return `${context.window === "table" ? "About " : ""}${percent(context.fraction)} of what this model will take` +
    (context.summarised ? ", and the earlier part has been summarised" : "");
}

/** What Activity adds to a running lane's line once it is half full, or
 * null when it is not, or nothing measured it. */
export function activityContext(context: Fill | null | undefined): string | null {
  if (!context || !measuredContext(context) || context.fraction < 0.5) return null;
  return `${context.window === "table" ? "about " : ""}${percent(context.fraction)} of the window`;
}

// ── the plan ───────────────────────────────────────────────────────────

/** Claude Code's weekly windows for one model family. */
const WEEKLY_FOR: Record<string, string> = {
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};

/** A window by its length, which is how both engines describe them. */
export function planWindowLabel(window: Pick<PlanWindow, "id" | "minutes">): string {
  if (WEEKLY_FOR[window.id]) return `Weekly limit, ${WEEKLY_FOR[window.id]}`;
  if (window.id === "seven_day_overage_included") return "Weekly limit, with extra usage";
  const minutes = window.minutes;
  if (!minutes || minutes <= 0) return "Limit";
  if (minutes < 60) return `${minutes}-minute limit`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}-hour limit`;
  if (minutes === 24 * 60) return "Daily limit";
  if (minutes === 7 * 24 * 60) return "Weekly limit";
  return `${Math.round(minutes / (24 * 60))}-day limit`;
}

/**
 * When a window starts again, from now: in minutes and hours while that
 * is the useful thing to know, and by the day and time after that. Null
 * once it has passed.
 */
export function resetPhrase(
  resetsAt: number | null,
  now: number,
  format: { locale?: string; timeZone?: string } = {},
): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const left = resetsAt - now;
  if (left <= 0) return null;
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `Resets in ${hours} h ${rest} min` : `Resets in ${hours} h`;
  }
  const when = new Intl.DateTimeFormat(format.locale, {
    weekday: "short",
    ...(left >= 6 * 24 * 60 * 60_000 ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(resetsAt));
  // some ICU versions put a narrow no-break space before AM and PM
  return `Resets ${when.replace(/[  ]/g, " ")}`;
}

export interface PlanRow {
  id: string;
  label: string;
  /** "42% used". */
  used: string;
  /** For the bar, 0 to 1. */
  fill: number;
  reset: string | null;
  /** The engine's own warning, in words, or at the limit. */
  note: string | null;
  near: boolean;
}

/**
 * The card's plan section: each window still current, shortest first. A
 * window whose reset has passed is left out, since what it says has
 * been replaced by a number nobody has heard yet.
 */
export function planRows(plan: PlanUsage | null | undefined, now: number, format?: { locale?: string; timeZone?: string }): PlanRow[] {
  if (!plan || !Array.isArray(plan.windows)) return [];
  return plan.windows
    .filter((w) => Number.isFinite(w.used) && w.used >= 0 && (w.resetsAt === null || w.resetsAt > now))
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity))
    .map((w) => {
      const out = w.status === "rejected" || w.used >= 1;
      return {
        id: w.id,
        label: planWindowLabel(w),
        used: `${percent(w.used)} used`,
        fill: Math.max(0, Math.min(1, w.used)),
        reset: resetPhrase(w.resetsAt, now, format),
        note: out ? "Limit reached" : w.status === "warning" ? "Near the limit" : null,
        near: out || w.status === "warning",
      };
    });
}

/** A plan's name as the engine gives it ("pro"), the way a name reads. */
export function planName(plan: string | null | undefined): string | null {
  const name = (plan ?? "").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}
