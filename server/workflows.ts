// Work with more than one step in it, and a place for a person to say yes.
//
// A routine wakes an agent on a clock. A job hands one piece of work to
// whoever suits it. Neither can express the thing people actually keep
// describing: when this happens, have somebody look at it, and if it
// turns out to matter, ask me before doing anything about it.
//
// That is three ideas, and each is small on its own. A trigger that is
// not a clock. Steps that pass values along. A step that stops and waits
// for a person. The difficulty is entirely in the third one, so the shape
// of everything here is chosen to make the third one work.
//
// The decision the rest follows from: a run is state on disk, advanced by
// a tick. It is never a chain of promises held open in memory. A run
// parked on an approval is a row in a file saying which step it stopped
// at and when it stops waiting; answering it is a fresh advance from that
// row rather than a callback firing inside a closure that has been alive
// for two days. Suspending a run in memory works beautifully until the
// app quits, which is exactly when somebody is out and the approval has
// been sitting there since yesterday.
//
// Two things left out on purpose.
//
//   No step that calls out to the internet. It is the obvious fourth
//   action and it is a hole: a workflow that can post anywhere is a way
//   to move a workspace's contents off this machine on a trigger, and
//   that needs a permission story of its own rather than a text field.
//
//   No regular expressions in conditions. Everything else here evaluates
//   nothing, which is why there is no sandbox and no time budget: there
//   is nothing that can run away. A regex is the single operator that
//   would have brought that problem back, and "contains" covers what
//   people actually write.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

// ── what a workflow is ─────────────────────────────────────────────────

export type TriggerKind = "manual" | "message" | "reaction" | "webhook";

