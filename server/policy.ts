// Rules a person writes about what their agents may do.
//
// An agent partway through a turn asks before anything consequential, and
// item 10 records the answer. That works and it does not scale: the
// hundredth "may I read this file" is the same decision as the first, and
// a person who answers a hundred cards stops reading them, which is worse
// than not asking.
//
// So the questions get answered by rules first, and only what the rules do
// not cover reaches a person. Five decisions, four of them borrowed and
// one of them ours.
//
//   Deny is evaluated before allow, and deny wins. An operator can then
//   reason about what is forbidden without reading every allow rule
//   written since, and a broad allow added later cannot quietly reopen
//   something that was shut.
//
//   The target is read here, from what the engine actually sent, rather
//   than taken as a label. A rule about a path has to be checked against
//   the path the tool was given, or renaming the thing gets past the rule.
//
//   Nothing that cannot be evaluated is permitted. A rule with an operator
//   this build does not know cannot be shown not to apply, so a deny with
//   one denies and an allow with one does not allow.
//
//   Rules compare, they never evaluate. The same call as item 20: there is
//   no expression language here, so there is no sandbox to get wrong and
//   nothing that can run away. It also means a rule is a form rather than
//   a syntax, which is the difference between a person writing one and a
//   person being told they could.
//
// And the one that is ours rather than theirs. **No rules means ask, not
// deny.** A gateway that is the only way through is right to refuse what
// it was told nothing about. Here the thing an empty policy replaces is a
// person deciding, and quietly refusing everything the day somebody opens
// this screen would be a worse product and a worse default. Fail closed
// applies inside a rule, never to the absence of one.
//
// Questions are never governed. An agent asking its owner something is not
// an action, and a rule that answered it would be inventing an answer.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type Effect = "allow" | "deny";

/** What a rule can look at. Each one is read from the request rather than
 * taken from a label the caller chose. */
export type Field = "tool" | "command" | "path" | "url" | "agent";

/** The same vocabulary as a workflow condition, for the same reason: a
 * comparison a person can read, and nothing that evaluates. */
export type Op = "contains" | "not-contains" | "equals" | "starts-with" | "ends-with";

export const FIELDS: Field[] = ["tool", "command", "path", "url", "agent"];
export const OPS: Op[] = ["contains", "not-contains", "equals", "starts-with", "ends-with"];

export interface Rule {
  id: string;
  effect: Effect;
  field: Field;
  op: Op;
  value: string;
  /** Only this agent. Absent means every agent. */
  botId?: string;
  enabled: boolean;
  createdAt: number;
}

/** One request, with its target already read out of what the tool was
 * given. Absent fields are absent, not empty: a rule about a path must
 * not match a request that has no path. */
export interface Ask {
  tool: string;
  command?: string;
  path?: string;
  url?: string;
  botId: string;
  agent: string;
}

export type Decision =
  | { verdict: "allow"; rule: Rule; because: string }
  | { verdict: "deny"; rule: Rule; because: string }
  | { verdict: "ask"; because: string };

export const MAX_RULES = 100;
export const MAX_VALUE = 200;

// ── reading the target out of a request ────────────────────────────────

/**
 * What the tool was actually asked to do.
 *
 * Names differ by tool and by engine, so the likely ones are tried in
 * turn. A field that is not there stays undefined, which is what stops a
 * rule about paths from matching a request that has none.
 */
export function targetOf(tool: string, input: Record<string, unknown>, who: { botId: string; agent: string }): Ask {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const found = text(input?.[key]);
      if (found) return found;
    }
    return undefined;
  };
  return {
    tool: (tool ?? "").trim() || "tool",
    command: first("command", "cmd", "script"),
    path: first("file_path", "path", "filePath", "notebook_path", "target_file"),
    url: first("url", "uri"),
    botId: who.botId,
    agent: who.agent,
  };
}

// ── deciding ───────────────────────────────────────────────────────────

/** What a rule is looking at in this request, or undefined when the
 * request has no such thing. */
function valueOf(field: Field, ask: Ask): string | undefined {
  switch (field) {
    case "tool":
      return ask.tool;
    case "command":
      return ask.command;
    case "path":
      return ask.path;
    case "url":
      return ask.url;
    case "agent":
      return ask.agent;
    default:
      return undefined;
  }
}

