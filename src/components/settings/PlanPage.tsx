// Settings, Plan: the membership on the one key this computer keeps, what
// it includes and how much of it is in use, and where the plan can go
// next.
//
// Read top to bottom, it answers in the order people ask. The plan, large,
// with its status beside it, what it costs when the site says, and the key
// it rides on. Then what it includes, as a few numbers with meters rather
// than a list of rows, and the add-on choices that are the person's. Then
// the offers, as cards. Anything a plan does not include is said quietly
// where it would be, with one way up for all of it.
//
// Everything about the membership is bloks.dev's to say, asked by this
// computer's server with the key (server/plan-account.ts) and shown as it
// came: the plan, its status, its dates, the offers and their prices. The
// page never holds the key. It sees it masked; Copy and the offers' links
// go through the desktop app, which adds the key only in the fragment of
// a bloks.dev link (electron/plan-link.mjs).
//
// Going to bloks.dev arms a look on return (src/lib/planClient.ts): back
// in the window, the plan is asked fresh, every gate follows it, and a
// plan that went up gets its small moment here.
//
// On one of the owner's own devices other than the computer the workspace
// runs on (the app on a server elsewhere, or a browser), the server
// says so (sameComputer) and the page shows the plan and Manage billing,
// and leaves the key, Hosting and the offers to that computer with one
// line saying so (GitHub 357). A look that could not be had keeps the last
// answer and says it is old: a reading that went missing is never shown
// as no plan.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  Cloud,
  Copy,
  Loader2,
  Lock,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  Repeat,
  Server,
  Smartphone,
  Sparkles,
  Trash2,
  TriangleAlert,
  Users,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { TOP_UP_WORDS, meterShare, percentText, topUpsLine } from "@/lib/credits";
import { appPlanOf, currentWorkspace, useWorkspaces } from "@/lib/workspaces";
import {
  hostingWords,
  isHostingOffer,
  keyIsHere,
  ladderFor,
  monthYear,
  planKey,
  planName,
  priceWords,
  renewalWords,
  shortDate,
  statusOf,
  type Offer,
  type PlanSnapshot,
} from "@/lib/plan";
import { clearPlanNews, loadPlan, openOffer, openSite, usePlan } from "@/lib/planClient";
import { HealthLine, SecretField, type Health } from "../ConnectionKit";
import { BloksAiSettings, useBloksAi } from "../CreditsSection";
import { BlockBurst } from "../members/BlockBurst";
import { SettingRow, SettingsEmpty, SettingsGroup } from "../SettingsLayout";
import { goToWorkspace } from "../WorkspaceSwitcher";
import { MoveToHostingCard } from "./MoveToHosting";
import { HostingMove } from "../hosting/HostingMove";
import { formatDate, formatNumber, t, tr, type MessageKey } from "@/lib/i18n";

const CLOUD_KEY = /^blok_live_[0-9a-f]{32}$/;
const easeOut = [0.23, 1, 0.32, 1] as const;
const OPTIONS_ID = "plan-options";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  // the service's own words: a refused card says why better than we can
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

interface RelayPlan {
  plan: string | null;
  spaces: { online: number; limit: number | null } | null;
  licence: boolean;
}

/** How many workspaces are online, in the relay's own words. Asked only
 * where it is answered: the computer the workspace runs on. */
function useRelayPlan(refreshKey: unknown, here: boolean) {
  const [plan, setPlan] = useState<RelayPlan | null>(null);
  useEffect(() => {
    if (!here) return;
    let alive = true;
    call<RelayPlan>("/api/relay/plan")
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
  }, [refreshKey, here]);
  return plan;
}

const reducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/** To the offers, for the one way up from what a plan does not include. */
function toOptions() {
  document.getElementById(OPTIONS_ID)?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
}

/** The glyph a plan wears beside its name. */
function PlanGlyph({ planKeyOf }: { planKeyOf: string }) {
  const Icon =
    planKeyOf === "team" || planKeyOf === "team-hosted" ? Users
    : planKeyOf === "hosted" ? Server
    : planKeyOf === "cloud" ? Cloud
    : planKeyOf === "free" ? Monitor
    : Sparkles;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-12 shrink-0 items-center justify-center rounded-xl",
        planKeyOf === "free" ? "bg-muted text-muted-foreground" : "bg-brand-soft text-brand-ink",
      )}
    >
      <Icon size={22} />
    </span>
  );
}

/** "Try again", said small, beside whatever could not be had. */
function TryAgain({ busy }: { busy: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void loadPlan(true)}
      className="inline-flex items-center gap-1 rounded font-medium text-foreground underline-offset-2 outline-none hover:underline disabled:opacity-60"
    >
      <RefreshCw size={11} className={cn(busy && "animate-spin")} aria-hidden />
      {busy ? t("planPage.trying") : t("common.tryAgain")}
    </button>
  );
}

// ── the moment ─────────────────────────────────────────────────────────

/** A plan that just went up: said once, with the blocks the app spends on
 * good news. Rare by nature, so it may take a moment of delight. */
function PlanMoment({ words, at, here }: { words: string; at: number; here: boolean }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    const timer = setTimeout(clearPlanNews, 7000);
    return () => clearTimeout(timer);
  }, [at]);
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: reduce ? 0.15 : 0.26, ease: easeOut }}
      className="mb-6 flex items-center gap-4 rounded-2xl bg-brand-soft px-5 py-4"
    >
      <span className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-ink text-brand-foreground">
        <Check size={20} strokeWidth={2.5} />
        <BlockBurst key={at} color="var(--brand-ink)" count={16} spread={64} />
      </span>
      <span className="min-w-0">
        <span className="block text-lead font-semibold text-foreground">{words}</span>
        <span className="block text-pretty text-body text-muted-foreground">
          {here ? t("planPage.everythingItIncludesIsOn") : t("planPage.everythingItIncludesIsOnNow")}
        </span>
      </span>
    </motion.div>
  );
}

// ── the plan ───────────────────────────────────────────────────────────