export interface Trigger {
  kind: TriggerKind;
  /** message and reaction: the lane or room being watched. */
  targetId?: string;
  targetKind?: "agent" | "room";
  /** message: fire only when the text contains this, case insensitive.
   * Absent means any message. */
  contains?: string;
  /** reaction: which emoji. */
  emoji?: string;
  /**
   * Whose message or reaction counts.
   *
   * Defaults to the person, because the alternative is a workflow that
   * agents can set off by talking to each other, and a loop where a
   * workflow's own post triggers itself is the first thing that happens
   * when they can.
   */
  from?: "user" | "anyone";
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

export interface Condition {
  /** Templated. Usually an earlier step's output. */
  left: string;
  op: ConditionOp;
  /** Templated. Unused by empty and not-empty. */
  right?: string;
}

export interface Step {
  /** Stable inside its workflow: this is how later steps name it. */
  id: string;
  action: StepAction;
  /** ask: the agent. post: the room. approve: the lane the card lands
   * in, which defaults to the agent of the nearest ask before it. */
  targetId?: string;
  /** The words, templated. */
  text: string;
  /** Run this step only if this holds. Absent means always. */
  when?: Condition;
  /** approve only: how long the person has. */
  timeoutMin?: number;
  /** approve only: what an unanswered card means when the time is up.
   * Stopping is the default, because nobody answering is not consent. */
  onTimeout?: "stop" | "continue";
}

export interface Workflow {
  id: string;
  name: string;
  trigger: Trigger;
  steps: Step[];
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  /** The last few runs, newest first. */
  runs?: WorkflowRun[];
}

// ── what a run is ──────────────────────────────────────────────────────

export type RunState = "running" | "waiting" | "done" | "failed" | "stopped";

export interface RunStep {
  stepId: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "skipped" | "waiting" | "failed" | "timed-out";
  /** What it produced, short enough to read in a list. */
  summary?: string;
  error?: string;
}

/** A run parked on an approval: everything needed to pick it up again. */
export interface Waiting {
  stepId: string;
  /** Where the card is, so answering it can find this run. */
  threadId: string;
  messageId: string;
  /** When the waiting stops, whatever the person has done. */
  until: number;
  onTimeout: "stop" | "continue";
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  startedAt: number;
  endedAt?: number;
  state: RunState;
  /** The step to run next. Everything before it is finished or skipped. */
  cursor: number;
  /** What set it off, as values later steps can read. */
  trigger: Record<string, string>;
  /** Each finished step's output, by step id. */
  values: Record<string, Record<string, string>>;
  steps: RunStep[];
  waiting?: Waiting;
  /** Why it stopped, when it stopped for a reason worth saying. */
  error?: string;
}

// ── caps ───────────────────────────────────────────────────────────────

export const MAX_WORKFLOWS = 40;
export const MAX_STEPS = 12;
export const MAX_STEP_TEXT = 2_000;
export const MAX_NAME = 80;
/** How many runs a workflow remembers. Enough to see a pattern, not
 * enough to turn a settings file into a log store. */
export const MAX_RUNS = 20;
/** The longest a run may sit on an approval, and the default. A day is
 * what a person away from their desk needs; a week is a run nobody is
 * coming back to. */
export const MAX_TIMEOUT_MIN = 7 * 24 * 60;
export const DEFAULT_TIMEOUT_MIN = 24 * 60;

// ── values passed between steps ────────────────────────────────────────

export interface Scope {
  trigger: Record<string, string>;
  steps: Record<string, Record<string, string>>;
}

export function scopeOf(run: Pick<WorkflowRun, "trigger" | "values">): Scope {
  return { trigger: run.trigger ?? {}, steps: run.values ?? {} };
}

const REFERENCE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** What one reference resolves to, or null when it names nothing. */
function lookup(path: string, scope: Scope): string | null {
  const parts = path.split(".");
  if (parts[0] === "trigger" && parts.length === 2) {
    const value = scope.trigger[parts[1]];
    return value === undefined ? null : String(value);
  }
  if (parts[0] === "steps" && parts.length === 3) {
    const value = scope.steps[parts[1]]?.[parts[2]];
    return value === undefined ? null : String(value);
  }
  return null;
}

/**
 * A step's words with the values filled in.
 *
 * A reference that names nothing becomes empty rather than staying as
 * literal braces. A step whose prompt still had "{{steps.triage.text}}"
 * in it would be sent to an agent as those characters, and an agent doing
 * its best with that is worse than an agent given a sentence with a gap.
 * Forward references cannot reach here anyway: they are refused when the
 * workflow is saved.
 */
export function fill(template: string, scope: Scope): string {
  return String(template ?? "").replace(REFERENCE, (_whole, path: string) => lookup(path, scope) ?? "");
}

/** Every reference in a piece of text, in the order they appear. */
export function referencesIn(template: string): string[] {
  const out: string[] = [];
  for (const match of String(template ?? "").matchAll(REFERENCE)) out.push(match[1]);
  return out;
}

// ── conditions ─────────────────────────────────────────────────────────

/**
 * Whether a step's condition holds.
 *
 * Nothing here is evaluated, only compared, which is the whole reason
 * there is no sandbox and no time budget in this file. Comparison is case
 * insensitive and trims both sides: a condition that fails because
 * somebody's agent replied with a trailing newline is a condition that
 * teaches people not to use conditions.
 */
export function holds(condition: Condition | undefined, scope: Scope): boolean {
  if (!condition) return true;
  const left = fill(condition.left ?? "", scope).trim().toLowerCase();
  const right = fill(condition.right ?? "", scope).trim().toLowerCase();
  switch (condition.op) {
    case "contains":
      return Boolean(right) && left.includes(right);
    case "not-contains":
      return !right || !left.includes(right);
    case "equals":
      return left === right;
    case "starts-with":
      return Boolean(right) && left.startsWith(right);
    case "ends-with":
      return Boolean(right) && left.endsWith(right);
    case "empty":
      return left === "";
    case "not-empty":
      return left !== "";
    default:
      // an operator we do not know is not a reason to run something the
      // person meant to guard
      return false;
  }
}

// ── validation ─────────────────────────────────────────────────────────

const OPS: ConditionOp[] = [
  "contains",
  "not-contains",
  "equals",
  "starts-with",
  "ends-with",
  "empty",
  "not-empty",
];
const ACTIONS: StepAction[] = ["ask", "post", "approve"];
const TRIGGERS: TriggerKind[] = ["manual", "message", "reaction", "webhook"];

/** A step id a person can read in a template, derived from what they
 * typed rather than a random string. */
export function slug(text: string, taken: string[] = []): string {
  const base =
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "step";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const tried = `${base}-${n}`;
    if (!taken.includes(tried)) return tried;
  }
  return `${base}-${taken.length + 1}`;
}

