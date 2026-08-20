// Automations: the schedule surface, grown up.
//
// A routine is an appointment an agent keeps, so the primary view is a
// calendar, not a list: a time gutter, day columns, and a card at every
// hour a routine will run. Two tabs share the page, Schedules and
// Webhooks, because both answer "what happens without me pressing
// anything". Full-viewport overlay, matching the app's own language:
// tokens, Blok avatars, quiet chrome; the reference material's ideas,
// none of its skin.
//
// Occurrences are projected client-side from each routine's time and
// weekday set. The calendar shows intentions, and the details popover is
// where a specific routine is paused, run now, or removed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import Webhook from "lucide-react/dist/esm/icons/webhook.js";
import Briefcase from "lucide-react/dist/esm/icons/briefcase.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "./Avatar";
import { type Routine, type RoutineRun } from "./RoutinesSection";
import { RoutinesDialog } from "./RoutinesDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { JobBoard } from "./JobBoard";
import { Workflows } from "./Workflows";
import { cn } from "@/lib/cn";

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
  lastFiredAt?: number;
  firedCount?: number;
  deliveries?: Array<{ at: number; excerpt: string }>;
}

const HOUR_PX = 52;
const DAY_START = 6; // the gutter starts at 6am; earlier hours are rare
const DAY_END = 23;

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
  const [tab, setTab] = useState<"schedules" | "workflows" | "webhooks" | "jobs">("schedules");
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [mode, setMode] = useState<"day" | "week" | "month">("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [filterId, setFilterId] = useState<string>("");
  const [creating, setCreating] = useState<{ time?: string; days?: number[]; date?: string } | null>(null);
  const [selected, setSelected] = useState<Routine | null>(null);

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
        const raw = ((clientY - rect.top) / HOUR_PX) * 60 + DAY_START * 60;
        const snapped = Math.round(raw / 15) * 15;
        // clamp into the hours the grid actually draws, so a drop can
        // never send a chip somewhere the calendar cannot show it
        return {
          dayIndex: index,
          minutes: Math.max(DAY_START * 60, Math.min(DAY_END * 60 - 15, snapped)),
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
  useEffect(load, [load]);

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
   * once routine lands only on its own date. */
  const occurrences = useCallback(
    (day: Date) =>
      visible
        .filter((r) => r.enabled)
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

  const paused = visible.filter((r) => !r.enabled);
  const monthLabel = (mode === "month" ? anchor : days[0]).toLocaleDateString([], { month: "long", year: "numeric" });
  const today = dayKey(new Date());

  return (
    <main className="relative flex h-full min-h-0 min-w-0 flex-1 animate-fade-in flex-col bg-background">
      {/* ── header ── */}
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b px-5">
        {/* The panel sits beside the sidebar, so it is narrower than the
            window and a viewport breakpoint cannot see that. The title
            gives up its width instead: the tabs and the close are the
            controls, and a subtitle is the first thing that can go. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock size={18} className="shrink-0 text-brand-ink" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold leading-tight text-foreground">
              Automations
            </div>
            <div className="hidden truncate text-[11.5px] leading-tight text-muted-foreground sm:block">
              What your agents do without being asked
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            {(
              [
                ["schedules", "Schedules", <CalendarClock key="s" size={13} />],
                ["workflows", "Workflows", <Workflow key="f" size={13} />],
                ["webhooks", "Webhooks", <Webhook key="w" size={13} />],
                ["jobs", "Job board", <Briefcase key="j" size={13} />],
              ] as const
            ).map(([key, label, icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors duration-150",
                  tab === key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {icon}
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X size={17} />
          </Button>
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
      ) : (
        <>
          {/* ── calendar controls ── */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2.5">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Earlier" onClick={() => setAnchor(mode === "month" ? addMonths(anchor, -1) : addDays(anchor, mode === "day" ? -1 : -7))}>
                <ChevronLeft size={15} />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setAnchor(startOfDay(new Date()))}>
                Today
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Later" onClick={() => setAnchor(mode === "month" ? addMonths(anchor, 1) : addDays(anchor, mode === "day" ? 1 : 7))}>
                <ChevronRight size={15} />
              </Button>
            </div>
            <span className="text-[14px] font-semibold text-foreground">{monthLabel}</span>

            <select
              value={filterId}
              onChange={(e) => setFilterId(e.target.value)}
              className="rounded-lg border border-input bg-background px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-ring/60"
            >
              <option value="">Everyone</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
              {state.bloks.map((r) => (
                <option key={r.id} value={r.id}>{r.name} (room)</option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex gap-1 rounded-xl bg-muted p-1">
                {(["day", "week", "month"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[12px] capitalize transition-colors duration-150",
                      mode === m
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <Button size="sm" onClick={() => setCreating({})}>
                <Plus size={13} />
                New routine
              </Button>
            </div>
          </div>

          {writeError && (
            <div className="mx-5 mt-2 shrink-0 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
              {writeError}
            </div>
          )}
          {/* ── the grid ── */}
          {routines !== null && routines.length === 0 ? (
            <EmptyRhythm onCreate={() => setCreating({})} />
          ) : mode === "month" ? (
            <MonthGrid
              anchor={anchor}
              occurrences={occurrences}
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
                  {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                    <div key={i} className="relative" style={{ height: HOUR_PX }}>
                      <span className="absolute -top-2 right-2 text-[10.5px] tabular-nums text-muted-foreground/70">
                        {(DAY_START + i) % 12 || 12} {DAY_START + i < 12 ? "AM" : "PM"}
                      </span>
                    </div>
                  ))}
                </div>

                {days.map((day, dayIndex) => {
                  const isToday = dayKey(day) === today;
                  const slots = occurrences(day);
                  return (
                    <div key={day.toISOString()} className="min-w-0 flex-1 border-r last:border-r-0">
                      <div
                        className={cn(
                          "sticky top-0 z-10 flex h-[34px] items-center justify-center gap-1.5 border-b bg-background text-[11.5px] font-medium uppercase tracking-[0.06em]",
                          isToday ? "text-brand-ink" : "text-muted-foreground",
                        )}
                      >
                        {day.toLocaleDateString([], { weekday: "short" })}
                        <span
                          className={cn(
                            "flex size-[22px] items-center justify-center rounded-full text-[12px] tabular-nums",
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
                        style={{ height: (DAY_END - DAY_START) * HOUR_PX }}
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
                          const minutes = ((e.clientY - rect.top) / HOUR_PX + DAY_START) * 60;
                          const hour = Math.max(0, Math.min(23, Math.floor(minutes / 60)));
                          setCreating({
                            time: `${String(hour).padStart(2, "0")}:00`,
                            days: [day.getDay()],
                            date: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
                          });
                        }}
                      >
                        {/* hour lines */}
                        {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                          <div
                            key={i}
                            className="absolute inset-x-0 border-t border-border/60"
                            style={{ top: i * HOUR_PX }}
                          />
                        ))}
                        {/* the moment it is right now */}
                        {isToday && <NowLine />}

                        {slots.map(({ routine, minutes }) => {
                          const target = targetOf(routine.targetId);
                          const top = ((minutes - DAY_START * 60) / 60) * HOUR_PX;
                          if (top < -HOUR_PX) return null;
                          return (
                            <button
                              key={routine.id}
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
                                "absolute inset-x-1 flex cursor-grab touch-none items-start gap-1.5 overflow-hidden rounded-lg border border-brand/25 bg-brand-soft px-1.5 py-1 text-left shadow-sm transition-transform duration-150 hover:scale-[1.02]",
                                drag?.routine.id === routine.id && "opacity-40",
                              )}
                              style={{
                                top: Math.max(0, top),
                                // the chip blocks out its duration, like an
                                // appointment would
                                height: Math.max(34, ((routine.durationMin ?? 30) / 60) * HOUR_PX - 2),
                              }}
                            >
                              {target?.bot ? (
                                <AgentAvatar bot={target.bot} size={18} />
                              ) : (
                                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted">
                                  <Users size={10} />
                                </span>
                              )}
                              <span className="min-w-0">
                                <span className="block truncate text-[11px] font-medium leading-tight text-foreground">
                                  {routine.name || routine.prompt}
                                </span>
                                <span className="block text-[9.5px] leading-tight text-muted-foreground">
                                  {routine.time}
                                  {routine.repeat === "once" && " · once"}
                                  {" · "}
                                  {target?.name ?? "?"}
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

          {/* ── paused strip ── */}
          {paused.length > 0 && (
            <div className="shrink-0 border-t px-5 py-2.5">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Paused
              </div>
              <div className="flex flex-wrap gap-1.5">
                {paused.map((routine) => {
                  const target = targetOf(routine.targetId);
                  return (
                    <button
                      key={routine.id}
                      onClick={() => setSelected(routine)}
                      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                    >
                      {target?.bot && <AgentAvatar bot={target.bot} size={16} />}
                      <span className="max-w-[200px] truncate">{routine.name || routine.prompt}</span>
                      {routine.repeat === "once" && routine.lastRunAt && (
                        <span className="text-[10.5px] text-success">ran</span>
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
          <span className="text-[11px] font-medium text-foreground">
            {`${String(Math.floor(drag.minutes / 60)).padStart(2, "0")}:${String(drag.minutes % 60).padStart(2, "0")}`}
            {" · "}
            {columnRects.current.get(drag.dayIndex)?.day.toLocaleDateString([], { weekday: "short" })}
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
          routine={selected}
          target={targetOf(selected.targetId)}
          onWrite={write}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

/** The red line of the present moment, updated each minute. */
function NowLine() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const top = ((minutes - DAY_START * 60) / 60) * HOUR_PX;
  if (top < 0 || top > (DAY_END - DAY_START) * HOUR_PX) return null;
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
        <div className="text-[16px] font-semibold text-foreground">
          Put your agents on a rhythm
        </div>
        <div className="mx-auto mt-1 max-w-[380px] text-[13px] leading-relaxed text-muted-foreground">
          Morning digests, weekly reports, recurring reviews. Every run lands
          in its own task lane with its own result.
        </div>
      </div>
      <Button onClick={onCreate}>
        <Plus size={14} />
        Create your first routine
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
  targetOf,
  onZoom,
}: {
  anchor: Date;
  occurrences: (day: Date) => Array<{ routine: Routine; minutes: number }>;
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
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
          <div
            key={label}
            className="bg-background px-2 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
          >
            {label}
          </div>
        ))}
        {cells.map((day) => {
          const inMonth = day.getMonth() === anchor.getMonth();
          const isToday = dayKey(day) === today;
          const slots = occurrences(day);
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
                  "self-start rounded-full px-1.5 text-[11px] tabular-nums leading-[18px]",
                  isToday ? "bg-brand-ink font-semibold text-brand-foreground" : "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </span>
              {slots.slice(0, 3).map(({ routine }) => {
                const target = targetOf(routine.targetId);
                return (
                  <span
                    key={routine.id}
                    className="flex items-center gap-1 overflow-hidden rounded-md border border-brand/20 bg-brand-soft px-1 py-0.5"
                  >
                    {target?.bot && <AgentAvatar bot={target.bot} size={12} />}
                    <span className="truncate text-[9.5px] font-medium text-foreground">
                      {routine.time} {routine.name || routine.prompt}
                    </span>
                  </span>
                );
              })}
              {slots.length > 3 && (
                <span className="px-1 text-[9.5px] text-muted-foreground">
                  +{slots.length - 3} more
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
function RunHistory({ runs }: { runs?: RoutineRun[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs?.length) {
    return (
      <div className="mt-4 border-t pt-3 text-[12px] text-muted-foreground">
        No runs yet. When this fires, what it did shows up here.
      </div>
    );
  }
  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Recent runs
      </div>
      <div className="max-h-[190px] overflow-y-auto">
        {runs.map((run) => {
          const showing = open === run.id;
          const detail = run.error ?? run.summary ?? "";
          return (
            <button
              key={run.id}
              onClick={() => setOpen(showing ? null : run.id)}
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
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] tabular-nums text-foreground">
                    {new Date(run.startedAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {run.state === "running"
                      ? "running"
                      : run.endedAt
                        ? `${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s`
                        : ""}
                  </span>
                </span>
                {detail && (
                  <span
                    className={cn(
                      "mt-0.5 block text-[11.5px] leading-relaxed",
                      showing ? "" : "truncate",
                      run.error ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {detail}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One routine, opened from its card: pause, run now, delete. */
function RoutineDetails({
  routine,
  target,
  onWrite,
  onClose,
}: {
  routine: Routine;
  target: { name: string; bot?: Bot } | null;
  onWrite: (run: Promise<unknown>) => void;
  onClose: () => void;
}) {
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const daysLabel =
    routine.repeat === "once"
      ? `Once on ${routine.date ?? "?"}`
      : routine.days.length === 0 || routine.days.length === 7
        ? "Every day"
        : routine.days.map((d) => DAY_NAMES[d]).join(", ");
  const runsOnLabel =
    routine.runsOn === "cloud"
      ? "cloud computer"
      : routine.runsOn === "local"
        ? "this Mac"
        : routine.runsOn === "off"
          ? "no computer"
          : null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-[400px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-4 shadow-2xl sm:p-5"
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
            <div className="text-[14px] font-semibold leading-snug text-foreground">
              {routine.name || routine.prompt}
            </div>
            {routine.name && (
              <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
                {routine.prompt}
              </div>
            )}
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {target?.name} · {daysLabel} at {routine.time} · {routine.durationMin ?? 30} min
              {runsOnLabel ? ` · ${runsOnLabel}` : ""}
            </div>
          </div>
          <Switch
            aria-label={`${routine.name || "This routine"}: on or off`}
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
            Run now
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
            Delete
          </Button>
        </div>
        <RunHistory runs={routine.runs} />
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
  const hookUrl = selected ? `${location.origin}/hook/${selected.token}` : "";
  const curl = selected
    ? `curl -sS '${hookUrl}' --json '{"text":"A build failed on main. Summarize the log and suggest a fix."}'`
    : "";

  const create = (targetId: string) => {
    const bot = state.bots.find((b) => b.id === targetId);
    const body = bot ? { botId: targetId } : { blokId: targetId };
    api("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({ ...body, name: `${targetOf(targetId)?.name ?? "New"} webhook` }),
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
      <div className="flex max-h-[180px] w-full shrink-0 flex-col border-b md:max-h-none md:w-[260px] md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Your webhooks
          </span>
          <select
            value={makingFor}
            onChange={(e) => {
              if (e.target.value) create(e.target.value);
              setMakingFor("");
            }}
            className="rounded-lg border border-input bg-background px-1.5 py-1 text-[11.5px] text-muted-foreground outline-none"
          >
            <option value="">+ New</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>for {b.name}</option>
            ))}
            {state.bloks.map((r) => (
              <option key={r.id} value={r.id}>for {r.name}</option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {(hooks ?? []).map((hook) => {
            const t = targetOf(hook.botId ?? hook.blokId ?? "");
            return (
              <button
                key={hook.id}
                onClick={() => setSelectedId(hook.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                  hook.id === selectedId ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                {t?.bot ? (
                  <AgentAvatar bot={t.bot} size={26} />
                ) : (
                  <span className="flex size-[26px] items-center justify-center rounded-full bg-muted">
                    <Users size={13} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {hook.name}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1 text-[11px]",
                      hook.enabled ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        hook.enabled ? "bg-success" : "bg-muted-foreground/40",
                      )}
                    />
                    {hook.enabled ? "Active" : "Paused"}
                  </span>
                </span>
              </button>
            );
          })}
          {hooks !== null && hooks.length === 0 && (
            <div className="px-3 py-8 text-center text-[12.5px] leading-relaxed text-muted-foreground">
              A webhook turns an outside event into a task for an agent.
            </div>
          )}
        </div>
      </div>

      {/* detail */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <div className="px-6 pt-4 text-[12.5px] text-destructive">{error}</div>}
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
                  className="-mx-1 w-full rounded-md px-1 text-[15px] font-semibold text-foreground outline-none transition-colors hover:bg-accent/60 focus:bg-accent/60"
                  title="Rename"
                />
                <div className="text-[12px] text-muted-foreground">
                  Tasks go to {target?.name ?? "?"}
                  {" · "}
                  {selected.firedCount
                    ? `fired ${selected.firedCount} ${selected.firedCount === 1 ? "time" : "times"}, last ${new Date(selected.lastFiredAt ?? 0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                    : "never fired"}
                </div>
              </div>
              <Switch
                aria-label={`${selected.name || "This webhook"}: on or off`}
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
                <div className="text-[13px] font-semibold text-foreground">The URL</div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => {
                    if (!confirm("Give this webhook a fresh URL? The old one stops answering.")) return;
                    api(`/api/webhooks/${selected.id}/rotate`, { method: "POST" })
                      .then(load)
                      .catch((e) => setError(e.message));
                  }}
                >
                  New URL
                </Button>
              </div>
              <div className="relative mt-2 rounded-xl bg-foreground/[0.04] p-3 pr-11">
                <code className="block break-all font-mono text-[11.5px] leading-relaxed text-foreground">
                  {hookUrl}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(hookUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  }}
                  className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="Copy URL"
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
              </div>
              <p className="mt-2 text-[12px] text-muted-foreground">
                POST anything to it, or try it from Terminal:
              </p>
              <div className="relative mt-1.5 rounded-xl bg-foreground/[0.04] p-3">
                <code className="block whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-foreground">
                  {curl}
                </code>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border bg-card p-4">
              <div className="text-[13px] font-semibold text-foreground">Recent deliveries</div>
              {selected.deliveries?.length ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {selected.deliveries.map((d, i) => (
                    <div key={i} className="flex items-baseline gap-2.5 text-[12px]">
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {new Date(d.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">
                        {d.excerpt || "(empty payload)"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[12.5px] text-muted-foreground">
                  Nothing yet. Each delivery shows up here with what it sent.
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between rounded-2xl border bg-card p-4">
              <div>
                <div className="text-[13px] font-semibold text-foreground">Remove this webhook</div>
                <div className="text-[12px] text-muted-foreground">The URL stops answering.</div>
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
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            {hooks === null ? "Loading…" : "Pick a webhook, or create one for an agent."}
          </div>
        )}
      </div>
    </div>
  );
}
