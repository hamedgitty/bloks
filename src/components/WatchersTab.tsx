// Watchers (server/watchers.ts): a folder, a page, a feed, a check or a
// place, and what an agent should do when it changes.
//
// A check runs a command unattended, so one an agent filed shows the
// command and waits for an Approve here before it ever runs.
//
// The list on the left, the one you are looking at on the right: what is
// watched, what the agent is told, how often it looks, and the last few
// times it fired. A new one is a kind, an address, who acts and what they
// do, and how often to look, read back as one plain sentence before it is
// filed.
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check } from "@/components/icons";
import { Eye } from "@/components/icons";
import { FlaskConical } from "@/components/icons";
import { Folder } from "@/components/icons";
import { Globe } from "@/components/icons";
import { Hourglass } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { MapPin } from "@/components/icons";
import { Pause } from "@/components/icons";
import { Rss } from "@/components/icons";
import { ShieldCheck } from "@/components/icons";
import { SquareTerminal } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { TriangleAlert } from "@/components/icons";
import { Zap } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { ago, AppDraftFields, appRowStatus, AppWatchDetail, appWhen, type AppDraftValue, type AppsStatus, type AppView } from "./AppWatch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { numberStops, Slider, type SliderStop } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { intervalLabel, intervalPhrase } from "@/lib/checkIns";
import { AUTOMATIONS_LIST, AUTOMATIONS_LIST_SIZE, useColumnFolded } from "@/lib/sideColumn";
import { ShowColumn, SideColumn } from "./SideColumn";
import { OPEN } from "./SidebarParts";
import { formatDate, formatList, formatNumber, t, type MessageKey } from "@/lib/i18n";

type Kind = "folder" | "page" | "feed" | "check" | "place" | "app";

interface WatcherRow {
  id: string;
  botId: string;
  name: string;
  kind: Kind;
  target: string;
  instruction: string;
  mentions?: string;
  mode: "act" | "rehearse";
  every: number;
  /** The most turns it starts in an hour; the server always says. */
  perHour?: number;
  enabled: boolean;
  lastCheck?: number;
  lastError?: string;
  /** Since when a finding has waited for the hour's limit to allow a turn. */
  held?: number;
  laneId?: string;
  /** the conversation its turns go to, by title; absent is a lane of its own */
  thread?: string;
  fires: Array<{ at: number; summary: string }>;
  approvedBy?: "person" | "mode";
  /** On, but its agent is archived, so it does not look until restored. */
  suspended?: "archived";
  /** Looks that failed in a row. */
  failures?: number;
  /** Stopped looking on its own after failing again and again. Any
   * change, or a look by hand that works, starts it again. */
  failing?: { at: number; error: string };
  /** Places: arriving or leaving, how near a point counts, act once, and
   * when to stop. */
  when?: "arrive" | "leave";
  radius?: number;
  once?: boolean;
  until?: number;
  /** Finished on its own: acted once, or its time ran out. */
  done?: { at: number; why: "once" | "until" };
  /** Apps: the app, the event, and what each event became. */
  app?: AppView;
}

// Keys, not words, so the cards read in the language of the moment. The
// placeholders of a path, an address or a command stay as they are typed;
// a place's is words, and translates.
const KIND: Record<
  Kind,
  { icon: typeof Folder; label: MessageKey; example: MessageKey; field: MessageKey; placeholder: () => string; instruction: MessageKey }
> = {
  folder: {
    icon: Folder,
    label: "watchersTab.kind.folder.label",
    example: "watchersTab.kind.folder.example",
    field: "watchersTab.kind.folder.field",
    placeholder: () => "/Users/you/Invoices",
    instruction: "watchersTab.kind.folder.instruction",
  },
  page: {
    icon: Globe,
    label: "watchersTab.kind.page.label",
    example: "watchersTab.kind.page.example",
    field: "watchersTab.kind.page.field",
    placeholder: () => "https://example.com/pricing",
    instruction: "watchersTab.kind.page.instruction",
  },
  feed: {
    icon: Rss,
    label: "watchersTab.kind.feed.label",
    example: "watchersTab.kind.feed.example",
    field: "watchersTab.kind.feed.field",
    placeholder: () => "https://example.com/blog/rss.xml",
    instruction: "watchersTab.kind.feed.instruction",
  },
  check: {
    icon: SquareTerminal,
    label: "watchersTab.kind.check.label",
    example: "watchersTab.kind.check.example",
    field: "watchersTab.kind.check.field",
    placeholder: () => "python3 scripts/supplier_replied.py",
    instruction: "watchersTab.kind.check.instruction",
  },
  place: {
    icon: MapPin,
    label: "watchersTab.kind.place.label",
    example: "watchersTab.kind.place.example",
    field: "watchersTab.kind.place.field",
    placeholder: () => t("watchersTab.kind.place.placeholder"),
    instruction: "watchersTab.kind.place.instruction",
  },
  app: {
    icon: Zap,
    label: "watchersTab.kind.app.label",
    example: "watchersTab.kind.app.example",
    field: "watchersTab.kind.app.field",
    placeholder: () => "",
    instruction: "watchersTab.kind.app.instruction",
  },
};

