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
// The schedule is a time plus days of the week, or every so often within
// hours, not cron, for the same reason as on the phone: it has to be
// readable without being decoded.
// Creation and changes happen in the shared RoutinesDialog, pinned to this agent.
import { useCallback, useEffect, useState } from "react";
import { CalendarClock } from "@/components/icons";
import { Pencil } from "@/components/icons";
import { Play } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { RoutinesDialog } from "./RoutinesDialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";
import { formatDate, t } from "@/lib/i18n";
import { describeSchedule } from "@/lib/routineDetails";

export interface RoutineRun {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "failed";
  summary?: string;
  error?: string;
  threadId?: string;
  /** It ran, and the agent answered QUIET: nothing needed the person. */
  quiet?: boolean;
}

export interface Routine {
  id: string;
  targetId: string;
  targetKind: "agent" | "room";
  name?: string;
  prompt: string;
  /** For a check-in, its first slot of the day. */
  time: string;
  days: number[];
  repeat?: "weekly" | "once";
  date?: string;
  durationMin?: number;
  runsOn?: "cloud" | "local" | "off";
  /** The conversation it runs in, by title or id; absent is General. */
  thread?: string;
  /** A check-in: every this many minutes, instead of at a time of day. */
  every?: number;
  /** The hours a check-in keeps to; absent is the whole day. */
  activeHours?: { from: string; to: string };
  /** Its agent may answer QUIET, and a quiet run is not announced. */
  quiet?: boolean;
  /** Its reports wait in the morning brief, with no notification of
   * their own (server/routines.ts). */
  briefOnly?: boolean;
  enabled: boolean;
  lastRunAt?: number;
  summary?: string;
  nextRunAt?: number | null;
  runs?: RoutineRun[];
  /** What its last run that was not quiet said. */
  lastReport?: { at: number; summary: string };
  /** On, but its agent is archived, so it does not run until restored. */
  suspended?: "archived";
  /** Runs that failed in a row. */
  failures?: number;
  /** Stopped running on its own after failing again and again, since
   * when and why. Any change starts it again. */
  failing?: { at: number; error: string };
}

/** The line under a routine saying when it next runs, or why it will not. */
export function routineStatus(routine: Routine, whenNext: (at?: number | null) => string): string {
  if (!routine.enabled) return t("common.paused");
  if (routine.suspended === "archived") return t("routinesSection.status.archived");
  if (routine.failing) return t("routinesSection.status.failing");
  return whenNext(routine.nextRunAt);
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
  const time = formatDate(when, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? t("routinesSection.nextToday", { time })
    : t("routinesSection.nextOn", { day: formatDate(when, { weekday: "short" }), time });
}

export function RoutinesSection({
  targetId,
  targetKind,
  targetName,
  bare = false,
}: {
  targetId: string;
  targetKind: "agent" | "room";
  targetName: string;
  /** Inside a page section that already names it: no card and no
   * heading of its own, only the routines and the way to add one. */
  bare?: boolean;
}) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
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
    <div className={bare ? undefined : "mt-4 rounded-2xl border bg-card p-4"}>
      {!bare && (
        <>
          <div className="flex items-center gap-2 text-ui font-semibold text-foreground">
            <CalendarClock size={15} className="text-muted-foreground" />
            {t("common.routines")}
          </div>
          <div className="mt-0.5 text-body text-muted-foreground">
            {t("routinesSection.whatItDoes", { name: targetName })}
          </div>
        </>
      )}

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">
          {error}
        </div>
      )}

      <div className={cn("flex flex-col gap-2", !bare && "mt-3")}>
        {(routines ?? []).map((routine) => (
          <div key={routine.id} className={cn("rounded-xl border p-2.5", bare ? "bg-card px-3.5 py-3" : "bg-background")}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-body font-medium",
                    routine.enabled ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {describeSchedule(routine)}
                </div>
                <div className="mt-0.5 line-clamp-2 text-small text-muted-foreground">
                  {routine.prompt}
                </div>
                <div className="mt-0.5 text-caption text-muted-foreground/70">
                  {routineStatus(routine, whenNext)}
                </div>
              </div>
              <Switch
                aria-label={
                  routine.name
                    ? t("routinesSection.toggleNamed", { name: routine.name })
                    : t("routinesSection.toggleUnnamed")
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
            <div className="mt-2 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                title={t("routinesSection.runOnceNow")}
                onClick={() => write(api(`/api/routines/${routine.id}/run`, { method: "POST" }))}
              >
                <Play size={11} />
                {t("common.runNow")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(routine)}>
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
        ))}

        {routines?.length === 0 && !adding && (
          <div className="px-3 py-6 text-center text-small text-muted-foreground">
            {t("routinesSection.nothingScheduledYet")}
          </div>
        )}
      </div>

      <Button variant="secondary" className="mt-3 w-full" onClick={() => setAdding(true)}>
        <Plus size={13} />
        {t("routinesSection.newRoutine")}
      </Button>
      {(adding || editing) && (
        <RoutinesDialog
          initialTarget={{ id: targetId, kind: targetKind }}
          startCreating={adding}
          edit={editing ?? undefined}
          onClose={() => {
            setAdding(false);
            setEditing(null);
            load();
          }}
        />
      )}

      <div className="mt-2 text-caption leading-relaxed text-muted-foreground/70">
        {t("routinesSection.runWhileOpen", { computer: thisComputer() })}
      </div>
    </div>
  );
}
