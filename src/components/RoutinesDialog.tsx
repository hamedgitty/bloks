// Routines, as a first-class overlay.
//
// Reachable from the sidebar, so it covers every agent and room in one
// place; the per-agent Routines block in the computer panel opens this
// same dialog pinned to its own target. Two views inside one dialog:
// the list of everything scheduled, and the form that files a new
// routine or changes one already there.
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
import { Pencil } from "@/components/icons";
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
import { formatDate, formatList, t, tr, type MessageKey } from "@/lib/i18n";
import { describeSchedule, routinePatch, weekdayName, type RoutineDraft } from "@/lib/routineDetails";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const WEEK = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const sameDays = (a: number[], b: number[]) => a.length === b.length && b.every((d) => a.includes(d));

/** "Weekdays at 09:00", "Mon, Wed at 09:00": a routine at a time of
 * day, in its row of the list. */
function describeAt(days: number[], time: string): string {
  if (days.length === 0 || days.length === 7) return t("routinesDialog.list.everyDayAt", { time });
  if (sameDays(days, WEEKDAYS)) return t("routinesDialog.list.weekdaysAt", { time });
  if (sameDays(days, WEEKEND)) return t("routinesDialog.list.weekendsAt", { time });
  const list = formatList(
    days.map((d) => weekdayName(d, "short")),
    { type: "unit", style: "short" },
  );
  return t("routinesDialog.list.daysAt", { days: list, time });
}

