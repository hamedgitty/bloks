// The Usage page's Limits: what each thing an agent runs on has left.
//
// Three kinds, each in its own words. A Claude or ChatGPT plan's windows,
// as the engine last said them (server/plan-usage.ts). Bloks AI's month
// and day, as shares of the allowance and never as an amount, with the
// way to top it up. And a spending limit the person sets on an engine
// that runs on a key of their own (server/spend-limits.ts), the one
// limit here that is theirs to move, so it is edited in place, with the
// engine's own price per million tokens beside it for a model the
// providers' list does not know (server/model-prices.ts).
//
// The plans are read once for the whole page (usePlanUsage), since the
// headline shows them too, beside an engine on a plan that gave no price.
import { useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ProviderMark } from "@/components/ProviderIcons";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { planName, planRows, type PlanRow, type PlanUsage } from "@/lib/contextCard";
import { percentText, renewsLine, topUpWords, type BloksAiStatus } from "@/lib/credits";
import { resetLine } from "@/lib/usageNotice";
import { estimatedMoney, money, perMillionText, planEngines, pricesNote, topsUpLine, type SpendLimitRow } from "@/lib/usagePage";
import { formatNumber, t } from "@/lib/i18n";

/** A share as a bar. Warning colour near the end, where it matters. */
function Bar({ fill, tone = "brand", label }: { fill: number; tone?: "brand" | "warning" | "destructive"; label: string }) {
  const share = Math.max(0, Math.min(1, fill));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full origin-left rounded-full",
          tone === "destructive" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-brand-ink",
        )}
        style={{ transform: `scaleX(${share})` }}
      />
    </div>
  );
}

/** One line of a limit: what it is, the bar, and the words under it. */
function LimitLine({ label, fill, tone, used, note }: { label: string; fill: number; tone?: "brand" | "warning" | "destructive"; used: string; note?: string | null }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5">
      <span className="truncate text-body text-foreground">{label}</span>
      <span className="text-small tabular-nums text-muted-foreground">{used}</span>
      <div className="col-span-2">
        <Bar fill={fill} tone={tone} label={label} />
      </div>
      {note && <span className="col-span-2 text-small tabular-nums text-muted-foreground">{note}</span>}
    </div>
  );
}

