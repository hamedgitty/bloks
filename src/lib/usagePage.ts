// The Usage page in words and numbers: what each figure says, how it is
// written, what a filter remembers. The server decides what was spent
// and what counts as a price (server/usage.ts, server/spend-limits.ts);
// this decides how to say it, when the honest thing to say is that
// nobody reported a price, and when a figure is an estimate from tokens
// (server/model-prices.ts), written "~$4.20" so it never reads as a bill.
//
// An engine on a plan that reports tokens and never a price (Codex on
// its ChatGPT sign-in) has no dollar figure to give, but its
// plan says what it has left (server/plan-usage.ts). So where its cost
// would be, the page shows that instead, kept apart from the tokens: the
// tokens are this workspace's, and the plan is the whole account's.
//
// Kept apart from the components so the wording and the arithmetic can
// be tested without a DOM.

import { planName, planRows, shortTokens, type PlanRow, type PlanUsage } from "./contextCard.ts";
import { formatDate, formatNumber, t, type MessageKey } from "./i18n.ts";

export type UsageRange = "7d" | "30d" | "90d" | "month";
export type UsageMetric = "cost" | "tokens" | "turns";
export type BreakdownTab = "agent" | "engine" | "day";

/** One span's tally, as GET /api/usage/report sends it. */
export interface UsageTotals {
  turns: number;
  input: number;
  output: number;
  /** Dollars, from engines that priced their turns, and estimates from
   * the tokens of those that did not where a price for them is known. */
  cost: number;
  /** Of `cost`, the estimated part. Absent from an older server. */
  estimated?: number;
  unmeasured: number;
}

export interface UsageRow extends UsageTotals {
  id: string;
  priced: boolean;
  /** Of `turns`, those on Bloks AI. Absent from an older server. */
  bloksAiTurns?: number;
}

export interface UsageDay extends UsageTotals {
  date: string;
  byEngine: Record<string, UsageTotals>;
}

/** GET /api/usage/report. */
export interface UsageReport {
  range: UsageRange;
  from: string;
  to: string;
  days: number;
  daily: UsageDay[];
  byAgent: UsageRow[];
  byEngine: UsageRow[];
  total: UsageTotals;
  previous: UsageTotals;
  priced: boolean;
  unpricedTurns: number;
  bloksAiTurns: number;
  agents: string[];
  engines: string[];
}

/** One engine on the person's own key, as GET /api/spend-limits says. */
export interface SpendLimitRow {
  instanceId: string;
  name: string;
  driverKind: string;
  limit: number | null;
  spent: number;
  priced: boolean;
  /** Some of this month's figure is an estimate from tokens. */
  estimated?: boolean;
  /** The person's own price for the engine, dollars per million tokens. */
  ownPrice?: OwnPrice | null;
  reportsPrice: boolean;
  usedPercent: number | null;
  reached: boolean;
  level: "info" | "warn" | "stop" | null;
  resetsAt: number;
}

/** A price the person set for an engine, per million tokens. */
export interface OwnPrice {
  input: number;
  output: number;
}

/** Where an estimate's prices come from, said wherever one is shown. */
export function pricesNote(): string {
  return t("libUsagePage.pricesNote");
}

// labels as keys, read where they are drawn
export const RANGES: ReadonlyArray<{ value: UsageRange; label: MessageKey }> = [
  { value: "7d", label: "libUsagePage.range.7d" },
  { value: "30d", label: "libUsagePage.range.30d" },
  { value: "90d", label: "libUsagePage.range.90d" },
  { value: "month", label: "libUsagePage.range.month" },
];

export const METRICS: ReadonlyArray<{ value: UsageMetric; label: MessageKey }> = [
  { value: "cost", label: "libUsagePage.metric.cost" },
  { value: "tokens", label: "libUsagePage.metric.tokens" },
  { value: "turns", label: "libUsagePage.metric.turns" },
];

/** The Bloks engine's id, whose turns are never priced here. */
export const BLOKS_AI_ENGINE = "bloks";

// ── what the person chose, kept on this device ─────────────────────────

export interface UsageView {
  range: UsageRange;
  metric: UsageMetric;
  bot: string | null;
  engine: string | null;
  tab: BreakdownTab;
}