/**
 * Where an approval at this index puts its card.
 *
 * A gate has to appear somewhere a person will see it. The step's own
 * target if it names one, otherwise wherever the run has been working,
 * otherwise the place the trigger watches. Null means nowhere, which is a
 * workflow that would stop dead on its gate and is refused when it is
 * saved rather than discovered on the day it fires.
 */
export function whereToAsk(
  workflow: { trigger?: Trigger; steps: Step[] },
  index: number,
): { id: string; kind: "agent" | "room" } | null {
  const step = workflow.steps[index];
  if (step?.targetId) return { id: step.targetId, kind: "agent" };
  for (let i = index - 1; i >= 0; i--) {
    const earlier = workflow.steps[i];
    if (!earlier.targetId) continue;
    return { id: earlier.targetId, kind: earlier.action === "post" ? "room" : "agent" };
  }
  const trigger = workflow.trigger;
  if (trigger?.targetId) return { id: trigger.targetId, kind: trigger.targetKind ?? "agent" };
  return null;
}

/**
 * What is wrong with this workflow, in the words somebody could act on.
 *
 * Forward references are the one worth catching here rather than at run
 * time. A step reading a later step's output is always a mistake, it
 * always produces an empty gap instead of an error, and the gap turns up
 * in an agent's prompt hours later where nobody connects it back.
 */
export function problems(input: { name?: string; trigger?: Trigger; steps?: Step[] }): string[] {
  const found: string[] = [];
  const trigger = input.trigger;
  if (!trigger) {
    found.push("pick something that sets this off");
  } else if (!TRIGGERS.includes(trigger.kind)) {
    // Named, so name the ones there are: the caller is often a model, and
    // "invalid" sends it round again to make the same mistake.
    found.push(`there is no "${trigger.kind}" trigger. The ones there are: ${TRIGGERS.join(", ")}`);
  } else if ((trigger.kind === "message" || trigger.kind === "reaction") && !trigger.targetId) {
    found.push(`a ${trigger.kind} trigger needs somewhere to watch`);
  } else if (trigger.kind === "reaction" && !trigger.emoji) {
    found.push("a reaction trigger needs an emoji");
  }

  const steps = input.steps ?? [];
  if (!steps.length) found.push("a workflow needs at least one step");
  if (steps.length > MAX_STEPS) found.push(`a workflow holds at most ${MAX_STEPS} steps`);

  const seen: string[] = [];
  steps.forEach((step, index) => {
    const where = `step ${index + 1}`;
    if (!step.id) found.push(`${where} has no name`);
    else if (seen.includes(step.id)) found.push(`two steps are both called "${step.id}"`);
    if (!ACTIONS.includes(step.action)) found.push(`${where} does not say what to do`);
    if (!String(step.text ?? "").trim()) found.push(`${where} has nothing to say`);
    if ((step.action === "ask" || step.action === "post") && !step.targetId) {
      found.push(step.action === "ask" ? `${where} does not say who to ask` : `${where} does not say which room`);
    }
    if (step.action === "approve" && !whereToAsk({ trigger: input.trigger, steps }, index)) {
      found.push(`${where} has nowhere to put its question: name an agent on it`);
    }
    if (step.when && !OPS.includes(step.when.op)) found.push(`${where} has a condition nobody can check`);

    // every reference has to name the trigger or a step already finished
    const references = [
      ...referencesIn(step.text ?? ""),
      ...referencesIn(step.when?.left ?? ""),
      ...referencesIn(step.when?.right ?? ""),
    ];
    for (const reference of references) {
      const parts = reference.split(".");
      if (parts[0] === "trigger") continue;
      if (parts[0] !== "steps" || parts.length !== 3) {
        found.push(`${where} mentions {{${reference}}}, which is not a thing a step can read`);
        continue;
      }
      if (parts[1] === step.id) {
        found.push(`${where} reads its own answer, which does not exist yet`);
      } else if (!seen.includes(parts[1])) {
        found.push(`${where} reads "${parts[1]}", which has not run by then`);
      }
    }
    if (step.id) seen.push(step.id);
  });
  return found;
}