function whenNext(at: number | null | undefined): string {
  if (!at) return "";
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date().toDateString();
  const time = formatDate(when, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? t("routinesDialog.nextToday", { time })
    : t("routinesDialog.nextOn", { day: formatDate(when, { weekday: "short" }), time });
}

type Target = { id: string; kind: "agent" | "room"; name: string; bot?: Bot };

export function RoutinesDialog({
  initialTarget,
  startCreating,
  prefill,
  edit,
  onClose,
}: {
  /** Pin the dialog to one agent or room; without it, all targets show. */
  initialTarget?: { id: string; kind: "agent" | "room" };
  /** Open straight into the create form (the per-agent entry point). */
  startCreating?: boolean;
  /** Seed the form, e.g. from a calendar slot the user clicked. */
  prefill?: { time?: string; days?: number[]; date?: string };
  /** Open straight into the form, filled with this routine, to change it. */
  edit?: Routine;
  onClose: () => void;
}) {
  const { state } = useStore();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [creating, setCreating] = useState(Boolean(startCreating || edit));
  // the routine the form changes; none is a new one
  const [editing, setEditing] = useState<Routine | null>(edit ?? null);
  const [error, setError] = useState<string | null>(null);

  const targets: Target[] = [
    ...state.bots.filter((b) => !b.hidden).map((b) => ({ id: b.id, kind: "agent" as const, name: b.name, bot: b })),
    ...state.bloks.map((r) => ({ id: r.id, kind: "room" as const, name: r.name })),
  ];
  // A routine keeps its target through an edit, so the form names it even
  // when the list of targets does not offer it.
  if (editing && !targets.some((option) => option.id === editing.targetId)) {
    const bot = state.bots.find((b) => b.id === editing.targetId);
    targets.push({
      id: editing.targetId,
      kind: editing.targetKind,
      name: bot?.name ?? state.bloks.find((r) => r.id === editing.targetId)?.name ?? t("routinesDialog.unknownTarget"),
      bot,
    });
  }
  const targetOf = (routine: Routine) => targets.find((option) => option.id === routine.targetId);

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
    setEditing(null);
    setCreating(true);
  };
  const startEdit = (routine: Routine) => {
    setError(null);
    setEditing(routine);
    setCreating(true);
  };
  const leaveNew = () => {
    setError(null);
    if (startCreating || edit) onClose();
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
        key={creating ? (editing ? `edit-${editing.id}` : "new") : "list"}
        className={cn(
          "flex w-[calc(100vw-24px)] flex-col gap-0 overflow-hidden p-0",
          creating ? "h-[min(760px,92dvh)] max-w-[920px]" : "max-h-[85vh] max-w-[540px]",
        )}
      >
        {creating ? (
          <CreateForm
            targets={targets}
            pinnedTargetId={editing?.targetId ?? initialTarget?.id}
            prefill={prefill}
            editing={editing ?? undefined}
            error={error}
            onBack={leaveNew}
            onSave={(draft, before) =>
              write(
                before && editing
                  ? api(`/api/routines/${editing.id}`, { method: "PATCH", body: JSON.stringify(routinePatch(before, draft)) })
                  : api("/api/routines", { method: "POST", body: JSON.stringify(draft) }),
              ).then((ok) => {
                if (ok) leaveNew();
                return ok;
              })
            }
          />
        ) : (
          <>
            <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5">
              <CalendarClock size={16} className="text-muted-foreground" />
              <DialogTitle className="text-lead">{t("common.routines")}</DialogTitle>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-5">
              {error && (
                <div className="mt-3 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">
                  {error}
                </div>
              )}

              {routines === null ? (
                <div className="py-10 text-center text-body text-muted-foreground">{t("common.loading")}</div>
              ) : routines.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="text-ui font-medium text-foreground">{t("routinesDialog.nothingScheduledYet")}</div>
                  <div className="mx-auto mt-1 max-w-[300px] text-body text-muted-foreground">
                    {t("routinesDialog.tasksYourAgentsRunOn")}
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
                                {target?.name ?? t("routinesDialog.unknownTarget")}
                              </span>
                              <span className={cn("text-small text-muted-foreground", routine.every ? "min-w-0 truncate" : "shrink-0")}>
                                {routine.every ? describeSchedule(routine) : describeAt(routine.days, routine.time)}
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
                            aria-label={
                              routine.name
                                ? t("routinesDialog.toggleNamed", { name: routine.name })
                                : t("routinesDialog.toggleUnnamed")
                            }
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
                            title={t("routinesDialog.runOnceNow")}
                            onClick={() => write(api(`/api/routines/${routine.id}/run`, { method: "POST" }))}
                          >
                            <Play size={11} />
                            {t("common.runNow")}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => startEdit(routine)}>
                            <Pencil size={11} />
                            {t("common.edit")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => write(api(`/api/routines/${routine.id}`, { method: "DELETE" }))}
                          >
                            <Trash2 size={11} />
                            {t("common.delete")}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <Button className="mt-4 w-full" variant="secondary" onClick={startNew}>
                <Plus size={13} />
                {t("routinesDialog.newRoutine")}
              </Button>
              <div className="mt-2 text-caption leading-relaxed text-muted-foreground/70">
                {t("routinesDialog.runWhileOpen", { computer: thisComputer() })}
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
  return formatDate(new Date(2000, 0, 1, Number(match[1]), Number(match[2])), {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "6 AM" or "06", for the hour marks over the week. */
function clockHour(hour: number): string {
  return formatDate(new Date(2000, 0, 1, hour), { hour: "numeric" });
}

/** "every weekday", "every Friday", "on Mon, Wed and Fri". Monday first
 * when read out, because that is how a week is said. */
function daysPhrase(days: number[]): string {
  if (days.length === 0 || days.length === 7) return t("routinesDialog.daysPhrase.everyDay");
  if (sameDays(days, WEEKDAYS)) return t("routinesDialog.daysPhrase.weekdays");
  if (sameDays(days, WEEKEND)) return t("routinesDialog.daysPhrase.weekends");
  if (days.length === 1) return t("routinesDialog.daysPhrase.oneDay", { day: weekdayName(days[0]) });
  const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return t("routinesDialog.daysPhrase.days", { days: formatList(ordered.map((d) => weekdayName(d, "short"))) });
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

/** "once, today", "once, tomorrow", "once, on Thursday", "once, on Tue 4 Nov". */
function oncePhrase(key: string, now: Date): string {
  const day = dayOf(key);
  if (!day) return t("routinesDialog.once.someDay");
  const ahead = daysFrom(now, day);
  if (ahead === 0) return t("routinesDialog.once.today");
  if (ahead === 1) return t("routinesDialog.once.tomorrow");
  if (ahead > 1 && ahead < 7) return t("routinesDialog.once.on", { day: weekdayName(day.getDay()) });
  return t("routinesDialog.once.on", { day: formatDate(day, { weekday: "short", day: "numeric", month: "short" }) });
}

/** When a run lands: today, tomorrow, or a day said by name. */
function runWhen(at: Date, now: Date): { ahead: "today" | "tomorrow" | "later"; day: string; time: string } {
  const ahead = daysFrom(now, at);
  const time = formatDate(at, { hour: "numeric", minute: "2-digit" });
  const day =
    ahead < 7
      ? formatDate(at, { weekday: "short" })
      : formatDate(at, { weekday: "short", day: "numeric", month: "short" });
  return { ahead: ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : "later", day, time };
}

/** "Today at 14:30", "Tomorrow at 9:00", "Wed at 9:00", "Tue 4 Nov at 9:00". */
function runLabel(at: Date, now: Date): string {
  const when = runWhen(at, now);
  if (when.ahead === "today") return t("routinesDialog.run.today", { time: when.time });
  if (when.ahead === "tomorrow") return t("routinesDialog.run.tomorrow", { time: when.time });
  return t("routinesDialog.run.on", { day: when.day, time: when.time });
}

/** "First run tomorrow at 9:00.", under the form; "Next run" for a
 * routine being changed, which may have run already. */
function firstRunNote(at: Date, now: Date, editing: boolean): string {
  const { ahead, day, time } = runWhen(at, now);
  if (ahead === "today") {
    return editing ? t("routinesDialog.edit.nextRun.today", { time }) : t("routinesDialog.firstRun.today", { time });
  }
  if (ahead === "tomorrow") {
    return editing ? t("routinesDialog.edit.nextRun.tomorrow", { time }) : t("routinesDialog.firstRun.tomorrow", { time });
  }
  return editing ? t("routinesDialog.edit.nextRun.on", { day, time }) : t("routinesDialog.firstRun.on", { day, time });
}

// ---------------------------------------------------------------------------
// The create form

type Mode = "weekly" | "once" | "every";
/** The words in the sentence that open an editor. */
type Part = "who" | "what" | "when" | "time" | "days" | "voice";

const PART_TITLES: Record<Part, MessageKey> = {
  who: "routinesDialog.part.who",
  what: "common.name",
  when: "routinesDialog.howOften",
  time: "routinesDialog.part.time",
  days: "routinesDialog.whichDays",
  voice: "routinesDialog.whenItSpeaksUp",
};

const HOURS_PRESETS = {
  work: { from: "09:00", to: "18:00", label: "routinesDialog.hours.work" },
  waking: { from: "08:00", to: "22:00", label: "routinesDialog.hours.waking" },
} as const satisfies Record<string, { from: string; to: string; label: MessageKey }>;

const TIME_CHIPS = ["07:00", "08:00", "09:00", "12:00", "17:00", "20:00"];

// made where they draw, so their labels are in the language of the moment
const everyStops = (): SliderStop<number>[] => CHECK_IN_EVERY.map((m) => ({ value: m, label: intervalLabel(m) }));

/** How long a routine holds its place on the calendar. The server keeps
 * fifteen-minute steps between 15 minutes and 8 hours. */
const durationStops = (): SliderStop<number>[] =>
  [15, 30, 60, 90, 120, 240].map((m) => ({ value: m, label: intervalLabel(m) }));

interface Starter {
  id: string;
  icon: typeof Sunrise;
  title: MessageKey;
  /** The name and the words it files are the person's own, so they are
   * filed in the language the person reads. */
  name: MessageKey;
  prompt: MessageKey;
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
    title: "routinesDialog.starter.digest.title",
    name: "routinesDialog.starter.digest.name",
    prompt: "routinesDialog.starter.digest.prompt",
    mode: "weekly",
    days: WEEKDAYS,
    time: "08:30",
  },
  {
    id: "inbox",
    icon: Repeat,
    title: "routinesDialog.starter.inbox.title",
    name: "routinesDialog.starter.inbox.name",
    prompt: "routinesDialog.starter.inbox.prompt",
    mode: "every",
    days: WEEKDAYS,
    every: 60,
    hours: HOURS_PRESETS.work,
    agentOnly: true,
  },
  {
    id: "friday",
    icon: FileText,
    title: "routinesDialog.starter.friday.title",
    name: "routinesDialog.starter.friday.name",
    prompt: "routinesDialog.starter.friday.prompt",
    mode: "weekly",
    days: [5],
    time: "16:00",
  },
];

/** A starter's schedule in a few words, short enough for its card. */
function starterLine(s: Starter): string {
  if (s.mode === "every" && s.every) {
    return s.every === 60
      ? t("routinesDialog.starterLine.hourlyWorkHours")
      : t("routinesDialog.starterLine.everyWorkHours", { interval: intervalLabel(s.every) });
  }
  const time = clock(s.time ?? "09:00");
  if (sameDays(s.days, WEEKDAYS)) return t("routinesDialog.starterLine.weekdays", { time });
  if (s.days.length === 1) return t("routinesDialog.starterLine.oneDay", { day: weekdayName(s.days[0]), time });
  return t("routinesDialog.starterLine.everyDay", { time });
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
  editing,
  error,
  onBack,
  onSave,
}: {
  targets: Target[];
  pinnedTargetId?: string;
  prefill?: { time?: string; days?: number[]; date?: string };
  /** The routine this changes, its values filled in; none files a new one. */
  editing?: Routine;
  error: string | null;
  onBack: () => void;
  /** Resolves true when it was filed. `before` is the form as it opened
   * on a routine being changed, so only what changed is sent. */
  onSave: (draft: RoutineDraft, before?: RoutineDraft) => Promise<boolean>;
}) {
  const [targetId, setTargetId] = useState(pinnedTargetId ?? targets[0]?.id ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  const [prompt, setPrompt] = useState(editing?.prompt ?? "");
  // at a time of day, once, or a check-in every so often (server/routines.ts)
  const [mode, setMode] = useState<Mode>(editing?.every ? "every" : editing?.repeat === "once" ? "once" : "weekly");
  const [time, setTime] = useState(editing?.time ?? prefill?.time ?? "09:00");
  const [days, setDays] = useState<number[]>(editing?.days ?? prefill?.days ?? []);
  const [date, setDate] = useState(editing?.date ?? prefill?.date ?? dateKey(new Date()));
  const [every, setEvery] = useState(editing?.every ?? 30);
  // a check-in with no hours runs all day; anything else offers work hours
  const [keepsHours, setKeepsHours] = useState(!editing?.every || Boolean(editing.activeHours));
  const [from, setFrom] = useState<string>(editing?.activeHours?.from ?? HOURS_PRESETS.work.from);
  const [to, setTo] = useState<string>(editing?.activeHours?.to ?? HOURS_PRESETS.work.to);
  // a check-in is quiet for being one, not by choice (server/routines.ts)
  const [quiet, setQuiet] = useState(Boolean(editing?.quiet && !editing.every));
  const [durationMin, setDurationMin] = useState(editing?.durationMin ?? 30);
  const [runsOn, setRunsOn] = useState<"" | "cloud" | "local" | "off">(editing?.runsOn ?? "");
  // off a Mac a routine cannot work this computer's screen either
  const { state } = useStore();
  const ownScreen = offersThisComputer(state.config?.hosted?.computers);
  const [thread, setThread] = useState(editing?.thread ?? "");
  const [part, setPart] = useState<Part>("when");
  // open on a routine that has them, so they are seen
  const [more, setMore] = useState(Boolean(editing?.runsOn || editing?.thread));
  const [saving, setSaving] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // the week ahead is drawn against the clock, so it keeps time
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(tick);
  }, []);

  const target = targets.find((option) => option.id === targetId);
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
      ? t("routinesDialog.problem.pickATime")
      : shownMode === "once" && upcoming.length === 0
        ? t("routinesDialog.problem.passed")
        : null;

  const draft: RoutineDraft | null = target
    ? {
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
      }
    : null;
  // the routine as the form first showed it: what an edit is measured against
  const [before] = useState(() => (editing ? (draft ?? undefined) : undefined));
  const changed = !before || !draft || Object.keys(routinePatch(before, draft)).length > 0;
  const ready = Boolean(prompt.trim() && target && !problem && changed);

  const save = async () => {
    if (!ready || !draft || saving) return;
    setSaving(true);
    const ok = await onSave(draft, before);
    // on success the form is already gone; on failure it stays as it was
    if (!ok) setSaving(false);
  };

  const pickStarter = (s: Starter) => {
    setName(t(s.name));
    setPrompt(t(s.prompt));
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
  const starterOn = (s: Starter) => prompt === t(s.prompt) && shownMode === s.mode;

  // the words a part shows in the sentence
  const whatWords = name.trim()
    ? t("routinesDialog.what.run", { name: name.trim() })
    : checkIn
      ? t("routinesDialog.what.checkIn")
      : t("routinesDialog.what.doThis");
  const whenWords = checkIn ? intervalPhrase(every) : shownMode === "once" ? oncePhrase(date, now) : daysPhrase(days);
  const hoursWords = hours
    ? t("routinesDialog.hoursPhrase.range", { from: clock(from), to: clock(to) })
    : t("routinesDialog.hoursPhrase.allDay");

  const firstRun = upcoming[0];
  const footerNote = error
    ? error
    : !target
      ? t("routinesDialog.footer.pickWho")
      : problem
        ? problem
        : !prompt.trim()
          ? t("routinesDialog.footer.sayWhat")
          : firstRun
            ? firstRunNote(firstRun, now, Boolean(editing))
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
        <DialogTitle className="text-heading">
          {editing ? t("routinesDialog.edit.title") : t("routinesDialog.newRoutine")}
        </DialogTitle>
        <DialogDescription className="mt-0.5">
          {editing ? t("routinesDialog.edit.description") : t("routinesDialog.somethingAnAgentDoesFor")}
        </DialogDescription>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_300px] md:overflow-hidden">
        <div className="min-w-0 px-4 pb-6 pt-5 sm:px-6 md:overflow-y-auto">
          {/* starting points: a whole routine in one press, for a new one */}
          {!editing && (
            <>
              <div className="mb-2 text-body font-medium text-muted-foreground">{t("routinesDialog.startFrom")}</div>
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
                        <span className="block truncate text-body font-medium text-foreground">{t(s.title)}</span>
                        <span className="block text-small text-muted-foreground max-sm:hidden">{starterLine(s)}</span>
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </>
          )}

          {/* what it does, in the person's words */}
          <div className="mt-5 rounded-2xl border bg-card p-1.5 shadow-[0_1px_3px_var(--shadow-color)] transition-[border-color,box-shadow] duration-150 focus-within:border-ring/50 focus-within:shadow-[0_4px_18px_-6px_var(--shadow-color)]">
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              autoFocus
              aria-label={t("routinesDialog.whatShouldItDo")}
              placeholder={
                target
                  ? t("routinesDialog.promptPlaceholder", { name: target.name })
                  : t("routinesDialog.whatShouldItDo")
              }
              className="block w-full resize-none bg-transparent px-2.5 pb-1 pt-2 text-ui leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* the schedule, said as a sentence whose parts can be tapped */}
          <p className="mt-6 text-pretty text-title leading-9 sm:text-heading sm:font-normal sm:leading-10 text-muted-foreground">
            {tr(checkIn ? "routinesDialog.sentence.checkIn" : forAgent ? "routinesDialog.sentence.agent" : "routinesDialog.sentence.room", {
              who:
                pinnedTargetId || !target ? (
                  <span className="font-medium text-foreground">{target?.name ?? t("routinesDialog.someone")}</span>
                ) : (
                  <Token part="who" active={part} onOpen={setPart}>
                    {target.name}
                  </Token>
                ),
              what: (
                <Token part="what" active={part} onOpen={setPart}>
                  {whatWords}
                </Token>
              ),
              when: (
                <Token part="when" active={part} onOpen={setPart}>
                  {whenWords}
                </Token>
              ),
              hours: (
                <Token part="time" active={part} onOpen={setPart}>
                  {hoursWords}
                </Token>
              ),
              days: (
                <Token part="days" active={part} onOpen={setPart}>
                  {daysPhrase(days)}
                </Token>
              ),
              time: (
                <Token part="time" active={part} onOpen={setPart}>
                  {clock(time)}
                </Token>
              ),
              voice: (
                <Token part="voice" active={part} onOpen={setPart}>
                  {quiet ? t("routinesDialog.speakingUpOnlyIfIt") : t("routinesDialog.andTellYouHowIt")}
                </Token>
              ),
            })}
          </p>

          {/* the editor for the part that was tapped */}
          <div id="routine-part" className="mt-3 rounded-2xl border bg-card p-3 sm:p-4">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={part === "time" && checkIn ? "hours" : part} {...swap}>
                <div className="mb-3 text-small font-medium text-muted-foreground">
                  {part === "time" && checkIn ? t("routinesDialog.whichHours") : t(PART_TITLES[part])}
                </div>
                {part === "who" && (
                  <div className="grid max-h-[188px] grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2">
                    {targets.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={option.id === targetId}
                        onClick={() => setTargetId(option.id)}
                        className={cn(
                          "flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left outline-none transition-[border-color,background-color] duration-150",
                          option.id === targetId ? "border-brand bg-brand-soft" : "border-transparent bg-muted/50 hover:bg-accent",
                        )}
                      >
                        {option.bot ? (
                          <AgentAvatar bot={option.bot} size={28} />
                        ) : (
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <Users size={14} />
                          </span>
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-body font-medium text-foreground">{option.name}</span>
                          <span className="block truncate text-caption text-muted-foreground">
                            {option.kind === "room" ? t("routinesDialog.room") : option.bot?.title || t("common.agent")}
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
                      placeholder={t("routinesDialog.eGMorningDigest")}
                      aria-label={t("common.name")}
                      className="rounded-xl text-body"
                    />
                    <div className="mt-2 text-small text-muted-foreground">
                      {t("routinesDialog.nameOptional")}{" "}
                      <button
                        type="button"
                        onClick={() => promptRef.current?.focus()}
                        className="font-medium text-foreground underline-offset-2 hover:underline"
                      >
                        {t("routinesDialog.editWhatItDoes")}
                      </button>
                    </div>
                  </>
                )}

                {part === "when" && (
                  <>
                    <Segmented
                      aria-label={t("routinesDialog.howOften")}
                      size="sm"
                      className="w-full sm:w-fit"
                      value={shownMode}
                      onChange={setMode}
                      options={[
                        { value: "weekly", label: t("routinesDialog.mode.weekly") },
                        { value: "once", label: t("routinesDialog.mode.once") },
                        ...(forAgent ? [{ value: "every" as const, label: t("routinesDialog.mode.every") }] : []),
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
                                {ahead === 0 ? t("routinesDialog.today") : t("routinesDialog.tomorrow")}
                              </Chip>
                            );
                          })}
                          <input
                            type="date"
                            value={date}
                            min={dateKey(now)}
                            onChange={(e) => e.target.value && setDate(e.target.value)}
                            aria-label={t("routinesDialog.date")}
                            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                          />
                        </div>
                      )}
                      {shownMode === "every" && (
                        <>
                          <Slider aria-label={t("routinesDialog.howOften")} stops={everyStops()} value={every} onChange={setEvery} onCommit={setEvery} />
                          <div className="mt-1 text-small text-muted-foreground">
                            {t("routinesDialog.checkInsStaySilentUnless")}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}

                {part === "time" && !checkIn && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TIME_CHIPS.map((chip) => (
                      <Chip key={chip} on={time === chip} onClick={() => setTime(chip)}>
                        {clock(chip)}
                      </Chip>
                    ))}
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      aria-label={t("routinesDialog.exactTime")}
                      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                    />
                  </div>
                )}

                {part === "time" && checkIn && (
                  <>
                    <Segmented
                      aria-label={t("routinesDialog.whichHours")}
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
                        { value: "work", label: t(HOURS_PRESETS.work.label) },
                        { value: "waking", label: t(HOURS_PRESETS.waking.label) },
                        { value: "all", label: t("routinesDialog.hours.all") },
                      ]}
                    />
                    <div className={cn("mt-3 flex flex-wrap items-center gap-2 text-body text-muted-foreground transition-opacity duration-150", !keepsHours && "opacity-50")}>
                      {tr("routinesDialog.hoursFromTo", {
                        from: (
                          <input
                            type="time"
                            value={from}
                            onChange={(e) => {
                              setKeepsHours(true);
                              setFrom(e.target.value);
                            }}
                            aria-label={t("routinesDialog.from")}
                            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                          />
                        ),
                        to: (
                          <input
                            type="time"
                            value={to}
                            onChange={(e) => {
                              setKeepsHours(true);
                              setTo(e.target.value);
                            }}
                            aria-label={t("routinesDialog.to")}
                            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-body text-foreground outline-none transition-[border-color] duration-150 focus:border-ring/60"
                          />
                        ),
                      })}
                    </div>
                  </>
                )}

                {part === "days" && <DaysEditor days={days} setDays={setDays} />}

                {part === "voice" && (
                  <div role="radiogroup" aria-label={t("routinesDialog.whenItSpeaksUp")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                      { id: "always", on: !quiet, title: t("routinesDialog.voice.always"), line: t("routinesDialog.voice.alwaysLine"), pick: () => setQuiet(false) },
                      { id: "quiet", on: quiet, title: t("routinesDialog.voice.quiet"), line: t("routinesDialog.voice.quietLine"), pick: () => setQuiet(true) },
                    ].map((o) => (
                      <button
                        key={o.id}
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
                {t("routinesDialog.moreOptions")}
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
                        <div className="mb-1 text-body font-medium text-foreground">{t("routinesDialog.howLongItTakes")}</div>
                        <div className="mb-2 text-small text-muted-foreground">{t("routinesDialog.theTimeItHoldsOn")}</div>
                        <Slider aria-label={t("routinesDialog.howLongItTakes")} stops={durationStops()} value={durationMin} onChange={setDurationMin} onCommit={setDurationMin} />
                      </div>
                    )}
                    {forAgent && target && (
                      <div>
                        {/* Was "Runs on", with None said to leave it
                            able to "think and talk, not act". Neither was
                            so: this is the screen the run is handed, and
                            the run's commands and files are on this
                            computer whichever is picked (GitHub 388). */}
                        <div className="mb-2 text-body font-medium text-foreground">{t("routinesDialog.computer")}</div>
                        <Segmented
                          aria-label={t("routinesDialog.computer")}
                          size="sm"
                          className="w-full sm:w-fit"
                          value={runsOn}
                          onChange={setRunsOn}
                          options={[
                            { value: "", label: t("routinesDialog.runsOn.usual"), title: t("routinesDialog.runsOn.usualTitle", { name: target.name }) },
                            { value: "cloud", label: t("routinesDialog.runsOn.cloud") },
                            // kept on offer for a routine that already has it
                            ...(ownScreen || runsOn === "local" ? [{ value: "local" as const, label: ThisComputer() }] : []),
                            { value: "off", label: t("routinesDialog.runsOn.none"), title: t("routinesDialog.runsOn.noneTitle") },
                          ]}
                        />
                        <div className="mt-1.5 text-small text-muted-foreground">
                          {runsOn === "cloud"
                            ? t("routinesDialog.aCloudBoxToSee")
                            : runsOn === "local"
                              ? t("routinesDialog.runsOn.ownScreen", { computer: ThisComputer() })
                              : runsOn === "off"
                                ? t("routinesDialog.noScreenToSeeOr")
                                : t("routinesDialog.runsOn.usualLine", { name: target.name })}
                          {state.instances.find((i) => i.instanceId === target.bot?.modelSelection?.instanceId)?.driverKind === "boxAgent"
                            ? ""
                            : ` ${t("routinesDialog.runsOn.eitherWay", { computer: thisComputer() })}`}
                        </div>
                      </div>
                    )}
                    {forAgent && (
                      <div>
                        <div className="mb-2 text-body font-medium text-foreground">{t("routinesDialog.conversation")}</div>
                        <Input
                          value={thread}
                          maxLength={40}
                          onChange={(e) => setThread(e.target.value)}
                          placeholder={t("common.general")}
                          aria-label={t("routinesDialog.conversation")}
                          className="max-w-[260px] rounded-xl text-body"
                        />
                        <div className="mt-1.5 text-small text-muted-foreground">
                          {t("routinesDialog.leaveBlankForTheMain")}
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
        <aside aria-label={t("common.preview")} className="flex flex-col border-t bg-sidebar/50 px-5 py-5 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
          <div className="mb-3 text-body font-medium text-muted-foreground">{t("routinesDialog.theWeekAhead")}</div>
          <WeekAhead schedule={schedule} now={now} next={firstRun} />

          <div className="mb-2 mt-6 text-body font-medium text-muted-foreground">{t("routinesDialog.nextRuns")}</div>
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
            <div className="text-body text-muted-foreground">{t("routinesDialog.nothingComingUp")}</div>
          )}

          <div className="mb-2 mt-6 text-body font-medium text-muted-foreground">
            {target ? t("routinesDialog.whatNameIsAsked", { name: target.name }) : t("routinesDialog.whatItIsAsked")}
          </div>
          <div className="rounded-xl border bg-card px-3 py-2.5">
            {name.trim() && <div className="mb-0.5 truncate text-small font-medium text-foreground">{name.trim()}</div>}
            <div className={cn("line-clamp-5 whitespace-pre-wrap text-body leading-relaxed", prompt.trim() ? "text-foreground" : "text-muted-foreground")}>
              {prompt.trim() || t("routinesDialog.writeItOnTheLeft")}
            </div>
          </div>
          {/* what an edit leaves as it was and the form does not show */}
          {editing && (!editing.enabled || editing.briefOnly) && (
            <div className="mt-3 flex flex-col gap-1 text-small text-muted-foreground">
              {!editing.enabled && <span>{t("routinesDialog.edit.paused")}</span>}
              {editing.briefOnly && <span>{t("routinesDialog.edit.briefOnly")}</span>}
            </div>
          )}

          <div className="mt-auto pt-6 text-caption leading-relaxed text-muted-foreground/80">
            {t("routinesDialog.runWhileOpen", { computer: thisComputer() })}
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
          {editing ? t("common.cancel") : t("common.back")}
        </Button>
        <Button size="lg" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={15} className="animate-spin" /> : <CalendarClock size={15} />}
          {editing
            ? saving
              ? t("routinesDialog.edit.saving")
              : t("routinesDialog.edit.save")
            : saving
              ? t("routinesDialog.scheduling")
              : t("routinesDialog.scheduleIt")}
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
      aria-label={t("routinesDialog.tokenLabel", { part: t(PART_TITLES[part]), words: children })}
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
        aria-label={t("routinesDialog.whichDays")}
        size="sm"
        className="w-full sm:w-fit"
        value={set}
        onChange={(v) => setDays(v === "weekdays" ? WEEKDAYS : v === "weekends" ? WEEKEND : [])}
        options={[
          { value: "all", label: t("routinesDialog.daysSet.all") },
          { value: "weekdays", label: t("routinesDialog.daysSet.weekdays") },
          { value: "weekends", label: t("routinesDialog.daysSet.weekends") },
        ]}
      />
      <div className="mt-3 flex gap-1.5" role="group" aria-label={t("routinesDialog.days")}>
        {WEEK.map((day) => {
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
              title={weekdayName(day)}
              aria-label={weekdayName(day)}
              aria-pressed={on}
              className={cn(
                "size-9 rounded-full text-small font-semibold outline-none transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.92]",
                on ? "bg-brand-ink text-brand-foreground" : "bg-muted text-muted-foreground hover:bg-accent",
              )}
            >
              {weekdayName(day, "narrow")}
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
          const label = i === 0 ? t("routinesDialog.today") : formatDate(day, { weekday: "short" });
          const dayName = i === 0 ? t("routinesDialog.today") : weekdayName(day.getDay());
          const spoken = !runs.length
            ? t("routinesDialog.weekRow.nothing", { day: dayName })
            : schedule.every
              ? t("routinesDialog.weekRow.checkIns", { day: dayName, count: runs.length })
              : t("routinesDialog.weekRow.at", { day: dayName, time: clock(schedule.time) });
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
                      {band.ticks.map((tick) => {
                        const minutes = band.top + tick;
                        const past = i === 0 && minutes <= nowMinutes;
                        const isNext = `${key} ${minutes}` === nextKey;
                        return (
                          <span
                            key={tick}
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