/** A card per thing, its mark and name across the top. */
function LimitCard({
  driverKind,
  title,
  aside,
  badge,
  children,
}: {
  driverKind: string;
  title: string;
  aside?: React.ReactNode;
  badge?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <ProviderMark driverKind={driverKind} size={15} />
        </span>
        <span className="min-w-0 truncate text-ui font-medium text-foreground">{title}</span>
        {badge && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">{badge}</span>}
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </div>
  );
}

function Group({ id, title, note, children }: { id?: string; title: string; note: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3">
      <div>
        <h3 className="text-ui font-medium text-foreground">{title}</h3>
        <p className="mt-0.5 text-pretty text-small text-muted-foreground">{note}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

// ── plans ──────────────────────────────────────────────────────────────

/** One window of a plan, in the warning colour near its end. */
export function PlanLine({ row }: { row: PlanRow }) {
  return (
    <LimitLine
      label={row.label}
      fill={row.fill}
      tone={row.note !== null && row.note === t("contextCard.limitReached") ? "destructive" : row.near || row.fill >= 0.8 ? "warning" : "brand"}
      used={row.used}
      note={[row.note, row.reset].filter(Boolean).join(" · ")}
    />
  );
}

/** Where the Plans group is, for a link from higher up the page. */
export const PLANS_ID = "usage-plans";

/**
 * What each engine's plan last said, by engine, from GET /api/plan-usage;
 * null until the answer is in. The server keeps only the latest reading,
 * in memory, so an empty answer is normal after a restart, and the next
 * turn brings it back. Asked again whenever `tick` moves.
 */
export function usePlanUsage(tick = 0): Record<string, PlanUsage> | null {
  const [plans, setPlans] = useState<Record<string, PlanUsage> | null>(null);
  useEffect(() => {
    let current = true;
    api("/api/plan-usage")
      .then((body) => current && setPlans(body?.usage ?? {}))
      .catch(() => current && setPlans({}));
    return () => {
      current = false;
    };
  }, [tick]);
  return plans;
}

function PlanCards({
  plans,
  answered,
  badgeFor,
}: {
  plans: Record<string, PlanUsage> | null;
  answered: readonly string[] | null;
  badgeFor: (instanceId: string) => string | null;
}) {
  const { state } = useStore();
  const engines = planEngines(state.instances, plans, answered);
  if (!engines.length) return null;
  const now = Date.now();
  return (
    <Group id={PLANS_ID} title={t("usageLimits.plans")} note={t("usageLimits.whatAClaudeOrChatgpt")}>
      {engines.map((engine) => {
        const plan = plans?.[engine.instanceId] ?? null;
        const rows = planRows(plan, now);
        const name = planName(plan?.plan);
        return (
          <LimitCard
            key={engine.instanceId}
            driverKind={engine.driverKind}
            title={name ? `${engine.displayName} ${name}` : engine.displayName}
            badge={badgeFor(engine.instanceId)}
          >
            {rows.length ? (
              rows.map((row) => <PlanLine key={row.id} row={row} />)
            ) : (
              <p className="text-pretty text-small text-muted-foreground">
                {plans === null ? t("usageLimits.reading") : t("usageLimits.nothingHeardYet", { engine: engine.displayName })}
              </p>
            )}
          </LimitCard>
        );
      })}
    </Group>
  );
}

// ── Bloks AI ───────────────────────────────────────────────────────────

function BloksAiCard({ badge }: { badge: string | null }) {
  const [status, setStatus] = useState<BloksAiStatus | null>(null);
  useEffect(() => {
    let current = true;
    api("/api/credits")
      .then((body: BloksAiStatus) => current && setStatus(body))
      .catch(() => current && setStatus(null));
    return () => {
      current = false;
    };
  }, []);
  if (!status?.offered || status.needsKey) return null;
  const now = Date.now();
  const used = status.usedPercent ?? (status.monthlyLeftPercent !== null ? 100 - status.monthlyLeftPercent : null);
  const today = status.usedTodayPercent ?? null;
  const daily = status.dailyLimitPercent ?? null;
  const renews = renewsLine(status.renewsAt, undefined, true);
  return (
    <Group title="Bloks AI" note={t("usageLimits.yourBloksAiAllowanceAs")}>
      <LimitCard
        driverKind="bloks"
        title="Bloks AI"
        badge={badge}
        aside={
          <a
            href={status.checkoutUrl}
            target="_blank"
            rel="noreferrer"
            title={topUpWords()}
            className="inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-body font-medium text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-accent active:scale-[0.97]"
          >
            {t("usageLimits.topUp")}
          </a>
        }
      >
        {status.connected && used !== null ? (
          <>
            <LimitLine
              label={t("usageLimits.thisMonth")}
              fill={used / 100}
              tone={status.low || used >= 100 ? "warning" : "brand"}
              used={t("usageLimits.percentUsed", { percent: percentText(used) })}
              note={renews}
            />
            {today !== null && daily !== null && (
              <LimitLine
                label={t("usageLimits.today")}
                fill={today / daily}
                tone={today >= daily ? "destructive" : today / daily >= 0.8 ? "warning" : "brand"}
                used={t("usageLimits.ofTodaysLimit", { percent: percentText((today / daily) * 100) })}
                note={resetLine(status.dailyResetsAt ?? null, now)}
              />
            )}
          </>
        ) : (
          <p className="text-small text-muted-foreground">{status.problem ?? t("usageLimits.whatIsLeftCouldNot")}</p>
        )}
        <p className="text-caption text-muted-foreground">{topUpWords()}</p>
      </LimitCard>
    </Group>
  );
}

// ── spending limits on the person's own keys ───────────────────────────

/** A dollar field: the sign drawn in front, the figure typed after it. */
function DollarInput({
  id,
  value,
  onChange,
  onCancel,
  placeholder,
  invalid,
  describedBy,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  placeholder: string;
  invalid: boolean;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="relative w-32">
      <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ui text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        autoFocus={autoFocus}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="h-8 pl-6 tabular-nums"
      />
    </div>
  );
}

/** What the month's figure is made of when any of it is an estimate, and
 * the person's own price when there is one. Their price counts from when
 * it was set, so it is said as what comes first, not as what the month
 * so far was priced at. */
function estimateLine(row: SpendLimitRow): string | null {
  if (row.ownPrice) {
    const prices = { input: perMillionText(row.ownPrice.input), output: perMillionText(row.ownPrice.output) };
    return row.estimated ? t("usageLimits.estimatedOwnPrice", prices) : t("usageLimits.ownPrice", prices);
  }
  return row.estimated ? t("usageLimits.estimatedListPrices", { note: pricesNote() }) : null;
}

function SpendCard({ row, badge, onSaved }: { row: SpendLimitRow; badge: string | null; onSaved: (rows: SpendLimitRow[]) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (change: { usd?: number | string | null; price?: { input: string; output: string } | null }, done: string) => {
    setBusy(true);
    setError(null);
    api(`/api/spend-limits/${encodeURIComponent(row.instanceId)}`, { method: "PUT", body: JSON.stringify(change) })
      .then((body: { limits: SpendLimitRow[] }) => {
        onSaved(body.limits);
        setEditing(false);
        toast.success(done);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const open = () => {
    setText(row.limit === null ? "" : String(row.limit));
    setPriceIn(row.ownPrice ? String(row.ownPrice.input) : "");
    setPriceOut(row.ownPrice ? String(row.ownPrice.output) : "");
    setError(null);
    setEditing(true);
  };
  const close = () => setEditing(false);
  /** What the form would change: a limit typed, a price typed in both
   * fields or cleared from both, each only when it differs from before. */
  const submit = () => {
    const change: { usd?: string; price?: { input: string; output: string } | null } = {};
    if (text.trim() && text.trim() !== String(row.limit ?? "")) change.usd = text.trim();
    const typedIn = priceIn.trim();
    const typedOut = priceOut.trim();
    if (Boolean(typedIn) !== Boolean(typedOut)) {
      setError(t("usageLimits.giveBothPrices"));
      return;
    }
    if (typedIn && (typedIn !== String(row.ownPrice?.input ?? "") || typedOut !== String(row.ownPrice?.output ?? ""))) {
      change.price = { input: typedIn, output: typedOut };
    } else if (!typedIn && row.ownPrice) change.price = null;
    if (!("usd" in change) && !("price" in change)) {
      close();
      return;
    }
    save(change, t("usageLimits.savedFor", { name: row.name }));
  };

  const tone = row.reached ? "destructive" : row.level === "warn" ? "warning" : "brand";
  const spentText = row.estimated ? estimatedMoney(row.spent) : money(row.spent);
  const estimate = estimateLine(row);
  return (
    <LimitCard
      driverKind={row.driverKind}
      title={row.name}
      badge={badge}
      aside={
        !editing && (
          <Button size="sm" variant={row.reached ? "default" : "outline"} onClick={open} className="h-7">
            {row.limit === null ? t("usageLimits.setLimit") : row.reached ? t("usageLimits.raiseLimit") : t("common.edit")}
          </Button>
        )
      }
    >
      {row.limit !== null ? (
        <LimitLine
          label={t("usageLimits.thisMonth")}
          fill={row.spent / row.limit}
          tone={tone}
          used={t("usageLimits.spentOf", { spent: spentText, limit: money(row.limit) })}
          note={`${t("usageLimits.percentUsed", {
            percent: formatNumber((row.usedPercent ?? 0) / 100, { style: "percent", maximumFractionDigits: 2 }),
          })} · ${topsUpLine(row.resetsAt)}`}
        />
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-body text-foreground">{t("usageLimits.thisMonth")}</span>
          <span className="text-small tabular-nums text-muted-foreground">{row.priced ? spentText : t("usageLimits.nothingPricedYet")}</span>
        </div>
      )}
      {estimate && <p className="text-pretty text-small text-muted-foreground">{estimate}</p>}
      {row.reached && !editing && (
        <p className="text-pretty text-small text-destructive">{t("usageLimits.pausedUntilRaised", { name: row.name })}</p>
      )}
      {!row.reportsPrice && (
        <p className="text-pretty text-small text-muted-foreground">
          {t("usageLimits.notPricedYet", { name: row.name })}
        </p>
      )}
      {row.limit === null && row.reportsPrice && !editing && (
        <p className="text-small text-muted-foreground">{t("usageLimits.noLimitItRunsUntil")}</p>
      )}
      {editing && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) submit();
          }}
        >
          <div className="flex flex-col gap-2">
            <label htmlFor={`limit-${row.instanceId}`} className="text-small text-muted-foreground">
              {t("usageLimits.monthlyLimitInUsDollars")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <DollarInput
                id={`limit-${row.instanceId}`}
                autoFocus
                value={text}
                onChange={(value) => {
                  setText(value);
                  setError(null);
                }}
                onCancel={close}
                placeholder="20"
                invalid={Boolean(error)}
                describedBy={error ? `limit-error-${row.instanceId}` : undefined}
              />
              {row.limit !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-8 hover:text-destructive"
                  disabled={busy}
                  onClick={() => save({ usd: null }, t("usageLimits.limitRemovedFrom", { name: row.name }))}
                >
                  {t("usageLimits.removeLimit")}
                </Button>
              )}
            </div>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-small text-muted-foreground">{t("usageLimits.yourOwnPriceForA")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={`price-in-${row.instanceId}`} className="text-caption text-muted-foreground">
                  {t("usageLimits.pricePerMillionInputTokens")}
                </label>
                <DollarInput
                  id={`price-in-${row.instanceId}`}
                  value={priceIn}
                  onChange={(value) => {
                    setPriceIn(value);
                    setError(null);
                  }}
                  onCancel={close}
                  placeholder="3"
                  invalid={Boolean(error)}
                  describedBy={error ? `limit-error-${row.instanceId}` : undefined}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`price-out-${row.instanceId}`} className="text-caption text-muted-foreground">
                  {t("usageLimits.perMillionOutputTokens")}
                </label>
                <DollarInput
                  id={`price-out-${row.instanceId}`}
                  value={priceOut}
                  onChange={(value) => {
                    setPriceOut(value);
                    setError(null);
                  }}
                  onCancel={close}
                  placeholder="15"
                  invalid={Boolean(error)}
                  describedBy={error ? `limit-error-${row.instanceId}` : undefined}
                />
              </div>
            </div>
            <p className="text-caption text-muted-foreground">{t("usageLimits.usedAheadOfList", { name: row.name })}</p>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" className="h-8" disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : t("common.save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
          {error && (
            <p id={`limit-error-${row.instanceId}`} className="text-small text-destructive">
              {error}
            </p>
          )}
        </form>
      )}
    </LimitCard>
  );
}

function SpendCards({ badgeFor }: { badgeFor: (instanceId: string) => string | null }) {
  const { dispatch } = useStore();
  const [rows, setRows] = useState<SpendLimitRow[] | null>(null);
  useEffect(() => {
    let current = true;
    api("/api/spend-limits")
      .then((body: { limits: SpendLimitRow[] }) => current && setRows(body.limits))
      // an older server has no limits to set
      .catch(() => current && setRows([]));
    return () => {
      current = false;
    };
  }, []);
  if (rows === null) return null;
  return (
    <Group
      title={t("usageLimits.spendingLimits")}
      note={t("usageLimits.aMonthlyLimitOnAn")}
    >
      {rows.length ? (
        rows.map((row) => <SpendCard key={row.instanceId} row={row} badge={badgeFor(row.instanceId)} onSaved={setRows} />)
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4 md:col-span-2">
          <p className="text-pretty text-small text-muted-foreground">
            {t("usageLimits.noEngineHereRunsOn")}
          </p>
          <Button size="sm" variant="outline" onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: "engines" })}>
            {t("usageLimits.openEngines")}
          </Button>
        </div>
      )}
    </Group>
  );
}

