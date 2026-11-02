// Automations: the schedule surface, grown up.
//
// A routine is an appointment an agent keeps, so the primary view is a
// calendar, not a list: a time gutter, day columns, and a card at every
// hour a routine will run. The other tabs share the page (watchers,
// standing intents, workflows, webhooks, the job board) because all of
// them answer "what happens without me pressing anything". Full-viewport overlay, matching the app's own language:
// tokens, Blok avatars, quiet chrome; the reference material's ideas,
// none of its skin.
//
// Occurrences are projected client-side from each routine's time and
// weekday set. The calendar shows intentions, and the details popover is
// where a specific routine is paused, run now, or removed.
//
// A check-in is not an appointment, and one every quarter of an hour
// drawn as cards would bury the week. So it is a thin band over its hours
// with a tick for each check-in, a chip in the month, and a row in the
// Check-ins strip under the grid that says it in words.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock } from "@/components/icons";
import { ChevronLeft } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Copy } from "@/components/icons";
import { Check } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Play } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Repeat } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Users } from "@/components/icons";
import { Webhook } from "@/components/icons";
import { Briefcase } from "@/components/icons";
import { Workflow } from "@/components/icons";
import { useStore, type AutomationsTab, type Bot } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { type Routine, type RoutineRun } from "./RoutinesSection";
import { RoutinesDialog } from "./RoutinesDialog";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { Switch } from "@/components/ui/switch";
import { useEscape } from "@/lib/useEscape";
import { JobBoard } from "./JobBoard";
import { Workflows } from "./Workflows";
import { cn } from "@/lib/cn";
import { WatchersTab } from "./WatchersTab";
import { IntentsTab } from "./IntentsTab";
import { Zap } from "@/components/icons";
import { Eye } from "@/components/icons";
import { thisComputer } from "@/lib/thisComputer";
import { cardLanes, gridHours } from "@/lib/dayGrid";
import { checkInBand, foldQuietRuns, intervalShort } from "@/lib/checkIns";
import { AUTOMATIONS_LIST, AUTOMATIONS_LIST_SIZE, useColumnFolded } from "@/lib/sideColumn";
import { ShowColumn, SideColumn } from "./SideColumn";
import { Markdownish } from "./Markdown";
import { describeSchedule, runElapsed, runSource, weekdayName } from "@/lib/routineDetails";
import { formatDate, formatList, t, type MessageKey } from "@/lib/i18n";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

interface WebhookRow {
  id: string;
  token: string;
  name: string;
  botId?: string;
  blokId?: string;
  enabled: boolean;
  /** The conversation an agent's events go to; absent is its first. */
  thread?: string;
  lastFiredAt?: number;
  firedCount?: number;
  deliveries?: Array<{ at: number; excerpt: string }>;
}

const HOUR_PX = 52;

const VIEW_LABELS: Record<"day" | "week" | "month", MessageKey> = {
  day: "automationsPanel.view.day",
  week: "automationsPanel.view.week",
  month: "automationsPanel.view.month",
};
/** How far apart check-in bands sit, side by side at a column's edge. */
const BAND_STEP = 10;
/** The shortest a routine's card is drawn, so its name always fits. */
const CARD_MIN_PX = 34;
/** The space between two cards side by side. */
const CARD_GAP = 2;