/** Everything a client may set, cut to shape. Returns null when what
 * arrived is not a workflow at all. */
export function clean(raw: unknown): Omit<Workflow, "id" | "createdAt"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const rawTrigger = (typeof v.trigger === "object" && v.trigger !== null ? v.trigger : {}) as Record<string, unknown>;
  // A missing kind means manual, which is the honest default for a
  // workflow that does not say what sets it off. A kind that was named
  // and is not one of ours is kept as it arrived, so problems() can
  // refuse it by name: quietly turning "schedule" into "manual" hands
  // back a workflow that will never fire and says nothing about it.
  const named = rawTrigger.kind;
  const kind = (
    named === undefined || named === null || named === ""
      ? "manual"
      : TRIGGERS.includes(named as TriggerKind)
        ? named
        : String(named)
  ) as TriggerKind;
  const trigger: Trigger = { kind };
  if (typeof rawTrigger.targetId === "string" && /^[\w-]{1,64}$/.test(rawTrigger.targetId)) {
    trigger.targetId = rawTrigger.targetId;
  }
  if (rawTrigger.targetKind === "agent" || rawTrigger.targetKind === "room") {
    trigger.targetKind = rawTrigger.targetKind;
  }
  if (typeof rawTrigger.contains === "string" && rawTrigger.contains.trim()) {
    trigger.contains = rawTrigger.contains.trim().slice(0, 120);
  }
  if (typeof rawTrigger.emoji === "string" && rawTrigger.emoji.trim()) {
    trigger.emoji = [...rawTrigger.emoji.trim()].slice(0, 4).join("");
  }
  trigger.from = rawTrigger.from === "anyone" ? "anyone" : "user";

  const takenIds: string[] = [];
  const steps: Step[] = (Array.isArray(v.steps) ? v.steps : [])
    .slice(0, MAX_STEPS)
    .map((entry) => {
      const s = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const action = ACTIONS.includes(s.action as StepAction) ? (s.action as StepAction) : "ask";
      const text = String(s.text ?? "").slice(0, MAX_STEP_TEXT);
      const wanted = typeof s.id === "string" && s.id.trim() ? s.id : text || action;
      const id = slug(wanted, takenIds);
      takenIds.push(id);
      const step: Step = { id, action, text };
      if (typeof s.targetId === "string" && /^[\w-]{1,64}$/.test(s.targetId)) step.targetId = s.targetId;
      const rawWhen = (typeof s.when === "object" && s.when !== null ? s.when : null) as Record<string, unknown> | null;
      if (rawWhen && OPS.includes(rawWhen.op as ConditionOp)) {
        step.when = {
          left: String(rawWhen.left ?? "").slice(0, MAX_STEP_TEXT),
          op: rawWhen.op as ConditionOp,
          right: String(rawWhen.right ?? "").slice(0, MAX_STEP_TEXT),
        };
      }
      if (action === "approve") {
        const asked = Number(s.timeoutMin);
        step.timeoutMin = Number.isFinite(asked)
          ? Math.max(1, Math.min(MAX_TIMEOUT_MIN, Math.round(asked)))
          : DEFAULT_TIMEOUT_MIN;
        step.onTimeout = s.onTimeout === "continue" ? "continue" : "stop";
      }
      return step;
    });

  return {
    name: String(v.name ?? "").trim().slice(0, MAX_NAME) || "Untitled workflow",
    trigger,
    steps,
    enabled: v.enabled !== false,
  };
}

// ── the run, as a state machine ────────────────────────────────────────

export type NextMove =
  | { kind: "done" }
  | { kind: "step"; step: Step; index: number }
  | { kind: "skip"; step: Step; index: number };

