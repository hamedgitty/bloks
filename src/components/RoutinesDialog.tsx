// Routines, as a first-class overlay.
//
// Reachable from the sidebar, so it covers every agent and room in one
// place; the per-agent Routines block in the computer panel opens this
// same dialog pinned to its own target. Two views inside one dialog:
// the list of everything scheduled, and a create form.
//
// The form is a sentence, not a form: "Nova will run Morning digest every
// weekday at 9:00". Each part you could change is a word you can tap, and
// the one you tapped opens its editor underneath, so the schedule is read
// and changed in the same place. "Every 30 minutes, between nine and six"
// is the one other sentence it can say: a check-in, which is quiet unless
// something needs the person. Beside it, the week ahead is drawn as it
// will run, and moves as the sentence changes.
//
// Self-fetching like RoutinesSection: routines are read on open and
// after every write; nothing else in the app holds them in state.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CalendarClock } from "@/components/icons";
import { ChevronDown } from "@/components/icons";
import { FileText } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Play } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Repeat } from "@/components/icons";
import { Sunrise } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Users } from "@/components/icons";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { type Routine, routineStatus } from "./RoutinesSection";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Slider, type SliderStop } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { ThisComputer, thisComputer } from "@/lib/thisComputer";
import { offersThisComputer } from "@/lib/hosted";
import {
  CHECK_IN_EVERY,
  checkInBand,
  checkInProblem,
  dateKey,
  intervalLabel,
  intervalPhrase,
  nextRuns,
  runsOnDay,
  type DraftSchedule,
} from "@/lib/checkIns";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const sameDays = (a: number[], b: number[]) => a.length === b.length && b.every((d) => a.includes(d));

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  if (sameDays(days, WEEKDAYS)) return "Weekdays";
  if (sameDays(days, WEEKEND)) return "Weekends";
  return days.map((d) => DAY_NAMES[d].slice(0, 3)).join(", ");
}

function whenNext(at: number | null | undefined): string {
  if (!at) return "";
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `next today at ${time}`
    : `next ${when.toLocaleDateString([], { weekday: "short" })} at ${time}`;
}

type Target = { id: string; kind: "agent" | "room"; name: string; bot?: Bot };

/** What the form files: the body of POST /api/routines. */
type Draft = {
  targetId: string;
  targetKind: "agent" | "room";
  name?: string;
  prompt: string;
  time?: string;
  days: number[];
  repeat?: "once";
  date?: string;
  durationMin?: number;
  runsOn?: "cloud" | "local" | "off";
  thread?: string;
  every?: number;
  activeHours?: { from: string; to: string };
  quiet?: boolean;
};

