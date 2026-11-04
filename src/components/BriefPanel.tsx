// The morning brief (server/brief.ts): what your agents did while you
// were away, what is waiting on you, and a way to hear it.
//
// It reads as a short page rather than a dashboard: a headline, then what
// wants you, then each agent's night in a few plain sentences. What wants
// you comes first because it is the only part that needs you to do
// anything; the rest is there to be read, in any order, or not at all.
// It holds the questions and approvals still open, and your list: what
// an agent found you have to do yourself (server/todos.ts), kept until
// you mark it done or dismiss it, or the agent says it no longer needs
// doing.
//
// Above that come the cards (BriefCards.tsx): what the routines and
// watchers the person set up last reported, which is what most mornings
// are opened for (GitHub 378). The person arranges the page
// (BriefCustomize.tsx), and nothing arranged is the order it always had,
// with the cards first.
//
// Play reads it as a round: an opening, then each agent in its own voice,
// then what is waiting. While it plays, the part being read stays lit and
// the rest steps back, so the page follows the voice. Every line links
// back to the conversation it came from, and approvals can be answered
// here without opening anything.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight } from "@/components/icons";
import { AudioLines } from "@/components/icons";
import { Check } from "@/components/icons";
import { ChevronLeft } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Moon } from "@/components/icons";
import { Pause } from "@/components/icons";
import { Play } from "@/components/icons";
import { RefreshCw } from "@/components/icons";
import { Sunrise } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { Bone, PanelHeader, SubHead } from "./OverviewParts";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { SkeletonAvatar } from "@/components/ui/skeleton";
import { SlidersHorizontal } from "@/components/icons";
import { ResultCard, type BriefResult } from "./BriefCards";
import { BriefCustomize, type ArrangedSection } from "./BriefCustomize";
import { DEFAULT_SECTIONS, layoutOf } from "@/lib/briefLayout";
import { atSpeechSpeed } from "@/lib/useSpeechSpeed";
import { formatDate, formatNumber, t, tr, type MessageKey } from "@/lib/i18n";

interface BriefPart {
  botId: string | null;
  name: string;
  items: Array<{ text: string; threadId: string }>;
  script: string;
}
interface BriefWaiting {
  botId: string;
  name: string;
  title: string;
  threadId: string;
  messageId: string;
  requestId?: string;
  /** A todo is something an agent found the person has to do themselves
   * (server/todos.ts), closed here with Done or Dismiss. */
  kind: "approval" | "question" | "todo";
  todoId?: string;
  detail?: string;
  routine?: string;
  since?: number;
}
/** A line on the person's list as it stands now. */
interface TodoNow {
  id: string;
  botId: string;
  name: string;
  title: string;
  detail?: string;
  threadId: string;
  routine?: string;
  firstAt: number;
  state: "open" | "done" | "dismissed" | "cleared";
}
export interface Brief {
  id: string;
  at: number;
  since: number;
  headline: string;
  parts: BriefPart[];
  waiting: BriefWaiting[];
  spend: { turns: number; cost: number; costKnown: boolean; estimated?: number };
  ready: Array<{ label: string; many?: string; count: number }>;
  /** What the nightly tidy did to each agent's memory; absent on briefs
   * made before there was one. */
  memory?: Array<{ botId: string; name: string; text: string; runId: string }>;
  /** What was still failing when it was made (server/incidents.ts), and
   * what had stopped for failing. Absent on a brief from before. */
  incidents?: Array<{ id: string; title: string; why: string; state: string; threadId?: string; needs?: string }>;
  failing?: Array<{ kind: "routine" | "watcher"; id: string; name: string; error: string; since: number }>;
  /** The cards as they stood when it was made. Absent on a brief from
   * before there were cards. */
  results?: BriefResult[];
  quiet: boolean;
  readAt?: number;
}

interface BriefList {
  briefs: Brief[];
  /** `notify`, `allClear` and `layout` are absent from a server older
   * than the arranging, which then shows the brief as it always did. */
  settings: { enabled: boolean; time: string; notify?: boolean; allClear?: boolean };
  /** Every section in the person's order, hidden ones too. */
  sections?: ArrangedSection[];
  /** The cards as they stand now, for the newest brief. */
  live?: BriefResult[];
  /** The person's list as it stands now; absent from an older server. */
  todos?: TodoNow[];
  audio: boolean;
}

/** The briefs, newest first, re-read when the server says they changed. */
export function useBriefs() {
  const { state } = useStore();
  const [data, setData] = useState<BriefList | null>(null);
  const reload = useCallback(() => {
    api("/api/briefs")
      .then((r) => setData(r))
      .catch(() => setData({ briefs: [], settings: { enabled: true, time: "08:00" }, audio: false }));
  }, []);
  // a routine or a watcher reporting, or being changed, moves its card
  // and a line on the person's list being added or closed moves that
  useEffect(reload, [reload, state.ticks.brief, state.ticks.routines, state.ticks.watchers, state.ticks.todos]);
  return { data, reload };
}

