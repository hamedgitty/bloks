// Workflows: what happens, in order, and where you get a say.
//
// The hard part to show is not the list of steps. It is that a run can be
// sitting still, waiting for a person, and that this is a normal state
// rather than a stuck one. So a run in progress is drawn as its steps
// with one of them highlighted, and a run parked on an approval says who
// it is waiting for and until when, in words rather than a spinner.
//
// The editor is a form rather than a canvas. A canvas is the obvious way
// to draw a workflow and the wrong way to write one: dragging boxes is
// slower than typing for anything under a dozen steps, and a dozen steps
// is the cap.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot.js";
import Hourglass from "lucide-react/dist/esm/icons/hourglass.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { useStore, type Bot } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export type StepAction = "ask" | "post" | "approve";
export type ConditionOp =
  | "contains"
  | "not-contains"
  | "equals"
  | "starts-with"
  | "ends-with"
  | "empty"
  | "not-empty";

export interface Step {
  id: string;
  action: StepAction;
  targetId?: string;
  text: string;
  when?: { left: string; op: ConditionOp; right?: string };
  timeoutMin?: number;
  onTimeout?: "stop" | "continue";
}

export interface RunStep {
  stepId: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "skipped" | "waiting" | "failed" | "timed-out";
  summary?: string;
  error?: string;
}

export interface Run {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "waiting" | "done" | "failed" | "stopped";
  steps: RunStep[];
  waiting?: { stepId: string; until: number; onTimeout: "stop" | "continue" };
  error?: string;
}

export interface Workflow {
  id: string;
  name: string;
  trigger: {
    kind: "manual" | "message" | "reaction" | "webhook";
    targetId?: string;
    targetKind?: "agent" | "room";
    contains?: string;
    emoji?: string;
    from?: "user" | "anyone";
  };
  steps: Step[];
  enabled: boolean;
  lastRunAt?: number;
  runs?: Run[];
  summary?: string;
}

const OPS: Array<[ConditionOp, string]> = [
  ["contains", "contains"],
  ["not-contains", "does not contain"],
  ["equals", "is exactly"],
  ["starts-with", "starts with"],
  ["ends-with", "ends with"],
  ["not-empty", "said anything"],
  ["empty", "said nothing"],
];

/**
 * What a step will be called, so an earlier answer can be referenced
 * before the workflow has ever been saved.
 *
 * The same rule as slug() in server/workflows.ts, which stays the
 * authority: whatever is sent gets normalised there. This produces a
 * string that rule leaves alone, so the two agree. If they ever drifted,
 * the save would be refused with the reference named rather than
 * silently leaving a gap in a prompt, which is the failure worth having.
 */
function stepId(text: string, taken: string[]): string {
  const base =
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "step";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${taken.length + 1}`;
}

function when(at: number): string {
  const date = new Date(at);
  const today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return today ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** "3 hours from now", for a deadline somebody has to act inside. */
function until(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return "any moment";
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} from now`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? "hour" : "hours"} from now`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} from now`;
}