export const DEFAULT_VIEW: UsageView = { range: "30d", metric: "cost", bot: null, engine: null, tab: "agent" };

const VIEW_KEY = "bloks-usage-view";

/** The last choices on this device, each one checked, so an old or
 * damaged value falls back to the default rather than breaking the page. */
export function readView(storage: Pick<Storage, "getItem"> | null = safeStorage()): UsageView {
  try {
    const saved = JSON.parse(storage?.getItem(VIEW_KEY) ?? "{}") as Partial<UsageView>;
    const one = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
      allowed.includes(value as T) ? (value as T) : fallback;
    const id = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      range: one(saved.range, RANGES.map((r) => r.value), DEFAULT_VIEW.range),
      metric: one(saved.metric, METRICS.map((m) => m.value), DEFAULT_VIEW.metric),
      bot: id(saved.bot),
      engine: id(saved.engine),
      tab: one(saved.tab, ["agent", "engine", "day"] as const, DEFAULT_VIEW.tab),
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: UsageView, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(VIEW_KEY, JSON.stringify(view));
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

// ── figures ────────────────────────────────────────────────────────────

/** A tally's number in one metric. */
export function valueOf(totals: UsageTotals, metric: UsageMetric): number {
  if (metric === "cost") return totals.cost;
  if (metric === "tokens") return totals.input + totals.output;
  return totals.turns;
}

/** Dollars the way a bill writes them: "$12.40", "$1,204.18", and
 * "under $0.01" for a price too small to write in cents, which a bare
 * "$0.00" would show as free. */
const CENTS = { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return formatNumber(0, CENTS);
  if (usd < 0.01) return t("libUsagePage.under", { amount: formatNumber(0.01, CENTS) });
  return formatNumber(usd, CENTS);
}

/** Dollars estimated from tokens: "~$4.20", and "under ~$0.01". */
export function estimatedMoney(usd: number): string {
  const about = (amount: number) => t("libUsagePage.about", { amount: formatNumber(amount, CENTS) });
  if (!Number.isFinite(usd) || usd <= 0) return about(0);
  if (usd < 0.01) return t("libUsagePage.under", { amount: about(0.01) });
  return about(usd);
}

/** Whether a tally's cost is, at least in part, an estimate. */
export function isEstimate(totals: Pick<UsageTotals, "estimated"> | null | undefined): boolean {
  return (totals?.estimated ?? 0) > 0;
}

/** Dollars per million tokens, as a provider's price page writes them:
 * "$3", "$0.15", "$1.25". */
export function perMillionText(usd: number): string {
  return formatNumber(usd, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/** Dollars on an axis, as short as they can be and still be read. */
export function axisMoney(usd: number): string {
  const dollars = (n: number, min: number, max: number) =>
    formatNumber(n, { style: "currency", currency: "USD", minimumFractionDigits: min, maximumFractionDigits: max });
  if (usd === 0) return dollars(0, 0, 0);
  if (usd >= 1_000) return `$${shortTokens(usd)}`;
  if (usd >= 10) return dollars(Math.round(usd), 0, 0);
  return usd < 1 ? dollars(usd, 2, 2) : dollars(usd, 0, 1);
}

/** "1 turn", "12 turns", with the thousands grouped. */
export function turnsText(n: number): string {
  return t("libUsagePage.turns", { count: n });
}

/** A metric's figure in full, for the headline and a tooltip. A cost
 * with any estimate in it is written as one. */
export function figure(value: number, metric: UsageMetric, estimated = false): string {
  if (metric === "cost") return estimated ? estimatedMoney(value) : money(value);
  if (metric === "tokens") return shortTokens(value);
  return formatNumber(value);
}

/** A tally's figure in one metric, an estimate written as one. Nothing
 * there is nothing used. */
export function figureOf(totals: UsageTotals | null | undefined, metric: UsageMetric): string {
  if (!totals) return figure(0, metric);
  return figure(valueOf(totals, metric), metric, isEstimate(totals));
}

/** A metric's figure on an axis. */
export function axisFigure(value: number, metric: UsageMetric): string {
  if (metric === "cost") return axisMoney(value);
  return value === 0 ? "0" : shortTokens(value);
}

/** A share of a whole, as a percent: "42%", and "under 1%" for a sliver
 * a rounded 0% would hide. */
export function shareText(part: number, whole: number): string {
  const percent = (n: number) => formatNumber(n / 100, { style: "percent" });
  if (!(whole > 0) || !(part > 0)) return percent(0);
  const share = (part / whole) * 100;
  if (share < 1) return t("libUsagePage.under", { amount: percent(1) });
  return percent(Math.round(share));
}

/**
 * Against the span before: "12% more than the 30 days before", or null
 * when there is nothing to compare with, since growth from nothing is no
 * percent at all. Within half a percent either way is about the same.
 */
export function deltaLine(now: number, before: number, days: number): { text: string; direction: "up" | "down" | "flat" } | null {
  if (!(before > 0) || !Number.isFinite(now)) return null;
  const change = ((now - before) / before) * 100;
  if (Math.abs(change) < 0.5) return { text: t("libUsagePage.delta.same", { count: days }), direction: "flat" };
  // past ten times, a percent stops meaning anything to anybody
  if (change >= 900) return { text: t("libUsagePage.delta.times", { count: days, times: Math.round(now / before) }), direction: "up" };
  const percent = formatNumber(Math.round(Math.abs(change)) / 100, { style: "percent" });
  return change > 0
    ? { text: t("libUsagePage.delta.more", { count: days, percent }), direction: "up" }
    : { text: t("libUsagePage.delta.less", { count: days, percent }), direction: "down" };
}

/**
 * The quiet line under the headline: how many turns, and whatever the
 * figure leaves out. A cost is an estimate from what the engines said, in
 * US dollars, and from their tokens at list prices where they said no
 * price; turns on an engine nobody has a price for are not in it, and
 * Bloks AI never is.
 */
export function headlineNotes(report: Pick<UsageReport, "total" | "unpricedTurns" | "bloksAiTurns" | "priced">, metric: UsageMetric): string[] {
  const notes = [turnsText(report.total.turns)];
  if (metric === "cost" && report.priced) {
    notes.push(isEstimate(report.total) ? t("libUsagePage.note.estimateWithTokens") : t("libUsagePage.note.estimate"), "USD");
    if (report.unpricedTurns > 0) notes.push(t("libUsagePage.note.unpriced", { count: report.unpricedTurns }));
  }
  if (metric === "cost" && report.bloksAiTurns > 0) notes.push(t("libUsagePage.note.bloksAi", { count: report.bloksAiTurns }));
  if (report.total.unmeasured > 0) notes.push(t("libUsagePage.note.unmeasured", { count: report.total.unmeasured }));
  return notes;
}

// ── on a plan ──────────────────────────────────────────────────────────

/** Engines signed in to a Claude or ChatGPT plan, which say what the
 * plan has left as they answer. */
export const PLAN_KINDS: readonly string[] = ["claudeAgent", "codex"];

export function onPlan(driverKind: string | null | undefined): boolean {
  return PLAN_KINDS.includes(driverKind ?? "");
}

/**
 * The engines the Limits section shows a plan for, in the order given:
 * those on a plan that are installed here, that have a reading of their
 * plan, or that answered a turn in the span in view (`answered`, the
 * report's engines; null before it is in). Claude Code and Codex are
 * always set up, so listing every one on a plan showed both, saying
 * nothing was heard, on a computer that has neither (GitHub 459). One
 * that answered and has since gone keeps its card while its turns are in
 * view.
 */
export function planEngines<T extends { instanceId: string; driverKind: string; snapshot: { state: string } }>(
  instances: readonly T[],
  plans: Record<string, PlanUsage> | null | undefined,
  answered: readonly string[] | null | undefined,
): T[] {
  return instances.filter(
    (i) => onPlan(i.driverKind) && (i.snapshot.state === "available" || Boolean(plans?.[i.instanceId]) || Boolean(answered?.includes(i.instanceId))),
  );
}

/** Of those, the ones that never give a price. Claude Code gives a turn's
 * cost even on a plan, so a Claude turn with none failed before it said
 * anything, and saying its plan reports no dollar figure would be wrong. */
const PRICELESS_PLAN_KINDS: readonly string[] = ["codex"];

export function planWithoutPrice(driverKind: string | null | undefined): boolean {
  return PRICELESS_PLAN_KINDS.includes(driverKind ?? "");
}

/** An engine on a plan that used something in view and priced none of
 * it: what it used, and what its plan last said it has left. */
export interface PlanUse {
  id: string;
  turns: number;
  tokens: number;
  /** The plan's name as the engine gave it ("Pro"), when it did. */
  plan: string | null;
  /** The plan's windows still current, shortest first. None is no
   * current reading: nothing heard since the server started, or only
   * windows that have since started again. */
  windows: PlanRow[];
}

/**
 * The engines in a report that ran on a plan that never gives a price,
 * each with its plan as GET /api/plan-usage last said it. An engine that
 * priced any of its turns in view has a cost to show and is not one.
 * `kindOf` names an engine's driver from its id.
 */
export function planUses(
  report: Pick<UsageReport, "byEngine">,
  kindOf: (engineId: string) => string,
  plans: Record<string, PlanUsage> | null | undefined,
  now: number,
  format?: { locale?: string; timeZone?: string },
): PlanUse[] {
  return report.byEngine
    .filter((row) => row.turns > 0 && !row.priced && row.id !== BLOKS_AI_ENGINE && planWithoutPrice(kindOf(row.id)))
    .map((row) => {
      const reading = plans?.[row.id] ?? null;
      return {
        id: row.id,
        turns: row.turns,
        tokens: row.input + row.output,
        plan: planName(reading?.plan),
        windows: planRows(reading, now, format),
      };
    });
}

/** What the plan side of a PlanUse is called: "Your Pro plan". */
export function planTitle(plan: string | null): string {
  return plan ? t("libUsagePage.yourNamedPlan", { plan }) : t("libUsagePage.yourPlan");
}

/** Said under a plan's windows, so they are never read as this
 * workspace's share of them. */
export function accountWide(): string {
  return t("libUsagePage.accountWide");
}

/** Said in place of the windows when there is no current reading. */
export function noPlanReading(engine: string): string {
  return t("libUsagePage.noPlanReading", { engine });
}

/** The title of the way to Limits where a plan engine's cost would be. */
export function seePlanTitle(engine: string): string {
  return t("libUsagePage.seePlanTitle", { engine });
}

// ── dates ──────────────────────────────────────────────────────────────

/** A local YYYY-MM-DD as a Date at noon, where no change of clocks lands. */
export function dayOf(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/** "Oct 3", for an axis or a row. */
// a locale given is used as it is (the tests pin one); otherwise the reader's
function dateIn(at: Date, options: Intl.DateTimeFormatOptions, locale?: string): string {
  return locale ? at.toLocaleDateString(locale, options) : formatDate(at, options);
}

export function shortDay(date: string, locale?: string): string {
  return dateIn(dayOf(date), { month: "short", day: "numeric" }, locale);
}

/** "Fri, Oct 3", for a tooltip. */
export function longDay(date: string, locale?: string): string {
  return dateIn(dayOf(date), { weekday: "short", month: "short", day: "numeric" }, locale);
}

/** "Tops up Nov 1": when a spending limit's month starts again, in the
 * words the composer's notice uses for it. */
export function topsUpLine(at: number, locale?: string): string {
  return t("libUsagePage.topsUp", { date: dateIn(new Date(at), { month: "short", day: "numeric" }, locale) });
}

// ── the chart's scale ──────────────────────────────────────────────────

/** Round numbers from zero to past the highest value, three or four of
 * them, so the gridlines fall on figures a person would say. */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

// ── the breakdown ──────────────────────────────────────────────────────

export type SortKey = "name" | "value" | "share" | "tokens";

/**
 * Rows in the order asked for. Value and share sort alike (a share is a
 * value over one total); the day tab's names are dates, which sort as
 * text. Ties keep the busiest first, so the order never jumps between
 * two clicks on the same header.
 */
export function sortRows<T extends UsageTotals>(rows: T[], key: SortKey, descending: boolean, metric: UsageMetric, name: (row: T) => string): T[] {
  const by = (row: T): number | string =>
    key === "name" ? name(row).toLowerCase() : key === "tokens" ? row.input + row.output : valueOf(row, metric);
  return [...rows].sort((a, b) => {
    const x = by(a);
    const y = by(b);
    const order = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return (descending ? -order : order) || b.input + b.output - (a.input + a.output);
  });
}