export function RoutinesDialog({
  initialTarget,
  startCreating,
  prefill,
  onClose,
}: {
  /** Pin the dialog to one agent or room; without it, all targets show. */
  initialTarget?: { id: string; kind: "agent" | "room" };
  /** Open straight into the create form (the per-agent entry point). */
  startCreating?: boolean;
  /** Seed the form, e.g. from a calendar slot the user clicked. */
  prefill?: { time?: string; days?: number[]; date?: string };
  onClose: () => void;
}) {
  const { state } = useStore();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [creating, setCreating] = useState(Boolean(startCreating));
  const [error, setError] = useState<string | null>(null);

  const targets: Target[] = [
    ...state.bots.filter((b) => !b.hidden).map((b) => ({ id: b.id, kind: "agent" as const, name: b.name, bot: b })),
    ...state.bloks.map((r) => ({ id: r.id, kind: "room" as const, name: r.name })),
  ];
  const targetOf = (routine: Routine) => targets.find((t) => t.id === routine.targetId);

  const load = useCallback(() => {
    api("/api/routines")
      .then(({ routines }: { routines: Routine[] }) =>
        setRoutines(
          routines
            .filter((r) => !initialTarget || r.targetId === initialTarget.id)
            .sort((a, b) => a.time.localeCompare(b.time)),
        ),
      )
      .catch(() => setRoutines([]));
  }, [initialTarget]);

  useEffect(load, [load]);

  /** Resolves true only when the write landed, so callers can decide
   * whether closing a form would throw away the user's draft. */
  const write = (run: Promise<unknown>) =>
    run
      .then(() => {
        setError(null);
        load();
        return true;
      })
      .catch((e: Error) => {
        setError(e.message);
        load();
        return false;
      });

  const startNew = () => {
    setError(null);
    setCreating(true);
  };
  const leaveNew = () => {
    setError(null);
    if (startCreating) onClose();
    else setCreating(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      {/* Keyed by view, so the form arrives as a sheet of its own (its
          width is a different shape of work) rather than the list
          stretching into it. The form's height is fixed, not grown to
          fit: a centred sheet that grew would jump each time a part of
          the sentence opened a taller editor. */}
      <DialogContent
        key={creating ? "new" : "list"}
        className={cn(
          "flex w-[calc(100vw-24px)] flex-col gap-0 overflow-hidden p-0",
          creating ? "h-[min(760px,92dvh)] max-w-[920px]" : "max-h-[85vh] max-w-[540px]",
        )}
      >
        {creating ? (
          <CreateForm
            targets={targets}
            pinnedTargetId={initialTarget?.id}
            prefill={prefill}
            error={error}
            onBack={leaveNew}
            onSave={(draft) =>
              write(api("/api/routines", { method: "POST", body: JSON.stringify(draft) })).then((ok) => {
                if (ok) leaveNew();
                return ok;
              })
            }
          />
        ) : (
          <>
            <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5">
              <CalendarClock size={16} className="text-muted-foreground" />
              <DialogTitle className="text-lead">Routines</DialogTitle>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-5">
              {error && (
                <div className="mt-3 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">
                  {error}
                </div>
              )}

              {routines === null ? (
                <div className="py-10 text-center text-body text-muted-foreground">Loading…</div>
              ) : routines.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="text-ui font-medium text-foreground">Nothing scheduled yet</div>
                  <div className="mx-auto mt-1 max-w-[300px] text-body text-muted-foreground">
                    Tasks your agents run on a schedule.
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-2">
                  {routines.map((routine) => {
                    const target = targetOf(routine);
                    return (
                      <div key={routine.id} className="rounded-xl border bg-card p-3">
                        <div className="flex items-start gap-2.5">
                          {target?.bot ? (
                            <AgentAvatar bot={target.bot} size={26} />
                          ) : (
                            <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                              <Users size={13} />
                            </span>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span
                                className={cn(
                                  "truncate text-body font-medium",
                                  routine.enabled ? "text-foreground" : "text-muted-foreground",
                                )}
                              >
                                {target?.name ?? "Unknown target"}
                              </span>
                              <span className={cn("text-small text-muted-foreground", routine.every ? "min-w-0 truncate" : "shrink-0")}>
                                {routine.every
                                  ? (routine.summary ?? `Every ${routine.every} min`)
                                  : `${describeDays(routine.days)} at ${routine.time}`}
                              </span>
                            </div>
                            <div className="mt-0.5 line-clamp-2 text-body text-muted-foreground">
                              {routine.name && (
                                <span className="font-medium text-foreground">{routine.name} · </span>
                              )}
                              {routine.prompt}
                            </div>
                            <div className="mt-0.5 text-caption text-muted-foreground/70">
                              {routineStatus(routine, whenNext)}
                            </div>
                          </div>
                          <Switch
                            aria-label={`${routine.name || "This routine"}: on or off`}
                            checked={routine.enabled}
                            onCheckedChange={(on) =>
                              write(
                                api(`/api/routines/${routine.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ enabled: on }),
                                }),
                              )
                            }
                          />
                        </div>
                        <div className="mt-1.5 flex items-center gap-1 pl-9">
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Run once now"
                            onClick={() => write(api(`/api/routines/${routine.id}/run`, { method: "POST" }))}
                          >
                            <Play size={11} />
                            Run now
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => write(api(`/api/routines/${routine.id}`, { method: "DELETE" }))}
                          >
                            <Trash2 size={11} />
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <Button className="mt-4 w-full" variant="secondary" onClick={startNew}>
                <Plus size={13} />
                New routine
              </Button>
              <div className="mt-2 text-caption leading-relaxed text-muted-foreground/70">
                Routines run while Bloks is open. Runs missed while {thisComputer()} sleeps are skipped.
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Saying a schedule out loud

/** "9:00" or "9:00 AM", the way this Mac writes a time. */
function clock(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return hhmm;
  return new Date(2000, 0, 1, Number(match[1]), Number(match[2])).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "6 AM" or "06", for the hour marks over the week. */
function clockHour(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
}

/** "a, b and c". */
function listOf(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "every weekday", "every Friday", "on Mon, Wed and Fri". Monday first
 * when read out, because that is how a week is said. */
function daysPhrase(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "every day";
  if (sameDays(days, WEEKDAYS)) return "every weekday";
  if (sameDays(days, WEEKEND)) return "at weekends";
  if (days.length === 1) return `every ${DAY_NAMES[days[0]]}`;
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return `on ${listOf(ordered.map((d) => DAY_NAMES[d].slice(0, 3)))}`;
}

/** Midnight of a "YYYY-MM-DD", local. */
function dayOf(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/** Whole days from today to `day`. */
function daysFrom(now: Date, day: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - today.getTime()) / 86_400_000);
}

/** "today", "tomorrow", "on Thursday", "on Tue 4 Nov". */
function datePhrase(key: string, now: Date): string {
  const day = dayOf(key);
  if (!day) return "on a day";
  const ahead = daysFrom(now, day);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  if (ahead > 1 && ahead < 7) return `on ${DAY_NAMES[day.getDay()]}`;
  return `on ${day.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
}

/** "Today at 14:30", "Tomorrow at 9:00", "Wed at 9:00", "Tue 4 Nov at 9:00". */
function runLabel(at: Date, now: Date): string {
  const ahead = daysFrom(now, at);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day =
    ahead === 0
      ? "Today"
      : ahead === 1
        ? "Tomorrow"
        : ahead < 7
          ? at.toLocaleDateString([], { weekday: "short" })
          : at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${day} at ${time}`;
}

// ---------------------------------------------------------------------------
// The create form

type Mode = "weekly" | "once" | "every";
/** The words in the sentence that open an editor. */
type Part = "who" | "what" | "when" | "time" | "days" | "voice";

const PART_TITLES: Record<Part, string> = {
  who: "Who runs it",
  what: "Name",
  when: "How often",
  time: "What time",
  days: "Which days",
  voice: "When it speaks up",
};

const HOURS_PRESETS = {
  work: { from: "09:00", to: "18:00", label: "Work hours" },
  waking: { from: "08:00", to: "22:00", label: "Waking hours" },
} as const;

const TIME_CHIPS = ["07:00", "08:00", "09:00", "12:00", "17:00", "20:00"];

const EVERY_STOPS: SliderStop<number>[] = CHECK_IN_EVERY.map((m) => ({ value: m, label: intervalLabel(m) }));

/** How long a routine holds its place on the calendar. The server keeps
 * fifteen-minute steps between 15 minutes and 8 hours. */
const DURATION_STOPS: SliderStop<number>[] = [15, 30, 60, 90, 120, 240].map((m) => ({ value: m, label: intervalLabel(m) }));

interface Starter {
  id: string;
  icon: typeof Sunrise;
  title: string;
  name: string;
  prompt: string;
  mode: Mode;
  days: number[];
  time?: string;
  every?: number;
  hours?: { from: string; to: string };
  /** A check-in, which only an agent can keep. */
  agentOnly?: boolean;
}

/** Three routines most people want first, each a whole sentence: the
 * words and the schedule both, so one press is a routine ready to file. */
const STARTERS: Starter[] = [
  {
    id: "digest",
    icon: Sunrise,
    title: "Morning digest",
    name: "Morning digest",
    prompt:
      "Summarise what came in overnight: email, messages and anything waiting on me. Lead with what needs a reply today.",
    mode: "weekly",
    days: WEEKDAYS,
    time: "08:30",
  },
  {
    id: "inbox",
    icon: Repeat,
    title: "Hourly inbox check",
    name: "Inbox check",
    prompt: "Look through my inbox for anything urgent or from someone important, and tell me what it is.",
    mode: "every",
    days: WEEKDAYS,
    every: 60,
    hours: HOURS_PRESETS.work,
    agentOnly: true,
  },
  {
    id: "friday",
    icon: FileText,
    title: "Friday report",
    name: "Friday report",
    prompt: "Write up the week: what got done, what slipped and what is next. Keep it to one page.",
    mode: "weekly",
    days: [5],
    time: "16:00",
  },
];

/** A starter's schedule in a few words, short enough for its card. */
function starterLine(s: Starter): string {
  if (s.mode === "every" && s.every) return `${s.every === 60 ? "Hourly" : intervalLabel(s.every)}, work hours`;
  const days = sameDays(s.days, WEEKDAYS) ? "Weekdays" : s.days.length === 1 ? `${DAY_NAMES[s.days[0]]}s` : "Every day";
  return `${days}, ${clock(s.time ?? "09:00")}`;
}

/** A part changing swaps its editor: quick, and over before the eye has
 * finished moving. Reduce motion keeps only the fade (App's MotionConfig). */
const swap = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] as const } },
  exit: { opacity: 0, transition: { duration: 0.1, ease: "easeOut" as const } },
};

function CreateForm({
  targets,
  pinnedTargetId,
  prefill,
  error,
  onBack,
  onSave,
}: {
  targets: Target[];
  pinnedTargetId?: string;
  prefill?: { time?: string; days?: number[]; date?: string };
  error: string | null;
  onBack: () => void;
  /** Resolves true when it was filed. */
  onSave: (draft: Draft) => Promise<boolean>;
}) {
  const [targetId, setTargetId] = useState(pinnedTargetId ?? targets[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  // at a time of day, once, or a check-in every so often (server/routines.ts)
  const [mode, setMode] = useState<Mode>("weekly");
  const [time, setTime] = useState(prefill?.time ?? "09:00");
  const [days, setDays] = useState<number[]>(prefill?.days ?? []);
  const [date, setDate] = useState(prefill?.date ?? dateKey(new Date()));
  const [every, setEvery] = useState(30);
  const [keepsHours, setKeepsHours] = useState(true);
  const [from, setFrom] = useState<string>(HOURS_PRESETS.work.from);
  const [to, setTo] = useState<string>(HOURS_PRESETS.work.to);
  const [quiet, setQuiet] = useState(false);
  const [durationMin, setDurationMin] = useState(30);
  const [runsOn, setRunsOn] = useState<"" | "cloud" | "local" | "off">("");
  // off a Mac a routine cannot work this computer's screen either
  const { state } = useStore();
  const ownScreen = offersThisComputer(state.config?.hosted?.computers);
  const [thread, setThread] = useState("");
  const [part, setPart] = useState<Part>("when");
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // the week ahead is drawn against the clock, so it keeps time
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const target = targets.find((t) => t.id === targetId);
  // A room's routine keeps to a time of day and speaks every time:
  // several agents answer it, and a channel may be reading along.
  const forAgent = target?.kind === "agent";
  const shownMode: Mode = mode === "every" && !forAgent ? "weekly" : mode;
  const checkIn = shownMode === "every";
  const hours = keepsHours ? { from, to } : null;

  const schedule: DraftSchedule = checkIn
    ? { every, ...(hours ? { activeHours: hours } : {}), days, time }
    : { days, time, repeat: shownMode === "once" ? "once" : "weekly", date };
  const upcoming = nextRuns(schedule, now, 3);

  const problem = checkIn
    ? checkInProblem(every, hours)
    : !/^\d{1,2}:\d{2}$/.test(time)
      ? "Pick a time."
      : shownMode === "once" && upcoming.length === 0
        ? "That time has passed. Pick a later one."
        : null;
  const ready = Boolean(prompt.trim() && target && !problem);

  const save = async () => {
    if (!ready || !target || saving) return;
    setSaving(true);
    const ok = await onSave({
      targetId: target.id,
      targetKind: target.kind,
      ...(name.trim() ? { name: name.trim() } : {}),
      prompt: prompt.trim(),
      days: shownMode === "once" ? [] : days,
      ...(checkIn
        ? { every, ...(hours ? { activeHours: hours } : {}) }
        : {
            time,
            ...(shownMode === "once" ? { repeat: "once" as const, date } : {}),
            durationMin,
            ...(forAgent && quiet ? { quiet: true } : {}),
          }),
      ...(forAgent && runsOn ? { runsOn } : {}),
      ...(forAgent && thread.trim() ? { thread: thread.trim() } : {}),
    });
    // on success the form is already gone; on failure it stays as it was
    if (!ok) setSaving(false);
  };

  const pickStarter = (s: Starter) => {
    setName(s.name);
    setPrompt(s.prompt);
    setMode(s.mode);
    setDays(s.days);
    if (s.time) setTime(s.time);
    if (s.every) setEvery(s.every);
    if (s.hours) {
      setKeepsHours(true);
      setFrom(s.hours.from);
      setTo(s.hours.to);
    }
    setPart("when");
  };
  const starterOn = (s: Starter) => prompt === s.prompt && shownMode === s.mode;

  // the words a part shows in the sentence
  const whatWords = name.trim() ? `run ${name.trim()}` : checkIn ? "check in" : "do this";
  const whenWords = checkIn
    ? intervalPhrase(every)
    : shownMode === "once"
      ? `once, ${datePhrase(date, now)}`
      : daysPhrase(days);
  const hoursWords = hours ? `from ${clock(from)} to ${clock(to)}` : "all day";

  const firstRun = upcoming[0];
  const footerNote = error
    ? error
    : !target
      ? "Pick who runs it."
      : problem
        ? problem
        : !prompt.trim()
          ? "Say what it should do."
          : firstRun
            ? `First run ${runLabel(firstRun, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}.`
            : "";
  const footerWarns = Boolean(error || (problem && target));

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        // Cmd or Ctrl and Return files it from anywhere in the form
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <header className="shrink-0 border-b pb-4 pl-4 pr-14 pt-5 sm:pl-6">
        <DialogTitle className="text-heading">New routine</DialogTitle>
        <DialogDescription className="mt-0.5">Something an agent does for you, on a schedule.</DialogDescription>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_300px] md:overflow-hidden">
        <div className="min-w-0 px-4 pb-6 pt-5 sm:px-6 md:overflow-y-auto">
          {/* starting points: a whole routine in one press */}
          <div className="mb-2 text-body font-medium text-muted-foreground">Start from</div>
          <div className="flex flex-wrap gap-2 sm:grid sm:grid-cols-3">
            {STARTERS.filter((s) => forAgent || !s.agentOnly).map((s, i) => {
              const Icon = s.icon;
              const on = starterOn(s);
              return (
                <motion.button
                  key={s.id}
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03, duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
                  onClick={() => pickStarter(s)}
                  aria-pressed={on}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 max-sm:py-1.5 text-left outline-none transition-[border-color,background-color,scale] duration-150 ease-out active:scale-[0.985]",
                    on ? "border-brand bg-brand-soft" : "bg-card hover:border-foreground/20 hover:bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center max-sm:hidden justify-center rounded-lg transition-colors duration-150",
                      on ? "bg-brand-ink text-brand-foreground" : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-body font-medium text-foreground">{s.title}</span>
                    <span className="block text-small text-muted-foreground max-sm:hidden">{starterLine(s)}</span>
                  </span>
                </motion.button>
              );
            })}
          </div>

          {/* what it does, in the person's words */}
          <div className="mt-5 rounded-2xl border bg-card p-1.5 shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/50 focus-within:shadow-[0_4px_18px_-6px_var(--shadow-color)]">
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              autoFocus
              aria-label="What should it do?"
              placeholder={
                target
                  ? `What should ${target.name} do? e.g. Summarise yesterday's inbox and flag anything urgent`
                  : "What should it do?"
              }
              className="block w-full resize-none bg-transparent px-2.5 pb-1 pt-2 text-ui leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* the schedule, said as a sentence whose parts can be tapped */}
          <p className="mt-6 text-pretty text-title leading-9 sm:text-heading sm:font-normal sm:leading-10 text-muted-foreground">
            {pinnedTargetId || !target ? (
              <span className="font-medium text-foreground">{target?.name ?? "Someone"}</span>
            ) : (
              <Token part="who" active={part} onOpen={setPart}>
                {target.name}
              </Token>
            )}{" "}
            will{" "}
            <Token part="what" active={part} onOpen={setPart}>
              {whatWords}
            </Token>{" "}
            <Token part="when" active={part} onOpen={setPart}>
              {whenWords}
            </Token>
            {checkIn ? (
              <>
                ,{" "}
                <Token part="time" active={part} onOpen={setPart}>
                  {hoursWords}
                </Token>
                ,{" "}
                <Token part="days" active={part} onOpen={setPart}>
                  {daysPhrase(days)}
                </Token>
                , and speak up only if something needs you.
              </>
            ) : (
              <>
                {" "}
                at{" "}
                <Token part="time" active={part} onOpen={setPart}>
                  {clock(time)}
                </Token>
                {forAgent ? (
                  <>
                    ,{" "}
                    <Token part="voice" active={part} onOpen={setPart}>
                      {quiet ? "speaking up only if it matters" : "and tell you how it went"}
                    </Token>
                    .
                  </>
                ) : (
                  "."
                )}
              </>
            )}
          </p>

          {/* the editor for the part that was tapped */}
          <div id="routine-part" className="mt-3 rounded-2xl border bg-card p-3 sm:p-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={part === "time" && checkIn ? "hours" : part} {...swap}>
                <div className="mb-3 text-small font-medium text-muted-foreground">
                  {part === "time" && checkIn ? "Which hours" : PART_TITLES[part]}
                </div>
                {part === "who" && (
                  <div className="grid max-h-[188px] grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2">
                    {targets.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={t.id === targetId}
                        onClick={() => setTargetId(t.id)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none transition-[border-color,background-color] duration-150",
                          t.id === targetId ? "border-brand bg-brand-soft" : "border-transparent bg-muted/50 hover:bg-accent",
                        )}
                      >
                        {t.bot ? (
                          <AgentAvatar bot={t.bot} size={28} />
                        ) : (
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <Users size={14} />
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-body font-medium text-foreground">{t.name}</span>
                          <span className="block truncate text-caption text-muted-foreground">
                            {t.kind === "room" ? "Room" : t.bot?.title || "Agent"}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {part === "what" && (
                  <>
                    <Input
                      value={name}
                      maxLength={60}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && !e.metaKey && !e.ctrlKey && setPart("when")}
                      placeholder="e.g. Morning digest"
                      aria-label="Name"
                      className="rounded-xl text-body"
                    />
                    <div className="mt-2 text-small text-muted-foreground">
                      Optional. It labels the routine on the calendar.{" "}
                      <button
                        type="button"
                        onClick={() => promptRef.current?.focus()}
                        className="font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        Edit what it does
                      </button>
                    </div>
                  </>
                )}

                {part === "when" && (
                  <>
                    <Segmented
                      aria-label="How often"
                      size="sm"
                      className="w-full sm:w-fit"
                      value={shownMode}
                      onChange={setMode}
                      options={[
                        { value: "weekly", label: "Repeats" },
                        { value: "once", label: "Once" },
                        ...(forAgent ? [{ value: "every" as const, label: "Check-in" }] : []),
                      ]}
                    />
                    <div className="mt-4">
                      {shownMode === "weekly" && <DaysEditor days={days} setDays={setDays} />}
                      {shownMode === "once" && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          {[0, 1].map((ahead) => {
                            const key = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead));
                            return (
                              <Chip key={ahead} on={date === key} onClick={() => setDate(key)}>
                                {ahead === 0 ? "Today" : "Tomorrow"}
                              </Chip>
                            );
                          })}
                          <input
                            type="date"
                            value={date}
                            min={dateKey(now)}
                            onChange={(e) => e.target.value && setDate(e.target.value)}
                            aria-label="Date"
                            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                          />
                        </div>
                      )}
                      {shownMode === "every" && (
                        <>
                          <Slider aria-label="How often" stops={EVERY_STOPS} value={every} onChange={setEvery} onCommit={setEvery} />
                          <div className="mt-1 text-small text-muted-foreground">
                            Check-ins stay silent unless something needs you.
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}

                {part === "time" && !checkIn && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TIME_CHIPS.map((t) => (
                      <Chip key={t} on={time === t} onClick={() => setTime(t)}>
                        {clock(t)}
                      </Chip>
                    ))}
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      aria-label="Exact time"
                      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                    />
                  </div>
                )}

                {part === "time" && checkIn && (
                  <>
                    <Segmented
                      aria-label="Which hours"
                      size="sm"
                      className="w-full sm:w-fit"
                      value={
                        !keepsHours
                          ? "all"
                          : (Object.keys(HOURS_PRESETS) as Array<keyof typeof HOURS_PRESETS>).find(
                              (k) => HOURS_PRESETS[k].from === from && HOURS_PRESETS[k].to === to,
                            )
                      }
                      onChange={(v) => {
                        if (v === "all") return setKeepsHours(false);
                        if (!v) return;
                        setKeepsHours(true);
                        setFrom(HOURS_PRESETS[v].from);
                        setTo(HOURS_PRESETS[v].to);
                      }}
                      options={[
                        { value: "work", label: HOURS_PRESETS.work.label },
                        { value: "waking", label: HOURS_PRESETS.waking.label },
                        { value: "all", label: "All day" },
                      ]}
                    />
                    <div className={cn("mt-3 flex flex-wrap items-center gap-2 text-body text-muted-foreground transition-opacity duration-150", !keepsHours && "opacity-50")}>
                      From
                      <input
                        type="time"
                        value={from}
                        onChange={(e) => {
                          setKeepsHours(true);
                          setFrom(e.target.value);
                        }}
                        aria-label="From"
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                      />
                      to
                      <input
                        type="time"
                        value={to}
                        onChange={(e) => {
                          setKeepsHours(true);
                          setTo(e.target.value);
                        }}
                        aria-label="To"
                        className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                      />
                    </div>
                  </>
                )}

                {part === "days" && <DaysEditor days={days} setDays={setDays} />}

                {part === "voice" && (
                  <div role="radiogroup" aria-label="When it speaks up" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                      { on: !quiet, title: "Every time", line: "Says what it did after each run.", pick: () => setQuiet(false) },
                      { on: quiet, title: "Only if it matters", line: "Stays quiet unless something needs you.", pick: () => setQuiet(true) },
                    ].map((o) => (
                      <button
                        key={o.title}
                        type="button"
                        role="radio"
                        aria-checked={o.on}
                        onClick={o.pick}
                        className={cn(
                          "rounded-xl border px-3 py-2.5 text-left outline-none transition-[border-color,background-color] duration-150",
                          o.on ? "border-brand bg-brand-soft" : "bg-card hover:border-foreground/20",
                        )}
                      >
                        <span className="block text-body font-medium text-foreground">{o.title}</span>
                        <span className="block text-small text-muted-foreground">{o.line}</span>
                      </button>
                    ))}
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* what most people never change, out of the way */}
          {(forAgent || !checkIn) && (
            <div className="mt-5">
              <button
                type="button"
                onClick={() => setMore((v) => !v)}
                aria-expanded={more}
                className="flex items-center gap-1.5 rounded-md py-1 text-body text-muted-foreground transition-colors duration-150 hover:text-foreground"
              >
                <ChevronDown size={14} className={cn("transition-transform duration-200 ease-out motion-reduce:transition-none", more && "rotate-180")} />
                More options
              </button>
              <AnimatePresence initial={false}>
                {more && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    className="mt-3 flex flex-col gap-5 rounded-2xl border bg-card p-3 sm:p-4"
                  >
                    {!checkIn && (
                      <div>
                        <div className="mb-1 text-body font-medium text-foreground">How long it takes</div>
                        <div className="mb-2 text-small text-muted-foreground">The time it holds on the calendar.</div>
                        <Slider aria-label="How long it takes" stops={DURATION_STOPS} value={durationMin} onChange={setDurationMin} onCommit={setDurationMin} />
                      </div>
                    )}
                    {forAgent && target && (
                      <div>
                        <div className="mb-2 text-body font-medium text-foreground">Runs on</div>
                        <Segmented
                          aria-label="Runs on"
                          size="sm"
                          className="w-full sm:w-fit"
                          value={runsOn}
                          onChange={setRunsOn}
                          options={[
                            { value: "", label: "Usual", title: `Wherever ${target.name} runs` },
                            { value: "cloud", label: "Cloud" },
                            ...(ownScreen ? [{ value: "local" as const, label: ThisComputer() }] : []),
                            { value: "off", label: "None", title: "No computer" },
                          ]}
                        />
                        <div className="mt-1.5 text-small text-muted-foreground">
                          {runsOn === "cloud"
                            ? "On a cloud computer."
                            : runsOn === "local"
                              ? `On ${thisComputer()}.`
                              : runsOn === "off"
                                ? "No computer: it can think and talk, not act."
                                : `Wherever ${target.name} usually runs.`}
                        </div>
                      </div>
                    )}
                    {forAgent && (
                      <div>
                        <div className="mb-2 text-body font-medium text-foreground">Conversation</div>
                        <Input
                          value={thread}
                          maxLength={40}
                          onChange={(e) => setThread(e.target.value)}
                          placeholder="General"
                          aria-label="Conversation"
                          className="max-w-[260px] rounded-xl text-body"
                        />
                        <div className="mt-1.5 text-small text-muted-foreground">
                          Leave blank for the main chat. Routines in different chats run side by side.
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* the routine as it will run, redrawn with every change */}
        <aside aria-label="Preview" className="flex flex-col border-t bg-sidebar/50 px-5 py-5 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
          <div className="mb-3 text-body font-medium text-muted-foreground">The week ahead</div>
          <WeekAhead schedule={schedule} now={now} next={firstRun} />

          <div className="mb-2 mt-6 text-body font-medium text-muted-foreground">Next runs</div>
          {upcoming.length ? (
            <ol className="flex flex-col gap-1.5">
              {upcoming.map((at, i) => (
                <li key={at.getTime()} className="flex items-center gap-2.5 text-body">
                  <span className={cn("size-1.5 shrink-0 rounded-full", i === 0 ? "bg-brand" : "bg-foreground/20")} />
                  <span className={cn("tabular-nums", i === 0 ? "font-medium text-foreground" : "text-muted-foreground")}>
                    {runLabel(at, now)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="text-body text-muted-foreground">Nothing coming up.</div>
          )}

          <div className="mb-2 mt-6 text-body font-medium text-muted-foreground">
            {target ? `What ${target.name} is asked` : "What it is asked"}
          </div>
          <div className="rounded-xl border bg-card px-3 py-2.5">
            {name.trim() && <div className="mb-0.5 truncate text-small font-medium text-foreground">{name.trim()}</div>}
            <div className={cn("line-clamp-5 whitespace-pre-wrap text-body leading-relaxed", prompt.trim() ? "text-foreground" : "text-muted-foreground")}>
              {prompt.trim() || "Write it on the left, or start from one of the three."}
            </div>
          </div>

          <div className="mt-auto pt-6 text-caption leading-relaxed text-muted-foreground/80">
            Routines run while Bloks is open. Runs missed while {thisComputer()} sleeps are skipped.
          </div>
        </aside>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t bg-background/85 px-4 py-3 backdrop-blur-md sm:flex-nowrap sm:px-6">
        <span
          className={cn(
            "mr-auto min-w-0 truncate text-body",
            footerWarns ? "text-destructive max-sm:basis-full max-sm:whitespace-normal" : "text-muted-foreground max-sm:hidden",
          )}
        >
          {footerNote}
        </span>
        <Button variant="ghost" size="lg" onClick={onBack} className="max-sm:mr-auto">
          Back
        </Button>
        <Button size="lg" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <CalendarClock size={15} />}
          {saving ? "Scheduling" : "Schedule it"}
        </Button>
      </div>
    </div>
  );
}

/** One tappable part of the sentence. Its words settle in when they
 * change, so a new choice is seen landing in the sentence. */
function Token({
  part,
  active,
  onOpen,
  children,
}: {
  part: Part;
  active: Part;
  onOpen: (part: Part) => void;
  children: string;
}) {
  const on = part === active;
  return (
    <button
      type="button"
      onClick={() => onOpen(part)}
      aria-expanded={on}
      aria-controls="routine-part"
      aria-label={`${PART_TITLES[part]}: ${children}`}
      className={cn(
        "group -mx-0.5 rounded-lg px-1 py-0.5 font-medium outline-none transition-[background-color,color] duration-150",
        on ? "bg-brand-soft text-brand-ink" : "text-foreground hover:bg-accent",
      )}
    >
      {/* the underline lives on the words, since an inline block does
          not inherit its parent's */}
      <motion.span
        key={children}
        initial={{ opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        className={cn(
          "inline-block underline decoration-dotted decoration-[1.5px] underline-offset-[5px] transition-[text-decoration-color] duration-150",
          on ? "decoration-transparent" : "decoration-foreground/35 group-hover:decoration-transparent",
        )}
      >
        {children}
      </motion.span>
    </button>
  );
}

/** A small round choice in a row of them: a time, a day. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-8 rounded-lg px-2.5 text-body tabular-nums outline-none transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96]",
        on ? "bg-foreground font-medium text-background" : "bg-muted text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

/** The days of the week, one button each, with the usual sets in one
 * press above them. None chosen is every day. */
function DaysEditor({ days, setDays }: { days: number[]; setDays: (days: number[]) => void }) {
  const set = days.length === 0 || days.length === 7 ? "all" : sameDays(days, WEEKDAYS) ? "weekdays" : sameDays(days, WEEKEND) ? "weekends" : undefined;
  return (
    <>
      <Segmented
        aria-label="Which days"
        size="sm"
        className="w-full sm:w-fit"
        value={set}
        onChange={(v) => setDays(v === "weekdays" ? WEEKDAYS : v === "weekends" ? WEEKEND : [])}
        options={[
          { value: "all", label: "Every day" },
          { value: "weekdays", label: "Weekdays" },
          { value: "weekends", label: "Weekends" },
        ]}
      />
      <div className="mt-3 flex gap-1.5" role="group" aria-label="Days">
        {DAY_LABELS.map((label, day) => {
          const on = days.length === 0 || days.includes(day);
          return (
            <button
              key={day}
              type="button"
              onClick={() => {
                // from "every day", a press means "not this one"
                const current = days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : days;
                const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort();
                setDays(next.length === 7 ? [] : next.length === 0 ? [day] : next);
              }}
              title={DAY_NAMES[day]}
              aria-label={DAY_NAMES[day]}
              aria-pressed={on}
              className={cn(
                "size-9 rounded-full text-small font-semibold outline-none transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.92]",
                on ? "bg-brand-ink text-brand-foreground" : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The seven days from today, one row each, midnight to midnight: a dot
 * where a routine at a time of day lands, and a band with a tick per run
 * where a check-in keeps its hours. Today is cut at the present, and the
 * next run is marked, so "next Tuesday" is never a guess.
 *
 * A dot rides a rail as wide as the row and moves by transform only, the
 * way the slider's thumb does, so a new time glides there rather than
 * blinking; a day dropped fades its dot out in place.
 */
function WeekAhead({ schedule, now, next }: { schedule: DraftSchedule; now: Date; next?: Date }) {
  const reduce = useReducedMotion();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const glide = reduce ? "none" : "transform 220ms var(--ease-out-quart), opacity 150ms ease-out";
  const at = /^(\d{1,2}):(\d{2})$/.exec(schedule.time);
  const timeMinutes = at ? Number(at[1]) * 60 + Number(at[2]) : 0;
  const nextKey = next ? `${dateKey(next)} ${next.getHours() * 60 + next.getMinutes()}` : "";

  return (
    <div>
      {/* the hours, so a dot reads as a time */}
      <div className="relative ml-12 h-4" aria-hidden>
        <div className="absolute inset-y-0 left-1.5 right-1.5">
          {[6, 12, 18].map((h) => (
            <span
              key={h}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-micro text-muted-foreground"
              style={{ left: `${(h / 24) * 100}%` }}
            >
              {clockHour(h)}
            </span>
          ))}
        </div>
      </div>
      <ol className="flex flex-col">
        {Array.from({ length: 7 }, (_, i) => {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
          const runs = runsOnDay(schedule, day);
          const key = dateKey(day);
          const band = schedule.every && runs.length ? checkInBand(schedule, 0, 24) : null;
          const label =
            i === 0 ? "Today" : day.toLocaleDateString([], { weekday: "short" });
          const spoken = runs.length
            ? `${i === 0 ? "Today" : DAY_NAMES[day.getDay()]}: ${schedule.every ? `${runs.length} check-ins` : clock(schedule.time)}`
            : `${i === 0 ? "Today" : DAY_NAMES[day.getDay()]}: nothing`;
          return (
            <li key={key} className="flex h-7 items-center gap-2" aria-label={spoken}>
              <span className={cn("w-10 shrink-0 text-caption", i === 0 ? "font-medium text-foreground" : "text-muted-foreground")}>
                {label}
              </span>
              <div className="relative h-full flex-1 overflow-hidden" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-px bg-border" />
                <div className="absolute inset-y-0 left-1.5 right-1.5">
                  {[6, 12, 18].map((h) => (
                    <span key={h} className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-border" style={{ left: `${(h / 24) * 100}%` }} />
                  ))}
                  {/* the present, on today's row */}
                  {i === 0 && (
                    <span
                      className="absolute top-1/2 h-4 w-px -translate-y-1/2 bg-destructive/70"
                      style={{ left: `${(nowMinutes / 1440) * 100}%` }}
                    />
                  )}

                  {band ? (
                    <>
                      <span
                        className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-brand/15"
                        style={{ left: `${(band.top / 1440) * 100}%`, width: `${(band.height / 1440) * 100}%` }}
                      />
                      {band.ticks.map((t) => {
                        const minutes = band.top + t;
                        const past = i === 0 && minutes <= nowMinutes;
                        const isNext = `${key} ${minutes}` === nextKey;
                        return (
                          <span
                            key={t}
                            className={cn(
                              "absolute top-1/2 w-px -translate-x-1/2 -translate-y-1/2 rounded-full",
                              isNext ? "h-4 w-0.5 bg-brand" : past ? "h-2.5 bg-brand/30" : "h-2.5 bg-brand/80",
                            )}
                            style={{ left: `${(minutes / 1440) * 100}%` }}
                          />
                        );
                      })}
                    </>
                  ) : (
                    !schedule.every && (
                      <div
                        className="absolute inset-0"
                        style={{ transform: `translateX(${(timeMinutes / 1440) * 100}%)`, transition: glide }}
                      >
                        <span
                          className={cn(
                            "absolute left-0 top-1/2 block size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
                            i === 0 && timeMinutes <= nowMinutes ? "bg-foreground/25" : "bg-brand",
                            `${key} ${timeMinutes}` === nextKey && "shadow-[0_0_0_3px_var(--brand-soft)]",
                          )}
                          style={{ opacity: runs.length ? 1 : 0, transition: reduce ? "none" : "opacity 150ms ease-out" }}
                        />
                      </div>
                    )
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
