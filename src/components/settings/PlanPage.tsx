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
  intervalWords,
  isHostingOffer,
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

/** How many workspaces are online, in the relay's own words. */
function useRelayPlan(refreshKey: unknown) {
  const [plan, setPlan] = useState<RelayPlan | null>(null);
  useEffect(() => {
    let alive = true;
    call<RelayPlan>("/api/relay/plan")
      .then((p) => alive && setPlan(p))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
  }, [refreshKey]);
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
      {busy ? "Trying" : "Try again"}
    </button>
  );
}

// ── the moment ─────────────────────────────────────────────────────────

/** A plan that just went up: said once, with the blocks the app spends on
 * good news. Rare by nature, so it may take a moment of delight. */
function PlanMoment({ words, at }: { words: string; at: number }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    const t = setTimeout(clearPlanNews, 7000);
    return () => clearTimeout(t);
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
        <span className="block text-pretty text-body text-muted-foreground">Everything it includes is on now, in every workspace on this computer.</span>
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
        <div className="text-small font-medium text-muted-foreground">Your plan</div>
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
  const interval = intervalWords(account.interval);
  return [
    price,
    renewalWords(account),
    // a price already says how often
    !price && interval ? `Billed ${interval.toLowerCase()}` : null,
    account.since ? `Member since ${monthYear(account.since)}` : null,
  ].filter((fact): fact is string => Boolean(fact));
}

/** When bloks.dev could not be asked: the one quiet line, saying how old
 * what is shown is, with the way to look again. */
