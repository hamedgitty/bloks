// What an agent found the person has to do themselves (GitHub 378, 430).
//
// A routine's report is words: "the NAS has a failing disk, replace it"
// sits in a card on Overview with everything else the routine said, and
// the brief's count of what waits on the person never saw it. Counting
// it by reading the report would be a model guessing at a sentence. So
// the agent says it, once, as a thing on the person's list: one line of
// what to do, a line of why, and a key of its own for the thing.
//
// Four rules hold the list honest:
//
//   One thing, once. The key is the agent's name for the thing, and a
//   routine that reports the same disk every morning refreshes the one
//   line rather than adding one a day. Only an agent's own keys are its
//   to reuse; two agents never share one.
//
//   The person closes it, or the agent clears it. Done is "I did it",
//   dismissed is "not for me", and either takes it off the list. An
//   agent clears it when it no longer needs doing, which is how a
//   recovered failure leaves the count without anyone touching it.
//
//   Dismissed stays dismissed. The next morning's report of the same
//   thing does not put back what the person waved away; only the agent
//   clearing it first (the thing went away and came back) starts it
//   again. Done is different: reported again after the person did it,
//   it did not hold, and it is a new line.
//
//   The owner's alone. Only an agent's own full credential, on a turn the
//   owner's, adds to it (server/index.ts), and only the owner reads or
//   closes it. It is never in a room's or a member's view.
//
// Everything here is plain data and functions over it, so the rules can
// be tested without a server; the store at the end keeps it on disk.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { readSaved, writeFileAtomic } from "./atomic-write.ts";
import { newId } from "./contracts.ts";

export type TodoState = "open" | "done" | "dismissed" | "cleared";

export interface Todo {
  id: string;
  /** The agent that put it there. */
  botId: string;
  /** The agent's own name for the thing, so the same thing is one line. */
  key: string;
  /** What the person has to do, in a line. */
  title: string;
  /** Why, or what it is about, in a line or two. */
  detail?: string;
  /** The conversation it was said in, where the report is. */
  threadId: string;
  /** The routine whose run said it, when one did, and its name then. */
  routineId?: string;
  routineName?: string;
  /** When it was first said, and last said. */
  firstAt: number;
  at: number;
  /** How many times it has been said while it stood. */
  times: number;
  state: TodoState;
  closedAt?: number;
}

export const MAX_TITLE = 140;
export const MAX_DETAIL = 500;
/** More than a person can act on in a morning. Past it, the agent is
 * told to clear what no longer needs doing rather than pile on. */
export const MAX_OPEN_PER_AGENT = 20;
/** A closed line is kept this long after it was last said, so a report
 * of a dismissed thing still finds it dismissed. */
export const KEEP_CLOSED_MS = 30 * 24 * 60 * 60_000;
const MAX_KEPT = 1000;

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One line of plain words: whitespace runs made one space, cut at a word. */
function line(raw: unknown, max: number): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/** A key as an agent wrote it, or one made from the title when it gave
 * none: lower case, words joined by dashes. Null when neither makes one. */
export function todoKey(raw: unknown, title: string): string | null {
  const given = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (given) return KEY.test(given) ? given : null;
  const made = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return KEY.test(made) ? made : null;
}

export interface TodoInput {
  key?: unknown;
  title?: unknown;
  detail?: unknown;
}

export interface SayContext {
  botId: string;
  threadId: string;
  routine?: { id: string; name: string };
  now: number;
}

/**
 * added      a new line on the list
 * updated    it was on the list already, and was said again
 * reopened   the person had marked it done, and it is back
 * dismissed  the person dismissed it, and it stays off the list
 */
export type SayOutcome = "added" | "updated" | "reopened" | "dismissed";

export type SayResult =
  | { ok: true; list: Todo[]; todo: Todo; outcome: SayOutcome }
  | { ok: false; error: string };

/** The newest line an agent has under a key. */
function latest(list: Todo[], botId: string, key: string): Todo | undefined {
  let found: Todo | undefined;
  for (const t of list) if (t.botId === botId && t.key === key && (!found || t.firstAt >= found.firstAt)) found = t;
  return found;
}

/** An agent saying the person has something to do. */
export function sayTodo(list: Todo[], input: TodoInput, context: SayContext): SayResult {
  const title = line(input.title, MAX_TITLE);
  if (title.length < 3) return { ok: false, error: "a todo needs what the person has to do, in a few words" };
  const key = todoKey(input.key, title);
  if (!key) return { ok: false, error: "a key is up to 64 letters, digits, dots, dashes or underscores, starting with a letter or a digit" };
  const detail = line(input.detail, MAX_DETAIL);
  const said = {
    title,
    ...(detail ? { detail } : {}),
    threadId: context.threadId,
    ...(context.routine ? { routineId: context.routine.id, routineName: context.routine.name } : {}),
  };
  const before = latest(list, context.botId, key);
  if (before?.state === "open" || before?.state === "dismissed") {
    // said again: the newest words, and the count of times, on the one line
    const { detail: _detail, routineId: _routineId, routineName: _routineName, ...rest } = before;
    const next: Todo = { ...rest, ...said, at: context.now, times: before.times + 1 };
    return { ok: true, list: list.map((t) => (t === before ? next : t)), todo: next, outcome: before.state === "open" ? "updated" : "dismissed" };
  }
  const open = list.filter((t) => t.botId === context.botId && t.state === "open").length;
  if (open >= MAX_OPEN_PER_AGENT) {
    return { ok: false, error: `you have ${MAX_OPEN_PER_AGENT} things on the person's list already. Clear the ones that no longer need doing with untodo first` };
  }
  const todo: Todo = { id: newId(), botId: context.botId, key, ...said, firstAt: context.now, at: context.now, times: 1, state: "open" };
  return { ok: true, list: [...list, todo], todo, outcome: before?.state === "done" ? "reopened" : "added" };
}

