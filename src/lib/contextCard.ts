// How full a conversation is, and what the engine's plan has left, in
// words: the composer's ring and its card, the conversation chips, the
// sidebar rows and Activity (GitHub 224).
//
// Kept apart from the components so the wording and the arithmetic can
// be tested without a DOM. The engine's readings and window, and the
// person's compaction line, come from the server (server/context.ts,
// server/plan-usage.ts); this only
// decides how to say it, and when there is nothing honest to say, in
// the reader's language: "about" belongs to each sentence whole, since
// it does not sit in the same place in every language.
import { formatLocale, t } from "./i18n.ts";

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
  /** The full model window when limit is the lower before-turn line. */
  modelLimit?: number;
  /** The line is approximate only when a table window's share set it.
   * A ceiling in tokens is exact even when the model window is guessed. */
  limitApproximate?: boolean;
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
  if (fraction < 0.005) return t("contextCard.underOnePercent");
  return `${Math.round(fraction * 100)}%`;
}

/** Text keeps the real share; the wire and drawn ring are capped at one. */
export function contextShare(context: Fill): number {
  return context.limit > 0 ? context.used / context.limit : 0;
}

function contextPercent(context: Fill): string {
  const share = contextShare(context);
  // Whole-percent rounding must not hide a crossing just past the line.
  return share > 1 && Math.round(share * 100) === 100 ? t("contextCard.overAllPercent") : percent(share);
}

function approximateLimit(context: Fill): boolean {
  return context.modelLimit !== undefined ? context.limitApproximate === true : context.window === "table";
}

/** What the card says about the window: how full, in what, and whether
 * the earlier part was summarised. "About" when the window is a guess. */
export function contextCard(context: LaneContext): { share: string; tokens: string; summarised: string | null; compaction: string | null } {
  const about = approximateLimit(context);
  const percent = contextPercent(context);
  const used = shortTokens(context.used);
  const limit = shortTokens(context.limit);
  // two sentences, each with its own "about": the line can be exact
  // while the model's window is a guess
  const compaction = context.modelLimit !== undefined
    ? [
        about ? t("contextCard.summarisesAtAbout", { limit }) : t("contextCard.summarisesAt", { limit }),
        context.window === "table"
          ? t("contextCard.modelMaxAbout", { max: shortTokens(context.modelLimit) })
          : t("contextCard.modelMax", { max: shortTokens(context.modelLimit) }),
      ].join(" ")
    : null;
  return {
    share: about ? t("contextCard.shareAbout", { percent }) : t("contextCard.share", { percent }),
    tokens: about ? t("contextCard.tokensAbout", { used, limit }) : t("contextCard.tokens", { used, limit }),
    summarised: context.summarised ? t("contextCard.summarised") : null,
    compaction,
  };
}

/** The ring's name for a screen reader, which cannot see the ring. */
export function ringLabel(context: LaneContext): string {
  const percent = contextPercent(context);
  return approximateLimit(context) ? t("contextCard.ringAbout", { percent }) : t("contextCard.ring", { percent });
}

/** What the ring says on hover: how full, in tokens, and whether the
 * earlier part was summarised. "About" when the window is a guess. */
export function contextTitle(context: LaneContext): string {
  if (!measuredContext(context)) return t("contextCard.titleSummarised");
  const percent = contextPercent(context);
  const { tokens } = contextCard(context);
  const about = approximateLimit(context);
  if (context.summarised) {
    return about ? t("contextCard.titleAboutSummarised", { percent, tokens }) : t("contextCard.titleFullSummarised", { percent, tokens });
  }
  return about ? t("contextCard.titleAbout", { percent, tokens }) : t("contextCard.title", { percent, tokens });
}

/** What Activity adds to a running lane's line once it is half full, or
 * null when it is not, or nothing measured it. */
export function activityContext(context: Fill | null | undefined): string | null {
  if (!context || !measuredContext(context) || contextShare(context) < 0.5) return null;
  const percent = contextPercent(context);
  return approximateLimit(context) ? t("contextCard.activityAbout", { percent }) : t("contextCard.activity", { percent });
}

// ── the plan ───────────────────────────────────────────────────────────

