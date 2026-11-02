// Usage, a place on the main rail: what the agents have used, and what
// is left of everything they run on.
//
// The numbers are the engines' own (server/usage.ts). A cost is a price
// an engine reported, or, for one that reports tokens and no price, its
// tokens at the providers' list price or the person's own price for it
// (server/model-prices.ts), written "~$4.20" and said to be an estimate.
// An engine nobody has a price for shows its tokens and says "not
// reported" where a cost would be, never a dollar figure made up for it.
// One on a plan that gives no price (Codex on its ChatGPT sign-in) shows,
// beside its tokens, what its plan last said it has left, and says so
// plainly when there is no reading: the tokens are this workspace's, and
// the plan is the whole account's, so the two are never added up.
// Bloks AI is never in dollars and never in a dollar total: its turns are
// counted with the rest, and what it has left is in Limits, as shares,
// the way the service says it.
//
// One span at a time, for every agent and engine or for one of each,
// in one metric; each choice is kept on this device. Clicking an agent
// or an engine in the breakdown, or an engine in the chart's legend,
// narrows the whole page to it. A link from a composer's notice opens it
// on that conversation's agent, at Limits.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowDown, ArrowUp, ChevronDown, RefreshCw, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentAvatar } from "@/components/Avatar";
import { ProviderMark } from "@/components/ProviderIcons";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { shortTokens } from "@/lib/contextCard";
import {
  BLOKS_AI_ENGINE,
  METRICS,
  RANGES,
  accountWide,
  deltaLine,
  figure,
  figureOf,
  headlineNotes,
  isEstimate,
  longDay,
  noPlanReading,
  planTitle,
  planUses,
  planWithoutPrice,
  pricesNote,
  readView,
  saveView,
  seePlanTitle,
  shareText,
  sortRows,
  turnsText,
  valueOf,
  type BreakdownTab,
  type PlanUse,
  type SortKey,
  type UsageReport,
  type UsageRow,
  type UsageView,
} from "@/lib/usagePage";
import { ChartLegend, UsageChart, type ChartLine } from "./usage/UsageChart";
import { PLANS_ID, PlanLine, UsageLimits, usePlanUsage } from "./usage/UsageLimits";
import { formatNumber, t, useLanguage } from "@/lib/i18n";

/** Engines drawn as lines over the total: as many as there are series
 * colours after the brand's own, which the total wears. */
const MAX_LINES = 4;
const lineColour = (i: number) => `var(--series-${i + 2})`;

/** The page settles in a beat at a time, top down, as Overview does. */
const arrive = (order: number) => ({
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, delay: order * 0.04, ease: [0.23, 1, 0.32, 1] as const },
});

/** Names for what the report calls by id. An engine no longer set up is
 * still named by its id rather than dropped: its turns happened. */
function useNames() {
  const { state } = useStore();
  // the fallbacks are words, so a change of language makes new ones
  const language = useLanguage();
  return useMemo(() => {
    const engine = (id: string) =>
      state.instances.find((i) => i.instanceId === id)?.displayName ?? (id === BLOKS_AI_ENGINE ? "Bloks AI" : id);
    const kind = (id: string) => state.instances.find((i) => i.instanceId === id)?.driverKind ?? id;
    const agent = (id: string) => state.bots.find((b) => b.id === id)?.name ?? t("usagePage.removedAgent");
    return { engine, kind, agent };
  }, [state.instances, state.bots, language]);
}

/** The report for the view, kept while the next one is asked for, so a
 * change of filter does not blank the page between two answers. */
function useReport(view: Pick<UsageView, "range" | "bot" | "engine">) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    const query = new URLSearchParams({ range: view.range });
    if (view.bot) query.set("bot", view.bot);
    if (view.engine) query.set("engine", view.engine);
    api(`/api/usage/report?${query}`)
      .then((body: UsageReport) => {
        if (!current) return;
        setReport(body);
        setFailed(false);
      })
      .catch(() => current && setFailed(true))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [view.range, view.bot, view.engine, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { report, loading, failed, refresh };
}

// ── the header's controls ──────────────────────────────────────────────