/** How often a page, a feed or a check is looked at: the steps the
 * server's bounds allow (server/watchers.ts, 5 minutes to a day). */
const LOOK_EVERY = [5, 15, 30, 60, 180, 720, 1440];

/** The stops for a watcher already looking at `every`, which an agent may
 * have filed off the usual steps; it gets a stop of its own rather than
 * the slider pretending it is at the first one. */
function lookStops(every: number): SliderStop<number>[] {
  const values = LOOK_EVERY.includes(every) ? LOOK_EVERY : [...LOOK_EVERY, every].sort((a, b) => a - b);
  return values.map((m) => ({ value: m, label: intervalLabel(m) }));
}

/** The most turns an hour a watcher may start, as the server bounds it
 * (server/watchers.ts, MIN_PER_HOUR to MAX_PER_HOUR, six unless said). */
const PER_HOUR = { min: 1, max: 30, usual: 6 };
// made where it draws, so the stops speak the language chosen now
const perHourStops = () => numberStops(PER_HOUR.min, PER_HOUR.max, (n) => t("watchersTab.turns", { count: n }));

/** Whether the hourly limit can ever hold this watcher back: one that
 * looks as things happen (a folder, a place), one whose schedule looks
 * more than once an hour, or one holding a finding back right now. At an
 * hour or slower it can never bind, so it is not shown. */
const capMatters = (w: Pick<WatcherRow, "kind" | "every" | "held">) =>
  w.held !== undefined || w.kind === "folder" || w.kind === "place" || 60 / w.every > 1;

/** What is being watched, in as few words as a sentence can carry: a
 * folder's last name, a page without its scheme. */