/**
 * The plan's head, the same with a key and without: the glyph, the name
 * as the largest words on the page with its status beside it, one line of
 * facts under it, and one thing to press on the right.
 */
function Headline({
  glyph,
  name,
  pill,
  facts,
  action,
}: {
  glyph: string;
  name: string;
  pill?: React.ReactNode;
  facts?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-4">
      <PlanGlyph planKeyOf={glyph} />
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="text-small font-medium text-muted-foreground">{t("planPage.yourPlan")}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="min-w-0 text-balance text-display font-semibold text-foreground">{name}</h2>
          {pill}
        </div>
        {facts && <div className="mt-1 text-pretty text-body tabular-nums text-muted-foreground">{facts}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 pt-1">{action}</div>}
    </div>
  );
}

/** The facts under a plan's name, in the order they are looked for: what
 * it costs (only when the site said), when it renews, how it is billed,
 * and since when. */
function factsOf(account: NonNullable<PlanSnapshot["account"]>): string[] {
  const price = priceWords(account.price);
  // said whole, not lowered from "Monthly", which not every language can do
  const billed = account.interval === "month" ? t("planPage.billed.month") : account.interval === "year" ? t("planPage.billed.year") : null;
  return [
    price,
    renewalWords(account),
    // a price already says how often
    !price && billed ? billed : null,
    account.since ? t("planPage.memberSince", { date: monthYear(account.since) }) : null,
  ].filter((fact): fact is string => Boolean(fact));
}

/** When bloks.dev could not be asked: the one quiet line, saying how old
 * what is shown is, with the way to look again. */
function staleWords(snapshot: PlanSnapshot): string | null {
  if (snapshot.accountState === "cached" && snapshot.accountAt) {
    const at = formatDate(snapshot.accountAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    // the server's own reason when it gave one, as it came
    return `${snapshot.problem ?? t("planPage.stale.couldntReach")} ${t("planPage.stale.showingFrom", { at })}`;
  }
  if (snapshot.accountState === "unavailable") return t("planPage.stale.missing");
  return null;
}

/** The line about how old what is shown is, or null when it is current:
 * this device could not ask again just now, or the server could not ask
 * bloks.dev. */
function oldWords(snapshot: PlanSnapshot, stale: boolean): string | null {
  return stale ? t("planPage.stale.couldntCheck") : staleWords(snapshot);
}

/** On a device other than the computer the workspace runs on, which keeps
 * the key: said once, where the key's own row is on that computer. */
function Elsewhere() {
  return (
    <footer data-setting-row="bloks-key" className="border-t bg-muted/30 px-6 py-3 text-pretty text-small text-muted-foreground transition-colors duration-700 max-sm:px-5">
      {t("planPage.elsewhere")}
    </footer>
  );
}

/** How old the plan shown is, with the way to look again. */
function OldLine({ words, loading, className }: { words: string; loading: boolean; className?: string }) {
  return (
    <p role="status" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty text-small text-muted-foreground", className)}>
      <span>{words}</span>
      <TryAgain busy={loading} />
    </p>
  );
}

function PlanCard({
  snapshot,
  loading,
  stale,
  here,
  onManage,
  managing,
  manageError,
  ready,
  onReadyOpened,
  onChanged,
}: {
  snapshot: PlanSnapshot;
  loading: boolean;
  /** How old what is shown is, when it is not current. */
  stale: string | null;
  here: boolean;
  onManage: () => void;
  managing: boolean;
  manageError: string | null;
  /** A billing link the browser held back, for the person to press. */
  ready: string | null;
  onReadyOpened: () => void;
  onChanged: () => void;
}) {
  const key = planKey(snapshot, appPlanOf(useWorkspaces()));
  const account = snapshot.account;
  const status = account ? statusOf(account) : null;
  const refused = snapshot.accountState === "refused";
  const pill: { tone: Health; label: string } | null = refused ? { tone: "issue", label: t("planPage.keyNotRecognised") } : status ? { tone: status.tone, label: status.label } : null;
  const facts = account ? factsOf(account) : [];
  return (
    <section aria-label={t("planPage.yourPlan")} className="mb-9 overflow-hidden rounded-2xl border bg-card">
      <div className="p-6 max-sm:p-5">
        <Headline
          glyph={key}
          name={planName(key)}
          pill={pill && <HealthLine tone={pill.tone} label={pill.label} />}
          facts={
            facts.length > 0 &&
            // each fact whole on its line, so a narrow card breaks between them
            facts.map((fact, i) => (
              <Fragment key={fact}>
                <span className="whitespace-nowrap">
                  {fact}
                  {i < facts.length - 1 && " ·"}
                </span>{" "}
              </Fragment>
            ))
          }
          action={
            // a card that needs updating asks below, with the same way in
            !refused &&
            !status?.needsCard && (
              <span data-setting-row="manage-billing" className="rounded-lg transition-colors duration-700">
                <Button size="sm" variant="secondary" disabled={managing} onClick={onManage} className="gap-1.5">
                  {managing ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpRight size={13} />}
                  {t("planPage.manageBilling")}
                </Button>
              </span>
            )
          }
        />
        {status?.needsCard && (
          <div role="status" className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3">
            <TriangleAlert size={16} className="shrink-0 text-warning" />
            <span className="min-w-0 flex-1 basis-[220px] text-pretty text-body text-foreground">{status.line}</span>
            <Button size="sm" variant="brand" disabled={managing} onClick={onManage}>
              {managing ? <Loader2 size={13} className="animate-spin" /> : t("planPage.updateYourCard")}
            </Button>
          </div>
        )}
        {status && !status.needsCard && status.line && <p className="mt-3 text-pretty text-small text-muted-foreground">{status.line}</p>}
        {refused && snapshot.problem && <p className="mt-3 text-pretty text-small text-destructive">{snapshot.problem}</p>}
        {manageError && (
          <p role="alert" className="mt-3 text-pretty text-small text-destructive">
            {manageError}
          </p>
        )}
        {ready && (
          <p role="status" className="mt-3 text-pretty text-small text-muted-foreground">
            {t("planPage.billingReady")}{" "}
            <a href={ready} target="_blank" rel="noopener noreferrer" onClick={onReadyOpened} className="font-medium text-foreground underline underline-offset-2">
              {t("planPage.openBilling")}
            </a>
          </p>
        )}
        {stale && <OldLine words={stale} loading={loading} className="mt-4" />}
      </div>
      {here ? <KeyFooter snapshot={snapshot} onChanged={onChanged} /> : <Elsewhere />}
    </section>
  );
}

/** No key: Bloks runs on this computer with the person's own engines and
 * keys, and a key already bought goes in here. Called Self-hosted rather
 * than Free: it is a way of running Bloks, not a lesser tier of it. */
const SELF_HOSTED_POINTS: MessageKey[] = ["planPage.selfHosted.agents", "planPage.selfHosted.engines", "planPage.selfHosted.local"];

function FreeCard({ onActivated, stale, loading, here }: { onActivated: () => void; stale: string | null; loading: boolean; here: boolean }) {
  const [open, setOpen] = useState(false);
  if (!here) {
    return (
      <section aria-label={t("planPage.yourPlan")} className="mb-9 overflow-hidden rounded-2xl border bg-card">
        <div className="p-6 max-sm:p-5">
          <Headline glyph="free" name={planName("free")} facts={t("planPage.selfHosted.elsewhereFacts")} />
          {stale && <OldLine words={stale} loading={loading} className="mt-4" />}
        </div>
        <Elsewhere />
      </section>
    );
  }
  return (
    <section aria-label={t("planPage.yourPlan")} className="mb-9 overflow-hidden rounded-2xl border bg-card">
      <div className="p-6 max-sm:p-5">
        <Headline glyph="free" name={planName("free")} facts={t("planPage.selfHosted.facts")} />
        <p className="mt-4 max-w-[60ch] text-pretty text-body text-muted-foreground">
          {t("planPage.addAPlanWhenYou")}
        </p>
        <ul className="mt-4 grid gap-2 @xl:grid-cols-3 @xl:gap-4">
          {SELF_HOSTED_POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2 text-pretty text-small text-foreground">
              <Check size={14} strokeWidth={2.25} className="mt-[2px] shrink-0 text-brand-ink" />
              <span className="min-w-0">{t(point)}</span>
            </li>
          ))}
        </ul>
        {stale && <OldLine words={stale} loading={loading} className="mt-4" />}
      </div>
      <footer data-setting-row="bloks-key" className="border-t bg-muted/30 px-6 py-3 transition-colors duration-700 max-sm:px-5">
        <AnimatePresence initial={false} mode="wait">
          {open ? (
            <motion.div
              key="key"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2, ease: easeOut }}
              className="py-2"
            >
              <KeyField action={t("planPage.activate")} hint={t("planPage.itsInYourConfirmationEmail")} onDone={onActivated} onCancel={() => setOpen(false)} autoFocus />
            </motion.div>
          ) : (
            <motion.div key="ask" className="flex flex-wrap items-center justify-between gap-3" exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <span className="text-small text-muted-foreground">{t("planPage.haveABloksKeyFrom")}</span>
              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                {t("planPage.enterYourKey")}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </section>
  );
}