/** An agent saying it no longer needs doing. Whatever the person did with
 * it, it is over, and the same thing said later is a new line. */
export function clearTodo(list: Todo[], botId: string, key: string, now: number): { list: Todo[]; todo: Todo } | null {
  const before = latest(list, botId, String(key).trim().toLowerCase());
  if (!before) return null;
  if (before.state === "cleared") return { list, todo: before };
  const next: Todo = { ...before, state: "cleared", closedAt: now };
  return { list: list.map((t) => (t === before ? next : t)), todo: next };
}

/** The person closing a line: done, or dismissed. Only an open one; one
 * closed already says how it was. */
export function closeTodo(list: Todo[], id: string, how: "done" | "dismissed", now: number): { list: Todo[]; todo: Todo } | null {
  const before = list.find((t) => t.id === id);
  if (!before) return null;
  if (before.state !== "open") return { list, todo: before };
  const next: Todo = { ...before, state: how, closedAt: now };
  return { list: list.map((t) => (t === before ? next : t)), todo: next };
}

/** Closed lines past their keep, and the oldest closed ones past the cap.
 * An open line is never dropped here: only its agent or the person
 * takes it off. */
export function pruneTodos(list: Todo[], now: number): Todo[] {
  const kept = list.filter((t) => t.state === "open" || now - t.at < KEEP_CLOSED_MS);
  if (kept.length <= MAX_KEPT) return kept;
  const closed = kept.filter((t) => t.state !== "open").sort((a, b) => a.at - b.at);
  const drop = new Set(closed.slice(0, kept.length - MAX_KEPT));
  return kept.filter((t) => !drop.has(t));
}

/** A saved line, read back only when it has the shape of one. */
function validTodo(t: unknown): t is Todo {
  const o = t as Partial<Todo> | null;
  return Boolean(
    o &&
      typeof o.id === "string" &&
      typeof o.botId === "string" &&
      typeof o.key === "string" &&
      typeof o.title === "string" &&
      typeof o.threadId === "string" &&
      typeof o.firstAt === "number" &&
      typeof o.at === "number" &&
      (o.state === "open" || o.state === "done" || o.state === "dismissed" || o.state === "cleared"),
  );
}

/** What an agent is told back, so it knows where the thing stands. */
export function todoForAgent(t: Todo) {
  return {
    key: t.key,
    title: t.title,
    ...(t.detail ? { detail: t.detail } : {}),
    state: t.state,
    firstAt: t.firstAt,
    at: t.at,
    times: t.times ?? 1,
    ...(t.closedAt ? { closedAt: t.closedAt } : {}),
  };
}

/** The words for an agent about what saying it did. */
export function sayNote(outcome: SayOutcome): string {
  switch (outcome) {
    case "added":
      return "It is on the person's list, and waits for them in the morning brief. Say it again with the same key while it stands; clear it with untodo once it no longer needs doing.";
    case "updated":
      return "It was on the person's list already: the line has your newest words, and it is still one thing.";
    case "reopened":
      return "The person had marked this done. It is back on their list as a new line, since it did not hold.";
    case "dismissed":
      return "The person dismissed this, so it stays off their list. Clear it with untodo once it no longer applies, and it can come back if it happens again.";
  }
}

export class TodoStore {
  private list: Todo[];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    const saved = readSaved<unknown[]>(file, [], Array.isArray);
    this.list = pruneTodos(saved.filter(validTodo).map((t) => ({ ...t, times: typeof t.times === "number" ? t.times : 1 })), Date.now());
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify(this.list), 0o600);
    } catch {
      /* the list lives on in memory, and is written with the next change */
    }
  }

  all(): Todo[] {
    return this.list;
  }

  get(id: string): Todo | undefined {
    return this.list.find((t) => t.id === id);
  }

  /** Every line one agent put there, newest first. */
  of(botId: string): Todo[] {
    return this.list.filter((t) => t.botId === botId).sort((a, b) => b.at - a.at);
  }

  say(input: TodoInput, context: SayContext): SayResult {
    const result = sayTodo(this.list, input, context);
    if (!result.ok) return result;
    this.list = pruneTodos(result.list, context.now);
    this.save();
    return result;
  }

  clear(botId: string, key: string, now = Date.now()): Todo | null {
    const result = clearTodo(this.list, botId, key, now);
    if (!result) return null;
    if (result.list !== this.list) {
      this.list = result.list;
      this.save();
    }
    return result.todo;
  }

  close(id: string, how: "done" | "dismissed", now = Date.now()): Todo | null {
    const result = closeTodo(this.list, id, how, now);
    if (!result) return null;
    if (result.list !== this.list) {
      this.list = result.list;
      this.save();
    }
    return result.todo;
  }

  /** An agent that is gone takes its lines with it. */
  forgetBot(botId: string) {
    const before = this.list.length;
    this.list = this.list.filter((t) => t.botId !== botId);
    if (this.list.length !== before) this.save();
  }
}