const startOfDay = (at: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Today", "Yesterday", or "Thu, Oct 15": a day as you would say it. */
function dayLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return t("briefPanel.today");
  if (days === 1) return t("briefPanel.yesterday");
  return formatDate(at, { weekday: "short", month: "short", day: "numeric" });
}

const fullDay = (at: number) => formatDate(at, { weekday: "long", month: "long", day: "numeric" });
const clock = (at: number) => formatDate(at, { hour: "numeric", minute: "2-digit" });

/** "Since 6:40 PM yesterday": the stretch of time the brief covers. */
function sinceLine(brief: Brief): string {
  if (!brief.since) return "";
  const days = Math.round((startOfDay(brief.at) - startOfDay(brief.since)) / 86_400_000);
  // the stepper already says which day this is, so the evening before is
  // only a weekday, and "yesterday" when the brief is today's
  const today = startOfDay(Date.now()) === startOfDay(brief.at);
  if (days === 0) return t("briefPanel.since", { time: clock(brief.since) });
  if (days === 1 && today) return t("briefPanel.sinceYesterday", { time: clock(brief.since) });
  return t("briefPanel.sinceWeekday", { time: clock(brief.since), day: formatDate(brief.since, { weekday: "long" }) });
}

/** "08:30" as the clock on the wall says it: "8:30 AM", and "8 AM" on the hour. */
function sayTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const at = new Date(2000, 0, 1, hour, minute);
  return formatDate(at, minute ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
}

/**
 * One line of an agent's night, split the way it reads best: the lane it
 * happened in as a run in head, what was said as the sentence, and a
 * count of changed files as a quiet note after it. The server writes them
 * as "Lane: said (3 files changed)".
 */
function readItem(text: string): { lane: string; said: string; files: string } {
  let rest = text;
  let files = "";
  const tail = rest.match(/\s*\((\d+ files? changed)\)$/);
  if (tail) {
    files = tail[1];
    rest = rest.slice(0, tail.index);
  }
  const lane = rest.match(/^([^:.!?]{1,48}): ([\s\S]+)$/);
  return lane ? { lane: lane[1], said: lane[2], files } : { lane: "", said: rest, files };
}

/** "4 quiet check-ins, nothing needed you." is a footnote, not news. */
const QUIET = /^\d+ quiet check-ins?, nothing needed you\.$/;

/** "3 replies, about $1.20": what the night cost, as far as it is known. */
function spendLine(spend: Brief["spend"]): string {
  const count = spend.turns;
  if (!spend.costKnown || spend.cost <= 0) return t("briefPanel.spend.replies", { count });
  const cost = formatNumber(spend.cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (spend.estimated ?? 0) > 0
    ? t("briefPanel.spend.repliesEstimated", { count, cost })
    : t("briefPanel.spend.repliesAbout", { count, cost });
}

/** The times most people want; anything else is a tap on Other away. */
const PRESET_TIMES = ["07:00", "08:00", "09:00"];

/**
 * What has been dealt with from the waiting list. The brief is a
 * snapshot, so the server will go on listing an approval after it is
 * answered; this is what keeps it ticked when you come back from the
 * conversation it opened, and, kept on this device, after a restart.
 */
const HANDLED_KEY = "bloks-brief-handled";

/** What became of a waiting card. Kept as a word of code, not of English,
 * so a tick reads in whatever language the reader has now; the English
 * labels an older version kept read the same once lowercased. */
type Handled = "allowed" | "denied" | "answered" | "closed" | "opened" | "done" | "dismissed" | "cleared";
const HANDLED_WORDS: Record<Handled, MessageKey> = {
  allowed: "briefPanel.handled.allowed",
  denied: "briefPanel.handled.denied",
  answered: "briefPanel.handled.answered",
  closed: "briefPanel.handled.closed",
  opened: "briefPanel.handled.opened",
  done: "briefPanel.handled.done",
  dismissed: "briefPanel.handled.dismissed",
  cleared: "briefPanel.handled.cleared",
};

/** A line on the list as the waiting rows show it, the same shape the
 * brief keeps, so a line the brief listed and one added since read alike. */
const todoRow = (todo: TodoNow): BriefWaiting => ({
  botId: todo.botId,
  name: todo.name,
  title: todo.title,
  threadId: todo.threadId,
  messageId: todo.id,
  kind: "todo",
  todoId: todo.id,
  ...(todo.detail ? { detail: todo.detail } : {}),
  ...(todo.routine ? { routine: todo.routine } : {}),
  since: todo.firstAt,
});
const handledWords = (done: string) => {
  const code = done.toLowerCase();
  return code in HANDLED_WORDS ? t(HANDLED_WORDS[code as Handled]) : done;
};
const handled = new Map<string, string>(readHandled());

function readHandled(): Array<[string, string]> {
  try {
    const kept = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "[]");
    return Array.isArray(kept) ? kept.filter((e) => Array.isArray(e) && e.length === 2) : [];
  } catch {
    return [];
  }
}