function Menu({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; icon?: React.ReactNode }>;
  onChange: (value: string) => void;
  icon?: React.ReactNode;
}) {
  const chosen = options.find((o) => o.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={t("usagePage.menuLabel", { label, chosen: chosen.label })} className="h-8 max-w-[200px] gap-1.5 px-2.5 font-normal text-foreground">
          {icon ?? chosen.icon}
          <span className="min-w-0 truncate">{chosen.label}</span>
          <ChevronDown size={13} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(420px,70dvh)] overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option, i) => (
            <div key={option.value}>
              {i === 1 && options.length > 1 && <DropdownMenuSeparator />}
              <DropdownMenuRadioItem value={option.value}>
                <span className="flex min-w-0 items-center gap-2">
                  {option.icon}
                  <span className="truncate">{option.label}</span>
                </span>
              </DropdownMenuRadioItem>
            </div>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ALL = "__all";

function Controls({
  view,
  set,
  report,
  loading,
  onRefresh,
}: {
  view: UsageView;
  set: (patch: Partial<UsageView>) => void;
  report: UsageReport | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { state } = useStore();
  const names = useNames();
  // whoever has usage in the span, and whoever is picked even if not
  const agents = [...new Set([...(report?.agents ?? []), ...(view.bot ? [view.bot] : [])])];
  const engines = [...new Set([...(report?.engines ?? []), ...(view.engine ? [view.engine] : [])])];
  const bot = (id: string) => state.bots.find((b) => b.id === id);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu
        label={t("common.agent")}
        value={view.bot ?? ALL}
        onChange={(v) => set({ bot: v === ALL ? null : v })}
        options={[
          { value: ALL, label: t("usagePage.allAgents") },
          ...agents
            .map((id) => ({
              value: id,
              label: names.agent(id),
              icon: bot(id) ? <AgentAvatar bot={bot(id)!} size={16} /> : undefined,
            }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ]}
      />
      <Menu
        label={t("common.engine")}
        value={view.engine ?? ALL}
        onChange={(v) => set({ engine: v === ALL ? null : v })}
        options={[
          { value: ALL, label: t("usagePage.allEngines") },
          ...engines
            .map((id) => ({ value: id, label: names.engine(id), icon: <ProviderMark driverKind={names.kind(id)} size={14} /> }))
            .sort((a, b) => a.label.localeCompare(b.label)),
        ]}
      />
      <Segmented
        size="sm"
        aria-label={t("usagePage.measure")}
        value={view.metric}
        options={METRICS.map((m) => ({ value: m.value, label: t(m.label) }))}
        onChange={(metric) => set({ metric })}
      />
      <Menu label={t("usagePage.span")} value={view.range} onChange={(v) => set({ range: v as UsageView["range"] })} options={RANGES.map((r) => ({ value: r.value, label: t(r.label) }))} />
      <Button variant="ghost" size="icon" aria-label={t("usagePage.refresh")} title={t("usagePage.refresh")} onClick={onRefresh} className="size-8">
        <RefreshCw size={15} className={cn(loading && "animate-spin motion-reduce:animate-none")} />
      </Button>
    </div>
  );
}

// ── the headline ───────────────────────────────────────────────────────

function spanWords(view: Pick<UsageView, "range">, days: number): string {
  return view.range === "month" ? t("usagePage.thisMonth") : t("usagePage.lastDays", { count: days });
}

function Headline({ report, view, onMetric }: { report: UsageReport; view: UsageView; onMetric: (metric: UsageView["metric"]) => void }) {
  const metric = view.metric;
  const unpriced = metric === "cost" && !report.priced;
  const value = valueOf(report.total, metric);
  const delta = unpriced ? null : deltaLine(value, valueOf(report.previous, metric), report.days);
  const estimated = metric === "cost" && isEstimate(report.total);
  const label = t(METRICS.find((m) => m.value === metric)!.label);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-body text-muted-foreground">{t("usagePage.metricInSpan", { metric: label, span: spanWords(view, report.days) })}</p>
      {unpriced ? (
        <>
          <p className="text-balance text-heading font-semibold text-foreground">{t("usagePage.noPriceReported")}</p>
          <p className="max-w-[60ch] text-pretty text-body text-muted-foreground">
            {t("usagePage.noHonestFigure")}{" "}
            <button type="button" onClick={() => onMetric("tokens")} className="font-medium text-foreground underline underline-offset-2">
              {t("usagePage.showTokens")}
            </button>
          </p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-[40px] font-semibold leading-[44px] tabular-nums text-foreground">{figure(value, metric, estimated)}</p>
            {metric === "tokens" && <span className="text-ui text-muted-foreground">{t("usagePage.tokens")}</span>}
            {delta && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-small tabular-nums text-muted-foreground">
                {delta.direction === "up" ? <ArrowUp size={12} /> : delta.direction === "down" ? <ArrowDown size={12} /> : null}
                {delta.text}
              </span>
            )}
          </div>
          <p className="text-pretty text-small tabular-nums text-muted-foreground">{headlineNotes(report, metric).join(" · ")}</p>
          {estimated && <p className="text-pretty text-small text-muted-foreground">{pricesNote()}</p>}
        </>
      )}
    </div>
  );
}

/**
 * An engine on a plan that priced none of its turns, under the headline
 * where its cost would be: what it used in view, and what its plan has
 * left, side by side and never added up. With no current reading the
 * tokens and turns are what there is, and the card says so in a line.
 */
function PlanUseCard({
  use,
  view,
  days,
  reading,
  onPlans,
}: {
  use: PlanUse;
  view: UsageView;
  days: number;
  /** The plans are still being asked for. */
  reading: boolean;
  onPlans: () => void;
}) {
  const names = useNames();
  const name = names.engine(use.id);
  const here = view.bot ? t("usagePage.engineForAgent", { engine: name, agent: names.agent(view.bot) }) : t("usagePage.engineInWorkspace", { engine: name });
  return (
    <section aria-label={t("usagePage.engineOnPlan", { engine: name })} className="grid grid-cols-1 gap-4 rounded-xl border p-4 sm:grid-cols-2 sm:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex min-w-0 items-center gap-2 text-small text-muted-foreground">
          <ProviderMark driverKind={names.kind(use.id)} size={13} />
          <span className="min-w-0 truncate">{here}</span>
        </p>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-title font-semibold tabular-nums text-foreground" title={formatNumber(use.tokens)}>
            {shortTokens(use.tokens)}
          </span>
          <span className="text-ui text-muted-foreground">{t("usagePage.tokens")}</span>
        </p>
        <p className="text-small tabular-nums text-muted-foreground">
          {t("usagePage.turnsInSpan", { turns: turnsText(use.turns), span: spanWords(view, days) })}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-small text-muted-foreground">{planTitle(use.plan)}</p>
        {reading ? (
          <p className="text-small text-muted-foreground">{t("usagePage.reading")}</p>
        ) : use.windows.length ? (
          <>
            {use.windows.map((row) => (
              <PlanLine key={row.id} row={row} />
            ))}
            <p className="text-pretty text-small text-muted-foreground">{accountWide()}</p>
          </>
        ) : (
          <p className="text-pretty text-body text-foreground">{noPlanReading(name)}</p>
        )}
        <button
          type="button"
          onClick={onPlans}
          className="self-start text-small font-medium text-foreground underline underline-offset-2"
        >
          {t("usagePage.seePlansInLimits")}
        </button>
      </div>
    </section>
  );
}

function Totals({ report }: { report: UsageReport }) {
  const total = report.total;
  const items = [
    { label: t("usagePage.inputTokens"), value: shortTokens(total.input), title: formatNumber(total.input) },
    { label: t("usagePage.outputTokens"), value: shortTokens(total.output), title: formatNumber(total.output) },
    { label: t("usagePage.allTokens"), value: shortTokens(total.input + total.output), title: formatNumber(total.input + total.output) },
    { label: t("libUsagePage.metric.turns"), value: formatNumber(total.turns), title: undefined },
  ];
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="bg-background px-4 py-3">
          <dt className="text-small text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 text-title font-semibold tabular-nums text-foreground" title={item.title}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── the breakdown ──────────────────────────────────────────────────────

interface Line extends UsageRow {
  name: string;
  /** Agent and engine rows narrow the page; a day does not. */
  pick?: () => void;
  icon?: React.ReactNode;
  bloksAi?: boolean;
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; descending: boolean };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const on = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={on ? (sort.descending ? "descending" : "ascending") : "none"} className={cn("px-0 py-2 font-normal", className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-small transition-colors duration-150 hover:bg-accent hover:text-foreground",
          on ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {on ? (sort.descending ? <ArrowDown size={11} /> : <ArrowUp size={11} />) : null}
      </button>
    </th>
  );
}

/** Where a cost would be for Bloks AI, or for an engine on a plan, which
 * have none: a way to what each has left instead, in Limits. */
function ToLimits({ label, onLimits, title = t("usagePage.seeBloksAiLeft") }: { label: string; onLimits: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onLimits}
      title={title}
      className="text-muted-foreground underline decoration-border underline-offset-2 transition-colors duration-150 hover:text-foreground"
    >
      {label}
    </button>
  );
}

function Breakdown({
  report,
  view,
  set,
  onLimits,
  onPlans,
}: {
  report: UsageReport;
  view: UsageView;
  set: (patch: Partial<UsageView>) => void;
  onLimits: () => void;
  onPlans: () => void;
}) {
  const { state } = useStore();
  const names = useNames();
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "value", descending: true });
  // the day tab's names are dates, written in the reader's language
  const language = useLanguage();
  const metric = view.metric;
  const tab = view.tab;

  const rows: Line[] = useMemo(() => {
    if (tab === "agent") {
      return report.byAgent.map((row) => {
        const bot = state.bots.find((b) => b.id === row.id);
        return {
          ...row,
          name: names.agent(row.id),
          icon: bot ? <AgentAvatar bot={bot} size={22} /> : <span className="size-[22px] shrink-0 rounded-full bg-muted" />,
          pick: view.bot === row.id ? undefined : () => set({ bot: row.id }),
        };
      });
    }
    if (tab === "engine") {
      return report.byEngine.map((row) => ({
        ...row,
        name: names.engine(row.id),
        icon: (
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-muted">
            <ProviderMark driverKind={names.kind(row.id)} size={13} />
          </span>
        ),
        bloksAi: row.id === BLOKS_AI_ENGINE,
        pick: view.engine === row.id ? undefined : () => set({ engine: row.id }),
      }));
    }
    return report.daily
      .filter((d) => d.turns > 0)
      .map((d) => ({ ...d, id: d.date, name: longDay(d.date), priced: d.cost > 0 }));
  }, [tab, report, names, state.bots, view.bot, view.engine, set, language]);

  // a day's name is a date, which sorts by its id rather than its words
  const sorted = sortRows(rows, sort.key, sort.descending, metric, (r) => (tab === "day" ? r.id : r.name));
  const whole = rows.reduce((sum, r) => sum + (metric === "cost" && (!r.priced || r.bloksAi) ? 0 : valueOf(r, metric)), 0);
  const onSort = (next: SortKey) =>
    setSort((was) => (was.key === next ? { key: next, descending: !was.descending } : { key: next, descending: next !== "name" }));
  const fourth = metric === "tokens" ? t("libUsagePage.metric.turns") : t("libUsagePage.metric.tokens");

  const valueCell = (row: Line) => {
    if (metric === "cost" && row.bloksAi) return <ToLimits label={t("usagePage.inLimits")} onLimits={onLimits} />;
    // an agent that only ever ran on Bloks AI had nothing to report: it
    // runs on an allowance, which Limits shows
    if (metric === "cost" && !row.priced && row.turns > 0 && row.bloksAiTurns === row.turns) {
      return <ToLimits label="Bloks AI" onLimits={onLimits} />;
    }
    // an engine on a plan that gives no price, or any row of one when the
    // page is narrowed to it: what the plan has left is in Limits
    const plan = tab === "engine" ? row.id : view.engine;
    if (metric === "cost" && !row.priced && row.turns > 0 && plan && planWithoutPrice(names.kind(plan))) {
      return <ToLimits label={t("usagePage.seePlan")} title={seePlanTitle(names.engine(plan))} onLimits={onPlans} />;
    }
    if (metric === "cost" && !row.priced) return <span className="text-muted-foreground">{t("usagePage.notReported")}</span>;
    return figureOf(row, metric);
  };
  const shareOf = (row: Line) => (metric === "cost" && (!row.priced || row.bloksAi) ? 0 : valueOf(row, metric));

  return (
    <section aria-labelledby="usage-breakdown" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="usage-breakdown" className="text-lead font-semibold text-foreground">
          {t("usagePage.breakdown")}
        </h2>
        <Segmented
          size="sm"
          aria-label={t("usagePage.breakDownBy")}
          value={tab}
          onChange={(next: BreakdownTab) => set({ tab: next })}
          options={[
            { value: "agent", label: t("common.agent") },
            { value: "engine", label: t("common.engine") },
            { value: "day", label: t("usagePage.day") },
          ]}
        />
      </div>
      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-body text-muted-foreground">{t("usagePage.nothingInThisSpan")}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <table className="w-full table-fixed text-body">
            <thead className="border-b bg-muted/40">
              <tr className="text-left">
                <HeaderCell label={tab === "day" ? t("usagePage.day") : tab === "agent" ? t("common.agent") : t("common.engine")} sortKey="name" sort={sort} onSort={onSort} className="pl-2.5" />
                <HeaderCell label={t(METRICS.find((m) => m.value === metric)!.label)} sortKey="value" sort={sort} onSort={onSort} className="w-[30%] text-right sm:w-[22%]" />
                <HeaderCell label={t("usagePage.share")} sortKey="share" sort={sort} onSort={onSort} className="hidden w-[24%] pl-3 sm:table-cell" />
                <HeaderCell label={fourth} sortKey="tokens" sort={sort} onSort={onSort} className="w-[22%] pr-2.5 text-right sm:w-[14%]" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const part = shareOf(row);
                const name = (
                  <span className="flex min-w-0 items-center gap-2.5">
                    {row.icon}
                    <span className="min-w-0 truncate text-foreground">{row.name}</span>
                  </span>
                );
                return (
                  <tr key={row.id} className={cn("border-t first:border-t-0", row.pick && "transition-colors duration-150 hover:bg-accent/50")}>
                    <th scope="row" className="py-2 pl-4 pr-2 text-left font-normal">
                      {row.pick ? (
                        <button
                          type="button"
                          onClick={row.pick}
                          title={t("usagePage.showOnly", { name: row.name })}
                          className="-mx-1.5 -my-1 flex w-[calc(100%+12px)] min-w-0 rounded-md px-1.5 py-1 text-left"
                        >
                          {name}
                        </button>
                      ) : (
                        name
                      )}
                    </th>
                    <td className="py-2 pl-2 text-right tabular-nums text-foreground">{valueCell(row)}</td>
                    <td className="hidden py-2 pl-5 pr-2 sm:table-cell">
                      {/* nothing priced has no share of a price */}
                      {metric === "cost" && (!row.priced || row.bloksAi) ? null : (
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full origin-left rounded-full bg-brand-ink/70"
                              style={{ transform: `scaleX(${whole > 0 ? part / whole : 0})` }}
                            />
                          </span>
                          <span className="w-14 shrink-0 text-right text-small tabular-nums text-muted-foreground">{shareText(part, whole)}</span>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pl-2 pr-4 text-right tabular-nums text-muted-foreground">
                      {metric === "tokens" ? formatNumber(row.turns) : shortTokens(row.input + row.output)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── the page ───────────────────────────────────────────────────────────

/** A filter in force, said once more under the headline with a way out,
 * so a narrowed page never passes for the whole picture. */
function FilterChips({ view, set }: { view: UsageView; set: (patch: Partial<UsageView>) => void }) {
  const names = useNames();
  const chips = [
    ...(view.bot ? [{ key: "bot", label: names.agent(view.bot), clear: () => set({ bot: null }) }] : []),
    ...(view.engine ? [{ key: "engine", label: names.engine(view.engine), clear: () => set({ engine: null }) }] : []),
  ];
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-small text-muted-foreground">{t("usagePage.showingOnly")}</span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.clear}
          aria-label={t("usagePage.stopShowingOnly", { name: chip.label })}
          className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-small text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-accent/70 active:scale-[0.97]"
        >
          {chip.label}
          <X size={11} className="text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function Loading() {
  return (
    <SkeletonGroup label={t("usagePage.loadingUsage")} className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-3 w-72" />
      </div>
      <Skeleton className="h-[70px] w-full rounded-xl" />
      <Skeleton className="h-[224px] w-full rounded-xl" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </SkeletonGroup>
  );
}

function Empty({ view }: { view: UsageView }) {
  const { dispatch } = useStore();
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
      <p className="text-lead font-semibold text-foreground">
        {view.range === "month" ? t("usagePage.nothingUsedThisMonth") : t("usagePage.nothingUsedLastDays", { count: Number(view.range.replace("d", "")) })}
      </p>
      <p className="max-w-[44ch] text-pretty text-body text-muted-foreground">
        {t("usagePage.everyTurnAnAgentTakes")}
      </p>
      <Button className="mt-1" onClick={() => dispatch({ type: "openPage", page: null })}>
        {t("usagePage.goToChat")}
      </Button>
    </div>
  );
}

export function UsagePage() {
  const { state } = useStore();
  const names = useNames();
  // A link from a notice narrows the page to its agent, once, as the
  // page opens; after that the person's own choices hold.
  const focus = state.usageFocus;
  const [view, setView] = useState<UsageView>(() => {
    const saved = readView();
    return focus?.botId ? { ...saved, bot: focus.botId, engine: null } : saved;
  });
  const set = useCallback((patch: Partial<UsageView>) => {
    setView((was) => {
      const next = { ...was, ...patch };
      saveView(next);
      return next;
    });
  }, []);
  const { report, loading, failed, refresh: refreshReport } = useReport(view);
  // the plans are read again with the report, so Refresh brings both
  const [planTick, setPlanTick] = useState(0);
  const plans = usePlanUsage(planTick);
  const refresh = useCallback(() => {
    refreshReport();
    setPlanTick((n) => n + 1);
  }, [refreshReport]);
  const limits = useRef<HTMLElement>(null);
  const toLimitsNow = useCallback(() => limits.current?.scrollIntoView({ block: "start", behavior: "smooth" }), []);
  const toPlansNow = useCallback(
    () => (document.getElementById(PLANS_ID) ?? limits.current)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    [],
  );

  // Opened for its limits: there once the numbers above have landed, so
  // the page does not move under the person after it got there.
  const toLimits = focus?.section === "limits" ? focus.at : null;
  const landed = report !== null;
  useEffect(() => {
    if (toLimits === null || !landed) return;
    limits.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [toLimits, landed]);

  const lines: ChartLine[] = useMemo(() => {
    if (!report || view.engine) return [];
    const drawn = report.byEngine.filter((e) => valueOf(e, view.metric) > 0 && !(view.metric === "cost" && (!e.priced || e.id === BLOKS_AI_ENGINE)));
    if (drawn.length < 2) return [];
    return drawn.slice(0, MAX_LINES).map((e, i) => ({ id: e.id, name: names.engine(e.id), colour: lineColour(i) }));
  }, [report, view.engine, view.metric, names]);

  const uses = useMemo(
    () => (report && view.metric === "cost" ? planUses(report, names.kind, plans, Date.now()) : []),
    [report, view.metric, names, plans],
  );

  const empty = report && report.agents.length === 0;

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-20 pt-9 max-md:pt-16 sm:px-6 lg:px-10">
          <motion.header {...arrive(0)} className="mb-8 flex flex-col gap-4">
            <div>
              <h1 className="text-balance text-display font-semibold text-foreground">{t("usagePage.usage")}</h1>
              <p className="mt-1 text-pretty text-ui text-muted-foreground">{t("usagePage.whatYourAgentsUsedBy")}</p>
            </div>
            <Controls view={view} set={set} report={report} loading={loading} onRefresh={refresh} />
          </motion.header>

          {failed && !report ? (
            <p className="rounded-xl border border-dashed px-4 py-6 text-center text-body text-muted-foreground">
              {t("usagePage.couldNotRead")}{" "}
              <button type="button" onClick={refresh} className="font-medium text-foreground underline underline-offset-2">
                {t("common.tryAgain")}
              </button>
            </p>
          ) : !report ? (
            <Loading />
          ) : empty ? (
            <Empty view={view} />
          ) : (
            <motion.div {...arrive(1)} className={cn("flex flex-col gap-8 transition-opacity duration-150", loading && "opacity-60")}>
              <div className="flex flex-col gap-3">
                <Headline report={report} view={view} onMetric={(metric) => set({ metric })} />
                <FilterChips view={view} set={set} />
                {uses.map((use) => (
                  <PlanUseCard key={use.id} use={use} view={view} days={report.days} reading={plans === null} onPlans={toPlansNow} />
                ))}
              </div>
              <Totals report={report} />
              <section aria-label={t("usagePage.byDay")} className="flex flex-col gap-3 rounded-xl border p-4 pb-3">
                <UsageChart
                  days={report.daily}
                  metric={view.metric}
                  lines={lines}
                  label={t(`usagePage.daily.${view.metric}`, { span: spanWords(view, report.days) })}
                />
                {lines.length > 0 && <ChartLegend lines={lines} onPick={(engine) => set({ engine })} />}
              </section>
              <Breakdown report={report} view={view} set={set} onLimits={toLimitsNow} onPlans={toPlansNow} />
            </motion.div>
          )}

          <motion.section
            {...arrive(2)}
            ref={limits}
            id="usage-limits"
            aria-labelledby="usage-limits-title"
            className="mt-14 flex scroll-mt-6 flex-col gap-6 border-t pt-10"
          >
            <div>
              <h2 id="usage-limits-title" className="text-lead font-semibold text-foreground">
                {t("usagePage.limits")}
              </h2>
              <p className="mt-0.5 text-pretty text-body text-muted-foreground">{t("usagePage.whatEachPlanAllowanceAnd")}</p>
            </div>
            <UsageLimits focusBot={view.bot} plans={plans} answered={report?.engines ?? null} />
          </motion.section>
        </div>
      </div>
    </main>
  );
}