/**
 * Every limit, in three groups. `focus` is the agent the page is about,
 * when it is about one: the cards for the engine that agent runs on say
 * so, since that is the limit a person following a notice came to see.
 * `plans` is the page's reading of them (usePlanUsage).
 */
export function UsageLimits({
  focusBot,
  plans,
  answered,
}: {
  focusBot: string | null;
  plans: Record<string, PlanUsage> | null;
  /** The engines that answered a turn in the span in view, null before
   * the report is in: a plan is shown for those and for the installed. */
  answered: readonly string[] | null;
}) {
  const { state } = useStore();
  const bot = focusBot ? state.bots.find((b) => b.id === focusBot) : undefined;
  const runsOn = bot?.modelSelection.instanceId ?? null;
  const onCredits = bot && runsOn === "bloks";
  const badgeFor = (instanceId: string) => (bot && !onCredits && runsOn === instanceId ? t("usageLimits.agentsEngine", { name: bot.name }) : null);
  return (
    <div className="flex flex-col gap-8">
      <PlanCards plans={plans} answered={answered} badgeFor={badgeFor} />
      <BloksAiCard badge={bot && onCredits ? t("usageLimits.agentsEngine", { name: bot.name }) : null} />
      <SpendCards badgeFor={badgeFor} />
    </div>
  );
}