/**
 * Does this rule apply to this request.
 *
 * `unknown` is the third answer and it exists so the caller can fail in
 * the safe direction: a rule this build cannot evaluate has not been
 * shown not to apply, and what to do about that depends on whether it
 * denies or allows.
 */
export function applies(rule: Rule, ask: Ask): boolean | "unknown" {
  if (!FIELDS.includes(rule.field)) return "unknown";
  if (!OPS.includes(rule.op)) return "unknown";
  if (rule.botId && rule.botId !== ask.botId) return false;

  const found = valueOf(rule.field, ask);
  // A rule about a path says nothing about a request that has no path,
  // including a "does not contain" one: a request with no path has not
  // satisfied it, it is simply not what the rule is about.
  if (found === undefined) return false;

  const left = found.toLowerCase();
  const right = (rule.value ?? "").trim().toLowerCase();
  switch (rule.op) {
    case "contains":
      return Boolean(right) && left.includes(right);
    case "not-contains":
      return Boolean(right) && !left.includes(right);
    case "equals":
      return left === right;
    case "starts-with":
      return Boolean(right) && left.startsWith(right);
    case "ends-with":
      return Boolean(right) && left.endsWith(right);
    default:
      return "unknown";
  }
}

/** How a rule reads back, for the card, the record and the refusal. */
export function describe(rule: Rule): string {
  const op = rule.op.replace(/-/g, " ");
  return `${rule.effect} when ${rule.field} ${op} "${rule.value}"`;
}

/**
 * What happens to this request.
 *
 * Deny first and in order, then allow, then ask. Asking is the answer
 * whenever nothing applies, which is the whole difference between this
 * and a gateway: the thing an empty policy replaces here is a person
 * deciding, not an open door.
 */
export function decide(rules: Rule[], ask: Ask): Decision {
  const live = rules.filter((rule) => rule.enabled);
  const denies = live.filter((rule) => rule.effect === "deny");
  const allows = live.filter((rule) => rule.effect === "allow");

  for (const rule of denies) {
    const hit = applies(rule, ask);
    // A deny nobody can evaluate has not been shown not to apply.
    if (hit === true || hit === "unknown") {
      return {
        verdict: "deny",
        rule,
        because: hit === "unknown" ? `${describe(rule)}, which this version cannot check` : describe(rule),
      };
    }
  }
  for (const rule of allows) {
    if (applies(rule, ask) === true) {
      return { verdict: "allow", rule, because: describe(rule) };
    }
  }
  return { verdict: "ask", because: "no rule covers this" };
}

/** What the agent is told when a rule refuses. It names the rule, because
 * an agent told only "not allowed" tries a different way round. */
export function refusal(decision: Extract<Decision, { verdict: "deny" }>): string {
  return `Bloks: a rule in this workspace refuses this (${decision.because}). Do not try another way round it; carry on with what you can do without it, and say what you could not do.`;
}

// ── what a client may send ─────────────────────────────────────────────

export interface NewRule {
  effect?: unknown;
  field?: unknown;
  op?: unknown;
  value?: unknown;
  botId?: unknown;
  enabled?: unknown;
}

/**
 * A rule as it arrives, checked into shape, or the reason it is not one.
 *
 * Refusing at the door is what keeps the runtime honest: `applies` has an
 * unknown branch for a file somebody hand-edited, and nothing that gets
 * saved through here can reach it.
 */
export function cleanRule(input: NewRule): { rule: Omit<Rule, "id" | "createdAt"> } | { error: string } {
  const effect = input.effect === "deny" ? "deny" : input.effect === "allow" ? "allow" : null;
  if (!effect) return { error: "a rule has to allow or deny" };
  if (!FIELDS.includes(input.field as Field)) return { error: "a rule has to be about something we can look at" };
  if (!OPS.includes(input.op as Op)) return { error: "a rule has to compare in a way we can check" };
  const value = String(input.value ?? "").trim().slice(0, MAX_VALUE);
  if (!value) return { error: "a rule needs something to compare against" };
  const botId =
    typeof input.botId === "string" && /^[\w-]{1,64}$/.test(input.botId) ? input.botId : undefined;
  return {
    rule: {
      effect,
      field: input.field as Field,
      op: input.op as Op,
      value,
      ...(botId ? { botId } : {}),
      enabled: input.enabled !== false,
    },
  };
}