function keepHandled() {
  try {
    // only the newest few hundred: a week of mornings, not a growing log
    localStorage.setItem(HANDLED_KEY, JSON.stringify([...handled].slice(-300)));
  } catch {
    /* private mode or full: ticks hold for this visit */
  }
}

/** A card answered in its conversation counts as handled here too, even
 * when it was answered somewhere the brief never saw. */
function answeredLabel(card: { answered?: string; closed?: string; dismissed?: boolean } | undefined, kind: "approval" | "question"): Handled | null {
  if (!card) return null;
  if (card.answered) return kind === "approval" ? (/deny|reject|decline/i.test(card.answered) ? "denied" : "allowed") : "answered";
  if (card.closed || card.dismissed) return "closed";
  return null;
}

const settle = [0.23, 1, 0.32, 1] as const;

/**
 * Stepping between days turns the page the way time runs: an earlier
 * brief comes in from the left, a later one from the right. The direction
 * rides on `custom` so the brief leaving knows it too, not only the one
 * arriving. Reduce motion keeps the fade and drops the travel.
 */
const turn = {
  enter: (direction: 1 | -1) => ({ opacity: 0, x: direction * -12 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.22, ease: settle } },
  leave: (direction: 1 | -1) => ({ opacity: 0, x: direction * 8, transition: { duration: 0.12, ease: "easeOut" as const } }),
};