/** Claude Code's weekly windows for one model family, by the family's
 * name, which stays as it is in every language. */
const WEEKLY_FOR: Record<string, string> = {
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};

/** A window by its length, which is how both engines describe them. */
export function planWindowLabel(window: Pick<PlanWindow, "id" | "minutes">): string {
  if (WEEKLY_FOR[window.id]) return t("contextCard.weeklyFor", { model: WEEKLY_FOR[window.id] });
  if (window.id === "seven_day_overage_included") return t("contextCard.weeklyExtra");
  const minutes = window.minutes;
  if (!minutes || minutes <= 0) return t("contextCard.limit");
  if (minutes < 60) return t("contextCard.minuteLimit", { count: minutes });
  if (minutes < 24 * 60) return t("contextCard.hourLimit", { count: Math.round(minutes / 60) });
  if (minutes === 24 * 60) return t("contextCard.dailyLimit");
  if (minutes === 7 * 24 * 60) return t("contextCard.weeklyLimit");
  return t("contextCard.dayLimit", { count: Math.round(minutes / (24 * 60)) });
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
  if (minutes < 60) return t("contextCard.resetsInMinutes", { minutes });
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? t("contextCard.resetsInHoursMinutes", { hours, minutes: rest }) : t("contextCard.resetsInHours", { hours });
  }
  // `locale` is for tests; the app says it the way the chosen language does
  const when = new Intl.DateTimeFormat(format.locale ?? formatLocale(), {
    weekday: "short",
    ...(left >= 6 * 24 * 60 * 60_000 ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(resetsAt));
  // some ICU versions put a narrow no-break space before AM and PM
  return t("contextCard.resetsAt", { when: when.replace(/[  ]/g, " ") });
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
        used: t("contextCard.used", { percent: percent(w.used) }),
        fill: Math.max(0, Math.min(1, w.used)),
        reset: resetPhrase(w.resetsAt, now, format),
        note: out ? t("contextCard.limitReached") : w.status === "warning" ? t("contextCard.nearLimit") : null,
        near: out || w.status === "warning",
      };
    });
}

/** A plan's name as the engine gives it ("pro"), the way a name reads. */
export function planName(plan: string | null | undefined): string | null {
  const name = (plan ?? "").trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

// ── what it used ───────────────────────────────────────────────────────

/** Tokens and replies, as a lane keeps them (its usage) and as Activity
 * counts a day per agent (server/usage.ts). */
export interface Spent {
  turns: number;
  input: number;
  output: number;
  /** In dollars, where the engine gives a price. */
  cost?: number;
  /** Of `cost`, the dollars estimated from tokens: written "~$". */
  estimated?: number;
  /** Replies whose engine said nothing about tokens. */
  unmeasured?: number;
}

/** "12 replies", "1 reply". */
export function repliesPhrase(turns: number): string {
  return t("contextCard.replies", { count: turns });
}

/**
 * What the composer's card says something cost. Only a price the engine
 * gave is a price: a subscription engine reports none, and zero would
 * read as free, so that is "Not reported". `costKnown` is Activity's word
 * that some engine priced something today; this agent's own zero still
 * means its engine did not.
 */
export function spendPhrase(spent: Spent | null | undefined, costKnown: boolean): string {
  if (!spent || spent.turns <= 0) return t("contextCard.nothingYet");
  const cost = spent.cost ?? 0;
  if (!costKnown || !(cost > 0)) return t("contextCard.notReported");
  // an estimate from tokens is written as one, as the Usage page does
  const mark = (spent.estimated ?? 0) > 0 ? "~" : "";
  if (cost < 0.01) return t("contextCard.under", { amount: `${mark}$0.01` });
  return `${mark}$${cost.toFixed(2)}`;
}

/** A token count for the card, or "Not reported" when every reply came
 * from an engine that counted none, which a bare 0 would hide. */
export function tokensPhrase(n: number, spent: Spent | null | undefined): string {
  if (n > 0) return shortTokens(n);
  return spent && spent.turns > 0 && (spent.unmeasured ?? 0) >= spent.turns ? t("contextCard.notReported") : "0";
}