/** A key typed in: activated the way Bloks Cloud always was, which puts
 * this workspace online with it (POST /api/relay/activate). */
function KeyField({
  action,
  hint,
  onDone,
  onCancel,
  autoFocus,
}: {
  action: string;
  hint: string;
  onDone: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ws = currentWorkspace(useWorkspaces());
  const looksRight = CLOUD_KEY.test(key.trim());
  const activate = () => {
    const trimmed = key.trim();
    if (busy || !trimmed) return;
    if (!CLOUD_KEY.test(trimmed)) return setError(t("planPage.notAKey"));
    setBusy(true);
    setError(null);
    call("/api/relay/activate", { method: "POST", body: JSON.stringify({ key: trimmed }) })
      .then(() => {
        setKey("");
        onDone();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (autoFocus) document.getElementById("plan-key")?.focus();
  }, [autoFocus]);
  return (
    <div>
      <div className="flex items-start gap-2">
        <SecretField
          id="plan-key"
          label={t("planPage.bloksKey")}
          value={key}
          onChange={(value) => {
            setKey(value);
            setError(null);
          }}
          shape={CLOUD_KEY}
          hint={`${t("planPage.startsWith")} ${hint}`}
          placeholder="blok_live_..."
          onEnter={activate}
          className="min-w-0 flex-1"
        />
        <Button size="sm" variant="brand" className="mt-[22px] h-8" disabled={busy || !looksRight} onClick={activate}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : action}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="mt-[22px] h-8" disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-pretty text-small text-destructive">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-pretty text-small text-muted-foreground">{ws ? t("planPage.goesOnline", { name: ws.name }) : t("planPage.thisWorkspaceGoesOnlineWith")}</p>
      )}
    </div>
  );
}

// ── the key ────────────────────────────────────────────────────────────

/** The key a plan rides on, at the foot of the plan: masked, with Copy,
 * Replace and Remove in a small menu, since none is pressed often. */