// ── somebody else is driving ───────────────────────────────────────────
//
// A person taking over an agent's computer has to mean something, or it
// is a label on a screen. While the wheel is held, the agent's actions
// that would have asked for permission are refused instead.
//
// Refused rather than queued, which is the decision worth stating. A queue
// would replay, ten minutes later, a plan the agent made before a person
// changed things underneath it, and the whole reason to take over is that
// the plan needed changing.
//
// Held in memory rather than on disk on purpose: if this process restarted
// then nobody is at the wheel, whatever a file might say. The record keeps
// the history; this keeps only the present.
//
// The stakes of that went up when a hold stopped being only about
// permission questions and started stopping turns outright, and it is
// still the right way round. A hold says a person is at this keyboard
// now. A file saying so after a restart would be a claim nobody made,
// and an agent frozen by it would stay frozen with no one there to hand
// the wheel back.

export interface Hold {
  botId: string;
  since: number;
  /** Said back to the agent and shown on the screen. */
  why: string;
  /** How much was turned away while this hold has been on: routines that
   * did not fire, webhooks that did not wake it, messages refused. A
   * hold with teeth should be able to say what it cost, and a count is
   * the honest version of that. Per refusal entries in the record would
   * flood a signed append only file the moment a webhook retried. */
  turnedAway: number;
}

export class Wheel {
  private held = new Map<string, Hold>();

  take(botId: string, why: string, now: number): Hold {
    const hold: Hold = {
      botId,
      since: now,
      why: why.trim().slice(0, 200) || "you are using it",
      turnedAway: 0,
    };
    this.held.set(botId, hold);
    return hold;
  }

  /** Something tried to make this agent work and was refused. */
  noteTurnedAway(botId: string): void {
    const hold = this.held.get(botId);
    if (hold) hold.turnedAway += 1;
  }

  release(botId: string): Hold | null {
    const hold = this.held.get(botId) ?? null;
    this.held.delete(botId);
    return hold;
  }

  heldBy(botId: string): Hold | null {
    return this.held.get(botId) ?? null;
  }

  all(): Hold[] {
    return [...this.held.values()].sort((a, b) => a.since - b.since);
  }
}

/** What the agent is told while somebody is driving. It says to wait
 * rather than to work around, because working around is what an agent
 * does with "no". */
export function pausedMessage(hold: Hold): string {
  return `Bloks: somebody has taken over this computer (${hold.why}). Do not do this another way and do not retry: stop here, say what you were about to do, and wait to be asked again.`;
}

/**
 * What the person is told when they try to set the agent going anyway.
 *
 * Deliberately not pausedMessage. That one is aimed at a model and its
 * job is to stop it working around the refusal. This one is aimed at
 * whoever just pressed something, and its job is to name the fix, which
 * is the wheel they are holding.
 */
export function heldRefusal(hold: Hold, botName: string): string {
  return `You have ${botName}'s computer (${hold.why}). Hand the wheel back to let it work.`;
}

// ── the file ───────────────────────────────────────────────────────────

const RULES_FILE = join(DATA_DIR, "rules.json");

export class PolicyStore {
  rules: Rule[] = [];

  constructor(file: string = RULES_FILE) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(parsed)) {
        this.rules = parsed.filter((r) => r?.id && typeof r.value === "string");
      }
    } catch {
      /* no rules yet, which means every question still reaches a person */
    }
  }

  private readonly file: string;

  private save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(this.rules, null, 2), { mode: 0o600 });
    } catch {
      /* a rule that did not save is a question that reaches a person */
    }
  }

  list(): Rule[] {
    // Deny first, because that is the order they are evaluated in and a
    // list that reads in a different order than it runs is a trap.
    return [...this.rules].sort(
      (a, b) => (a.effect === b.effect ? a.createdAt - b.createdAt : a.effect === "deny" ? -1 : 1),
    );
  }

  add(rule: Omit<Rule, "id" | "createdAt">, now: number): Rule | null {
    if (this.rules.length >= MAX_RULES) return null;
    const made: Rule = { ...rule, id: newId(), createdAt: now };
    this.rules.push(made);
    this.save();
    return made;
  }

  setEnabled(id: string, enabled: boolean): Rule | null {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return null;
    rule.enabled = enabled;
    this.save();
    return rule;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.save();
    return true;
  }

  /** A rule about an agent that is gone would never fire again, and would
   * read as protection that is not there. */
  removeForBot(botId: string) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.botId !== botId);
    if (this.rules.length !== before) this.save();
  }
}