function staleWords(snapshot: PlanSnapshot): string | null {
  if (snapshot.accountState === "cached" && snapshot.accountAt) {
    const at = new Date(snapshot.accountAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `${snapshot.problem ?? "Couldn't reach bloks.dev just now."} Showing details from ${at}.`;
  }
  if (snapshot.accountState === "unavailable") return "Couldn't reach bloks.dev, so the details are missing for now.";
  return null;
}

function PlanCard({
  snapshot,
  loading,
  onManage,
  managing,
  manageError,
  onChanged,
}: {
  snapshot: PlanSnapshot;
  loading: boolean;
  onManage: () => void;
  managing: boolean;
  manageError: string | null;
  onChanged: () => void;
}) {
  const appPlan = appPlanOf(useWorkspaces());
  const key = planKey(snapshot, snapshot.capabilities?.licence === false ? undefined : appPlan);
  const account = snapshot.account;
  const status = account ? statusOf(account) : null;
  const stale = staleWords(snapshot);
  const refused = snapshot.accountState === "refused";
  const pill: { tone: Health; label: string } | null = refused ? { tone: "issue", label: "Key not recognised" } : status ? { tone: status.tone, label: status.label } : null;
  const facts = account ? factsOf(account) : [];
  return (
    <section aria-label="Your plan" className="mb-9 overflow-hidden rounded-2xl border bg-card">
      <div className="p-6 max-sm:p-5">
        <Headline
          glyph={key}
          name={account ? planName(key) : "Subscription details unavailable"}
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
                  Manage billing
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
              {managing ? <Loader2 size={13} className="animate-spin" /> : "Update your card"}
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
        {stale && (
          <p role="status" className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-pretty text-small text-muted-foreground">
            <span>{stale}</span>
            <TryAgain busy={loading} />
          </p>
        )}
      </div>
      {snapshot.capabilities?.licence !== false && <KeyFooter snapshot={snapshot} onChanged={onChanged} />}
    </section>
  );
}

/** No key: Bloks runs on this computer with the person's own engines and
 * keys, and a key already bought goes in here. Called Self-hosted rather
 * than Free: it is a way of running Bloks, not a lesser tier of it. */
const SELF_HOSTED_POINTS = [
  "All your agents, rooms and automations",
  "On the engines and API keys you already have",
  "Everything stays on this computer",
];

function FreeCard({ onActivated }: { onActivated: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Your plan" className="mb-9 overflow-hidden rounded-2xl border bg-card">
      <div className="p-6 max-sm:p-5">
        <Headline glyph="free" name="Self-hosted" facts="Bloks runs right here, on your own engines and keys." />
        <p className="mt-4 max-w-[60ch] text-pretty text-body text-muted-foreground">
          Add a plan when you want your workspaces online, people in them, or Bloks AI.
        </p>
        <ul className="mt-4 grid gap-2 @xl:grid-cols-3 @xl:gap-4">
          {SELF_HOSTED_POINTS.map((point) => (
            <li key={point} className="flex items-start gap-2 text-pretty text-small text-foreground">
              <Check size={14} strokeWidth={2.25} className="mt-[2px] shrink-0 text-brand-ink" />
              <span className="min-w-0">{point}</span>
            </li>
          ))}
        </ul>
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
              <KeyField action="Activate" hint="It's in your confirmation email." onDone={onActivated} onCancel={() => setOpen(false)} autoFocus />
            </motion.div>
          ) : (
            <motion.div key="ask" className="flex flex-wrap items-center justify-between gap-3" exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              <span className="text-small text-muted-foreground">Have a Bloks key from bloks.dev?</span>
              <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
                Enter your key
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
    if (!CLOUD_KEY.test(trimmed)) return setError("That's not a Bloks key. They start with blok_live_.");
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
          label="Bloks key"
          value={key}
          onChange={(value) => {
            setKey(value);
            setError(null);
          }}
          shape={CLOUD_KEY}
          hint={`Starts with blok_live_. ${hint}`}
          placeholder="blok_live_..."
          onEnter={activate}
          className="min-w-0 flex-1"
        />
        <Button size="sm" variant="brand" className="mt-[22px] h-8" disabled={busy || !looksRight} onClick={activate}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : action}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" className="mt-[22px] h-8" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-pretty text-small text-destructive">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-pretty text-small text-muted-foreground">{ws ? `${ws.name} goes online with it.` : "This workspace goes online with it."}</p>
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
    if (ok) toast.success("Key copied. Keep it to yourself: it is what bloks.dev knows you by.", { id: "plan-key" });
    else setError("Couldn't copy the key just now.");
  };

  const remove = async () => {
    const yes = await confirm({
      title: "Remove your key from this computer?",
      body:
        `Bloks forgets the key here, and ${ws?.name ?? "this workspace"} goes offline. Other workspaces that are online stay online until you turn them off.` +
        "\n\nYour membership is not cancelled. To cancel, use Manage billing. To use the key again, enter it here.",
      confirmLabel: "Remove key",
      destructive: true,
    });
    if (!yes) return;
    setRemoving(true);
    setError(null);
    try {
      await call("/api/plan/licence", { method: "DELETE" });
      toast("Your key is removed from this computer", { id: "plan-key" });
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
        <span className="text-small font-medium text-muted-foreground">Bloks key</span>
        <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-small text-foreground">{snapshot.licence.masked ?? "blok_live_••••"}</code>
        <span className="min-w-0 flex-1 basis-[200px] truncate text-small text-muted-foreground">
          {snapshot.account?.email ? `${snapshot.account.email} · one key for every workspace here` : "One key for every workspace here"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label="Key options" title="Key options" disabled={removing}>
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
                Copy key
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                toField.current = true;
                setReplacing(true);
              }}
            >
              <Repeat />
              Replace key
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
              <Trash2 />
              Remove from this computer
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
              action="Use this key"
              hint="The computer it was on stops reaching your phone."
              autoFocus
              onCancel={() => setReplacing(false)}
              onDone={() => {
                setReplacing(false);
                toast.success("Key replaced", { id: "plan-key" });
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

/** "2 of 3": the count to read, its limit quieter. */
function OfCount({ n, of, unit }: { n: number; of?: number; unit?: string }) {
  return (
    <>
      {n}
      {(of !== undefined || unit) && <span className="text-body font-normal text-muted-foreground">{of !== undefined ? ` of ${of}` : ` ${unit}`}</span>}
    </>
  );
}

function WhatYouHave({ snapshot, relay, ai }: { snapshot: PlanSnapshot; relay: RelayPlan | null; ai: ReturnType<typeof useBloksAi> }) {
  const { dispatch } = useStore();
  const go = (page: string) => dispatch({ type: "toggleAppSettings", open: true, page });
  const key = planKey(snapshot, appPlanOf(useWorkspaces()));
  const account = snapshot.account;
  const localLicence = snapshot.capabilities?.licence !== false;
  const team = snapshot.ownerPlan === "team" || account?.plan === "team";
  const spaces = relay?.spaces ?? null;
  const members = snapshot.members;
  const aiShown = bloksAiShown(ai, account);
  const ladder = ladderFor(key, snapshot.offers, account);
  // offers not had yet keep the tile's place, so nothing jumps when they land
  const aiOffered = snapshot.offers ? ladder.some((o) => o.id === "ai" || o.id === "bloks-ai") : true;
  const link = "rounded font-medium text-brand-ink underline-offset-2 outline-none hover:underline";

  const tiles: React.ReactNode[] = [];

  // workspaces online, as the relay counts them
  if (!spaces) {
    tiles.push(
      <Tile
        key="spaces"
        rowId="workspaces-online"
        label="Workspaces online"
        quiet
        value="None yet"
        line={
          <button type="button" className={cn(link, "inline-flex items-center gap-0.5")} onClick={() => go("workspace:online")}>
            Put this one online
            <ArrowRight size={12} aria-hidden />
          </button>
        }
      />,
    );
  } else if (spaces.limit === null) {
    tiles.push(<Tile key="spaces" rowId="workspaces-online" label="Workspaces online" value={<OfCount n={spaces.online} unit="online" />} line="No limit on your plan" />);
  } else {
    const left = Math.max(0, spaces.limit - spaces.online);
    tiles.push(
      <Tile
        key="spaces"
        rowId="workspaces-online"
        label="Workspaces online"
        value={<OfCount n={spaces.online} of={spaces.limit} />}
        meter={<Meter label="Workspaces online" share={spaces.online / Math.max(1, spaces.limit)} value={spaces.online} max={spaces.limit} />}
        line={left > 0 ? `${left} more can go online` : "All in use. Turning one off frees its place."}
      />,
    );
  }

  // members, on Bloks Team
  if (team) {
    tiles.push(
      <Tile
        key="members"
        rowId="members"
        label="Members"
        value={<OfCount n={members.count} of={members.limit > 0 ? members.limit : undefined} />}
        meter={members.limit > 0 && <Meter label="Members" share={members.count / members.limit} value={members.count} max={members.limit} />}
        line="In this workspace, besides you"
      />,
    );
  } else {
    tiles.push(<Tile key="members" rowId="members" label="Members" quiet value="Not included" line="Comes with Bloks Team" />);
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
            "Not connected"
          ) : !reading ? (
            "Can't read it"
          ) : empty ? (
            "Used up"
          ) : (
            <>
              {percentText(used)}
              <span className="text-body font-normal text-muted-foreground"> used</span>
            </>
          )
        }
        meter={reading && <Meter label="Bloks AI used this month" share={used / 100} value={Math.round(used)} max={100} warn={empty || status.low} />}
        line={
          status.refused ? (
            <span className="text-warning">{status.refused.message}</span>
          ) : status.needsKey ? (
            localLicence ? "Connect it below with your key" : "Key controls are available in the host's local window"
          ) : (
            <>
              {[status.low && !empty ? "Running low" : null, resets ? `Resets ${shortDate(resets)}` : null, extra]
                .filter(Boolean)
                .map((part) => `${part} · `)
                .join("")}
              {/* the site's own page, so the key rides along in the
                  fragment and nobody types it again there */}
              {localLicence && <button type="button" title={TOP_UP_WORDS} className={link} onClick={() => void openOffer(status.checkoutUrl)}>
                Top up
              </button>}
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
        value="Included"
        line={account.bloksAi.renewsAt ? `Resets ${shortDate(account.bloksAi.renewsAt)}` : "Agents can run on it with no sign-in"}
      />,
    );
  } else if (aiOffered) {
    tiles.push(<Tile key="ai" rowId="bloks-ai" label="Bloks AI" quiet value="Not included" line="An add-on" />);
  }

  const locked = !team || (!aiShown && !account?.bloksAi?.active && aiOffered);
  const cols = tiles.length >= 3 ? "@xl:grid-cols-3" : tiles.length === 2 ? "@xl:grid-cols-2" : "";
  return (
    <SettingsGroup
      title="What you have"
      action={
        localLicence && locked &&
        ladder.some((o) => o.onSale && o.cta) && (
          <button type="button" className={cn(link, "inline-flex items-center gap-0.5 text-small")} onClick={toOptions}>
            Upgrade
            <ArrowDown size={12} aria-hidden />
          </button>
        )
      }
    >
      <dl className={cn("grid divide-y @xl:divide-x @xl:divide-y-0", cols)}>{tiles}</dl>
      {account?.sharedRoom === true && account.plan === "cloud" && (
        <SettingRow label="Shared room" description="One room shared with guests of its own, kept from when Bloks Cloud included it." control={<HealthLine tone="on" label="Included" />} />
      )}
    </SettingsGroup>
  );
}

/** Hosting, once the licence has it, in the place the way to it held:
 * the machine's row, and room under it for what follows the row (moving
 * the agents onto the machine), handed in as `below`. */
function HostingGroup({ hosting, state, below, controls = true }: { hosting: NonNullable<ReturnType<typeof hostingWords>>; state: string | null; below?: React.ReactNode; controls?: boolean }) {
  return (
    <section aria-label="Hosting" className="mb-9 last:mb-0">
      <SettingsGroup title="Hosting" className={below ? "mb-3" : "mb-0"}>
        <HostingRow hosting={hosting} state={state} controls={controls} />
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
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * Hosting's row: the tier, the machine's state, and once it is running,
 * the way in. "Open" pairs this computer with the hosted workspace as one
 * of your own devices and lists it beside your other workspaces; "Pair
 * your iPhone" shows the same pairing link and code the app uses
 * everywhere else, for the phone to scan. Nothing here needs a terminal
 * on the machine, which nobody has.
 */
function HostingRow({ hosting, state, controls }: { hosting: NonNullable<ReturnType<typeof hostingWords>>; state: string | null; controls: boolean }) {
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
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
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
      setError("Couldn't copy the link just now.");
    }
  };

  return (
    <SettingRow label={hosting.name} description={hosting.line} control={<HealthLine tone={hosting.tone} label={hosting.label} />}>
      {running && controls && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {listed ? (
              <Button size="sm" className="gap-1.5" onClick={() => void goToWorkspace(listed.id)}>
                <Server size={14} />
                Open your hosted workspace
              </Button>
            ) : (
              canList && (
                <Button size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void pairHere()}>
                  {busy === "open" ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
                  Open your hosted workspace
                </Button>
              )
            )}
            <Button size="sm" variant="secondary" className="gap-1.5" disabled={busy !== null} onClick={() => void pairPhone()}>
              {busy === "phone" ? <Loader2 size={14} className="animate-spin" /> : <Smartphone size={14} />}
              Pair your iPhone
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
                Pair this computer again
              </button>
            )}
          </div>
          {waking && busy && (
            <p role="status" className="text-pretty text-small text-muted-foreground">
              Your hosted workspace is waking up. This takes a few seconds, sometimes a minute or two.
            </p>
          )}
          {error && (
            <p role="alert" className="text-pretty text-small text-destructive">
              {error}
            </p>
          )}
          {phone && (
            <div className="flex flex-wrap items-start gap-4 rounded-xl bg-muted/60 p-3">
              <div className="shrink-0 rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5" aria-label="Pairing QR code">
                {phone.qr ? (
                  <img src={phone.qr} alt="Scan with the Bloks app on your iPhone" className="size-[152px]" />
                ) : (
                  <div className="flex size-[152px] items-center justify-center text-caption text-neutral-500">QR unavailable</div>
                )}
              </div>
              <div className="min-w-[180px] flex-1 text-small leading-relaxed text-muted-foreground">
                <p className="text-pretty text-foreground">Scan this with your iPhone's camera, or open the link in the Bloks app.</p>
                <p className="mt-1 text-pretty">Anyone who opens it in time becomes one of your devices, so keep it to yourself.</p>
                <p className="mt-1 tabular-nums">Works once. Expires in {countdown(phone.expiresAt, now)}.</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => void copy()}>
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Copied" : "Copy the link"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPhone(null)}>
                    Done
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
            {yearly ? `Or ${yearly}` : offer.price?.note}
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
        <span className="rounded-full bg-muted px-2 py-0.5 text-small font-medium text-muted-foreground">Coming soon</span>
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
  const title = key === "free" ? "When you want more" : "Your options";
  const onSale = ladder.filter((o) => o.onSale);
  const soon = ladder.filter((o) => !o.onSale);
  const lead = onSale.find((o) => o.cta)?.id;
  const heading = (
    <div className="mb-2.5 flex min-h-[24px] items-center justify-between gap-3 px-1">
      <h2 className="text-body font-medium text-muted-foreground">{title}</h2>
      {snapshot.offersState === "cached" && !retryShown && snapshot.offersAt && (
        <span className="text-small text-muted-foreground">As of {shortDate(snapshot.offersAt)}</span>
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
              Plans and add-ons come from bloks.dev, which couldn't be reached just now.
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
              See plans
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
          Each opens bloks.dev in your browser{snapshot.licence.present && window.bloks ? ", with your key, so there is nothing to type" : ""}. Come back here when you are done.
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
    <div aria-busy="true" aria-label="Loading your plan" className="@container">
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
  const { snapshot, problem, news, loading } = usePlan();
  const workspaces = useWorkspaces();
  const appPlan = appPlanOf(workspaces);
  const workspace = currentWorkspace(workspaces);
  const ai = useBloksAi();
  const [managing, setManaging] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const relay = useRelayPlan(snapshot?.accountAt ?? snapshot?.ownerPlan ?? null);

  useEffect(() => {
    void loadPlan();
  }, []);

  const changed = useCallback(() => {
    void loadPlan(true);
    ai.load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A portal link lasts minutes, so it is asked for only now, and opened
  // straight away. Link (which took some payments) has its own sign-in,
  // and the person is told that before they land there.
  const manage = async () => {
    setManaging(true);
    setManageError(null);
    try {
      const said = await call<{ url: string; manageAt: "portal" | "link" }>("/api/plan/manage", { method: "POST" });
      if (said.manageAt === "link") {
        const go = await confirm({
          title: "Manage billing with Link",
          body: "Link handled the payment for this plan, so billing is managed there. You'll sign in to Link with the email you paid with.",
          confirmLabel: "Open Link",
        });
        if (!go) return;
      }
      openSite(said.url);
    } catch (e) {
      setManageError(e instanceof Error ? e.message : String(e));
    } finally {
      setManaging(false);
    }
  };

  if (!snapshot) {
    if (problem) {
      return (
        <SettingsGroup>
          <SettingsEmpty
            icon={<Lock size={18} />}
            title="Subscription unavailable"
            body={problem}
            action={
              <Button size="sm" variant="secondary" onClick={() => void loadPlan(true)}>
                Try again
              </Button>
            }
          />
        </SettingsGroup>
      );
    }
    return <PlanSkeleton />;
  }

  const free = !snapshot.licence.present;
  // one Try again on the page: the plan's, when it is already saying so
  const retryShown = !free && staleWords(snapshot) !== null;
  const hosting = hostingWords(snapshot.account?.hosting ?? null);
  // the way to Hosting, for a licence known to have none (an account that
  // could not be read at all might have it)
  const localLicence = snapshot.capabilities?.licence !== false;
  const localHosting = snapshot.capabilities?.hosting !== false;
  const hostingCard = localHosting && (free || (snapshot.account !== null && !hosting));
  return (
    <div className="@container">
      {snapshot.capabilities?.licence === false && (
        <p className="mb-3 text-small text-muted-foreground">
          {workspace?.name ? `Subscription for ${workspace.name}` : "This workspace's subscription"}{snapshot.account?.email ? ` · ${snapshot.account.email}` : ""}
          {snapshot.licence.masked ? ` · ${snapshot.licence.masked}` : ""}
        </p>
      )}
      {problem && <p role="status" className="mb-4 text-small text-muted-foreground">{problem} <TryAgain busy={loading} /></p>}
      <AnimatePresence>{news?.up && <PlanMoment key={news.at} words={news.words} at={news.at} />}</AnimatePresence>
      {free ? (
        localLicence ? <FreeCard onActivated={changed} /> : (
          <SettingsEmpty icon={<Lock size={18} />} title="No subscription key reported" body="This workspace reports no subscription key. Key changes are available only in its host's local window." />
        )
      ) : (
        <PlanCard snapshot={snapshot} loading={loading} onManage={() => void manage()} managing={managing} manageError={manageError} onChanged={changed} />
      )}
      {!free && snapshot.account && <WhatYouHave snapshot={snapshot} relay={relay} ai={ai} />}
      {hostingCard ? (
        <MoveToHostingCard snapshot={snapshot} appPlan={appPlan} />
      ) : (
        hosting && <HostingGroup hosting={hosting} state={snapshot.account?.hosting?.state ?? null} controls={localHosting} below={localHosting ? <HostingMove /> : undefined} />
      )}
      {!free && bloksAiShown(ai, snapshot.account) && <BloksAiSettings ai={ai} canConnect={localLicence} />}
      {localLicence && <YourOptions snapshot={snapshot} loading={loading} retryShown={retryShown} hostingCard={hostingCard} />}
    </div>
  );
}