function KeyFooter({ snapshot, onChanged }: { snapshot: PlanSnapshot; onChanged: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  /** Replace was picked: the closing menu hands focus to the field rather
   * than back to its button. */
  const toField = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const ws = currentWorkspace(useWorkspaces());
  const canCopy = Boolean(window.bloks?.licenceCopy) && snapshot.licence.kept;

  const copy = async () => {
    setError(null);
    const ok = await window.bloks?.licenceCopy?.().catch(() => false);
    if (ok) toast.success(t("planPage.keyCopied"), { id: "plan-key" });
    else setError(t("planPage.couldntCopyKey"));
  };

  const remove = async () => {
    const yes = await confirm({
      title: t("planPage.removeKey.title"),
      body: `${ws?.name ? t("planPage.removeKey.body", { name: ws.name }) : t("planPage.removeKey.bodyThis")}\n\n${t("planPage.removeKey.notCancelled")}`,
      confirmLabel: t("planPage.removeKey.confirm"),
      destructive: true,
    });
    if (!yes) return;
    setRemoving(true);
    setError(null);
    try {
      await call("/api/plan/licence", { method: "DELETE" });
      toast(t("planPage.removeKey.done"), { id: "plan-key" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <footer data-setting-row="bloks-key" className="border-t bg-muted/30 px-6 py-3 transition-colors duration-700 max-sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-small font-medium text-muted-foreground">{t("planPage.bloksKey")}</span>
        <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-small text-foreground">{snapshot.licence.masked ?? "blok_live_••••"}</code>
        <span className="min-w-0 flex-1 basis-[200px] truncate text-small text-muted-foreground">
          {snapshot.account?.email ? t("planPage.emailOneKey", { email: snapshot.account.email }) : t("planPage.oneKeyForEveryWorkspace")}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t("planPage.keyOptions")} title={t("planPage.keyOptions")} disabled={removing}>
              {removing ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={16} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="whitespace-nowrap"
            onCloseAutoFocus={(e) => {
              if (!toField.current) return;
              toField.current = false;
              e.preventDefault();
              requestAnimationFrame(() => document.getElementById("plan-key")?.focus());
            }}
          >
            {canCopy && (
              <DropdownMenuItem onSelect={() => void copy()}>
                <Copy />
                {t("planPage.copyKey")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                toField.current = true;
                setReplacing(true);
              }}
            >
              <Repeat />
              {t("planPage.replaceKey")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              <Trash2 />
              {t("planPage.removeFromThisComputer")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-pretty text-small text-destructive">
          {error}
        </p>
      )}
      <AnimatePresence initial={false}>
        {replacing && (
          <motion.div
            key="replace"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2, ease: easeOut }}
            className="pb-2 pt-3"
          >
            <KeyField
              action={t("planPage.useThisKey")}
              hint={t("planPage.theComputerItWasOn")}
              autoFocus
              onCancel={() => setReplacing(false)}
              onDone={() => {
                setReplacing(false);
                toast.success(t("planPage.keyReplaced"), { id: "plan-key" });
                onChanged();
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </footer>
  );
}

// ── what the plan includes ─────────────────────────────────────────────

/** Whether Bloks AI is part of what this person has: the service reads a
 * balance for them, or the account says it is on. A licence without it
 * gets the offer below instead of an empty meter. */
function bloksAiShown(ai: ReturnType<typeof useBloksAi>, account: PlanSnapshot["account"]): boolean {
  const status = ai.status;
  if (!status?.offered) return false;
  if (status.connected || status.fromEnvironment) return true;
  if (account) return Boolean(account.bloksAi?.active) || status.needsKey;
  return true;
}

/** A thin bar for how much of something is in use. Full, or nearly out,
 * is said in the warning colour; nothing else is. */
function Meter({ share, label, value, max, warn }: { share: number; label: string; value: number; max: number; warn?: boolean }) {
  const s = Math.max(0, Math.min(1, share));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full origin-left", warn || s >= 1 ? "bg-warning" : "bg-brand-ink")} style={{ transform: `scaleX(${s})` }} />
    </div>
  );
}

/**
 * One thing the plan includes: its name, how much is in use as the
 * number to read, a meter where there is a limit, and one short line.
 * Something the plan does not include is the same tile, quiet, with no
 * meter and no lock: the one way up is above the tiles, not on each.
 */
function Tile({
  label,
  value,
  meter,
  line,
  quiet,
  rowId,
}: {
  label: string;
  value: React.ReactNode;
  meter?: React.ReactNode;
  line?: React.ReactNode;
  quiet?: boolean;
  rowId: string;
}) {
  return (
    <div data-setting-row={rowId} className="flex min-w-0 flex-col px-5 py-4 transition-colors duration-700">
      <dt className="text-small font-medium text-muted-foreground">{label}</dt>
      <dd className="contents">
        {/* quiet words sit in the same line box as a number, smaller */}
        <span className={cn("mt-1 block truncate leading-6 tabular-nums", quiet ? "text-ui font-medium text-muted-foreground" : "text-title font-semibold text-foreground")}>
          {value}
        </span>
        {/* the bar's row is kept even without one, so tiles side by side
            keep their lines on one level */}
        <span className={cn("mt-2.5 block h-1.5", !meter && "hidden @xl:block")}>{meter}</span>
        {line && <span className="mt-2 block text-pretty text-small text-muted-foreground">{line}</span>}
      </dd>
    </div>
  );
}

/** "2 of 3": the count to read, its limit quieter. The whole phrase is
 * one sentence, quiet, with the count drawn large inside it. */
function OfCount({ n, of, online }: { n: number; of?: number; online?: boolean }) {
  if (of === undefined && !online) return <>{formatNumber(n)}</>;
  const count = <span className="text-title font-semibold text-foreground">{formatNumber(n)}</span>;
  return (
    <span className="text-body font-normal text-muted-foreground">
      {of !== undefined ? tr("planPage.countOf", { count, limit: of }) : tr("planPage.countOnline", { count })}
    </span>
  );
}

function WhatYouHave({ snapshot, relay, ai, here }: { snapshot: PlanSnapshot; relay: RelayPlan | null; ai: ReturnType<typeof useBloksAi>; here: boolean }) {
  const { dispatch } = useStore();
  const go = (page: string) => dispatch({ type: "toggleAppSettings", open: true, page });
  const key = planKey(snapshot, appPlanOf(useWorkspaces()));
  const account = snapshot.account;
  const team = snapshot.ownerPlan === "team" || account?.plan === "team";
  const spaces = relay?.spaces ?? null;
  const members = snapshot.members;
  const aiShown = bloksAiShown(ai, account);
  const ladder = ladderFor(key, snapshot.offers, account);
  // offers not had yet keep the tile's place, so nothing jumps when they land
  const aiOffered = snapshot.offers ? ladder.some((o) => o.id === "ai" || o.id === "bloks-ai") : true;
  const link = "rounded font-medium text-brand-ink underline-offset-2 outline-none hover:underline";

  const tiles: React.ReactNode[] = [];

  // workspaces online, as the relay counts them. Asked on the computer the
  // workspace runs on alone (GET /api/relay/plan), so elsewhere the tile
  // is left out rather than said to be none.
  const spacesTile = (): React.ReactNode => {
    if (!spaces) {
      return (
        <Tile
          key="spaces"
          rowId="workspaces-online"
          label={t("planPage.workspacesOnline")}
          quiet
          value={t("planPage.tile.noneYet")}
          line={
            <button type="button" className={cn(link, "inline-flex items-center gap-0.5")} onClick={() => go("workspace:online")}>
              {t("planPage.putThisOneOnline")}
              <ArrowRight size={12} aria-hidden />
            </button>
          }
        />
      );
    }
    if (spaces.limit === null) {
      return <Tile key="spaces" rowId="workspaces-online" label={t("planPage.workspacesOnline")} value={<OfCount n={spaces.online} online />} line={t("planPage.tile.noLimit")} />;
    }
    const left = Math.max(0, spaces.limit - spaces.online);
    return (
      <Tile
        key="spaces"
        rowId="workspaces-online"
        label={t("planPage.workspacesOnline")}
        value={<OfCount n={spaces.online} of={spaces.limit} />}
        meter={<Meter label={t("planPage.workspacesOnline")} share={spaces.online / Math.max(1, spaces.limit)} value={spaces.online} max={spaces.limit} />}
        line={left > 0 ? t("planPage.tile.moreCanGoOnline", { count: left }) : t("planPage.tile.allInUse")}
      />
    );
  };
  if (here) tiles.push(spacesTile());

  // members, on Bloks Team
  if (team) {
    tiles.push(
      <Tile
        key="members"
        rowId="members"
        label={t("common.members")}
        value={<OfCount n={members.count} of={members.limit > 0 ? members.limit : undefined} />}
        meter={members.limit > 0 && <Meter label={t("common.members")} share={members.count / members.limit} value={members.count} max={members.limit} />}
        line={t("planPage.tile.besidesYou")}
      />,
    );
  } else {
    tiles.push(<Tile key="members" rowId="members" label={t("common.members")} quiet value={t("planPage.tile.notIncluded")} line={t("planPage.tile.withTeam")} />);
  }

  // Bloks AI: the allowance as a meter of what is used, and when it resets
  const status = ai.status;
  if (aiShown && status) {
    const reading = status.connected && status.leftPercent !== null;
    const used = 100 - meterShare(status);
    const resets = status.renewsAt ?? account?.bloksAi?.renewsAt ?? null;
    const extra = topUpsLine(status.topUps);
    const empty = reading && meterShare(status) <= 0;
    tiles.push(
      <Tile
        key="ai"
        rowId="bloks-ai"
        label="Bloks AI"
        quiet={!reading}
        value={
          status.needsKey ? (
            t("planPage.tile.notConnected")
          ) : !reading ? (
            t("planPage.tile.cantRead")
          ) : empty ? (
            t("planPage.tile.usedUp")
          ) : (
            <span className="text-body font-normal text-muted-foreground">
              {tr("planPage.percentUsed", { percent: <span className="text-title font-semibold text-foreground">{percentText(used)}</span> })}
            </span>
          )
        }
        meter={reading && <Meter label={t("planPage.bloksAiUsedThisMonth")} share={used / 100} value={Math.round(used)} max={100} warn={empty || status.low} />}
        line={
          status.refused ? (
            <span className="text-warning">{status.refused.message}</span>
          ) : status.needsKey ? (
            here ? t("planPage.tile.connectBelow") : t("planPage.tile.connectThere")
          ) : (
            <>
              {[status.low && !empty ? t("planPage.tile.runningLow") : null, resets ? t("planPage.tile.resets", { date: shortDate(resets) }) : null, extra]
                .filter(Boolean)
                .map((part) => `${part} · `)
                .join("")}
              {/* the site's own page, so the key rides along in the
                  fragment and nobody types it again there; elsewhere the
                  key is not this device's to add */}
              <button type="button" title={TOP_UP_WORDS} className={link} onClick={() => void (here ? openOffer(status.checkoutUrl) : openSite(status.checkoutUrl))}>
                {t("planPage.topUp")}
              </button>
            </>
          )
        }
      />,
    );
  } else if (account?.bloksAi?.active) {
    tiles.push(
      <Tile
        key="ai"
        rowId="bloks-ai"
        label="Bloks AI"
        value={t("planPage.included")}
        line={account.bloksAi.renewsAt ? t("planPage.tile.resets", { date: shortDate(account.bloksAi.renewsAt) }) : t("planPage.tile.noSignIn")}
      />,
    );
  } else if (aiOffered) {
    tiles.push(<Tile key="ai" rowId="bloks-ai" label="Bloks AI" quiet value={t("planPage.tile.notIncluded")} line={t("planPage.tile.addOn")} />);
  }

  const locked = !team || (!aiShown && !account?.bloksAi?.active && aiOffered);
  const cols = tiles.length >= 3 ? "@xl:grid-cols-3" : tiles.length === 2 ? "@xl:grid-cols-2" : "";
  return (
    <SettingsGroup
      title={t("planPage.whatYouHave")}
      action={
        // the offers are on the computer this workspace runs on
        here &&
        locked &&
        ladder.some((o) => o.onSale && o.cta) && (
          <button type="button" className={cn(link, "inline-flex items-center gap-0.5 text-small")} onClick={toOptions}>
            {t("planPage.upgrade")}
            <ArrowDown size={12} aria-hidden />
          </button>
        )
      }
    >
      <dl className={cn("grid divide-y @xl:divide-x @xl:divide-y-0", cols)}>{tiles}</dl>
      {account?.sharedRoom === true && account.plan === "cloud" && (
        <SettingRow label={t("planPage.sharedRoom")} description={t("planPage.oneRoomSharedWithGuests")} control={<HealthLine tone="on" label={t("planPage.included")} />} />
      )}
    </SettingsGroup>
  );
}

/** Hosting, once the licence has it, in the place the way to it held:
 * the machine's row, and room under it for what follows the row (moving
 * the agents onto the machine), handed in as `below`. */
function HostingGroup({ hosting, state, below }: { hosting: NonNullable<ReturnType<typeof hostingWords>>; state: string | null; below?: React.ReactNode }) {
  return (
    <section aria-label={t("planPage.hosting")} className="mb-9 last:mb-0">
      <SettingsGroup title={t("planPage.hosting")} className={below ? "mb-3" : "mb-0"}>
        <HostingRow hosting={hosting} state={state} />
      </SettingsGroup>
      {below}
    </section>
  );
}

// ── the way into a hosted workspace ────────────────────────────────────

/** How long a sleeping hosted workspace may take to wake before asking
 * again stops: most wakes are seconds, one that has to rebuild about two
 * minutes. */
const WAKE_PATIENCE_MS = 3 * 60_000;

/**
 * A pairing link to the hosted workspace, asked of bloks.dev by this
 * computer's server with the key and sealed for it alone
 * (server/plan-account.ts). A workspace that is waking up is asked again
 * every few seconds, with `onWaking` told so the row can say what is
 * happening, rather than failing on the first try.
 */
async function hostedLink(onWaking: () => void): Promise<{ link: string; expiresAt: number }> {
  const until = Date.now() + WAKE_PATIENCE_MS;
  for (;;) {
    const res = await fetch("/api/plan/hosting/link", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await res.json().catch(() => ({}));
    if (res.ok && typeof body.link === "string") return { link: body.link, expiresAt: Number(body.expiresAt) || Date.now() + 15 * 60_000 };
    if (body.waking === true && Date.now() < until) {
      onWaking();
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
}

/** Minutes and seconds left, as the pairing screens count them. */
function countdown(until: number, now: number): string {
  const left = Math.max(0, Math.round((until - now) / 1000));
  return `${formatNumber(Math.floor(left / 60))}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * Hosting's row: the tier, the machine's state, and once it is running,
 * the way in. "Open" pairs this computer with the hosted workspace as one
 * of your own devices and lists it beside your other workspaces; "Pair
 * your iPhone" shows the same pairing link and code the app uses
 * everywhere else, for the phone to scan. Nothing here needs a terminal
 * on the machine, which nobody has.
 */
function HostingRow({ hosting, state }: { hosting: NonNullable<ReturnType<typeof hostingWords>>; state: string | null }) {
  const workspaces = useWorkspaces();
  const listed = workspaces.available ? workspaces.workspaces.find((w) => w.kind === "hosted") : undefined;
  const canList = Boolean(window.bloks?.workspaceHosted);
  const running = state === "active" || state === "grace";
  const [busy, setBusy] = useState<"open" | "phone" | null>(null);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState<{ link: string; qr: string | null; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!phone) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phone]);
  useEffect(() => {
    if (phone && now >= phone.expiresAt) setPhone(null);
  }, [phone, now]);

  const work = async (what: "open" | "phone", job: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setWaking(false);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setWaking(false);
    }
  };

  const pairHere = () =>
    work("open", async () => {
      const { link } = await hostedLink(() => setWaking(true));
      const said = await window.bloks?.workspaceHosted?.({ link, open: true });
      if (said?.error) throw new Error(said.error);
    });

  const pairPhone = () =>
    work("phone", async () => {
      const { link, expiresAt } = await hostedLink(() => setWaking(true));
      // the QR always sits on white; a themed QR is an unscannable QR
      const qr = await QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 168, color: { dark: "#111111", light: "#ffffff" } }).catch(
        () => null,
      );
      setNow(Date.now());
      setPhone({ link, qr, expiresAt });
    });

  const copy = async () => {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t("planPage.couldntCopyLink"));
    }
  };

  return (
    <SettingRow label={hosting.name} description={hosting.line} control={<HealthLine tone={hosting.tone} label={hosting.label} />}>
      {running && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {listed ? (
              <Button size="sm" className="gap-1.5" onClick={() => void goToWorkspace(listed.id)}>
                <Server size={14} />
                {t("planPage.openYourHostedWorkspace")}
              </Button>
            ) : (
              canList && (
                <Button size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void pairHere()}>
                  {busy === "open" ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
                  {t("planPage.openYourHostedWorkspace")}
                </Button>
              )
            )}
            <Button size="sm" variant="secondary" className="gap-1.5" disabled={busy !== null} onClick={() => void pairPhone()}>
              {busy === "phone" ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
              {t("planPage.pairYourIphone")}
            </Button>
            {/* a pairing revoked on the machine, or a new Mac: pair this
                one again in place, keeping the workspace's place here */}
            {listed && canList && (
              <button
                type="button"
                className="text-small text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground disabled:opacity-50"
                disabled={busy !== null}
                onClick={() => void pairHere()}
              >
                {t("planPage.pairThisComputerAgain")}
              </button>
            )}
          </div>
          {waking && busy && (
            <p role="status" className="text-pretty text-small text-muted-foreground">
              {t("planPage.yourHostedWorkspaceIsWaking")}
            </p>
          )}
          {error && (
            <p role="alert" className="text-pretty text-small text-destructive">
              {error}
            </p>
          )}
          {phone && (
            <div className="flex flex-wrap items-start gap-4 rounded-xl bg-muted/60 p-3">
              <div className="shrink-0 rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5" aria-label={t("planPage.pairingQrCode")}>
                {phone.qr ? (
                  <img src={phone.qr} alt={t("planPage.scanWithTheBloksApp")} className="size-[152px]" />
                ) : (
                  <div className="flex size-[152px] items-center justify-center text-caption text-neutral-500">{t("planPage.qrUnavailable")}</div>
                )}
              </div>
              <div className="min-w-[180px] flex-1 text-small leading-relaxed text-muted-foreground">
                <p className="text-pretty text-foreground">{t("planPage.scanThisWithYourIphones")}</p>
                <p className="mt-1 text-pretty">{t("planPage.anyoneWhoOpensItIn")}</p>
                <p className="mt-1 tabular-nums">{t("planPage.worksOnceExpiresIn", { left: countdown(phone.expiresAt, now) })}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => void copy()}>
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? t("common.copied") : t("planPage.copyTheLink")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPhone(null)}>
                    {t("common.done")}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingRow>
  );
}


// ── where it can go next ───────────────────────────────────────────────

/** An offer on sale: what it is, what it adds in a line, its price as
 * the site wrote it, and one way to it. `wide` lays it along a row, for
 * the one card left over in a row of two. */
function OfferCard({ offer, lead, wide }: { offer: Offer; lead: boolean; wide: boolean }) {
  const price = priceWords(offer.price);
  const yearly = offer.price?.yearly ? priceWords(offer.price.yearly) : null;
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-5",
        lead && "border-brand-ink/40",
        wide && "@xl:col-span-2 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn("flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5", wide && "@xl:justify-start")}>
          <h3 className="text-lead font-semibold text-foreground">{offer.name}</h3>
          {price && <span className="text-body font-medium tabular-nums text-foreground">{price}</span>}
        </div>
        {offer.tagline && <p className="mt-1 text-pretty text-body text-muted-foreground">{offer.tagline}</p>}
        {(yearly || offer.price?.note) && (
          <p className="mt-1.5 text-pretty text-small tabular-nums text-muted-foreground">
            {yearly ? t("planPage.orYearly", { price: yearly }) : offer.price?.note}
            {yearly && offer.price?.yearly?.note && <span className="ml-1.5 font-medium text-success">{offer.price.yearly.note}</span>}
          </p>
        )}
      </div>
      {offer.cta && (
        <div className={cn("mt-auto", wide && "@xl:mt-0")}>
          <Button size="sm" variant={lead ? "brand" : "secondary"} className="gap-1.5" onClick={() => void openOffer(offer.cta!.url)}>
            {offer.cta.label}
            <ArrowUpRight size={13} />
          </Button>
        </div>
      )}
    </article>
  );
}

/** Something the site shows but does not sell yet: one quiet card across
 * the row, its name, a line, and the badge. Nothing to press, so nothing
 * that looks like it could be pressed. */
function SoonCard({ offer }: { offer: Offer }) {
  return (
    <article className="min-w-0 rounded-2xl border bg-muted/30 px-5 py-4 @xl:col-span-2">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-ui font-semibold text-foreground">{offer.name}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-small font-medium text-muted-foreground">{t("planPage.comingSoon")}</span>
      </div>
      {offer.tagline && <p className="mt-0.5 text-pretty text-body text-muted-foreground">{offer.tagline}</p>}
    </article>
  );
}

function OfferSkeleton() {
  return (
    <div className="flex flex-col rounded-2xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-28 rounded-full" />
        <Skeleton className="h-3 w-16 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-2.5 w-4/5 rounded-full" />
      <Skeleton className="mt-6 h-7 w-28 rounded-md" />
    </div>
  );
}

function YourOptions({ snapshot, loading, retryShown, hostingCard }: { snapshot: PlanSnapshot; loading: boolean; retryShown: boolean; hostingCard: boolean }) {
  const key = planKey(snapshot, appPlanOf(useWorkspaces()));
  // the way to Hosting has its own card above, so it is not offered twice
  const ladder = ladderFor(key, snapshot.offers, snapshot.account).filter((o) => !hostingCard || !isHostingOffer(o));
  const title = key === "free" ? t("planPage.options.whenYouWantMore") : t("planPage.options.yourOptions");
  const onSale = ladder.filter((o) => o.onSale);
  const soon = ladder.filter((o) => !o.onSale);
  const lead = onSale.find((o) => o.cta)?.id;
  const heading = (
    <div className="mb-2.5 flex min-h-[24px] items-center justify-between gap-3 px-1">
      <h2 className="text-body font-medium text-muted-foreground">{title}</h2>
      {snapshot.offersState === "cached" && !retryShown && snapshot.offersAt && (
        <span className="text-small text-muted-foreground">{t("planPage.options.asOf", { date: shortDate(snapshot.offersAt) })}</span>
      )}
    </div>
  );

  if (!snapshot.offers) {
    return (
      <section id={OPTIONS_ID} aria-label={title} aria-busy={loading || undefined} className="mb-9 scroll-mt-6 last:mb-0">
        {heading}
        {loading ? (
          <div className="grid gap-3 @xl:grid-cols-2">
            <OfferSkeleton />
            <OfferSkeleton />
          </div>
        ) : (
          // the site could not be asked and nothing was kept: one quiet way there
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border bg-card px-5 py-4">
            <p className="min-w-0 flex-1 basis-[240px] text-pretty text-body text-muted-foreground">
              {t("planPage.options.unreachable")}
              {!retryShown && (
                <>
                  {" "}
                  <span className="text-small">
                    <TryAgain busy={loading} />
                  </span>
                </>
              )}
            </p>
            <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => openSite(`${snapshot.site}/pricing`)}>
              {t("planPage.seePlans")}
              <ArrowUpRight size={13} />
            </Button>
          </div>
        )}
      </section>
    );
  }
  if (!ladder.length) return null;
  return (
    <section id={OPTIONS_ID} aria-label={title} className="mb-9 scroll-mt-6 last:mb-0">
      {heading}
      <div className="grid gap-3 @xl:grid-cols-2">
        {onSale.map((offer, i) => (
          <OfferCard key={offer.id} offer={offer} lead={offer.id === lead} wide={onSale.length % 2 === 1 && i === onSale.length - 1} />
        ))}
        {soon.map((offer) => (
          <SoonCard key={offer.id} offer={offer} />
        ))}
      </div>
      {onSale.some((o) => o.cta) && (
        <p className="mt-2.5 px-1 text-pretty text-small text-muted-foreground">
          {snapshot.licence.present && window.bloks ? t("planPage.options.eachOpensWithKey") : t("planPage.options.eachOpens")}
        </p>
      )}
    </section>
  );
}

// ── the page ───────────────────────────────────────────────────────────

/** The page's shape while the first answer comes: the plan, what it
 * includes, and two offers, where each will land. */
function PlanSkeleton() {
  return (
    <div aria-busy="true" aria-label={t("planPage.loadingYourPlan")} className="@container">
      <div className="mb-9 overflow-hidden rounded-2xl border bg-card">
        <div className="flex items-start gap-4 p-6 max-sm:p-5">
          <Skeleton className="size-12 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className="mt-1 h-2.5 w-16 rounded-full" />
            <Skeleton className="mt-3 h-6 w-44 rounded-full" />
            <Skeleton className="mt-3 h-2.5 w-full max-w-[340px] rounded-full" />
          </div>
          <Skeleton className="h-7 w-28 rounded-md max-sm:hidden" />
        </div>
        <div className="flex items-center gap-3 border-t bg-muted/30 px-6 py-3.5 max-sm:px-5">
          <Skeleton className="h-2.5 w-14 rounded-full" />
          <Skeleton className="h-3.5 w-32 rounded-md" />
        </div>
      </div>
      <Skeleton className="mb-3.5 ml-1 h-3 w-24 rounded-full" />
      <div className="mb-9 grid divide-y overflow-hidden rounded-2xl border bg-card @xl:grid-cols-3 @xl:divide-x @xl:divide-y-0">
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-5 py-4">
            <Skeleton className="h-2.5 w-24 rounded-full" />
            <Skeleton className="mt-3 h-4 w-14 rounded-full" />
            <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
            <Skeleton className="mt-3 h-2 w-32 rounded-full" />
          </div>
        ))}
      </div>
      <Skeleton className="mb-3.5 ml-1 h-3 w-24 rounded-full" />
      <div className="grid gap-3 @xl:grid-cols-2">
        <OfferSkeleton />
        <OfferSkeleton />
      </div>
    </div>
  );
}

export function PlanPage() {
  const { snapshot, problem, stale, news, loading } = usePlan();
  const appPlan = appPlanOf(useWorkspaces());
  const ai = useBloksAi();
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  // before the first answer, as before: only an answer says elsewhere
  const here = snapshot ? keyIsHere(snapshot) : true;
  const relay = useRelayPlan(snapshot?.accountAt ?? snapshot?.ownerPlan ?? null, here);

  useEffect(() => {
    void loadPlan();
  }, []);

  const changed = useCallback(() => {
    void loadPlan(true);
    ai.load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A portal link lasts minutes, so it is asked for only now, and opened
  // straight away on this device, whichever computer asked bloks.dev for
  // it. Link (which took some payments) has its own sign-in, and the
  // person is told that before they land there. A browser may hold back a
  // window opened once the link is back, so then the link waits here to
  // be pressed.
  const manage = async () => {
    setManaging(true);
    setManageError(null);
    setReady(null);
    try {
      const said = await call<{ url: string; manageAt: "portal" | "link" }>("/api/plan/manage", { method: "POST" });
      if (said.manageAt === "link") {
        const go = await confirm({
          title: t("planPage.link.title"),
          body: t("planPage.link.body"),
          confirmLabel: t("planPage.link.open"),
        });
        if (!go) return;
      }
      if (!openSite(said.url)) setReady(said.url);
    } catch (e) {
      setManageError(e instanceof Error ? e.message : String(e));
    } finally {
      setManaging(false);
    }
  };

  if (!snapshot) {
    if (problem?.kind === "cloud-off") {
      // nothing to try again: a plan is bloks.dev's, and nothing goes there
      return (
        <SettingsGroup>
          <SettingsEmpty icon={<Lock size={18} />} title={t("planPage.cloudOff.title")} body={problem.words} />
        </SettingsGroup>
      );
    }
    if (problem) {
      // could not look is not the same as no plan, and is not said as one
      return (
        <SettingsGroup>
          <SettingsEmpty
            icon={problem.kind === "refused" ? <Lock size={18} /> : <TriangleAlert size={18} />}
            title={problem.kind === "refused" ? t("planPage.yourPlanIsntShownHere") : t("planPage.couldntLoadYourPlan")}
            body={problem.kind === "refused" ? t("planPage.problem.refused") : t("planPage.problem.unreachable")}
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadPlan(true)}>
                {t("common.tryAgain")}
              </Button>
            }
          />
        </SettingsGroup>
      );
    }
    return <PlanSkeleton />;
  }

  const free = !snapshot.licence.present;
  const old = oldWords(snapshot, stale);
  // one Try again on the page: the plan's, when it is already saying so
  const retryShown = old !== null;
  const hosting = hostingWords(snapshot.account?.hosting ?? null);
  // the way to Hosting, for a licence known to have none (an account that
  // could not be read at all might have it)
  const hostingCard = free || (snapshot.account !== null && !hosting);
  return (
    <div className="@container">
      <AnimatePresence>{news?.up && <PlanMoment key={news.at} words={news.words} at={news.at} here={here} />}</AnimatePresence>
      {free ? (
        <FreeCard onActivated={changed} stale={old} loading={loading} here={here} />
      ) : (
        <PlanCard
          snapshot={snapshot}
          loading={loading}
          stale={old}
          here={here}
          onManage={() => void manage()}
          managing={managing}
          manageError={manageError}
          ready={ready}
          onReadyOpened={() => setReady(null)}
          onChanged={changed}
        />
      )}
      {!free && <WhatYouHave snapshot={snapshot} relay={relay} ai={ai} here={here} />}
      {/* Hosting and the offers are the key's, and stay on its computer */}
      {here &&
        (hostingCard ? (
          <MoveToHostingCard snapshot={snapshot} appPlan={appPlan} />
        ) : (
          hosting && <HostingGroup hosting={hosting} state={snapshot.account?.hosting?.state ?? null} below={<HostingMove />} />
        ))}
      {!free && bloksAiShown(ai, snapshot.account) && <BloksAiSettings ai={ai} keyHere={here} />}
      {here && <YourOptions snapshot={snapshot} loading={loading} retryShown={retryShown} hostingCard={hostingCard} />}
    </div>
  );
}
