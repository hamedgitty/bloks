// Routines for one agent, in the right-side panel.
//
// This sits where the product already promised it: the Routines block in
// the computer panel used to be a disabled button labelled "Coming soon".
// The backend behind it is server/routines.ts.
//
// Self-fetching rather than reducer-backed, matching SkillsPanel: routines
// are read on open and after every write, and nothing else in the app needs
// them in state.
//
// The schedule is a time plus days of the week, not cron, for the same
// reason as on the phone: it has to be readable without being decoded.
// Creation happens in the shared RoutinesDialog, pinned to this agent.
import { useCallback, useEffect, useState } from "react";
import CalendarClock from "lucide-react/dist/esm/icons/calendar-clock.mjs";
import Play from "lucide-react/dist/esm/icons/play.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { Button } from "@/components/ui/button";
import { RoutinesDialog } from "./RoutinesDialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

export interface RoutineRun {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "failed";
  summary?: string;
  error?: string;
  threadId?: string;
}

export interface Routine {
  id: string;
  targetId: string;
  targetKind: "agent" | "room";
  name?: string;
  prompt: string;
  time: string;
  days: number[];
  repeat?: "weekly" | "once";
  date?: string;
  durationMin?: number;
  runsOn?: "cloud" | "local" | "off";
  enabled: boolean;
  lastRunAt?: number;
  summary?: string;
  nextRunAt?: number | null;
  runs?: RoutineRun[];
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function whenNext(at: number | null | undefined): string {
  if (!at) return "";
  const when = new Date(at);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Next today ${time}` : `Next ${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function RoutinesSection({
  targetId,
  targetKind,
  targetName,
}: {
  targetId: string;
  targetKind: "agent" | "room";
  targetName: string;
}) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/routines")
      .then(({ routines }: { routines: Routine[] }) =>
        setRoutines(routines.filter((r) => r.targetId === targetId).sort((a, b) => a.time.localeCompare(b.time))),
      )
      .catch(() => setRoutines([]));
  }, [targetId]);

  useEffect(load, [load]);

  const write = (run: Promise<unknown>) =>
    run
      .then(() => {
        setError(null);
        load();
      })
      .catch((e: Error) => setError(e.message));

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-foreground">
        <CalendarClock size={15} className="text-muted-foreground" />
        Routines
      </div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
        Recurring tasks {targetName} runs on a schedule.
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {error}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {(routines ?? []).map((routine) => (
          <div key={routine.id} className="rounded-xl border bg-background p-2.5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-[13px] font-medium",
                    routine.enabled ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {routine.summary ?? routine.time}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
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
            <div className="mt-2 flex items-center gap-1">
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
        ))}

        {routines?.length === 0 && !adding && (
          <div className="rounded-xl border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">
            Nothing scheduled yet.
          </div>
        )}
      </div>

      <Button variant="secondary" className="mt-3 w-full" onClick={() => setAdding(true)}>
        <Plus size={13} />
        Create Routine
      </Button>
      {adding && (
        <RoutinesDialog
          initialTarget={{ id: targetId, kind: targetKind }}
          startCreating
          onClose={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
        Routines run while Bloks is open. If this Mac is asleep at the scheduled time the run is
        skipped rather than piling up.
      </div>
    </div>
  );
}