function shortTarget(kind: Kind, target: string): string {
  const text = target.trim();
  if (!text) return "";
  if (kind === "folder") return text.split(/[\\/]/).filter(Boolean).pop() ?? text;
  if (kind === "check" || kind === "place") return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  const bare = text.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

/** Whether a check may run now: approved here, or filed by an agent that
 * still runs commands without asking. Mirrors checkAllowed on the server. */
const mayRun = (w: WatcherRow, approvals?: string) =>
  w.kind !== "check" || w.approvedBy === "person" || (w.approvedBy === "mode" && (approvals === "auto" || approvals === "full"));

function Draft({ apps, onMade }: { apps: AppsStatus | null; onMade: (id: string) => void }) {
  const { state } = useStore();
  const bots = state.bots.filter((b) => !b.hidden && !b.archivedAt);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("page");
  const [when, setWhen] = useState<"arrive" | "leave">("arrive");
  const [target, setTarget] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // an app is picked in its own fields, and names where its turns go here
  const [app, setApp] = useState<AppDraftValue | null>(null);
  const [thread, setThread] = useState("");
  const pick = async () => {
    const path = await window.bloks?.pickFolder?.();
    if (path) setTarget(path);
  };
  const [every, setEvery] = useState(30);
  const bot = bots.find((b) => b.id === botId);
  const ready = Boolean(botId && instruction.trim() && (kind === "app" ? app?.ready : target.trim()));
  const make = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    // a folder is watched as it changes, so how often means nothing to it
    const body =
      kind === "app" && app
        ? {
            botId,
            kind,
            instruction,
            toolkit: app.toolkit,
            trigger: app.trigger,
            config: app.config,
            ...(app.accountId ? { accountId: app.accountId } : {}),
            ...(app.filter.trim() ? { filter: app.filter.trim() } : {}),
            ...(thread.trim() ? { thread: thread.trim() } : {}),
          }
        : { botId, kind, target, instruction, ...(kind === "folder" || kind === "place" ? {} : { every }), ...(kind === "place" ? { when } : {}) };
    api("/api/watchers", { method: "POST", body: JSON.stringify(body) })
      .then((r) => onMade(r.watcher.id))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // the watcher read back as one plain sentence, as it is filled in
  const who = bot?.name ?? t("watchersTab.readback.theAgent");
  const what = shortTarget(kind, target);
  const often = intervalPhrase(every);
  const readback =
    kind === "folder"
      ? t("watchersTab.readback.folder", { who, what: what || t("watchersTab.readback.theFolder") })
      : kind === "page"
        ? t("watchersTab.readback.page", { who, what: what || t("watchersTab.readback.thePage"), often })
        : kind === "feed"
          ? t("watchersTab.readback.feed", { who, what: what || t("watchersTab.readback.theFeed"), often })
          : kind === "place"
            ? t(when === "leave" ? "watchersTab.readback.placeLeave" : "watchersTab.readback.placeArrive", { who, what: what || t("watchersTab.readback.thePlace") })
            : kind === "app"
              ? app?.toolkit && app.trigger
                ? t("watchersTab.readback.app", {
                    event: appWhen({ ...app, filter: app.filter.split(",").map((f) => f.trim()).filter(Boolean) }),
                    who,
                    where: thread.trim() ? t("watchersTab.readback.quoted", { text: thread.trim() }) : t("watchersTab.readback.theMainChat"),
                  })
                : t("watchersTab.readback.appUnpicked", { who })
              : t("watchersTab.readback.check", { who, what: what ? t("watchersTab.readback.quoted", { text: what }) : t("watchersTab.readback.theCommand"), often });

  return (
    <div
      className="mx-auto flex w-full max-w-[640px] flex-col"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          make();
        }
      }}
    >
      <h2 className="text-heading font-semibold text-foreground">{t("watchersTab.newWatcher")}</h2>
      <p className="mt-1 text-body text-muted-foreground">{t("watchersTab.anAgentKeepsAnEye")}</p>

      <div role="radiogroup" aria-label={t("watchersTab.whatToWatch")} className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(Object.keys(KIND) as Kind[]).map((k, i) => {
          const Icon = KIND[k].icon;
          const on = kind === k;
          return (
            <motion.button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03, duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
              onClick={() => setKind(k)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-2 rounded-xl border p-3 text-left outline-none transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.985]",
                on ? "border-brand bg-brand-soft" : "bg-card hover:border-foreground/20 hover:bg-accent/40",
              )}
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-lg transition-colors duration-150",
                  on ? "bg-brand-ink text-brand-foreground" : "bg-muted text-muted-foreground",
                )}
              >
                <Icon size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-body font-medium text-foreground">{t(KIND[k].label)}</span>
                <span className="block text-small leading-snug text-muted-foreground">{t(KIND[k].example)}</span>
              </span>
            </motion.button>
          );
        })}
      </div>

      {kind === "app" ? (
        <AppDraftFields apps={apps} onChange={setApp} />
      ) : (
        <>
          <label className="mt-6 mb-2 text-body font-medium text-foreground" htmlFor="watch-target">
            {t(KIND[kind].field)}
          </label>
          <div className="flex gap-2">
            <Input
              id="watch-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={KIND[kind].placeholder()}
              spellCheck={false}
              className="rounded-xl font-mono text-body"
            />
            {kind === "folder" && window.bloks?.pickFolder && (
              <Button variant="secondary" onClick={pick} className="h-9 rounded-xl">
                {t("watchersTab.choose")}
              </Button>
            )}
          </div>
        </>
      )}
      {/* a check runs a command with nobody watching; say so where the
          command is written, not after it is filed */}
      <AnimatePresence initial={false}>
        {kind === "check" && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            className="mt-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-small leading-relaxed text-foreground"
          >
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-warning" />
            <span>{t("watchersTab.checkRunsOnItsOwn", { often })}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-6 mb-2 text-body font-medium text-foreground">{t("watchersTab.whoActsOnIt")}</div>
      <div role="radiogroup" aria-label={t("watchersTab.whoActsOnIt")} className="flex flex-wrap gap-1.5">
        {bots.map((b) => {
          const on = b.id === botId;
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setBotId(b.id)}
              className={cn(
                "flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-body outline-none transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.97]",
                on ? "border-brand bg-brand-soft font-medium text-foreground" : "bg-card text-foreground/90 hover:border-foreground/20",
              )}
            >
              <AgentAvatar bot={b} size={22} />
              {b.name}
            </button>
          );
        })}
        {bots.length === 0 && <span className="text-body text-muted-foreground">{t("watchersTab.noAgentsYetMakeOne")}</span>}
      </div>

      <label className="mt-6 mb-2 text-body font-medium text-foreground" htmlFor="watch-instruction">
        {t(kind === "app" ? "watchersTab.whatDoesWhenHappens" : "watchersTab.whatDoesWhenChanges", { name: bot?.name ?? t("watchersTab.theAgent") })}
      </label>
      <Textarea
        id="watch-instruction"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={t(KIND[kind].instruction)}
        className="min-h-[90px] rounded-xl text-body"
      />

      {kind === "app" ? (
        <>
          <label className="mt-6 mb-2 text-body font-medium text-foreground" htmlFor="watch-thread">
            {t("watchersTab.whichChatItRepliesIn")}
          </label>
          <Input id="watch-thread" value={thread} onChange={(e) => setThread(e.target.value)} placeholder={t("common.general")} className="rounded-xl text-body" />
          <div className="mt-1.5 text-small leading-relaxed text-muted-foreground">
            {t("watchersTab.appThreadHint", { name: bot?.name ?? t("watchersTab.theAgent") })}
          </div>
        </>
      ) : kind === "place" ? (
        <>
          <div className="mt-6 mb-2 text-body font-medium text-foreground">{t("watchersTab.when")}</div>
          <div role="radiogroup" aria-label={t("watchersTab.when")} className="flex flex-wrap gap-1.5">
            {(["arrive", "leave"] as const).map((w) => (
              <button
                key={w}
                type="button"
                role="radio"
                aria-checked={when === w}
                onClick={() => setWhen(w)}
                className={cn(
                  "rounded-full border px-3 py-1 text-body outline-none transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.97]",
                  when === w ? "border-brand bg-brand-soft font-medium text-foreground" : "bg-card text-foreground/90 hover:border-foreground/20",
                )}
              >
                {w === "arrive" ? t("watchersTab.whenIArrive") : t("watchersTab.whenILeave")}
              </button>
            ))}
          </div>
          <div className="mt-2 text-small leading-relaxed text-muted-foreground">
            {t("watchersTab.aPlaceAsYourIphone")}
          </div>
        </>
      ) : (
        <>
          <div className="mt-6 mb-2 text-body font-medium text-foreground">{t("watchersTab.howOftenItLooks")}</div>
          {kind === "folder" ? (
            <div className="text-body text-muted-foreground">{t("watchersTab.asItChangesFoldersAre")}</div>
          ) : (
            <Slider aria-label={t("watchersTab.howOftenItLooks")} stops={lookStops(every)} value={every} onChange={setEvery} onCommit={setEvery} />
          )}
        </>
      )}

      <div className="mt-6 flex items-start gap-3 rounded-xl bg-muted/60 px-3.5 py-3">
        {bot ? <AgentAvatar bot={bot} size={26} /> : <Eye size={16} className="mt-1 text-muted-foreground" />}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            // a new kind, agent or pace swaps the sentence; typing the
            // address only rewrites it, so it never flickers per key
            key={`${kind}-${every}-${botId}-${when}-${app?.trigger ?? ""}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="min-w-0 flex-1 text-pretty break-words text-body leading-relaxed text-foreground"
          >
            {readback}
          </motion.p>
        </AnimatePresence>
      </div>

      {error && <div className="mt-3 text-body text-destructive">{error}</div>}
      <div className="mt-5 flex items-center gap-3">
        <Button size="lg" disabled={busy || !ready} onClick={make}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
          {busy ? t("watchersTab.starting") : t("watchersTab.startWatching")}
        </Button>
        {!ready && (
          <span className="text-small text-muted-foreground">
            {kind === "app"
              ? (app?.missing ?? (!instruction.trim() ? t("watchersTab.sayWhatToDoWhen") : ""))
              : !target.trim()
                ? kind === "check"
                  ? t("watchersTab.addTheCommand")
                  : t(`watchersTab.add.${kind}`)
                : !instruction.trim()
                  ? t("watchersTab.sayWhatToDoWhenIt")
                  : ""}
          </span>
        )}
      </div>
    </div>
  );
}

const untilDate = (at: number) => formatDate(at, { dateStyle: "medium", timeStyle: "short" });

/** "When you leave, within 2.5 km, once, until Oct 3, 2026, 4:00 PM.": a
 * place's terms, each said only when it is set. */
function placeTerms(w: WatcherRow): string {
  const terms = [w.when === "leave" ? t("watchersTab.whenYouLeave") : t("watchersTab.whenYouArrive")];
  if (w.radius) {
    terms.push(
      w.radius >= 1000
        ? t("watchersTab.place.withinKm", { n: formatNumber(Math.round(w.radius / 100) / 10) })
        : t("watchersTab.place.withinM", { n: w.radius }),
    );
  }
  if (w.once) terms.push(t("watchersTab.place.once"));
  if (w.until) terms.push(t("watchersTab.place.until", { date: untilDate(w.until) }));
  return t("watchersTab.place.terms", { terms: formatList(terms, { type: "unit" }) });
}

/** One entry of a watcher's history, as GET /api/watchers/:id/looks
 * sends it (server/watcher-looks.ts): several alike in a row are one,
 * with how many and since when. */
interface Look {
  at: number;
  outcome: "fired" | "quiet" | "held" | "busy" | "failed";
  detail?: string;
  nextAt?: number;
  count?: number;
  from?: number;
}

const LOOK: Record<Look["outcome"], { icon: typeof Folder; label: MessageKey; tone: string }> = {
  fired: { icon: Zap, label: "watchersTab.look.fired", tone: "text-foreground" },
  quiet: { icon: Check, label: "watchersTab.look.quiet", tone: "text-muted-foreground" },
  held: { icon: Hourglass, label: "watchersTab.look.held", tone: "text-warning" },
  busy: { icon: Pause, label: "watchersTab.look.busy", tone: "text-muted-foreground" },
  failed: { icon: TriangleAlert, label: "watchersTab.look.failed", tone: "text-warning" },
};
/** Entries shown before Show all. */
const LOOKS_SHOWN = 8;
const HOUR = 60 * 60_000;
const clock = (at: number) => formatDate(at, { timeStyle: "short" });
const stamp = (at: number) => formatDate(at, { dateStyle: "medium", timeStyle: "short" });

/** When its limit next allows a turn, as the server reckons it
 * (nextAllowedAt in server/watchers.ts): an hour after the turn that has
 * to drop out of the last hour to make room. */
function nextTurnAt(w: WatcherRow, now = Date.now()): number {
  const recent = w.fires.map((f) => f.at).filter((at) => now - at < HOUR).sort((a, b) => a - b);
  const over = recent.length - (w.perHour ?? PER_HOUR.usual);
  return over < 0 ? now : recent[over] + HOUR;
}

/** A finding held back by the hourly limit: why, and when it gets its
 * turn, in the reader's own clock rather than the server's words. */
function HeldBack({ w }: { w: WatcherRow }) {
  const now = Date.now();
  const at = nextTurnAt(w, now);
  const started = w.fires.filter((f) => now - f.at < HOUR).length;
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-body text-foreground">
      <Hourglass size={14} className="mt-0.5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{t("watchersTab.heldBackTitle")}</span>
        <span className="text-muted-foreground">
          {at > now ? t("watchersTab.heldBackUntil", { count: started, time: clock(at) }) : t("watchersTab.heldBackSoon")}
        </span>
      </div>
    </div>
  );
}

/** What its last looks found, newest first: a mark and a word for each
 * outcome, how long ago, and the line saying what or why. */
function Looks({ w }: { w: WatcherRow }) {
  const { state } = useStore();
  const [looks, setLooks] = useState<Look[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    api(`/api/watchers/${w.id}/looks`)
      .then((r) => live && setLooks(r.looks ?? []))
      .catch(() => live && setLooks((was) => was ?? []));
    return () => {
      live = false;
    };
  }, [w.id, state.ticks.watchers]);
  useEffect(() => setAll(false), [w.id]);
  const shown = looks && !all ? looks.slice(0, LOOKS_SHOWN) : (looks ?? []);
  const now = Date.now();
  return (
    <div>
      <div className="mb-1.5 text-small font-medium text-muted-foreground">{t("watchersTab.recentLooks")}</div>
      {looks === null ? null : looks.length === 0 ? (
        <div className="text-body text-muted-foreground">{t("watchersTab.noLooksYet")}</div>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {shown.map((look) => {
              const mark = LOOK[look.outcome] ?? LOOK.quiet;
              const Mark = mark.icon;
              const label = t(mark.label);
              const more = [
                look.count && look.count > 1 ? t("watchersTab.look.inARow", { count: look.count }) : null,
                look.outcome === "held" && look.nextAt && look.nextAt > now ? t("watchersTab.look.nextTurnAt", { time: clock(look.nextAt) }) : null,
              ].filter(Boolean);
              return (
                <li
                  key={`${look.at}-${look.outcome}`}
                  className="flex items-center gap-3 text-body"
                  title={look.from ? t("watchersTab.look.span", { from: stamp(look.from), to: stamp(look.at) }) : stamp(look.at)}
                >
                  <span className="w-[76px] shrink-0 whitespace-nowrap text-muted-foreground sm:w-[86px]">{ago(look.at)}</span>
                  <span className={cn("flex shrink-0 items-center gap-1.5 text-small font-medium sm:w-[112px]", mark.tone)}>
                    <Mark size={13} className={look.outcome === "fired" ? "text-brand-ink" : undefined} aria-hidden />
                    {/* the word beside the mark from a tablet up; on a phone
                        the line below says it where there is no other */}
                    <span className="sr-only sm:not-sr-only">{label}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {look.detail ? (
                      <span className="text-foreground">{look.detail}</span>
                    ) : (
                      <span className="text-muted-foreground sm:hidden">{label}</span>
                    )}
                    {more.length > 0 && <span className={cn("ml-2 text-muted-foreground", !look.detail && "sm:ml-0")}>{formatList(more as string[], { type: "unit" })}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {looks.length > LOOKS_SHOWN && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="mt-1.5 text-small text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {all ? t("watchersTab.showFewer") : t("watchersTab.showAllLooks", { count: looks.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Detail({ w, onChanged }: { w: WatcherRow; onChanged: () => void }) {
  const { state, dispatch } = useStore();
  const reduce = useReducedMotion();
  const bot = state.bots.find((b) => b.id === w.botId);
  const [instruction, setInstruction] = useState(w.instruction);
  const [thread, setThread] = useState(w.thread ?? "");
  useEffect(() => setThread(w.thread ?? ""), [w.id, w.thread]);
  // where its turns land: the named conversation, by id or title, or the
  // agent's first
  const laneId = w.thread ? bot?.tasks?.find((task) => task.id === w.thread || task.title === w.thread)?.id : bot?.tasks?.[0]?.id;
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setInstruction(w.instruction), [w.id, w.instruction]);
  const patch = (body: Partial<WatcherRow> & { approved?: boolean }) =>
    api(`/api/watchers/${w.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(onChanged).catch((e: Error) => setNote(e.message));
  const check = () => {
    setChecking(true);
    setNote(null);
    api(`/api/watchers/${w.id}/check`, { method: "POST" })
      .then((r) => setNote(r.note || t("watchersTab.checked")))
      .catch((e: Error) => setNote(e.message))
      .finally(() => setChecking(false));
  };
  const Icon = (KIND[w.kind] ?? KIND.page).icon;
  const waiting = !mayRun(w, bot?.approvals);
  return (
    <div className="flex flex-col gap-4">
      {w.kind === "check" && waiting && (
        <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3 text-body text-foreground">
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck size={14} className="text-warning" /> {t("watchersTab.wantsToRunCommand", { name: bot?.name ?? t("common.anAgent") })}
          </div>
          <code className="block break-all rounded-lg bg-background px-2.5 py-1.5 font-mono text-small">{w.target}</code>
          <div className="text-muted-foreground">
            {w.every < 60
              ? t("watchersTab.runsEveryMinutes", { count: w.every })
              : t("watchersTab.runsEveryHours", { count: Math.round(w.every / 60) })}
          </div>
          <div>
            <Button size="sm" onClick={() => patch({ approved: true })}>
              {t("common.approve")}
            </Button>
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-lead font-semibold text-foreground">
            <Icon size={15} className="text-muted-foreground" /> {w.name}
          </div>
          <div className="mt-0.5 break-all font-mono text-small text-muted-foreground">{w.target}</div>
          {w.kind === "check" && !waiting && (
            <div className="mt-1 flex items-center gap-1.5 text-small text-muted-foreground">
              <ShieldCheck size={12} />
              {w.approvedBy === "person"
                ? t("watchersTab.youApprovedThisCommand")
                : bot
                  ? t("watchersTab.canRunCommands", { name: bot.name })
                  : t("watchersTab.itsAgentCanRunCommands")}
              {w.approvedBy === "person" && (
                <button className="underline underline-offset-2" onClick={() => patch({ approved: false })}>
                  {t("watchersTab.withdraw")}
                </button>
              )}
            </div>
          )}
        </div>
        <Switch checked={w.enabled} onCheckedChange={(on) => patch({ enabled: on })} aria-label={t("watchersTab.watching")} />
      </div>
      <label className="flex flex-col gap-1.5 text-body text-muted-foreground">
        {t("watchersTab.whatDoesWhenChanges", { name: bot?.name ?? t("watchersTab.theAgent") })}
        <Textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onBlur={() => instruction.trim() && instruction !== w.instruction && patch({ instruction })}
          className="min-h-[80px] text-body text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-body text-muted-foreground">
        {t("watchersTab.whichChatItRepliesIn")}
        <Input
          value={thread}
          onChange={(e) => setThread(e.target.value)}
          onBlur={() => thread.trim() !== (w.thread ?? "") && patch({ thread: thread.trim() })}
          placeholder={t("common.general")}
          className="text-body text-foreground"
        />
        <span className="text-small">
          {t("watchersTab.leaveBlankForTheMain")}
        </span>
      </label>
      {/* every kind can be asked to act once or stop at a time, so every
          kind says so, and says when it is done */}
      {(w.kind === "place" || w.once || w.until || w.done) && (
        <div className="flex flex-col gap-1 text-body text-muted-foreground">
          {w.kind === "place" ? (
            <span>{placeTerms(w)}</span>
          ) : (
            w.once || w.until ? (
              <span>
                {w.until
                  ? t(w.once ? "watchersTab.actsOnceUntil" : "watchersTab.actsOnEveryChangeUntil", { date: untilDate(w.until) })
                  : t("watchersTab.actsOnce")}
              </span>
            ) : null
          )}
          {w.done && (
            <span className="text-foreground">
              {t(w.done.why === "once" ? "watchersTab.doneOnce" : "watchersTab.doneUntil", { when: ago(w.done.at) })}
            </span>
          )}
        </div>
      )}
      {w.kind !== "folder" && w.kind !== "place" && (
        <div className="max-w-[460px]">
          <div className="mb-1.5 text-body text-muted-foreground">{t("watchersTab.howOftenItLooks")}</div>
          {/* saved where the finger lets go, not at every stop on the way */}
          <Slider aria-label={t("watchersTab.howOftenItLooks")} stops={lookStops(w.every)} value={w.every} onCommit={(every) => patch({ every })} />
        </div>
      )}
      {/* Only where it can matter: a folder or a place, which look as often
          as things happen, a schedule of more than one look an hour, or a
          finding it is holding back now. Hidden, its value is kept. The
          margin closes the column's gap with it, so nothing jumps. */}
      <AnimatePresence initial={false}>
        {capMatters(w) && (
          <motion.div
            key="cap"
            initial={{ height: 0, opacity: 0, marginTop: -16 }}
            animate={{ height: "auto", opacity: 1, marginTop: 0 }}
            exit={{ height: 0, opacity: 0, marginTop: -16 }}
            transition={reduce ? { duration: 0 } : OPEN}
            className="overflow-hidden"
          >
            <div className="max-w-[460px]">
              <div className="mb-1.5 text-body text-muted-foreground">{t("watchersTab.atMostInAnHour")}</div>
              <Slider
                aria-label={t("watchersTab.atMostInAnHour")}
                readout="below"
                stops={perHourStops()}
                value={Math.min(PER_HOUR.max, Math.max(PER_HOUR.min, w.perHour ?? PER_HOUR.usual))}
                onCommit={(perHour) => perHour !== w.perHour && patch({ perHour })}
              />
              <div className="mt-1 text-small leading-relaxed text-muted-foreground">{t("watchersTab.pastThatItWaits")}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-body text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Switch checked={w.mode === "rehearse"} onCheckedChange={(on) => patch({ mode: on ? "rehearse" : "act" })} aria-label={t("watchersTab.rehearseFirst")} />
          <FlaskConical size={13} /> {t("watchersTab.tryOnACopyFirst")}
        </label>
        <span>{t("watchersTab.lastChecked", { when: ago(w.lastCheck) })}</span>
      </div>
      {w.enabled && w.suspended === "archived" && (
        <div className="rounded-lg bg-muted px-3 py-2 text-body text-muted-foreground">
          {t("watchersTab.pausedWhileNameArchived", { name: bot?.name ?? t("watchersTab.itsAgent") })}
        </div>
      )}
      {/* Stopped for failing: said apart from the last error, since it is
          the reason nothing happens on its own any more. Changing it here
          starts it again, and so does Check now when the look works. */}
      {w.failing && (
        <div className="flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-body">
          <div className="font-medium text-warning">{t("watchersTab.stoppedAfterFailing", { count: w.failures ?? 3 })}</div>
          <div className="text-muted-foreground">
            {t("watchersTab.doesNotLookUntil", { error: w.failing.error })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" disabled={checking} onClick={check}>
              {t("watchersTab.lookAgainNow")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => patch({ enabled: false })}>
              {t("common.pause")}
            </Button>
          </div>
        </div>
      )}
      {/* a finding waiting for the hourly limit is said in the reader's
          words and clock, in place of the server's last error about it */}
      {w.held !== undefined && w.enabled && !w.failing ? (
        <HeldBack w={w} />
      ) : (
        w.lastError && !w.failing && <div className="rounded-lg bg-warning/10 px-3 py-2 text-body text-warning">{w.lastError}</div>
      )}
      <Looks w={w} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" disabled={checking} onClick={check}>
          {checking ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />} {t("watchersTab.checkNow")}
        </Button>
        {laneId && bot && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              dispatch({ type: "select", id: bot.id, lane: laneId });
            }}
          >
            {t("watchersTab.openChat")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={() => api(`/api/watchers/${w.id}`, { method: "DELETE" }).then(onChanged).catch(() => {})}
        >
          <Trash2 size={13} /> {t("watchersTab.stopWatching")}
        </Button>
      </div>
      {note && <div className="text-body text-muted-foreground">{note}</div>}
    </div>
  );
}

export function WatchersTab() {
  const { state } = useStore();
  const [rows, setRows] = useState<WatcherRow[] | null>(null);
  // whether app watchers can hear at all, said beside every one of them
  const [apps, setApps] = useState<AppsStatus | null>(null);
  // a card about a watcher that stopped for failing opens it here
  const [selected, setSelected] = useState<string | "new" | null>(() => (state.routinesFocus?.kind === "watcher" ? state.routinesFocus.id : null));
  const load = useCallback(() => {
    api("/api/watchers")
      .then((r) => {
        setRows(r.watchers ?? []);
        setApps(r.apps ?? null);
      })
      .catch(() => setRows([]));
  }, []);
  useEffect(load, [load, state.ticks.watchers]);
  const current = rows?.find((w) => w.id === selected) ?? null;
  const showing = selected === "new" || (!current && rows?.length === 0) ? "new" : (current ?? rows?.[0] ?? null);
  const folded = useColumnFolded(AUTOMATIONS_LIST, AUTOMATIONS_LIST_SIZE);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <SideColumn id={AUTOMATIONS_LIST} size={AUTOMATIONS_LIST_SIZE} label={t("watchersTab.watchers")} className="max-h-[200px] w-full border-b md:max-h-none md:border-b-0">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-small font-medium text-muted-foreground">{t("watchersTab.watching")}</span>
          <button onClick={() => setSelected("new")} className="rounded-lg px-1.5 py-1 text-small text-muted-foreground hover:bg-accent hover:text-foreground">
            {t("watchersTab.new")}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {(rows ?? []).map((w) => {
            const bot = state.bots.find((b) => b.id === w.botId);
            const Icon = (KIND[w.kind] ?? KIND.page).icon;
            const waiting = !mayRun(w, bot?.approvals);
            const active = showing !== "new" && showing?.id === w.id;
            return (
              <button
                key={w.id}
                onClick={() => setSelected(w.id)}
                className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors", active ? "bg-accent" : "hover:bg-accent/60")}
              >
                {bot ? <AgentAvatar bot={bot} size={26} /> : <Icon size={16} />}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-body font-medium text-foreground">
                    <Icon size={12} className="shrink-0 text-muted-foreground" />
                    <span className="truncate">{w.name}</span>
                  </span>
                  <span
                    className={cn(
                      "block truncate text-caption",
                      waiting || w.lastError || w.failing || w.app?.paused || w.app?.proposal ? "text-warning" : w.enabled ? "text-muted-foreground" : "text-muted-foreground/70",
                    )}
                  >
                    {w.done
                      ? t("common.done")
                      : w.suspended === "archived" && w.enabled
                        ? t("watchersTab.pausedWhileArchived")
                        : (appRowStatus(w) ??
                          (!w.enabled
                            ? t("common.paused")
                            : w.failing
                              ? t("watchersTab.stoppedForFailing")
                              : waiting
                                ? t("watchersTab.needsYourApproval")
                                : w.held !== undefined
                                  ? t("watchersTab.look.held")
                                  : w.lastError
                                    ? t("watchersTab.needsALook")
                                    : w.fires[0]
                                      ? t("watchersTab.triggeredAgo", { when: ago(w.fires[0].at) })
                                      : t("watchersTab.checkedAgo", { when: ago(w.lastCheck) })))}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SideColumn>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* the list folded away: the way back to it, named for what it lists */}
        {folded && <ShowColumn id={AUTOMATIONS_LIST} text={t("watchersTab.watching")} label={t("watchersTab.showTheList")} className="-ml-2 -mt-2 mb-3" />}
        {rows === null ? null : showing === "new" ? (
          <Draft
            apps={apps}
            onMade={(id) => {
              setSelected(id);
              load();
            }}
          />
        ) : showing?.kind === "app" && showing.app ? (
          <AppWatchDetail key={showing.id} w={{ ...showing, app: showing.app }} apps={apps} onChanged={load} />
        ) : showing ? (
          <Detail key={showing.id} w={showing} onChanged={load} />
        ) : null}
      </div>
    </div>
  );
}