const dayKey = (d: Date) => d.toDateString();

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function addMonths(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

export function AutomationsPanel({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  // a page like Settings, and closed the same way; the routine dialog on
  // top of it registers after this and so takes Escape first
  useEscape(onClose);
  // a link from elsewhere (the security checkup's webhooks) opens its tab
  const [tab, setTab] = useState<AutomationsTab>(state.routinesTab ?? "schedules");
  // and so does one that arrives while the page is already open
  useEffect(() => {
    if (state.routinesTab) setTab(state.routinesTab);
  }, [state.routinesTab]);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [mode, setMode] = useState<"day" | "week" | "month">("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [filterId, setFilterId] = useState<string>("");
  const [creating, setCreating] = useState<{ time?: string; days?: number[]; date?: string } | null>(null);
  const [selected, setSelected] = useState<Routine | null>(null);
  // the routine whose form is open, over its details
  const [editing, setEditing] = useState<Routine | null>(null);

  // drag-to-reschedule: pointer-tracked, snapped to 15 minutes, dropped
  // onto whichever day column the pointer ends over, the way any
  // grown-up calendar moves an appointment
  const columnRects = useRef(new Map<number, { el: HTMLDivElement; day: Date }>());
  const [drag, setDrag] = useState<{
    routine: Routine;
    fromDay: number;
    x: number;
    y: number;
    minutes: number;
    dayIndex: number | null;
  } | null>(null);
  const dragMoved = useRef(false);

  const dropPoint = (clientX: number, clientY: number) => {
    for (const [index, { el }] of columnRects.current) {
      const rect = el.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right) {
        const raw = ((clientY - rect.top) / HOUR_PX) * 60 + hours.start * 60;
        const snapped = Math.round(raw / 15) * 15;
        // clamp into the hours the grid actually draws, so a drop can
        // never send a chip somewhere the calendar cannot show it
        return {
          dayIndex: index,
          minutes: Math.max(hours.start * 60, Math.min(hours.end * 60 - 15, snapped)),
        };
      }
    }
    return { dayIndex: null, minutes: 0 };
  };

  const beginDrag = (routine: Routine, fromDay: number, e: React.PointerEvent) => {
    const startX = e.clientX;
    const startY = e.clientY;
    dragMoved.current = false;
    const onMove = (ev: PointerEvent) => {
      if (!dragMoved.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      dragMoved.current = true;
      const { dayIndex, minutes } = dropPoint(ev.clientX, ev.clientY);
      setDrag({ routine, fromDay, x: ev.clientX, y: ev.clientY, minutes, dayIndex });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDrag(null);
      // the guard must outlive the click this pointerup produces, and
      // die right after: a cross-column drop's click lands on an
      // ancestor with no handler to consume it
      setTimeout(() => {
        dragMoved.current = false;
      }, 0);
      if (!dragMoved.current) return;
      const { dayIndex, minutes } = dropPoint(ev.clientX, ev.clientY);
      const slot = dayIndex !== null ? columnRects.current.get(dayIndex) : null;
      if (!slot) return;
      const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      const toDay = slot.day.getDay();
      // a once routine moves its calendar day; a specific-days routine
      // moves that weekday; an every-day routine only changes its clock
      const patch =
        routine.repeat === "once"
          ? {
              time,
              date: `${slot.day.getFullYear()}-${String(slot.day.getMonth() + 1).padStart(2, "0")}-${String(slot.day.getDate()).padStart(2, "0")}`,
            }
          : {
              time,
              days:
                routine.days.length === 0 || toDay === fromDay
                  ? routine.days
                  : [...new Set(routine.days.filter((d) => d !== fromDay).concat(toDay))].sort(),
            };
      void write(
        api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
      );
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const bots = state.bots.filter((b) => !b.hidden);
  const targetOf = useCallback(
    (id: string): { name: string; bot?: Bot } | null => {
      const bot = state.bots.find((b) => b.id === id);
      if (bot) return { name: bot.name, bot };
      const room = state.bloks.find((r) => r.id === id);
      return room ? { name: room.name } : null;
    },
    [state.bots, state.bloks],
  );

  const load = useCallback(() => {
    api("/api/routines")
      .then(({ routines }: { routines: Routine[] }) => setRoutines(routines))
      .catch(() => setRoutines([]));
  }, []);
  // and again when the server says routines changed, so one that has
  // just stopped for failing shows here without a reopen
  useEffect(load, [load, state.ticks.routines]);
  // A card about a routine that stopped for failing opens it here, once:
  // later reloads must not keep opening it over whatever is in view.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const focus = state.routinesFocus;
    if (focus?.kind !== "routine" || !routines || focused.current === focus.id) return;
    focused.current = focus.id;
    const routine = routines.find((r) => r.id === focus.id);
    if (routine) setSelected(routine);
  }, [routines, state.routinesFocus]);

  const [writeError, setWriteError] = useState<string | null>(null);
  const write = (run: Promise<unknown>) =>
    run
      .then(() => {
        setWriteError(null);
        load();
      })
      .catch((e: Error) => {
        setWriteError(e.message);
        load();
      });

  // the visible days: week starts on Monday, like a work calendar
  const days = useMemo(() => {
    if (mode === "day") return [anchor];
    const first = addDays(anchor, -((anchor.getDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => addDays(first, i));
  }, [anchor, mode]);

  const visible = (routines ?? []).filter((r) => !filterId || r.targetId === filterId);

  /** Which routines land on a given day, with their minute offsets. A
   * once routine lands only on its own date. Check-ins are drawn apart
   * (checkInsOn). */
  const occurrences = useCallback(
    (day: Date) =>
      visible
        .filter((r) => r.enabled && !r.every)
        .filter((r) =>
          r.repeat === "once"
            ? r.date ===
              `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
            : r.days.length === 0 || r.days.includes(day.getDay()),
        )
        .map((r) => {
          const [h, m] = r.time.split(":").map(Number);
          return { routine: r, minutes: h * 60 + (m || 0) };
        })
        .sort((a, b) => a.minutes - b.minutes),
    [visible],
  );
  // the hours the Day and Week grids draw: wide enough for every routine
  // on the days in view, a 3 AM one included
  const hours = gridHours(days.flatMap((day) => occurrences(day).map((slot) => slot.minutes)));

  /** The check-ins that run on a given day, each drawn as one band. */
  const checkInsOn = useCallback(
    (day: Date) =>
      visible.filter((r) => r.enabled && r.every && (r.days.length === 0 || r.days.includes(day.getDay()))),
    [visible],
  );

  const checkIns = visible.filter((r) => r.enabled && r.every);
  const paused = visible.filter((r) => !r.enabled);
  const monthLabel = formatDate(mode === "month" ? anchor : days[0], { month: "long", year: "numeric" });
  const today = dayKey(new Date());

  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 animate-fade-in flex-col bg-background">
      {/* ── header ── */}
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b px-5 max-md:pl-16">
        {/* The panel sits beside the sidebar, so it is narrower than the
            window and a viewport breakpoint cannot see that. The title
            gives up its width instead: the tabs are the controls, and a
            subtitle is the first thing that can go. Leaving is the title
            bar's Back, or Esc. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock size={18} className="shrink-0 text-brand-ink" />
          <div className="min-w-0">
            <div className="truncate text-lead font-semibold leading-tight text-foreground">
              {t("automationsPanel.automations")}
            </div>
            <div className="hidden truncate text-small leading-tight text-muted-foreground sm:block">
              {t("automationsPanel.whatRunsWithoutYou")}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(
              [
                ["schedules", "automationsPanel.tab.schedules", <CalendarClock key="s" size={13} />],
                ["watchers", "automationsPanel.tab.watchers", <Eye key="e" size={13} />],
                ["intents", "automationsPanel.tab.intents", <Zap key="i" size={13} />],
                ["workflows", "automationsPanel.tab.workflows", <Workflow key="f" size={13} />],
                ["webhooks", "automationsPanel.webhooks", <Webhook key="w" size={13} />],
                ["jobs", "automationsPanel.tab.jobs", <Briefcase key="j" size={13} />],
              ] as const
            ).map(([key, label, icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-body transition-colors duration-150",
                  tab === key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {icon}
                <span className="hidden sm:inline">{t(label)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === "jobs" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <JobBoard />
        </div>
      ) : tab === "workflows" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <Workflows />
        </div>
      ) : tab === "webhooks" ? (
        <WebhooksTab targetOf={targetOf} />
      ) : tab === "watchers" ? (
        <WatchersTab />
      ) : tab === "intents" ? (
        <IntentsTab />
      ) : (
        <>
          {/* ── calendar controls ── */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2.5">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label={t("automationsPanel.earlier")} onClick={() => setAnchor(mode === "month" ? addMonths(anchor, -1) : addDays(anchor, mode === "day" ? -1 : -7))}>
                <ChevronLeft size={15} />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
                {t("automationsPanel.today")}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("automationsPanel.later")} onClick={() => setAnchor(mode === "month" ? addMonths(anchor, 1) : addDays(anchor, mode === "day" ? 1 : 7))}>
                <ChevronRight size={15} />
              </Button>
            </div>
            <span className="text-ui font-semibold text-foreground">{monthLabel}</span>

            <select
              value={filterId}
              onChange={(e) => setFilterId(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1.5 text-body text-foreground outline-none focus:border-ring/60"
            >
              <option value="">{t("automationsPanel.everyone")}</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
              {state.bloks.map((r) => (
                <option key={r.id} value={r.id}>{t("automationsPanel.roomOption", { name: r.name })}</option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                {(["day", "week", "month"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-small transition-colors duration-150",
                      mode === m
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(VIEW_LABELS[m])}
                  </button>
                ))}
              </div>
              <Button size="sm" onClick={() => setCreating({})}>
                <Plus size={13} />
                {t("automationsPanel.newRoutine")}
              </Button>
            </div>
          </div>

          {writeError && (
            <div className="mx-5 mt-2 shrink-0 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">
              {writeError}
            </div>
          )}
          {/* ── stopped for failing: above the calendar, since a routine
              that will not run is the thing on it that needs a person ── */}
          {(routines ?? []).filter((r) => r.failing).map((routine) => (
            <FailingRoutine
              key={routine.id}
              routine={routine}
              target={targetOf(routine.targetId)}
              onOpen={() => setSelected(routine)}
              onWrite={write}
            />
          ))}
          {/* ── the grid ── */}
          {routines !== null && routines.length === 0 ? (
            <EmptyRhythm onCreate={() => setCreating({})} />
          ) : mode === "month" ? (
            <MonthGrid
              anchor={anchor}
              occurrences={occurrences}
              checkInsOn={checkInsOn}
              targetOf={targetOf}
              onZoom={(day) => {
                // a month cell zooms into that day for the full detail
                setAnchor(startOfDay(day));
                setMode("day");
              }}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex min-w-[640px]">
                {/* time gutter */}
                <div className="sticky left-0 z-10 w-14 shrink-0 border-r bg-background pt-[34px]">
                  {Array.from({ length: hours.end - hours.start }, (_, i) => (
                    <div key={i} className="relative" style={{ height: HOUR_PX }}>
                      <span className="absolute -top-2 right-2 text-caption tabular-nums text-muted-foreground/70">
                        {t(hours.start + i < 12 ? "automationsPanel.hourAm" : "automationsPanel.hourPm", {
                          hour: String((hours.start + i) % 12 || 12),
                        })}
                      </span>
                    </div>
                  ))}
                </div>

                {days.map((day, dayIndex) => {
                  const isToday = dayKey(day) === today;
                  const bands = checkInsOn(day);
                  // the cards leave the bands their own strip on the right
                  const cardsRight = bands.length ? 6 + bands.length * BAND_STEP : 4;
                  // each card where it is drawn, and those that overlap as
                  // drawn, the shortest ones' height included, side by side
                  const slots = occurrences(day).map((slot) => {
                    const top = Math.max(0, ((slot.minutes - hours.start * 60) / 60) * HOUR_PX);
                    // the card blocks out its duration, like an
                    // appointment would
                    const height = Math.max(CARD_MIN_PX, ((slot.routine.durationMin ?? 30) / 60) * HOUR_PX - 2);
                    return { ...slot, top, height };
                  });
                  const lanes = cardLanes(slots.map(({ routine, top, height }) => ({ id: routine.id, start: top, end: top + height })));
                  // the width the cards share, between the left edge and the bands
                  const room = `(100% - ${4 + cardsRight}px)`;
                  return (
                    <div key={day.toISOString()} className="min-w-0 flex-1 border-r last:border-r-0">
                      <div
                        className={cn(
                          "sticky top-0 z-10 flex h-[34px] items-center justify-center gap-1.5 border-b bg-background text-small font-medium uppercase tracking-[0.06em]",
                          isToday ? "text-brand-ink" : "text-muted-foreground",
                        )}
                      >
                        {formatDate(day, { weekday: "short" })}
                        <span
                          className={cn(
                            "flex size-[22px] items-center justify-center rounded-full text-small tabular-nums",
                            isToday && "bg-brand-ink font-semibold text-brand-foreground",
                          )}
                        >
                          {day.getDate()}
                        </span>
                      </div>

                      <div
                        ref={(el) => {
                          if (el) columnRects.current.set(dayIndex, { el, day });
                          else columnRects.current.delete(dayIndex);
                        }}
                        className="relative"
                        style={{ height: (hours.end - hours.start) * HOUR_PX }}
                        onClick={(e) => {
                          // the click that ends a drag lands here too (the
                          // click target is the columns' common ancestor);
                          // a drop must never open the create dialog
                          if (dragMoved.current) {
                            dragMoved.current = false;
                            return;
                          }
                          // clicking empty grid starts a routine at that hour
                          const rect = e.currentTarget.getBoundingClientRect();
                          const minutes = ((e.clientY - rect.top) / HOUR_PX + hours.start) * 60;
                          const hour = Math.max(0, Math.min(23, Math.floor(minutes / 60)));
                          setCreating({
                            time: `${String(hour).padStart(2, "0")}:00`,
                            days: [day.getDay()],
                            date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
                          });
                        }}
                      >
                        {/* hour lines */}
                        {Array.from({ length: hours.end - hours.start }, (_, i) => (
                          <div
                            key={i}
                            className="absolute inset-x-0 border-t border-border/60"
                            style={{ top: i * HOUR_PX }}
                          />
                        ))}
                        {/* the moment it is right now */}
                        {isToday && <NowLine start={hours.start} end={hours.end} />}

                        {/* check-ins: a band over their hours, a tick each */}
                        {bands.map((routine, i) => {
                          const band = checkInBand(routine, hours.start, hours.end);
                          if (!band) return null;
                          const target = targetOf(routine.targetId);
                          const label = target
                            ? t("automationsPanel.bandLabelFor", {
                                name: routine.name || routine.prompt,
                                schedule: describeSchedule(routine),
                                target: target.name,
                              })
                            : t("automationsPanel.bandLabel", { name: routine.name || routine.prompt, schedule: describeSchedule(routine) });
                          return (
                            <button
                              key={routine.id}
                              title={label}
                              aria-label={label}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected(routine);
                              }}
                              className="absolute w-2 overflow-hidden rounded-full border border-brand/40 bg-brand/10 transition-colors duration-150 hover:border-brand hover:bg-brand/20"
                              style={{
                                top: (band.top / 60) * HOUR_PX,
                                height: Math.max(8, (band.height / 60) * HOUR_PX),
                                right: 4 + i * BAND_STEP,
                              }}
                            >
                              {band.ticks.map((tick) => (
                                <span
                                  key={tick}
                                  className="absolute inset-x-0 h-px bg-brand-ink"
                                  style={{ top: (tick / 60) * HOUR_PX }}
                                />
                              ))}
                            </button>
                          );
                        })}

                        {slots.map(({ routine, top, height }) => {
                          const target = targetOf(routine.targetId);
                          const lane = lanes.get(routine.id) ?? { column: 0, columns: 1 };
                          const gap = lane.columns > 1 ? CARD_GAP : 0;
                          // a narrow card cuts its words short, so the whole of
                          // it is on hover and for a screen reader
                          const named = { name: routine.name || routine.prompt, time: routine.time };
                          const label =
                            routine.repeat === "once"
                              ? target
                                ? t("automationsPanel.cardLabel.onceFor", { ...named, target: target.name })
                                : t("automationsPanel.cardLabel.once", named)
                              : target
                                ? t("automationsPanel.cardLabel.for", { ...named, target: target.name })
                                : t("automationsPanel.cardLabel.plain", named);
                          return (
                            <button
                              key={routine.id}
                              title={label}
                              aria-label={label}
                              onPointerDown={(e) => beginDrag(routine, day.getDay(), e)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (dragMoved.current) {
                                  dragMoved.current = false;
                                  return;
                                }
                                setSelected(routine);
                              }}
                              className={cn(
                                "@container absolute flex cursor-grab touch-none items-start gap-1.5 overflow-hidden rounded-lg border border-brand/25 bg-brand-soft px-1.5 py-1 text-left shadow-sm transition-transform duration-150 hover:scale-[1.02]",
                                drag?.routine.id === routine.id && "opacity-40",
                              )}
                              style={{
                                left: `calc(4px + ${room} * ${lane.column / lane.columns})`,
                                width: `calc(${room} / ${lane.columns} - ${gap}px)`,
                                top,
                                height,
                              }}
                            >
                              {/* too narrow for the face and the name, the name stays */}
                              <span className="flex shrink-0 @max-[64px]:hidden">
                                {target?.bot ? (
                                  <AgentAvatar bot={target.bot} size={18} />
                                ) : (
                                  <span className="flex size-[18px] items-center justify-center rounded-full bg-muted">
                                    <Users size={10} />
                                  </span>
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-caption font-medium leading-tight text-foreground">
                                  {routine.name || routine.prompt}
                                </span>
                                <span className="block truncate text-micro leading-tight text-muted-foreground">
                                  {t(routine.repeat === "once" ? "automationsPanel.cardLine.once" : "automationsPanel.cardLine.plain", {
                                    time: routine.time,
                                    target: target?.name ?? "?",
                                  })}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── check-ins, in words ── */}
          {checkIns.length > 0 && (
            <div className="shrink-0 border-t px-5 py-2.5">
              <div className="mb-1.5 text-small font-medium text-muted-foreground">
                {t("automationsPanel.checkIns")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {checkIns.map((routine) => {
                  const target = targetOf(routine.targetId);
                  return (
                    <button
                      key={routine.id}
                      onClick={() => setSelected(routine)}
                      className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-brand/25 bg-brand-soft px-2.5 py-1 text-small transition-colors hover:border-brand/50"
                    >
                      {target?.bot ? <AgentAvatar bot={target.bot} size={16} /> : <Repeat size={12} className="shrink-0 text-brand-ink" />}
                      <span className="max-w-[160px] shrink-0 truncate font-medium text-foreground">{routine.name || routine.prompt}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{describeSchedule(routine)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── paused strip ── */}
          {paused.length > 0 && (
            <div className="shrink-0 border-t px-5 py-2.5">
              <div className="mb-1.5 text-small font-medium text-muted-foreground">
                {t("common.paused")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {paused.map((routine) => {
                  const target = targetOf(routine.targetId);
                  return (
                    <button
                      key={routine.id}
                      onClick={() => setSelected(routine)}
                      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-small text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                    >
                      {target?.bot && <AgentAvatar bot={target.bot} size={16} />}
                      <span className="max-w-[200px] truncate">{routine.name || routine.prompt}</span>
                      {routine.repeat === "once" && routine.lastRunAt && (
                        <span className="text-caption text-success">{t("automationsPanel.ran")}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {drag && drag.dayIndex !== null && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border border-brand/40 bg-brand-soft px-2 py-1 shadow-lg"
          style={{ left: drag.x, top: drag.y - 8 }}
        >
          <span className="text-caption font-medium text-foreground">
            {`${String(Math.floor(drag.minutes / 60)).padStart(2, "0")}:${String(drag.minutes % 60).padStart(2, "0")}`}
            {" · "}
            {(() => {
              const day = columnRects.current.get(drag.dayIndex)?.day;
              return day ? formatDate(day, { weekday: "short" }) : null;
            })()}
          </span>
        </div>
      )}
      {creating && (
        <RoutinesDialog
          startCreating
          prefill={creating}
          onClose={() => {
            setCreating(null);
            load();
          }}
        />
      )}
      {selected && (
        <RoutineDetails
          // as last read, so a change saved from its form shows here at once
          routine={routines?.find((r) => r.id === selected.id) ?? selected}
          target={targetOf(selected.targetId)}
          onWrite={write}
          onEdit={setEditing}
          onClose={() => setSelected(null)}
        />
      )}
      {editing && (
        <RoutinesDialog
          edit={editing}
          onClose={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </main>
  );
}

/**
 * A routine that stopped running on its own after failing again and
 * again: what it last said, and the three things to do about it. Fix it
 * opens the routine, where saving any change starts it again; Pause
 * switches it off; Remove takes it away. Each is the ordinary route.
 */
function FailingRoutine({
  routine,
  target,
  onOpen,
  onWrite,
}: {
  routine: Routine;
  target: { name: string; bot?: Bot } | null;
  onOpen: () => void;
  onWrite: (run: Promise<unknown>) => void;
}) {
  const name = routine.name || routine.prompt;
  const remove = async () => {
    const yes = await confirm({
      title: t("automationsPanel.removeRoutine.title", { name }),
      body: t("automationsPanel.removeRoutine.body"),
      confirmLabel: t("common.remove"),
      destructive: true,
    });
    if (yes) onWrite(api(`/api/routines/${routine.id}`, { method: "DELETE" }));
  };
  return (
    <div className="mx-5 mt-2.5 flex shrink-0 flex-col gap-2 rounded-xl border bg-card px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {target?.bot ? <AgentAvatar bot={target.bot} size={22} /> : <Repeat size={14} className="mt-0.5 shrink-0 text-warning" />}
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-foreground">{name}</div>
          <div className="text-small text-muted-foreground">
            <span className="text-warning">{t("automationsPanel.stoppedAfter", { count: routine.failures ?? 3 })}</span>{" "}
            {routine.failing?.error}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="secondary" size="sm" onClick={onOpen}>
          {t("automationsPanel.fixIt")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onWrite(api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) }))}>
          {t("common.pause")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void remove()}>
          {t("common.remove")}
        </Button>
      </div>
    </div>
  );
}

/** The red line of the present moment, updated each minute, on a grid
 * that draws the hours from `start` to `end`. */
function NowLine({ start, end }: { start: number; end: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const top = ((minutes - start * 60) / 60) * HOUR_PX;
  if (top < 0 || top > (end - start) * HOUR_PX) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top }}>
      <div className="h-px bg-destructive" />
      <div className="absolute -left-1 -top-[3px] size-[7px] rounded-full bg-destructive" />
    </div>
  );
}

function EmptyRhythm({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex items-center gap-2">
        <BlokAvatar color="blue" shape="star" expression="friendly" size={52} />
        <BlokAvatar color="green" shape="cloud" expression="excited" size={52} />
      </div>
      <div>
        <div className="text-title font-semibold text-foreground">
          {t("automationsPanel.putYourAgentsOnA")}
        </div>
        <div className="mx-auto mt-1 max-w-[380px] text-body leading-relaxed text-muted-foreground">
          {t("automationsPanel.dailyDigestsWeeklyReportsRegular")}
        </div>
      </div>
      <Button onClick={onCreate}>
        <Plus size={14} />
        {t("automationsPanel.createYourFirstRoutine")}
      </Button>
    </div>
  );
}

/** The month at a glance: six weeks of cells, each carrying the day's
 * routines as tiny chips. A cell is a door, clicking zooms into that
 * day's hour view for the full detail. */
function MonthGrid({
  anchor,
  occurrences,
  checkInsOn,
  targetOf,
  onZoom,
}: {
  anchor: Date;
  occurrences: (day: Date) => Array<{ routine: Routine; minutes: number }>;
  checkInsOn: (day: Date) => Routine[];
  targetOf: (id: string) => { name: string; bot?: Bot } | null;
  onZoom: (day: Date) => void;
}) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = addDays(monthStart, -((monthStart.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = dayKey(new Date());

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-2xl border bg-border">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <div
            key={d}
            className="bg-background px-2 py-1.5 text-center text-caption font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {weekdayName(d, "short")}
          </div>
        ))}
        {cells.map((day) => {
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = dayKey(day) === today;
          // a check-in is one chip a day however often it runs
          const slots = [
            ...occurrences(day).map(({ routine }) => ({ routine, when: routine.time, checkIn: false })),
            ...checkInsOn(day).map((routine) => ({ routine, when: intervalShort(routine.every!), checkIn: true })),
          ];
          return (
            <button
              key={day.toISOString()}
              onClick={() => onZoom(day)}
              className={cn(
                "flex min-h-[86px] flex-col items-stretch gap-1 bg-background p-1.5 text-left transition-colors duration-150 hover:bg-accent/50",
                !inMonth && "opacity-45",
              )}
            >
              <span
                className={cn(
                  "self-start rounded-full px-1.5 text-caption tabular-nums leading-[18px]",
                  isToday ? "bg-brand-ink font-semibold text-brand-foreground" : "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </span>
              {slots.slice(0, 3).map(({ routine, when, checkIn }) => {
                const target = targetOf(routine.targetId);
                return (
                  <span
                    key={routine.id}
                    className={cn(
                      "flex items-center gap-1 overflow-hidden rounded-md border px-1 py-0.5",
                      checkIn ? "border-dashed border-brand/30" : "border-brand/20 bg-brand-soft",
                    )}
                  >
                    {checkIn ? (
                      <Repeat size={10} className="shrink-0 text-brand-ink" />
                    ) : (
                      target?.bot && <AgentAvatar bot={target.bot} size={12} />
                    )}
                    <span className="truncate text-micro font-medium text-foreground">
                      {when} {routine.name || routine.prompt}
                    </span>
                  </span>
                );
              })}
              {slots.length > 3 && (
                <span className="px-1 text-micro text-muted-foreground">
                  {t("automationsPanel.moreSlots", { count: slots.length - 3 })}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What actually happened, the last twenty times.
 *
 * A routine that fires into the dark is one you end up not trusting: the
 * first question anybody asks is "did my nine o'clock run, and what did
 * it say", and until this existed the honest answer was that nobody
 * knew. Each row carries the agent's own first words, so the list is
 * readable without opening the lane behind it. */
function RunHistory({ routine }: { routine: Routine }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const runs = routine.runs;
  if (!runs?.length) {
    return (
      <div className="mt-4 border-t pt-3 text-small text-muted-foreground">
        {t("automationsPanel.noRunsYet")}
      </div>
    );
  }
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-1.5 text-small font-medium text-muted-foreground">
        {t("automationsPanel.recentRuns")}
      </div>
      <div>
        {foldQuietRuns(runs).map((row) => {
          // a stretch of quiet check-ins is one row: they ran, and nothing needed you
          if ("quiet" in row) {
            const newest = row.quiet[0];
            const oldest = row.quiet[row.quiet.length - 1];
            const at = (run: RoutineRun) => formatDate(run.startedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            return (
              <div key={newest.id} className="flex w-full items-start gap-2 px-1.5 py-1.5">
                <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-small tabular-nums text-muted-foreground">
                      {row.quiet.length === 1 ? at(newest) : t("automationsPanel.quietSpan", { from: at(oldest), to: at(newest) })}
                    </span>
                    <span className="shrink-0 text-caption text-muted-foreground">{t("automationsPanel.quiet")}</span>
                  </span>
                  <span className="mt-0.5 block text-small text-muted-foreground">
                    {row.quiet.length === 1
                      ? t("automationsPanel.nothingNeededYou")
                      : t("automationsPanel.quietCheckIns", { count: row.quiet.length })}
                  </span>
                </span>
              </div>
            );
          }
          const { run } = row;
          const showing = open === run.id;
          const detail = run.error ?? run.summary ?? "";
          const source = runSource(routine, run, state.bots, state.bloks);
          return (
            <div key={run.id}>
              <button
                onClick={() => setOpen(showing ? null : run.id)}
                aria-expanded={showing}
                aria-controls={`routine-run-${run.id}`}
                className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-accent/60"
              >
                <span
                  className={cn(
                    "mt-[5px] size-1.5 shrink-0 rounded-full",
                    run.state === "ok"
                      ? "bg-success"
                      : run.state === "failed"
                        ? "bg-destructive"
                        : "animate-pulse bg-brand",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-small tabular-nums text-foreground">
                      {formatDate(run.startedAt, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                    <span className="shrink-0 text-caption text-muted-foreground">
                      {runElapsed(run)}
                    </span>
                  </span>
                  {detail && !showing && (
                    <span className={cn("mt-0.5 block truncate text-small leading-relaxed", run.error ? "text-destructive" : "text-muted-foreground")}>
                      {detail}
                    </span>
                  )}
                  <span className="mt-0.5 flex items-center gap-1 text-caption text-muted-foreground">
                    <ChevronRight size={12} className={cn("shrink-0", showing && "rotate-90")} />
                    {showing ? t("automationsPanel.hideDetails") : t("automationsPanel.showDetails")}
                  </span>
                </span>
              </button>
              {showing && (
                <div id={`routine-run-${run.id}`} className="min-w-0 space-y-2 pb-3 pl-5 text-small [overflow-wrap:anywhere]">
                  <div className="text-caption text-muted-foreground">{run.error ? t("automationsPanel.savedErrorExcerpt") : t("automationsPanel.savedResultExcerpt")}</div>
                  {detail ? (
                    <div className={run.error ? "whitespace-pre-wrap text-destructive" : "text-foreground/80"}>
                      {run.error ? detail : <Markdownish text={detail} />}
                    </div>
                  ) : (
                    <div className="text-muted-foreground">{t("automationsPanel.noExcerptWasSaved")}</div>
                  )}
                  {source ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (source.kind === "agent") dispatch({ type: "select", id: source.id, lane: source.taskId });
                        else dispatch({ type: "select", id: source.id });
                      }}
                    >
                      {t("automationsPanel.openSourceConversation")}
                    </Button>
                  ) : (
                    <div className="text-muted-foreground">
                      {detail ? t("automationsPanel.sourceUnavailableExcerpt") : t("automationsPanel.sourceUnavailable")}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One routine, opened from its card: pause, run now, change, delete. */
function RoutineDetails({
  routine,
  target,
  onWrite,
  onEdit,
  onClose,
}: {
  routine: Routine;
  target: { name: string; bot?: Bot } | null;
  onWrite: (run: Promise<unknown>) => void;
  onEdit: (routine: Routine) => void;
  onClose: () => void;
}) {
  const [briefOnly, setBriefOnly] = useState(Boolean(routine.briefOnly));
  const when =
    routine.repeat === "once"
      ? t("automationsPanel.details.onceOn", { date: routine.date ?? "?", time: routine.time })
      : routine.days.length === 0 || routine.days.length === 7
        ? t("automationsPanel.details.everyDay", { time: routine.time })
        : t("automationsPanel.details.days", {
            days: formatList(
              routine.days.map((d) => weekdayName(d, "short")),
              { type: "unit", style: "short" },
            ),
            time: routine.time,
          });
  const runsOnLabel =
    routine.runsOn === "cloud"
      ? t("automationsPanel.details.cloud")
      : routine.runsOn === "local"
        ? thisComputer()
        : routine.runsOn === "off"
          ? t("automationsPanel.details.noScreen")
          : null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        role="dialog"
        aria-label={routine.name || t("automationsPanel.routineDetails")}
        aria-modal="true"
        className="max-h-[85dvh] w-[440px] max-w-[92vw] overflow-y-auto animate-pop-in rounded-2xl border bg-popover p-4 shadow-2xl [overflow-wrap:anywhere] sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {target?.bot ? (
            <AgentAvatar bot={target.bot} size={36} />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-full bg-muted">
              <Users size={16} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-ui font-semibold leading-snug text-foreground">
              {routine.name || t("automationsPanel.routine")}
            </div>
            <div className="mt-0.5 text-small text-muted-foreground">
              {target?.name} ·{" "}
              {routine.every
                ? describeSchedule(routine)
                : routine.quiet
                  ? `${when} · ${t("automationsPanel.quiet")}`
                  : when}
              {runsOnLabel ? ` · ${runsOnLabel}` : ""}
            </div>
            {routine.quiet && (
              <div className="mt-0.5 text-small text-muted-foreground/80">
                {t("automationsPanel.staysSilentWhenNothingNeeds")}
              </div>
            )}
            {routine.enabled && routine.suspended === "archived" && (
              <div className="mt-0.5 text-small text-warning">
                {target?.name
                  ? t("automationsPanel.pausedArchived.named", { name: target.name })
                  : t("automationsPanel.pausedArchived.unnamed")}
              </div>
            )}
            {/* Stopped for failing: why, and the way back. A run now that
                works starts it again on its own; so does any change. */}
            {routine.failing && (
              <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-small">
                <span className="text-warning">
                  {t("automationsPanel.stoppedAfterRunIt", { count: routine.failures ?? 3 })}
                </span>
                <span className="line-clamp-3 break-words text-muted-foreground">{routine.failing.error}</span>
                <span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      onWrite(api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) }).then(onClose))
                    }
                  >
                    {t("automationsPanel.startItAgain")}
                  </Button>
                </span>
              </div>
            )}
          </div>
          <Switch
            aria-label={
              routine.name
                ? t("automationsPanel.toggle.routineNamed", { name: routine.name })
                : t("automationsPanel.toggle.routineUnnamed")
            }
            checked={routine.enabled}
            onCheckedChange={(on) =>
              onWrite(
                api(`/api/routines/${routine.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ enabled: on }),
                }).then(onClose),
              )
            }
          />
        </div>
        {/* An agent's routine can keep its reports to the morning brief,
            so several of them make one notification in the morning
            rather than one each (server/brief.ts). */}
        {routine.targetKind === "agent" && routine.repeat !== "once" && (
          <label className="mt-4 flex items-start justify-between gap-4 rounded-xl bg-muted/40 px-3 py-2.5 text-body text-foreground">
            <span>
              {t("automationsPanel.briefOnly")}
              <span className="block text-small text-muted-foreground">
                {briefOnly ? t("automationsPanel.noNotificationWhenItRuns") : t("automationsPanel.notifiesWhenItRunsAnd")}
              </span>
            </span>
            <Switch
              aria-label={
                routine.name
                  ? t("automationsPanel.toggle.briefNamed", { name: routine.name })
                  : t("automationsPanel.toggle.briefUnnamed")
              }
              checked={briefOnly}
              onCheckedChange={(on) => {
                // the dialog stays open on this one, so it answers at once
                setBriefOnly(on);
                onWrite(api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ briefOnly: on }) }));
              }}
            />
          </label>
        )}
        <div className="mt-4 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            onClick={() =>
              onWrite(api(`/api/routines/${routine.id}/run`, { method: "POST" }).then(onClose))
            }
          >
            <Play size={12} />
            {t("common.runNow")}
          </Button>
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => onEdit(routine)}>
            <Pencil size={12} />
            {t("common.edit")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 text-destructive"
            onClick={() =>
              onWrite(api(`/api/routines/${routine.id}`, { method: "DELETE" }).then(onClose))
            }
          >
            <Trash2 size={12} />
            {t("common.delete")}
          </Button>
        </div>
        <details open className="mt-4 border-t pt-3">
          <summary className="cursor-pointer text-small font-medium text-muted-foreground">{t("common.instructions")}</summary>
          <div className="mt-2 whitespace-pre-wrap text-small leading-relaxed text-foreground/80">{routine.prompt}</div>
        </details>
        {routine.lastReport && (
          <section className="mt-4 min-w-0 border-t pt-3">
            <div className="mb-2 text-small font-medium text-muted-foreground">{t("automationsPanel.lastReportedSavedExcerpt")}</div>
            <div className="text-small leading-relaxed text-foreground/80">
              <Markdownish text={routine.lastReport.summary} />
            </div>
          </section>
        )}
        <RunHistory routine={routine} />
      </div>
    </div>
  );
}

