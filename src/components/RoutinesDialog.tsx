// Routines, as a first-class overlay.
//
// Reachable from the sidebar, so it covers every agent and room in one
// place; the per-agent Routines block in the computer panel opens this
// same dialog pinned to its own target. Two views inside one dialog:
// the list of everything scheduled, and a create form. The form is a
// picker plus prose plus a clock, not a cron string: a routine should
// read like a sentence about the week.
//
// Self-fetching like RoutinesSection: routines are read on open and
// after every write; nothing else in the app holds them in state.
import { useCallback, useEffect, useState } from "react";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import { useStore, type Bot } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { type Routine } from "./RoutinesSection";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

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

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  if (days.length === 5 && WEEKDAYS.every((d) => days.includes(d))) return "Weekdays";
  if (days.length === 2 && WEEKEND.every((d) => days.includes(d))) return "Weekends";
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
  prefill?: { time?: string; days?: number[] };
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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[520px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-5">
          <CalendarClock size={16} className="text-muted-foreground" />
          <DialogTitle className="text-[14.5px]">
            {creating ? "New routine" : "Routines"}
          </DialogTitle>
        </div>

        {creating ? (
          <>
            {error && (
              <div className="mx-5 mt-3 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </div>
            )}
            <CreateForm
            targets={targets}
            pinnedTargetId={initialTarget?.id}
            prefill={prefill}
            onBack={() => (startCreating ? onClose() : setCreating(false))}
            onSave={(draft) =>
              write(api("/api/routines", { method: "POST", body: JSON.stringify(draft) })).then(
                (ok) => ok && (startCreating ? onClose() : setCreating(false)),
              )
            }
          />
          </>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            {error && (
              <div className="mt-3 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                {error}
              </div>
            )}

            {routines === null ? (
              <div className="py-10 text-center text-[13px] text-muted-foreground">Loading…</div>
            ) : routines.length === 0 ? (
              <div className="py-10 text-center">
                <div className="text-[13.5px] font-medium text-foreground">Nothing scheduled yet</div>
                <div className="mx-auto mt-1 max-w-[300px] text-[12.5px] text-muted-foreground">
                  A routine is a task an agent runs on a schedule: a morning digest, a weekly
                  report, an inbox sweep.
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
                                "truncate text-[13px] font-medium",
                                routine.enabled ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {target?.name ?? "Unknown target"}
                            </span>
                            <span className="shrink-0 text-[11.5px] text-muted-foreground">
                              {describeDays(routine.days)} at {routine.time}
                            </span>
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">
                            {routine.name && (
                              <span className="font-medium text-foreground">{routine.name} · </span>
                            )}
                            {routine.prompt}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                            {routine.enabled ? whenNext(routine.nextRunAt) : "Paused"}
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
                          title="Run it now, without waiting for the schedule"
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

            <Button className="mt-4 w-full" variant="secondary" onClick={() => setCreating(true)}>
              <Plus size={13} />
              New routine
            </Button>
            <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
              Routines run while Bloks is open. If this Mac is asleep at the scheduled time the
              run is skipped rather than piling up.
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const DURATIONS: Array<[number, string]> = [
  [15, "15 min"],
  [30, "30 min"],
  [45, "45 min"],
  [60, "1 hour"],
  [90, "90 min"],
  [120, "2 hours"],
  [240, "4 hours"],
];

/** Local date as the input[type=date] value, no UTC surprises. */
function localDateValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CreateForm({
  targets,
  pinnedTargetId,
  prefill,
  onBack,
  onSave,
}: {
  targets: Target[];
  pinnedTargetId?: string;
  prefill?: { time?: string; days?: number[]; date?: string };
  onBack: () => void;
  onSave: (draft: {
    targetId: string;
    targetKind: "agent" | "room";
    name?: string;
    prompt: string;
    time: string;
    days: number[];
    repeat?: "once";
    date?: string;
    durationMin: number;
    runsOn?: "cloud" | "local" | "off";
  }) => void;
}) {
  const [targetId, setTargetId] = useState(pinnedTargetId ?? targets[0]?.id ?? "");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [time, setTime] = useState(prefill?.time ?? "09:00");
  const [days, setDays] = useState<number[]>(prefill?.days ?? []);
  const [repeat, setRepeat] = useState<"weekly" | "once">("weekly");
  const [date, setDate] = useState(prefill?.date ?? localDateValue(new Date()));
  const [durationMin, setDurationMin] = useState(30);
  const [runsOn, setRunsOn] = useState<"" | "cloud" | "local" | "off">("");
  const target = targets.find((t) => t.id === targetId);

  const toggle = (day: number) =>
    setDays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
    );

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5">
      {!pinnedTargetId && (
        <>
          <div className="mb-1.5 mt-4 text-[12.5px] font-medium text-muted-foreground">Who runs it</div>
          <div className="grid max-h-[168px] grid-cols-2 gap-1.5 overflow-y-auto pr-0.5">
            {targets.map((t) => (
              <button
                key={t.id}
                onClick={() => setTargetId(t.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors duration-150",
                  t.id === targetId
                    ? "border-brand bg-brand-soft"
                    : "border-transparent bg-muted/50 hover:bg-accent",
                )}
              >
                {t.bot ? (
                  <AgentAvatar bot={t.bot} size={28} />
                ) : (
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Users size={14} />
                  </span>
                )}
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block truncate text-[12.5px] font-medium",
                      t.id === targetId ? "text-foreground" : "text-foreground/90",
                    )}
                  >
                    {t.name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {t.kind === "room" ? "Team" : (t.bot?.title || "Agent")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mb-1.5 mt-4 text-[12.5px] font-medium text-muted-foreground">Name</div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Morning brief (optional)"
        className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
      />

      <div className="mb-1.5 mt-4 text-[12.5px] font-medium text-muted-foreground">What it does</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        autoFocus
        placeholder={
          target
            ? `e.g. Summarise yesterday's inbox and flag anything ${target.name} should escalate`
            : "What should it do?"
        }
        className="w-full resize-none rounded-xl border border-input bg-transparent px-3 py-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/60"
      />

      <div className="mb-1.5 mt-4 text-[12.5px] font-medium text-muted-foreground">When</div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          {(
            [
              ["weekly", "Repeats"],
              ["once", "Once"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRepeat(key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] transition-colors duration-150",
                repeat === key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-ring/60"
        />
        {repeat === "once" ? (
          <input
            type="date"
            value={date}
            min={localDateValue(new Date())}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-ring/60"
          />
        ) : (
          <div className="flex gap-1">
            {DAY_LABELS.map((label, day) => (
              <button
                key={day}
                onClick={() => toggle(day)}
                title={DAY_NAMES[day]}
                className={cn(
                  "size-7 rounded-md text-[11.5px] font-semibold transition-colors duration-150",
                  days.includes(day)
                    ? "bg-brand-ink text-brand-foreground"
                    : "bg-muted text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {repeat === "weekly" && (
        <div className="mt-2 flex items-center gap-2 text-[11.5px]">
          <button className="text-brand-ink hover:underline" onClick={() => setDays([])}>
            Every day
          </button>
          <button className="text-brand-ink hover:underline" onClick={() => setDays(WEEKDAYS)}>
            Weekdays
          </button>
          <button className="text-brand-ink hover:underline" onClick={() => setDays(WEEKEND)}>
            Weekends
          </button>
          <span className="text-muted-foreground">
            {describeDays(days)} at {time}
          </span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-5">
        <label className="block">
          <div className="mb-1.5 text-[12.5px] font-medium text-muted-foreground">Duration</div>
          <select
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value))}
            className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-ring/60"
          >
            {DURATIONS.map(([min, label]) => (
              <option key={min} value={min}>{label}</option>
            ))}
          </select>
        </label>
        {target?.kind === "agent" && (
          <label className="block">
            <div className="mb-1.5 text-[12.5px] font-medium text-muted-foreground">Runs on</div>
            <select
              value={runsOn}
              onChange={(e) => setRunsOn(e.target.value as typeof runsOn)}
              className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none focus:border-ring/60"
            >
              <option value="">Wherever {target.name} runs</option>
              <option value="cloud">Cloud computer</option>
              <option value="local">This Mac</option>
              <option value="off">No computer</option>
            </select>
          </label>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <Button
          disabled={!prompt.trim() || !target || !time || (repeat === "once" && !date)}
          onClick={() =>
            target &&
            onSave({
              targetId: target.id,
              targetKind: target.kind,
              ...(name.trim() ? { name: name.trim() } : {}),
              prompt: prompt.trim(),
              time,
              days,
              ...(repeat === "once" ? { repeat, date } : {}),
              durationMin,
              ...(runsOn ? { runsOn } : {}),
            })
          }
        >
          Create routine
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