export function BriefPanel() {
  const { state, dispatch } = useStore();
  const { data, reload } = useBriefs();
  const [pick, setPick] = useState<string | null>(null);
  // which way the last step went, so the page slides the way time does
  const [direction, setDirection] = useState<1 | -1>(1);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(() => new Map(handled));
  const [busy, setBusy] = useState<string | null>(null);

  const briefs = data?.briefs ?? [];
  const index = Math.max(0, briefs.findIndex((b) => b.id === pick));
  const brief = briefs[index] ?? null;

  // A notification opens the brief it was about, even when a newer one
  // has been made since: yesterday's tap is yesterday's brief.
  useEffect(() => {
    if (!state.briefFocus) return;
    setPick(state.briefFocus);
    dispatch({ type: "openBrief", id: null });
  }, [state.briefFocus, dispatch]);

  // opening it is reading it
  useEffect(() => {
    if (brief && !brief.readAt) void api(`/api/briefs/${brief.id}/read`, { method: "POST" }).catch(() => {});
  }, [brief]);

  // ── listening ──
  const [playing, setPlayingState] = useState<number | null>(null);
  const playingRef = useRef<number | null>(null);
  const setPlaying = (at: number | null) => {
    playingRef.current = at;
    setPlayingState(at);
  };
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const setPaused = (on: boolean) => {
    pausedRef.current = on;
    setPausedState(on);
  };
  const [buffering, setBuffering] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  // the part the loaded audio belongs to, which runs a step behind while
  // the next part is still on its way
  const audioPart = useRef<number | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    audioPart.current = null;
    setPlaying(null);
    setPaused(false);
    setBuffering(false);
  };
  useEffect(() => stop, []);

  // Each part is fetched as a file and played from memory, the way the
  // rest of the app plays speech; the next one is fetched while this one
  // plays, so the round has no gaps.
  const fetchPart = (id: string, at: number): Promise<string> =>
    fetch(`/api/briefs/${id}/parts/${at}/audio`).then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? t("briefPanel.couldntPlayPart"));
      return URL.createObjectURL(await res.blob());
    });

  const playFrom = (at: number, ready?: Promise<string>) => {
    if (!brief || at >= brief.parts.length) return stop();
    const id = brief.id;
    setPlaying(at);
    setBuffering(true);
    const next = at + 1 < brief.parts.length ? fetchPart(id, at + 1) : undefined;
    next?.catch(() => {});
    (ready ?? fetchPart(id, at))
      .then((url) => {
        // stopped, or moved on, while this part was loading
        if (playingRef.current !== at) return URL.revokeObjectURL(url);
        // read in an agent's voice, so at the speed chosen for those
        const player = atSpeechSpeed(new Audio(url));
        audio.current?.pause();
        audio.current = player;
        audioPart.current = at;
        player.onended = () => {
          URL.revokeObjectURL(url);
          if (audio.current === player) playFrom(at + 1, next);
        };
        setBuffering(false);
        // paused while it loaded: it waits, ready, for the next press
        if (pausedRef.current) return;
        return player.play();
      })
      .catch((e: Error) => {
        setError(e.message || t("briefPanel.playbackBlocked"));
        stop();
      });
  };

  const togglePause = () => {
    if (!pausedRef.current) {
      setPaused(true);
      audio.current?.pause();
      return;
    }
    setPaused(false);
    // only the part that is up now; an older one has already finished
    if (audioPart.current === playingRef.current) void audio.current?.play().catch(() => {});
  };

  // The bar runs on the clock of the audio itself, weighted by how long
  // each part's script is, so a long part fills more of it than a short
  // one. Written straight to the transform: sixty renders a second of the
  // whole brief to move one bar would be the opposite of calm.
  useEffect(() => {
    if (playing === null || !brief) return;
    const lengths = brief.parts.map((p) => Math.max(1, p.script.length));
    const total = lengths.reduce((a, b) => a + b, 0);
    const before = lengths.slice(0, playing).reduce((a, b) => a + b, 0);
    let frame = 0;
    const tick = () => {
      const player = audio.current;
      const ready = player && audioPart.current === playing && Number.isFinite(player.duration) && player.duration > 0;
      const through = ready ? Math.min(1, player.currentTime / player.duration) : 0;
      if (bar.current) bar.current.style.transform = `scaleX(${(before + through * lengths[playing]) / total})`;
      if (!paused) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [playing, paused, brief]);

  // ── the rest ──
  const step = (by: 1 | -1) => {
    const target = briefs[index + by];
    if (!target) return;
    stop();
    setDirection(by);
    setPick(target.id);
  };

  const make = () => {
    setMaking(true);
    setError(null);
    stop();
    api("/api/briefs", { method: "POST" })
      .then((r) => {
        setDirection(-1);
        setPick(r.brief?.id ?? null);
        reload();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setMaking(false));
  };

  const markDone = (id: string, label: Handled) => {
    handled.set(id, label);
    keepHandled();
    setDone(new Map(handled));
  };

  const open = (botId: string, threadId: string) => {
    dispatch({ type: "select", id: botId, lane: threadId });
  };

  const answer = (w: BriefWaiting, behavior: "allow" | "deny") => {
    if (!w.requestId) return;
    setBusy(w.messageId);
    api(`/api/bots/${w.botId}/respond`, { method: "POST", body: JSON.stringify({ requestId: w.requestId, behavior }) })
      .then(() => markDone(w.messageId, behavior === "allow" ? "allowed" : "denied"))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  // a line on the person's list, closed: they did it, or it is not for them
  const closeTodo = (w: BriefWaiting, how: "done" | "dismiss") => {
    if (!w.todoId) return;
    setBusy(w.messageId);
    api(`/api/todos/${w.todoId}/${how}`, { method: "POST" })
      .then(() => markDone(w.messageId, how === "done" ? "done" : "dismissed"))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  // the settings answer at once and the server catches up behind them
  const [want, setWant] = useState<{ enabled?: boolean; time?: string }>({});
  useEffect(() => setWant({}), [data?.settings.enabled, data?.settings.time]);
  const settings = (patch: { enabled?: boolean; time?: string }) => {
    setWant((w) => ({ ...w, ...patch }));
    api("/api/briefs/settings", { method: "PATCH", body: JSON.stringify(patch) })
      .then(reload)
      .catch((e: Error) => {
        setWant({});
        setError(e.message);
      });
  };
  const enabled = want.enabled ?? data?.settings.enabled ?? true;
  const time = want.time ?? data?.settings.time ?? "08:00";

  // ── arranging ──
  const [customizing, setCustomizing] = useState(false);
  // the arrangement answers at once too, and the server's catches up
  const [arranged, setArranged] = useState<ArrangedSection[] | null>(null);
  useEffect(() => setArranged(null), [data?.sections]);
  const sections: ArrangedSection[] =
    arranged ?? data?.sections ?? DEFAULT_SECTIONS.map((key) => ({ key, kind: key, pinned: false, hidden: false }));
  const [notifyWant, setNotifyWant] = useState<{ notify?: boolean; allClear?: boolean }>({});
  useEffect(() => setNotifyWant({}), [data?.settings.notify, data?.settings.allClear]);
  const arrange = (next: ArrangedSection[]) => {
    setArranged(next);
    api("/api/briefs/settings", { method: "PATCH", body: JSON.stringify({ layout: layoutOf(next) }) })
      .then(reload)
      .catch((e: Error) => {
        setArranged(null);
        setError(e.message);
      });
  };
  const notifySettings = (patch: { notify?: boolean; allClear?: boolean }) => {
    setNotifyWant((w) => ({ ...w, ...patch }));
    api("/api/briefs/settings", { method: "PATCH", body: JSON.stringify(patch) })
      .then(reload)
      .catch((e: Error) => {
        setNotifyWant({});
        setError(e.message);
      });
  };
  const briefOnly = (routineId: string, on: boolean) => {
    setArranged(sections.map((x) => (x.key === `routine:${routineId}` ? { ...x, briefOnly: on } : x)));
    api(`/api/routines/${routineId}`, { method: "PATCH", body: JSON.stringify({ briefOnly: on }) })
      .then(reload)
      .catch((e: Error) => {
        setArranged(null);
        setError(e.message);
      });
  };

  // The cards: as they stand now on the newest brief, where a report that
  // came in late updates its card, and as they stood on an older one.
  const newest = index === 0;
  const cards = new Map<string, BriefResult>(((newest ? data?.live : undefined) ?? brief?.results ?? []).map((r) => [r.key, r]));
  // a card from an older brief whose routine has gone since is still
  // what that morning said, so it comes first rather than not at all
  const orphans = newest ? [] : (brief?.results ?? []).filter((r) => !sections.some((x) => x.key === r.key));
  const openCard = (r: BriefResult) => r.botId && r.threadId && open(r.botId, r.threadId);

  const bot = (id: string | null) => (id ? state.bots.find((b) => b.id === id) : undefined);
  const closing = brief ? brief.parts.findIndex((p, i) => i > 0 && !p.botId) : -1;
  // while it plays, everything but the part being read steps back
  const dim = (part: number) => playing !== null && playing !== part;
  // what this device remembers, plus any card the app has loaded and
  // already seen answered
  // A line on the person's list says where it stands from the server,
  // which knows whether it was closed here, on a phone, or cleared by its
  // agent; one no longer listed has been over for a while.
  const todosNow = data?.todos ? new Map(data.todos.map((todo) => [todo.id, todo])) : null;
  const doneFor = (w: BriefWaiting): string | undefined => {
    if (w.kind === "todo" && todosNow) {
      const now = todosNow.get(w.todoId ?? w.messageId);
      if (!now) return "cleared";
      if (now.state !== "open") return now.state;
    }
    const kept = done.get(w.messageId);
    if (kept) return kept;
    if (w.kind === "todo") return undefined;
    const card = state.bots.find((b) => b.id === w.botId)?.messages.find((m) => m.id === w.messageId)?.card;
    return answeredLabel(card, w.kind) ?? undefined;
  };
  // What waits: the cards the brief listed, then the person's list. On
  // the newest brief the list is as it stands now, so a line an agent
  // added since the morning is here too, and one it said again reads in
  // its newest words; an older brief keeps the lines it had.
  const listed = brief?.waiting ?? [];
  const waitingRows: BriefWaiting[] = brief
    ? [
        ...listed.filter((w) => w.kind !== "todo"),
        ...listed.filter((w) => w.kind === "todo").map((w) => {
          const now = newest ? todosNow?.get(w.todoId ?? w.messageId) : undefined;
          return now?.state === "open" ? todoRow(now) : w;
        }),
        ...(newest && todosNow
          ? [...todosNow.values()].filter((todo) => todo.state === "open" && !listed.some((w) => (w.todoId ?? w.messageId) === todo.id)).map(todoRow)
          : []),
      ]
    : [];
  const waitingLeft = waitingRows.filter((w) => !doneFor(w)).length;
  const reader = playing === null || !brief ? "" : playing === 0 ? t("briefPanel.overview") : brief.parts[playing]?.name ?? "";

  return (
    <section aria-label={t("briefPanel.morningBrief")} className="flex min-w-0 flex-col">
      <PanelHeader
        icon={<Sunrise size={17} />}
        title={t("briefPanel.morningBrief")}
        actions={
          <>
            {briefs.length > 1 && (
              <div className="mr-1 flex items-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("briefPanel.earlierBrief")}
                  disabled={index >= briefs.length - 1}
                  onClick={() => step(1)}
                >
                  <ChevronLeft size={15} />
                </Button>
                <span
                  className="min-w-16 text-center text-body sm:min-w-[5.5rem] tabular-nums text-muted-foreground"
                  aria-live="polite"
                  aria-label={brief ? fullDay(brief.at) : undefined}
                >
                  {brief ? dayLabel(brief.at) : ""}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label={t("briefPanel.laterBrief")} disabled={index === 0} onClick={() => step(-1)}>
                  <ChevronRight size={15} />
                </Button>
              </div>
            )}
            {brief && data?.audio && playing === null && (
              <Button variant="secondary" size="sm" onClick={() => playFrom(0)} aria-label={t("briefPanel.listenToTheBrief")}>
                <Play size={13} />
                <span className="max-sm:hidden">{t("briefPanel.listen")}</span>
              </Button>
            )}
            {brief && (
              <Button variant="ghost" size="icon-sm" disabled={making} onClick={make} title={t("briefPanel.makeAFreshBriefNow")} aria-label={t("briefPanel.makeAFreshBriefNow")}>
                {making ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </Button>
            )}
            {data?.sections && (
              <Button variant="ghost" size="icon-sm" onClick={() => setCustomizing(true)} title={t("briefPanel.customizeTheBrief")} aria-label={t("briefPanel.customizeTheBrief")}>
                <SlidersHorizontal size={14} />
              </Button>
            )}
          </>
        }
      />

      <div className="mt-6 max-w-2xl">
        {error && (
          <div role="alert" className="mb-5 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-body text-destructive">
            <span className="min-w-0 flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label={t("common.dismiss")} className="mt-0.5 shrink-0 opacity-70 transition-opacity hover:opacity-100">
              <X size={13} />
            </button>
          </div>
        )}

        {!data ? (
          <BriefSkeleton />
        ) : !brief ? (
          <div className="flex flex-col items-start gap-4 py-2">
            <p className="text-balance text-heading font-semibold text-foreground">
              {enabled ? t("briefPanel.firstBriefAt", { time: sayTime(time) }) : t("briefPanel.noBriefYet")}
            </p>
            <p className="max-w-md text-pretty text-ui leading-relaxed text-muted-foreground">
              {t("briefPanel.eachMorningAShortRead")}
            </p>
            <Button onClick={make} disabled={making}>
              {making ? <Loader2 size={13} className="animate-spin" /> : <Sunrise size={14} />}
              {t("briefPanel.makeOneNow")}
            </Button>
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.article
              key={brief.id}
              custom={direction}
              variants={turn}
              initial="enter"
              animate="center"
              exit="leave"
              className="flex flex-col"
            >
              <div className={cn("transition-opacity duration-200", dim(0) && "opacity-45")}>
                <h3 className="text-balance text-heading font-semibold text-foreground">{brief.headline}</h3>
                <p className="mt-2 text-body text-muted-foreground">
                  {[
                    sinceLine(brief),
                    brief.spend.turns > 0 ? spendLine(brief.spend) : "",
                    // the server names what is ready, so its noun stays as it wrote it
                    ...brief.ready.map((r) => t("briefPanel.ready", { count: r.count, what: r.count === 1 ? r.label : (r.many ?? `${r.label}s`) })),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>

              <AnimatePresence initial={false}>
                {playing !== null && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: settle } }}
                    exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
                    className="mt-5 flex items-center gap-3 rounded-full bg-muted/70 py-1 pl-1 pr-1.5"
                    role="group"
                    aria-label={t("briefPanel.briefPlayer")}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-full text-foreground"
                      onClick={togglePause}
                      aria-label={paused ? t("briefPanel.resume") : t("common.pause")}
                    >
                      {buffering && !paused ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : paused ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                    </Button>
                    <div className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
                      <div ref={bar} className="absolute inset-0 origin-left rounded-full bg-foreground/60" style={{ transform: "scaleX(0)" }} />
                    </div>
                    <span className="max-w-[9rem] truncate text-small text-muted-foreground" aria-live="polite">
                      {reader}
                    </span>
                    <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={stop} aria-label={t("common.stop")}>
                      <X size={14} />
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* The sections in the person's order (server/brief.ts
                  arrangeSections): the cards, then the brief's own. */}
              {orphans.length > 0 && (
                <div className="mt-8 flex flex-col gap-3">
                  {orphans.map((r) => (
                    <ResultCard key={r.key} result={r} onOpen={openCard} />
                  ))}
                </div>
              )}
              {sections.map((section, at) => {
                if (section.hidden) return null;
                const card = cards.get(section.key);
                if (card) {
                  // cards that follow one another sit close, as one group
                  const prev = sections.slice(0, at).reverse().find((x) => !x.hidden && (cards.has(x.key) || x.kind !== "routine" && x.kind !== "watcher"));
                  const grouped = Boolean(prev && cards.has(prev.key));
                  return (
                    <div key={section.key} className={grouped ? "mt-3" : "mt-8"}>
                      <ResultCard result={card} after={newest && Boolean(card.at && card.at > brief.at)} onOpen={openCard} />
                    </div>
                  );
                }
                if (section.key === "waiting" && waitingRows.length > 0) {
                  return (
                    <div key="waiting" className={cn("mt-8 transition-opacity duration-200", closing >= 0 && dim(closing) && "opacity-45")}>
                      <SubHead className="flex items-center gap-1.5">
                        {waitingLeft ? (
                          <>{t("briefPanel.waitingOnYou")}</>
                        ) : (
                          <>
                            <Check size={12} className="text-success" />
                            {t("briefPanel.allHandled")}
                          </>
                        )}
                      </SubHead>
                      <ul className="-mx-3 flex flex-col">
                        {waitingRows.map((w) => (
                          <WaitingRow
                            key={w.messageId}
                            item={w}
                            agent={bot(w.botId)}
                            done={doneFor(w)}
                            busy={busy === w.messageId}
                            onAnswer={(behavior) => answer(w, behavior)}
                            onClose={(how) => closeTodo(w, how)}
                            onOpen={() => {
                              // a line on the list stays until it is closed: reading
                              // the report it came from is not doing it
                              if (!w.requestId && w.kind !== "todo") markDone(w.messageId, "opened");
                              open(w.botId, w.threadId);
                            }}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                }
                if (section.key === "failed" && (brief.incidents?.length || brief.failing?.length)) {
                  return (
                    <div key="failed" className={cn("mt-8 transition-opacity duration-200", closing >= 0 && dim(closing) && "opacity-45")}>
                      <SubHead>{t("briefPanel.somethingFailed")}</SubHead>
                      <ul className="flex flex-col gap-2">
                        {(brief.incidents ?? []).map((i) => (
                          <li key={i.id} className="text-body text-foreground">
                            {tr("briefPanel.incidentFailed", { title: i.title, why: <span className="text-muted-foreground">{i.why}</span> })}
                            {i.needs ? <span className="text-warning"> {t("briefPanel.needsYou", { needs: i.needs })}</span> : null}
                          </li>
                        ))}
                        {(brief.failing ?? []).map((f) => (
                          <li key={f.id} className="text-body text-foreground">
                            {tr(f.kind === "watcher" ? "briefPanel.failingWatcher" : "briefPanel.failingRoutine", {
                              name: f.name,
                              error: <span className="text-muted-foreground">{f.error}</span>,
                            })}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                }
                if (section.key === "agents") {
                  return (
                    <div key="agents" className="mt-8 flex flex-col gap-8">
                      {cards.size > 0 && brief.parts.some((p) => p.botId) && <SubHead className="-mb-6">{t("briefPanel.whatYourAgentsDid")}</SubHead>}
                      {brief.parts.map((part, at) => {
                        if (!part.botId) return null;
                        const agent = bot(part.botId);
                        const reading = playing === at;
                        return (
                          <section key={at} className={cn("transition-opacity duration-200", dim(at) && "opacity-45")}>
                            <div className="flex items-center gap-2">
                              {agent && <AgentAvatar bot={agent} size={20} />}
                              <h3 className="text-ui font-semibold text-foreground">{part.name}</h3>
                              {agent?.title && <span className="truncate text-small text-muted-foreground">{agent.title}</span>}
                              {reading && <AudioLines size={13} className="shrink-0 text-brand-ink" aria-label={t("briefPanel.readingNow")} />}
                            </div>
                            <div className="mt-2 flex flex-col gap-1.5">
                              {part.items.map((item, i) => {
                                if (QUIET.test(item.text)) {
                                  return (
                                    <p key={i} className="text-body text-muted-foreground">
                                      {item.text}
                                    </p>
                                  );
                                }
                                const { lane, said, files } = readItem(item.text);
                                return (
                                  <button
                                    key={i}
                                    onClick={() => part.botId && open(part.botId, item.threadId)}
                                    className="group -mx-2 rounded-lg px-2 py-1 text-left text-lead text-pretty text-foreground/90 transition-colors duration-150 hover:bg-accent/60 hover:text-foreground"
                                  >
                                    {lane && <span className="font-medium text-foreground">{lane}. </span>}
                                    {said}
                                    {files && <span className="text-body text-muted-foreground"> · {files}</span>}
                                    <ArrowUpRight
                                      size={13}
                                      className="ml-1 inline-block -translate-y-px text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                    />
                                  </button>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  );
                }
                if (section.key === "memory" && (brief.memory?.length ?? 0) > 0) {
                  return (
                    <div key="memory" className="mt-8">
                      <SubHead className="flex items-center gap-1.5">
                        <Moon size={12} />
                        {t("briefPanel.memoryTidiedOvernight")}
                      </SubHead>
                      <ul className="-mx-2 flex flex-col">
                        {brief.memory!.map((line) => {
                          const agent = bot(line.botId);
                          return (
                            <li key={line.runId}>
                              <button
                                onClick={() => dispatch({ type: "openMemory", target: line.botId })}
                                className="group flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent/60"
                              >
                                {agent ? <AgentAvatar bot={agent} size={20} /> : null}
                                <span className="min-w-0 flex-1 text-pretty text-body text-foreground/90">
                                  <span className="font-medium text-foreground">{line.name}: </span>
                                  {line.text}
                                  <span className="ml-1 whitespace-nowrap text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
                                    {t("briefPanel.reviewOrUndo")}
                                    <ArrowUpRight size={12} className="ml-0.5 inline-block -translate-y-px" />
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                }
                return null;
              })}
            </motion.article>
          </AnimatePresence>
        )}

        {data?.sections && (
          <BriefCustomize
            open={customizing}
            onOpenChange={setCustomizing}
            sections={sections}
            notify={notifyWant.notify ?? data.settings.notify ?? true}
            allClear={notifyWant.allClear ?? data.settings.allClear ?? false}
            onArrange={arrange}
            onSettings={notifySettings}
            onBriefOnly={briefOnly}
          />
        )}

        {data && (
          <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-5 text-body text-muted-foreground">
            <label className="flex items-center gap-2">
              <Switch checked={enabled} onCheckedChange={(on) => settings({ enabled: on })} aria-label={t("briefPanel.aBriefEveryMorning")} />
              {enabled ? t("briefPanel.everyMorningAt") : t("briefPanel.dailyBriefIsOff")}
            </label>
            {enabled && <BriefTime time={time} onChange={(next) => settings({ time: next })} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** Who put a line on the list, and since when when that was not today:
 * "For you, from Nova · Home lab health · since Mon, Oct 26". */
function todoMeta(item: BriefWaiting): string {
  const since = item.since && startOfDay(item.since) < startOfDay(Date.now()) ? t("briefPanel.todo.since", { day: dayLabel(item.since) }) : "";
  return [t("briefPanel.todo.from", { name: item.name }), item.routine ?? "", since].filter(Boolean).join(" · ");
}

/**
 * One thing waiting on you. Answered or opened, it folds down to a single
 * ticked line: still there, so you can see what you did, but out of the
 * way of what is left. A line on your list folds only once it is closed,
 * by you here or elsewhere, or by the agent that said it.
 */
function WaitingRow({
  item,
  agent,
  done,
  busy,
  onAnswer,
  onClose,
  onOpen,
}: {
  item: BriefWaiting;
  agent?: Parameters<typeof AgentAvatar>[0]["bot"];
  done?: string;
  busy: boolean;
  onAnswer: (behavior: "allow" | "deny") => void;
  onClose: (how: "done" | "dismiss") => void;
  onOpen: () => void;
}) {
  const todo = item.kind === "todo";
  return (
    <li className="relative px-3 [&:last-child>div]:border-b-0">
      <AnimatePresence mode="popLayout" initial={false}>
        {done ? (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.2, ease: settle } }}
            className="flex items-center gap-2.5 py-1.5 text-body text-muted-foreground"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
              <Check size={11} strokeWidth={2.5} />
            </span>
            <span className="shrink-0 text-foreground/80">{handledWords(done)}</span>
            <span className="min-w-0 truncate">{item.title}</span>
          </motion.div>
        ) : (
          <motion.div
            key="open"
            exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: "easeOut" } }}
            className="flex flex-col gap-2 border-b border-border/70 py-3 sm:flex-row sm:items-center sm:gap-3"
          >
            <button onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
              <span className="mt-0.5 shrink-0">{agent && <AgentAvatar bot={agent} size={22} />}</span>
              <span className="min-w-0">
                <span className="block text-ui text-foreground">{item.title}</span>
                {todo && item.detail && <span className="mt-0.5 line-clamp-2 block text-body text-foreground/75">{item.detail}</span>}
                <span className="block text-small text-muted-foreground">
                  {todo
                    ? todoMeta(item)
                    : t(item.kind === "approval" ? "briefPanel.wantsYourOk" : "briefPanel.hasAQuestion", { name: item.name })}
                </span>
              </span>
            </button>
            <div className="flex shrink-0 gap-1.5 pl-8 sm:pl-0">
              {todo ? (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onClose("dismiss")} aria-label={t("briefPanel.todo.dismissLabel", { title: item.title })}>
                    {t("common.dismiss")}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => onClose("done")} aria-label={t("briefPanel.todo.doneLabel", { title: item.title })}>
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
                    {t("common.done")}
                  </Button>
                </>
              ) : item.kind === "approval" && item.requestId ? (
                <>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAnswer("deny")}>
                    {t("briefPanel.deny")}
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => onAnswer("allow")}>
                    {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={13} />}
                    {t("briefPanel.allow")}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={onOpen}>
                  {t("briefPanel.answer")}
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/**
 * When the brief arrives: three times most mornings are made of, and
 * Other for the rest. Other opens a clock in place rather than a dialog,
 * since a time is one small thing to say.
 */
function BriefTime({ time, onChange }: { time: string; onChange: (time: string) => void }) {
  const preset = PRESET_TIMES.includes(time);
  const [other, setOther] = useState(!preset);
  useEffect(() => {
    if (!preset) setOther(true);
  }, [preset]);
  const value = other ? "other" : time;
  const commit = (next: string) => {
    if (PRESET_TIMES.includes(next)) setOther(false);
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented
        size="sm"
        aria-label={t("briefPanel.briefTime")}
        value={value}
        options={[...PRESET_TIMES.map((preset) => ({ value: preset, label: sayTime(preset) })), { value: "other", label: t("briefPanel.otherTime") }]}
        onChange={(v) => {
          if (v === "other") return setOther(true);
          commit(v);
        }}
      />
      {other && (
        <input
          type="time"
          defaultValue={time}
          key={time}
          autoFocus={preset}
          onBlur={(e) => e.target.value && e.target.value !== time && commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="h-7 rounded-md border bg-background px-2 text-body tabular-nums text-foreground"
          aria-label={t("briefPanel.customBriefTime")}
        />
      )}
    </div>
  );
}

/** The shape of a brief, while the real one is on its way. */
function BriefSkeleton() {
  return (
    <div role="status" aria-label={t("briefPanel.loadingTheBrief")} className="flex flex-col">
      <Bone className="h-5 w-11/12" />
      <Bone className="mt-2.5 h-5 w-3/5" />
      <Bone className="mt-4 w-2/5" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="mt-9 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <SkeletonAvatar size={20} shape="tile" />
            <Bone className="w-24" />
          </div>
          <Bone className="w-full" />
          <Bone className={i === 1 ? "w-2/3" : "w-5/6"} />
        </div>
      ))}
    </div>
  );
}