/** Webhooks: list on the left, one hook's whole story on the right. */
function WebhooksTab({
  targetOf,
}: {
  targetOf: (id: string) => { name: string; bot?: Bot } | null;
}) {
  const { state } = useStore();
  const [hooks, setHooks] = useState<WebhookRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [makingFor, setMakingFor] = useState("");

  const load = useCallback(() => {
    api("/api/webhooks")
      .then(({ webhooks }) => {
        setHooks(webhooks);
        setSelectedId((cur) => cur ?? webhooks[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const bots = state.bots.filter((b) => !b.hidden);
  const selected = hooks?.find((h) => h.id === selectedId) ?? null;
  const target = selected ? targetOf(selected.botId ?? selected.blokId ?? "") : null;
  const folded = useColumnFolded(AUTOMATIONS_LIST, AUTOMATIONS_LIST_SIZE);
  const hookUrl = selected ? `${location.origin}/hook/${selected.token}` : "";
  const curl = selected
    ? `curl -sS '${hookUrl}' --json '{"text":"A build failed on main. Summarize the log and suggest a fix."}'`
    : "";

  const create = (targetId: string) => {
    const bot = state.bots.find((b) => b.id === targetId);
    const body = bot ? { botId: targetId } : { blokId: targetId };
    api("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({
        ...body,
        name: (() => {
          const owner = targetOf(targetId)?.name;
          return owner ? t("automationsPanel.webhookName", { name: owner }) : t("automationsPanel.webhookNameNew");
        })(),
      }),
    })
      .then((r) => {
        load();
        setSelectedId(r.webhook?.id ?? null);
      })
      .catch((e) => setError(e.message));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      {/* list */}
      <SideColumn id={AUTOMATIONS_LIST} size={AUTOMATIONS_LIST_SIZE} label={t("automationsPanel.webhooks")} className="max-h-[180px] w-full border-b md:max-h-none md:border-b-0">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-small font-medium text-muted-foreground">
            {t("automationsPanel.yourWebhooks")}
          </span>
          <select
            value={makingFor}
            onChange={(e) => {
              if (e.target.value) create(e.target.value);
              setMakingFor("");
            }}
            className="rounded-lg border border-input bg-background px-1.5 py-1 text-small text-muted-foreground outline-none"
          >
            <option value="">{t("automationsPanel.new")}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{t("automationsPanel.forTarget", { name: b.name })}</option>
            ))}
            {state.bloks.map((r) => (
              <option key={r.id} value={r.id}>{t("automationsPanel.forTarget", { name: r.name })}</option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {(hooks ?? []).map((hook) => {
            const owner = targetOf(hook.botId ?? hook.blokId ?? "");
            return (
              <button
                key={hook.id}
                onClick={() => setSelectedId(hook.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  hook.id === selectedId ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                {owner?.bot ? (
                  <AgentAvatar bot={owner.bot} size={26} />
                ) : (
                  <span className="flex size-[26px] items-center justify-center rounded-full bg-muted">
                    <Users size={13} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-foreground">
                    {hook.name}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1 text-caption",
                      hook.enabled ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        hook.enabled ? "bg-success" : "bg-muted-foreground/40",
                      )}
                    />
                    {hook.enabled ? t("automationsPanel.active") : t("common.paused")}
                  </span>
                </span>
              </button>
            );
          })}
          {hooks !== null && hooks.length === 0 && (
            <div className="px-3 py-8 text-center text-body leading-relaxed text-muted-foreground">
              {t("automationsPanel.aWebhookLetsOtherApps")}
            </div>
          )}
        </div>
      </SideColumn>

      {/* detail */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* the list folded away: the way back to it, named for what it lists */}
        {folded && (
          <div className="px-3 pt-3">
            <ShowColumn id={AUTOMATIONS_LIST} text={t("automationsPanel.yourWebhooks")} label={t("automationsPanel.showTheList")} />
          </div>
        )}
        {error && <div className="px-6 pt-4 text-body text-destructive">{error}</div>}
        {selected ? (
          <div className="mx-auto max-w-[620px] px-6 py-5">
            <div className="flex items-center gap-3">
              {target?.bot ? (
                <AgentAvatar bot={target.bot} size={40} />
              ) : (
                <span className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <Users size={18} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <input
                  key={selected.id}
                  defaultValue={selected.name}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== selected.name) {
                      api(`/api/webhooks/${selected.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ name }),
                      })
                        .then(load)
                        .catch((err) => setError(err.message));
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="-mx-1 w-full rounded-md px-1 text-lead font-semibold text-foreground outline-none transition-colors hover:bg-accent/60 focus:bg-accent/60"
                  title={t("automationsPanel.rename")}
                />
                <div className="text-small text-muted-foreground">
                  {t("automationsPanel.goesTo", { name: target?.name ?? "?" })}
                  {" · "}
                  {selected.firedCount
                    ? t("automationsPanel.usedTimes", {
                        count: selected.firedCount,
                        last: formatDate(selected.lastFiredAt ?? 0, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
                      })
                    : t("automationsPanel.notUsedYet")}
                </div>
              </div>
              <Switch
                aria-label={
                  selected.name
                    ? t("automationsPanel.toggle.webhookNamed", { name: selected.name })
                    : t("automationsPanel.toggle.webhookUnnamed")
                }
                checked={selected.enabled}
                onCheckedChange={(on) =>
                  api(`/api/webhooks/${selected.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ enabled: on }),
                  })
                    .then(load)
                    .catch((e) => setError(e.message))
                }
              />
            </div>

            <div className="mt-5 rounded-2xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="text-body font-semibold text-foreground">{t("automationsPanel.url")}</div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={async () => {
                    const yes = await confirm({
                      title: t("automationsPanel.rotate.title"),
                      body: t("automationsPanel.rotate.body"),
                      confirmLabel: t("automationsPanel.rotate.confirm"),
                      destructive: true,
                    });
                    if (!yes) return;
                    api(`/api/webhooks/${selected.id}/rotate`, { method: "POST" })
                      .then(() => {
                        load();
                        toast.success(t("automationsPanel.rotate.done"));
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  {t("automationsPanel.newUrl")}
                </Button>
              </div>
              <div className="relative mt-2 rounded-xl bg-foreground/[0.04] p-3 pr-11">
                <code className="block break-all font-mono text-small leading-relaxed text-foreground">
                  {hookUrl}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(hookUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                  className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title={t("automationsPanel.copyUrl")}
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
              </div>
              <p className="mt-2 text-small text-muted-foreground">
                {t("automationsPanel.postAnythingToItOr")}
              </p>
              <div className="relative mt-1.5 rounded-xl bg-foreground/[0.04] p-3">
                <code className="block whitespace-pre-wrap break-all font-mono text-small leading-relaxed text-foreground">
                  {curl}
                </code>
              </div>
            </div>

            {selected.botId && (
              <label className="mt-4 block rounded-2xl border bg-card p-4">
                <div className="text-body font-semibold text-foreground">{t("automationsPanel.conversation")}</div>
                <input
                  key={`${selected.id}:${selected.thread ?? ""}`}
                  defaultValue={selected.thread ?? ""}
                  maxLength={40}
                  placeholder={t("common.general")}
                  onBlur={(e) => {
                    const thread = e.target.value.trim();
                    if (thread === (selected.thread ?? "")) return;
                    api(`/api/webhooks/${selected.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ thread: thread || null }),
                    })
                      .then(load)
                      .catch((err) => setError(err.message));
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="mt-2 w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-body text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
                />
                <p className="mt-1.5 text-small text-muted-foreground">
                  {target?.name
                    ? t("automationsPanel.threadHint.named", { name: target.name })
                    : t("automationsPanel.threadHint.unnamed")}
                </p>
              </label>
            )}

            <div className="mt-4 rounded-2xl border bg-card p-4">
              <div className="text-body font-semibold text-foreground">{t("automationsPanel.recentDeliveries")}</div>
              {selected.deliveries?.length ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {selected.deliveries.map((d, i) => (
                    <div key={i} className="flex items-baseline gap-2.5 text-small">
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDate(d.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="min-w-0 truncate font-mono text-small text-foreground">
                        {d.excerpt || t("automationsPanel.empty")}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-body text-muted-foreground">
                  {t("automationsPanel.nothingReceivedYet")}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between rounded-2xl border bg-card p-4">
              <div>
                <div className="text-body font-semibold text-foreground">{t("automationsPanel.removeThisWebhook")}</div>
                <div className="text-small text-muted-foreground">{t("automationsPanel.theUrlWillStopWorking")}</div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="text-destructive"
                onClick={() =>
                  api(`/api/webhooks/${selected.id}`, { method: "DELETE" })
                    .then(() => {
                      setSelectedId(null);
                      load();
                    })
                    .catch((e) => setError(e.message))
                }
              >
                <Trash2 size={12} />
                {t("common.delete")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {hooks === null ? t("common.loading") : t("automationsPanel.pickAWebhookOrMake")}
          </div>
        )}
      </div>
    </div>
  );
}