/**
 * What this run does next.
 *
 * Pure, and separate from doing it, so the interesting part (a condition
 * that skips a step, a cursor past the end) is testable without an agent,
 * a room or a clock.
 */
export function nextMove(workflow: Pick<Workflow, "steps">, run: WorkflowRun): NextMove {
  const index = run.cursor;
  const step = workflow.steps[index];
  if (!step) return { kind: "done" };
  return holds(step.when, scopeOf(run)) ? { kind: "step", step, index } : { kind: "skip", step, index };
}

/** A run that has stopped, one way or another. */
export function settled(run: WorkflowRun): boolean {
  return run.state === "done" || run.state === "failed" || run.state === "stopped";
}

/** When this approval stops waiting. */
export function waitUntil(step: Step, now: number): number {
  const minutes = Math.max(1, Math.min(MAX_TIMEOUT_MIN, step.timeoutMin ?? DEFAULT_TIMEOUT_MIN));
  return now + minutes * 60_000;
}

/** Runs parked on an approval whose time is up. */
export function timedOut(runs: WorkflowRun[], now: number): WorkflowRun[] {
  return runs.filter((run) => run.state === "waiting" && run.waiting && run.waiting.until <= now);
}

/**
 * Whether a message or reaction should set this workflow off.
 *
 * The from rule matters more than it looks. A workflow whose post step
 * lands in the room it is watching would trigger itself, forever, and the
 * default of only listening to the person is what stops that from being
 * possible rather than merely unlikely.
 */
export function firesOn(
  trigger: Trigger,
  event: { kind: "message" | "reaction"; targetId: string; text?: string; emoji?: string; fromUser: boolean },
): boolean {
  if (trigger.kind !== event.kind) return false;
  if (!trigger.targetId || trigger.targetId !== event.targetId) return false;
  if (trigger.from !== "anyone" && !event.fromUser) return false;
  if (event.kind === "reaction") return Boolean(trigger.emoji) && trigger.emoji === event.emoji;
  if (!trigger.contains) return true;
  return (event.text ?? "").toLowerCase().includes(trigger.contains.toLowerCase());
}

/** One line saying what a workflow does, for a list. */
export function describe(workflow: Workflow): string {
  const when =
    workflow.trigger.kind === "manual"
      ? "When you run it"
      : workflow.trigger.kind === "webhook"
        ? "When its webhook fires"
        : workflow.trigger.kind === "reaction"
          ? `When someone reacts ${workflow.trigger.emoji ?? ""}`.trim()
          : workflow.trigger.contains
            ? `When a message mentions "${workflow.trigger.contains}"`
            : "When a message lands";
  const count = workflow.steps.length;
  const gates = workflow.steps.filter((s) => s.action === "approve").length;
  const body = `${count} ${count === 1 ? "step" : "steps"}`;
  return gates ? `${when}, ${body}, ${gates === 1 ? "one waits for you" : `${gates} wait for you`}` : `${when}, ${body}`;
}

// ── the file ───────────────────────────────────────────────────────────

const WORKFLOWS_FILE = join(DATA_DIR, "workflows.json");

export class WorkflowStore {
  workflows: Workflow[] = [];

  constructor() {
    try {
      const parsed = JSON.parse(readFileSync(WORKFLOWS_FILE, "utf8"));
      if (Array.isArray(parsed)) {
        this.workflows = parsed.filter((w) => w?.id && typeof w.name === "string" && Array.isArray(w.steps));
      }
    } catch {
      /* none yet */
    }
  }