export function Workflows() {
  const { state } = useStore();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/workflows")
      .then((r) => setWorkflows(r.workflows ?? []))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    // the same cadence the job board uses: a run advances on its own, so
    // the list has to change without anybody pressing anything
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  // Existing steps still resolve a name from everyone, so a workflow
  // pointing at an archived agent stays readable. The picker offers only
  // the ones that can act: a step aimed at a retired agent is a workflow
  // that fails at the moment it fires.
  const bots = state.bots ?? [];
  const choosable = bots.filter((b) => !b.archivedAt);
  const rooms = state.bloks ?? [];

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-1 py-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-4">
        <p className="max-w-[560px] text-[12.5px] leading-relaxed text-muted-foreground">
          Work with more than one step in it. Something sets it off, each step passes what it found
          to the next, and a step can stop and wait for you before the rest happens.
        </p>
        <Button size="sm" className="shrink-0" onClick={() => setEditing("new")}>
          <Plus size={14} /> New workflow
        </Button>
      </div>

      {error && (
        <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</div>
      )}

      {workflows?.length === 0 && (
        <div className="rounded-2xl border border-dashed px-4 py-10 text-center">
          <div className="text-[13.5px] text-foreground">Nothing runs itself yet.</div>
          <div className="mx-auto mt-1 max-w-[420px] text-[12.5px] leading-relaxed text-muted-foreground">
            A workflow is worth having when the answer to something changes what happens next: have
            an agent look, and if it turns out to matter, ask you before anything is done about it.
          </div>
        </div>
      )}

      {workflows?.map((workflow) => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          bots={bots}
          onChanged={load}
          onEdit={() => setEditing(workflow)}
          onError={setError}
        />
      ))}

      {editing && (
        <Editor
          workflow={editing === "new" ? null : editing}
          bots={choosable}
          rooms={rooms}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function WorkflowCard({
  workflow,
  bots,
  onChanged,
  onEdit,
  onError,
}: {
  workflow: Workflow;
  bots: Bot[];
  onChanged: () => void;
  onEdit: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const runs = workflow.runs ?? [];
  const latest = runs[0];
  const waiting = runs.find((run) => run.state === "waiting");

  const run = () => {
    setBusy(true);
    api(`/api/workflows/${workflow.id}/run`, { method: "POST", body: JSON.stringify({}) })
      .then(onChanged)
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className={cn("rounded-2xl border bg-card", waiting && "border-warning/50")}>
      <div className="flex items-start gap-3 p-4">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `Hide the steps in ${workflow.name}` : `Show the steps in ${workflow.name}`}
          title={open ? "Hide the steps" : "Show the steps"}
          className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-foreground">{workflow.name}</span>
            {!workflow.enabled && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">off</span>
            )}
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted-foreground">{workflow.summary}</div>
          {/* The state worth putting on the outside of the card: a run
              that is sitting still because it is waiting for you looks
              exactly like a run that is stuck, unless it says so. */}
          {waiting?.waiting && (
            <div className="mt-2 flex items-center gap-1.5 text-[12.5px] text-warning">
              <Hourglass size={13} />
              Waiting for you. It {waiting.waiting.onTimeout === "continue" ? "carries on" : "stops"}{" "}
              {until(waiting.waiting.until)}.
            </div>
          )}
          {!waiting && latest && (
            <div className="mt-1 text-[11.5px] text-muted-foreground">
              Last run {when(latest.startedAt)} · {stateWord(latest)}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Switch
            aria-label={`${workflow.name}: on or off`}
            checked={workflow.enabled}
            onCheckedChange={(enabled) =>
              api(`/api/workflows/${workflow.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) })
                .then(onChanged)
                .catch((e: Error) => onError(e.message))
            }
          />
          <Button variant="ghost" size="icon-sm" title="Run it now" disabled={busy} onClick={run}>
            <Play size={14} />
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t px-4 py-3">
          <div className="flex flex-col gap-1.5">
            {workflow.steps.map((step, i) => (
              <div key={step.id} className="flex items-start gap-2.5 text-[12.5px]">
                <span className="mt-[3px] flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10.5px] text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground">{verb(step, bots)}</span>
                  <span className="ml-1.5 text-muted-foreground">{step.text}</span>
                  {step.when && (
                    <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                      only if {step.when.left} {OPS.find(([op]) => op === step.when!.op)?.[1]}{" "}
                      {step.when.right ? `“${step.when.right}”` : ""}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{step.id}</span>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (!confirm(`Delete "${workflow.name}"?`)) return;
                api(`/api/workflows/${workflow.id}`, { method: "DELETE" })
                  .then(onChanged)
                  .catch((e: Error) => onError(e.message));
              }}
            >
              <Trash2 size={13} /> Delete
            </Button>
          </div>

          {runs.length > 0 && (
            <div className="mt-3 border-t pt-3">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Runs
              </div>
              <div className="mt-1.5 flex flex-col gap-2">
                {runs.slice(0, 6).map((entry) => (
                  <RunRow key={entry.id} run={entry} steps={workflow.steps} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stateWord(run: Run): string {
  switch (run.state) {
    case "running":
      return "running";
    case "waiting":
      return "waiting for you";
    case "done":
      return "finished";
    case "stopped":
      return run.error ?? "stopped";
    default:
      return run.error ?? "failed";
  }
}

function verb(step: Step, bots: Bot[]): string {
  const who = bots.find((b) => b.id === step.targetId)?.name;
  if (step.action === "ask") return `Ask ${who ?? "an agent"}:`;
  if (step.action === "post") return "Post in the room:";
  return "Ask you:";
}

function RunRow({ run, steps }: { run: Run; steps: Step[] }) {
  const nameOf = (stepId: string) => steps.find((s) => s.id === stepId)?.text ?? stepId;
  return (
    <div className="rounded-xl bg-muted/40 px-2.5 py-2">
      <div className="flex items-center justify-between text-[11.5px]">
        <span className="text-muted-foreground">{when(run.startedAt)}</span>
        <span
          className={cn(
            run.state === "done" && "text-success",
            run.state === "waiting" && "text-warning",
            (run.state === "failed" || run.state === "stopped") && "text-destructive",
            run.state === "running" && "text-muted-foreground",
          )}
        >
          {stateWord(run)}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {run.steps.map((entry, i) => (
          <div key={`${entry.stepId}-${i}`} className="flex items-start gap-1.5 text-[11.5px]">
            <span className="mt-[2px] shrink-0">
              {entry.state === "ok" ? (
                <Check size={11} className="text-success" />
              ) : entry.state === "waiting" ? (
                <Hourglass size={11} className="text-warning" />
              ) : entry.state === "skipped" ? (
                <ChevronRight size={11} className="text-muted-foreground/60" />
              ) : entry.state === "running" ? (
                <CircleDot size={11} className="text-muted-foreground" />
              ) : (
                <X size={11} className="text-destructive" />
              )}
            </span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              <span className={cn(entry.state === "skipped" && "line-through opacity-60")}>
                {nameOf(entry.stepId)}
              </span>
              {entry.summary && <span className="ml-1 opacity-70">· {entry.summary.slice(0, 90)}</span>}
              {entry.error && <span className="ml-1 text-destructive">· {entry.error}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── the editor ─────────────────────────────────────────────────────────

const EMPTY: Workflow = {
  id: "",
  name: "",
  trigger: { kind: "manual", from: "user" },
  steps: [{ id: "", action: "ask", text: "", targetId: "" }],
  enabled: true,
};

function Editor({
  workflow,
  bots,
  rooms,
  onClose,
  onSaved,
}: {
  workflow: Workflow | null;
  bots: Bot[];
  rooms: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Workflow>(workflow ?? EMPTY);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const patchStep = (index: number, change: Partial<Step>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, i) => {
        if (i !== index) return s;
        const next = { ...s, ...change };
        // A step gets its name the moment it has words, not when the
        // workflow is first saved. Without that, a workflow being written
        // for the first time has nothing for a later step to refer to,
        // which is most of the point of having steps at all. Named once
        // and then left alone, so editing the words later does not break
        // a reference somebody already wrote.
        if (!next.id && next.text.trim()) {
          next.id = stepId(next.text, d.steps.filter((_, j) => j !== index).map((other) => other.id));
        }
        return next;
      }),
    }));

  const save = () => {
    setBusy(true);
    setProblems([]);
    const body = JSON.stringify({ ...draft, id: undefined });
    const call = draft.id
      ? api(`/api/workflows/${draft.id}`, { method: "PATCH", body })
      : api("/api/workflows", { method: "POST", body });
    call
      .then(onSaved)
      .catch((e: Error) => setProblems([e.message]))
      .finally(() => setBusy(false));
  };

  // what an earlier step is called, so a template can be inserted rather
  // than remembered
  const earlier = (index: number) =>
    draft.steps.slice(0, index).filter((s) => s.id).map((s) => s.id);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm">
      <div className="my-6 w-full max-w-[620px] rounded-2xl border bg-background shadow-lg">
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <div className="text-[15px] font-semibold text-foreground">
            {draft.id ? "Edit workflow" : "New workflow"}
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X size={17} />
          </Button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Name</span>
            <Input
              value={draft.name}
              placeholder="What this is for"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>

          <div className="rounded-2xl border bg-card p-3.5">
            <div className="text-[13px] font-semibold text-foreground">What sets it off</div>
            <div className="mt-2 flex flex-wrap gap-1 rounded-xl bg-muted p-1">
              {(
                [
                  ["manual", "You run it"],
                  ["message", "A message"],
                  ["reaction", "A reaction"],
                  ["webhook", "A webhook"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  onClick={() => setDraft({ ...draft, trigger: { ...draft.trigger, kind } })}
                  className={cn(
                    "flex-1 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors duration-150",
                    draft.trigger.kind === kind
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {(draft.trigger.kind === "message" || draft.trigger.kind === "reaction") && (
              <div className="mt-3 flex flex-col gap-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-muted-foreground">Where to watch</span>
                  <select
                    value={draft.trigger.targetId ?? ""}
                    onChange={(e) => {
                      const id = e.target.value;
                      const isRoom = rooms.some((r) => r.id === id);
                      setDraft({
                        ...draft,
                        trigger: { ...draft.trigger, targetId: id, targetKind: isRoom ? "room" : "agent" },
                      });
                    }}
                    className="rounded-xl border border-input bg-transparent px-3 py-2 text-[13.5px] text-foreground outline-none"
                  >
                    <option value="">Pick somewhere</option>
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name} (room)
                      </option>
                    ))}
                  </select>
                </label>
                {draft.trigger.kind === "message" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted-foreground">
                      Only when it mentions (leave empty for any message)
                    </span>
                    <Input
                      value={draft.trigger.contains ?? ""}
                      placeholder="invoice"
                      onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, contains: e.target.value } })}
                    />
                  </label>
                ) : (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Which emoji</span>
                    <Input
                      value={draft.trigger.emoji ?? ""}
                      placeholder="🚀"
                      onChange={(e) => setDraft({ ...draft, trigger: { ...draft.trigger, emoji: e.target.value } })}
                    />
                  </label>
                )}
                {/* The default is the person, and the reason is worth
                    saying: a workflow that posts where it watches would
                    otherwise set itself off, forever. */}
                <label className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2">
                  <span className="text-[12.5px] leading-relaxed text-muted-foreground">
                    Agents can set this off too. Off by default: a workflow that posts where it
                    watches would keep triggering itself.
                  </span>
                  <Switch
                    aria-label="Agents can set this off too"
                    checked={draft.trigger.from === "anyone"}
                    onCheckedChange={(on) =>
                      setDraft({ ...draft, trigger: { ...draft.trigger, from: on ? "anyone" : "user" } })
                    }
                  />
                </label>
              </div>
            )}
            {draft.trigger.kind === "webhook" && (
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                Save this, then add a webhook pointing at it under Automations, Webhooks. What gets
                posted arrives as <code className="rounded bg-muted px-1">{"{{trigger.text}}"}</code>.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-foreground">Steps</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setDraft({ ...draft, steps: [...draft.steps, { id: "", action: "ask", text: "", targetId: "" }] })
                }
              >
                <Plus size={13} /> Add a step
              </Button>
            </div>

            {draft.steps.map((step, index) => (
              <StepEditor
                key={index}
                step={step}
                index={index}
                bots={bots}
                rooms={rooms}
                earlier={earlier(index)}
                onChange={(change) => patchStep(index, change)}
                onRemove={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}
              />
            ))}
          </div>

          {problems.length > 0 && (
            <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] leading-relaxed text-destructive">
              {problems.map((problem) => (
                <div key={problem}>{problem}</div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={save}>
            {draft.id ? "Save" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StepEditor({
  step,
  index,
  bots,
  rooms,
  earlier,
  onChange,
  onRemove,
}: {
  step: Step;
  index: number;
  bots: Bot[];
  rooms: Array<{ id: string; name: string }>;
  earlier: string[];
  onChange: (change: Partial<Step>) => void;
  onRemove: () => void;
}) {
  const [conditional, setConditional] = useState(Boolean(step.when));

  return (
    <div className="rounded-2xl border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10.5px] text-muted-foreground">
          {index + 1}
        </span>
        <div className="flex flex-1 gap-1 rounded-xl bg-muted p-1">
          {(
            [
              ["ask", "Ask an agent"],
              ["post", "Post in a room"],
              ["approve", "Ask you"],
            ] as const
          ).map(([action, label]) => (
            <button
              key={action}
              onClick={() => onChange({ action, targetId: "" })}
              className={cn(
                "flex-1 rounded-lg px-2 py-1 text-[12px] transition-colors duration-150",
                step.action === action
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Remove step" onClick={onRemove}>
          <Trash2 size={13} />
        </Button>
      </div>

      {step.action !== "approve" && (
        <select
          value={step.targetId ?? ""}
          onChange={(e) => onChange({ targetId: e.target.value })}
          className="mt-2.5 w-full rounded-xl border border-input bg-transparent px-3 py-2 text-[13.5px] text-foreground outline-none"
        >
          <option value="">{step.action === "ask" ? "Which agent" : "Which room"}</option>
          {(step.action === "ask" ? bots : rooms).map((target) => (
            <option key={target.id} value={target.id}>
              {target.name}
            </option>
          ))}
        </select>
      )}

      <Textarea
        value={step.text}
        placeholder={
          step.action === "approve"
            ? "What you are being asked to approve"
            : step.action === "post"
              ? "What to say"
              : "What to ask them to do"
        }
        onChange={(e) => onChange({ text: e.target.value })}
        className="mt-2 min-h-[62px] resize-none text-[13px]"
      />

      {earlier.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="text-[11.5px] text-muted-foreground">Use an earlier answer:</span>
          {earlier.map((id) => (
            <button
              key={id}
              onClick={() => onChange({ text: `${step.text}{{steps.${id}.text}}` })}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              {id}
            </button>
          ))}
          <button
            onClick={() => onChange({ text: `${step.text}{{trigger.text}}` })}
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            trigger
          </button>
        </div>
      )}

      {step.action === "approve" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            Waits
            <Input
              type="number"
              min={1}
              value={String(Math.round((step.timeoutMin ?? 1440) / 60))}
              onChange={(e) => onChange({ timeoutMin: Math.max(1, Number(e.target.value) || 1) * 60 })}
              className="h-8 w-[68px] text-[13px]"
            />
            hours
          </label>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Switch
              aria-label="Carry on if nobody answers"
              checked={step.onTimeout === "continue"}
              onCheckedChange={(on) => onChange({ onTimeout: on ? "continue" : "stop" })}
            />
            carry on if nobody answers
          </label>
        </div>
      )}

      <div className="mt-2.5">
        {conditional || step.when ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-muted/50 px-2.5 py-2">
            <span className="text-[12px] text-muted-foreground">Only if</span>
            <Input
              value={step.when?.left ?? ""}
              placeholder="{{steps.triage.text}}"
              onChange={(e) =>
                onChange({ when: { op: "contains", ...step.when, left: e.target.value } })
              }
              className="h-8 min-w-[150px] flex-1 font-mono text-[12px]"
            />
            <select
              value={step.when?.op ?? "contains"}
              onChange={(e) =>
                onChange({ when: { left: "", ...step.when, op: e.target.value as ConditionOp } })
              }
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-[12.5px] text-foreground outline-none"
            >
              {OPS.map(([op, label]) => (
                <option key={op} value={op}>
                  {label}
                </option>
              ))}
            </select>
            {step.when?.op !== "empty" && step.when?.op !== "not-empty" && (
              <Input
                value={step.when?.right ?? ""}
                placeholder="urgent"
                onChange={(e) =>
                  onChange({ when: { left: "", op: "contains", ...step.when, right: e.target.value } })
                }
                className="h-8 min-w-[110px] flex-1 text-[12.5px]"
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Always run this step"
              onClick={() => {
                setConditional(false);
                onChange({ when: undefined });
              }}
            >
              <X size={13} />
            </Button>
          </div>
        ) : (
          <button
            onClick={() => setConditional(true)}
            className="text-[12px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            Only run this sometimes
          </button>
        )}
      </div>
    </div>
  );
}