  private save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(WORKFLOWS_FILE, JSON.stringify(this.workflows, null, 2), { mode: 0o600 });
    } catch {
      /* still a workflow for this session */
    }
  }

  list(): Workflow[] {
    return [...this.workflows].sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt));
  }

  get(id: string): Workflow | null {
    return this.workflows.find((w) => w.id === id) ?? null;
  }

  create(input: Omit<Workflow, "id" | "createdAt">, now: number): Workflow | null {
    if (this.workflows.length >= MAX_WORKFLOWS) return null;
    const workflow: Workflow = { ...input, id: newId(), createdAt: now };
    this.workflows.unshift(workflow);
    this.save();
    return workflow;
  }

  patch(id: string, input: Partial<Omit<Workflow, "id" | "createdAt">>): Workflow | null {
    const workflow = this.get(id);
    if (!workflow) return null;
    Object.assign(workflow, input);
    this.save();
    return workflow;
  }

  remove(id: string): boolean {
    const before = this.workflows.length;
    this.workflows = this.workflows.filter((w) => w.id !== id);
    if (this.workflows.length === before) return false;
    this.save();
    return true;
  }

  /** Workflows that watch this place, so a message or a reaction can ask
   * cheaply whether anything cares. */
  watching(targetId: string): Workflow[] {
    return this.workflows.filter((w) => w.enabled && w.trigger.targetId === targetId);
  }

  // ── runs ─────────────────────────────────────────────────────────────

  begin(workflowId: string, trigger: Record<string, string>, now: number): WorkflowRun | null {
    const workflow = this.get(workflowId);
    if (!workflow) return null;
    const run: WorkflowRun = {
      id: newId(),
      workflowId,
      startedAt: now,
      state: "running",
      cursor: 0,
      trigger,
      values: {},
      steps: [],
    };
    workflow.runs = [run, ...(workflow.runs ?? [])].slice(0, MAX_RUNS);
    workflow.lastRunAt = now;
    this.save();
    return run;
  }

  run(runId: string): { workflow: Workflow; run: WorkflowRun } | null {
    for (const workflow of this.workflows) {
      const run = workflow.runs?.find((r) => r.id === runId);
      if (run) return { workflow, run };
    }
    return null;
  }

  /** Every run parked on an approval, across every workflow. */
  waiting(): WorkflowRun[] {
    return this.workflows.flatMap((w) => (w.runs ?? []).filter((r) => r.state === "waiting"));
  }

  /** The run whose approval card is this message, if there is one. */
  runAwaiting(threadId: string, messageId: string): { workflow: Workflow; run: WorkflowRun } | null {
    for (const workflow of this.workflows) {
      const run = (workflow.runs ?? []).find(
        (r) => r.state === "waiting" && r.waiting?.threadId === threadId && r.waiting?.messageId === messageId,
      );
      if (run) return { workflow, run };
    }
    return null;
  }

  /** Change a run in place and write it down. Everything the runner does
   * to a run goes through here, so nothing advances without landing on
   * disk first. */
  update(runId: string, change: (run: WorkflowRun) => void): WorkflowRun | null {
    const found = this.run(runId);
    if (!found) return null;
    change(found.run);
    this.save();
    return found.run;
  }

  /**
   * Runs left mid-flight by a quit.
   *
   * A run that was running when the app stopped has no turn behind it any
   * more, so it is failed rather than shown as a spinner nobody is
   * driving. A run that was waiting is left exactly as it is: that is the
   * whole point of parking it on disk, and its card is still in the chat.
   */
  settleOrphanRuns(now: number): number {
    let settled = 0;
    for (const workflow of this.workflows) {
      for (const run of workflow.runs ?? []) {
        if (run.state !== "running") continue;
        run.state = "failed";
        run.endedAt = now;
        run.error = "Bloks stopped while this was running.";
        for (const step of run.steps) {
          if (step.state === "running") {
            step.state = "failed";
            step.endedAt = now;
          }
        }
        settled++;
      }
    }
    if (settled) this.save();
    return settled;
  }

  /** A deleted agent or room takes its workflows' triggers with it. */
  removeTarget(targetId: string) {
    let touched = false;
    for (const workflow of this.workflows) {
      if (workflow.trigger.targetId === targetId) {
        workflow.enabled = false;
        delete workflow.trigger.targetId;
        touched = true;
      }
      for (const step of workflow.steps) {
        if (step.targetId === targetId) {
          delete step.targetId;
          workflow.enabled = false;
          touched = true;
        }
      }
    }
    if (touched) this.save();
  }
}
