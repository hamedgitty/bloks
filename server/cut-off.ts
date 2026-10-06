// Turns cut off in the middle, and picking them up again (GitHub 160).
//
// Two things cut a turn off without it being anybody's decision: the Mac
// going to sleep, and Bloks itself stopping (a quit, an update, a crash).
// Both are picked up the same way. The person reads a notice saying what
// happened, and the agent is told, separately, to carry on and to check
// what already happened before repeating anything. Neither is a new
// message from the person, and neither repeats what they asked.
//
// Sleep is noticed while Bloks is still running, so it is kept in memory
// (server/index.ts, sleptLanes). A stop is not noticed at all, which is
// why every turn is written here when it starts and taken out when it
// ends: whatever is still here when Bloks starts was cut off, whether the
// last run ended in a clean quit or a crash. No shutdown hook is needed,
// and none could be trusted to run.
//
// The file is small and rewritten whole, through a temporary file and a
// rename, so a crash mid-write leaves the old list rather than half of a
// new one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MAX_QUEUED_RECOVERY_MS, MAX_SESSION_REF_CHARS, MAX_TITLE_CHARS, MAX_TURNS_IN_FLIGHT } from "./limits.ts";

export interface TurnInFlight {
  /** The lane the turn runs in, which is also what keys its engine session. */
  laneId: string;
  botId: string;
  /** The room it was speaking in, when it was not the lane's own chat. */
  roomId?: string;
  /** Who asked: "owner" or a person id. A shared room's approvals follow
   * it, so a continuation has to keep it rather than run as the owner. */
  requester?: string;
  /** The person started it, so what it says is a reply to them. */
  byYou?: boolean;
  /** The engine instance and its session, as they stood when the turn
   * was last heard from. What the continuation resumes is the lane's own
   * cursor in bots.json; this is the record of which one that was. */
  instanceId?: string;
  session?: string;
  /** The tool call running when it was last heard from, if one was. */
  tool?: string;
  startedAt: number;
  /** When this run of Bloks last knew the turn was alive. Refreshed while
   * it runs, so at the next start it says, near enough, when Bloks went. */
  seenAt: number;
  /** Somebody pressed Stop. A stop that the engine had not finished
   * acting on when Bloks went is still a stop. */
  stopped?: boolean;
  /** A workflow step: its run is settled as failed when Bloks starts, and
   * a step is never resumed behind the run's back. */
  workflow?: boolean;
  /** This turn was itself a continuation. Cut off again, it waits for the
   * person rather than looping through every restart. */
  carriedOn?: boolean;
  /** Too long ago to pick up unattended: a notice with a Continue button
   * is waiting for the person, in `threadId`. */
  waiting?: { noticeId: string; threadId: string; since: number };
}

function clean(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

/** What may reach the disk, whatever was handed in. */
function sanitize(raw: unknown): TurnInFlight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const laneId = clean(r.laneId, 64);
  const botId = clean(r.botId, 64);
  if (!laneId || !botId || typeof r.startedAt !== "number" || typeof r.seenAt !== "number") return null;
  const waiting = r.waiting as Record<string, unknown> | undefined;
  return {
    laneId,
    botId,
    ...(clean(r.roomId, 64) ? { roomId: clean(r.roomId, 64) } : {}),
    ...(clean(r.requester, 64) ? { requester: clean(r.requester, 64) } : {}),
    ...(r.byYou === true ? { byYou: true } : {}),
    ...(clean(r.instanceId, 64) ? { instanceId: clean(r.instanceId, 64) } : {}),
    ...(clean(r.session, MAX_SESSION_REF_CHARS) ? { session: clean(r.session, MAX_SESSION_REF_CHARS) } : {}),
    ...(clean(r.tool, MAX_TITLE_CHARS) ? { tool: clean(r.tool, MAX_TITLE_CHARS) } : {}),
    startedAt: r.startedAt,
    seenAt: r.seenAt,
    ...(r.stopped === true ? { stopped: true } : {}),
    ...(r.workflow === true ? { workflow: true } : {}),
    ...(r.carriedOn === true ? { carriedOn: true } : {}),
    ...(waiting && clean(waiting.noticeId, 64) && clean(waiting.threadId, 64) && typeof waiting.since === "number"
      ? { waiting: { noticeId: clean(waiting.noticeId, 64)!, threadId: clean(waiting.threadId, 64)!, since: waiting.since } }
      : {}),
  };
}

/** A session cursor as something short enough to keep: engines use a
 * string id, and anything else is not worth a line on disk. */
export function sessionRef(cursor: unknown): string | undefined {
  return clean(cursor, MAX_SESSION_REF_CHARS);
}

export class TurnsInFlight {
  private turns = new Map<string, TurnInFlight>();
  private readonly file: string;
  /** Set while Bloks is on its way out. Engines being shut down end their
   * turns as they go, and those endings are the stop itself, not the
   * turns finishing, so nothing is taken off the list after this. */
  private closing = false;

  constructor(file: string) {
    this.file = file;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) {
        for (const raw of parsed.slice(0, MAX_TURNS_IN_FLIGHT)) {
          const turn = sanitize(raw);
          if (turn) this.turns.set(turn.laneId, turn);
        }
      }
    } catch {
      /* nothing was running */
    }
  }

  private save() {
    if (this.closing) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, JSON.stringify([...this.turns.values()]), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      /* losing this costs one pickup after a crash, never a turn */
    }
  }

  /** A turn started. It replaces whatever the lane had, including a
   * Continue still waiting: the person has moved on, so the old step is
   * not theirs to pick up any more. Returns that replaced one. */
  begin(turn: Omit<TurnInFlight, "seenAt">, now = Date.now()): TurnInFlight | null {
    const before = this.turns.get(turn.laneId) ?? null;
    const next = sanitize({ ...turn, seenAt: now });
    if (!next) return before;
    this.turns.delete(next.laneId);
    // the oldest go first, which in a full list is the stale ones
    while (this.turns.size >= MAX_TURNS_IN_FLIGHT) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(next.laneId, next);
    this.save();
    return before;
  }

  /** The tool call now running in a lane, or null when it reported back.
   * Written only when it changes, so a turn of quick calls costs a write
   * per call and nothing for the stream in between. */
  tool(laneId: string, name: string | null, now = Date.now()) {
    const turn = this.turns.get(laneId);
    if (!turn || turn.waiting) return;
    const capped = name ? name.slice(0, MAX_TITLE_CHARS) : undefined;
    if (turn.tool === capped) return;
    if (capped) turn.tool = capped;
    else delete turn.tool;
    turn.seenAt = now;
    this.save();
  }

  /** The engine named its session, which a fresh one only does mid-turn. */
  session(laneId: string, instanceId: string, cursor: unknown) {
    const turn = this.turns.get(laneId);
    const ref = sessionRef(cursor);
    if (!turn || turn.waiting || (turn.instanceId === instanceId && turn.session === ref)) return;
    turn.instanceId = instanceId.slice(0, 64);
    if (ref) turn.session = ref;
    this.save();
  }

  /** Somebody stopped it on purpose. Kept until the turn ends, so a stop
   * that Bloks did not live to finish is not mistaken for a cut-off. */
  stop(laneId: string) {
    const turn = this.turns.get(laneId);
    if (!turn || turn.stopped || turn.waiting) return;
    turn.stopped = true;
    this.save();
  }

  /** The turn ended: finished, failed, or stopped. A Continue still
   * waiting stays, because it belongs to a turn that did not end. */
  end(laneId: string) {
    const turn = this.turns.get(laneId);
    if (!turn || turn.waiting || this.closing) return;
    this.turns.delete(laneId);
    this.save();
  }

  /** Off the list, whatever it was, before anything acts on it. This is
   * what makes a pickup happen once: a later start does not find it. */
  take(laneId: string): TurnInFlight | null {
    const turn = this.turns.get(laneId) ?? null;
    if (!turn) return null;
    this.turns.delete(laneId);
    this.save();
    return turn;
  }

  /** Left for the person, with the notice that offers to continue it. */
  wait(laneId: string, waiting: { noticeId: string; threadId: string }, now = Date.now()) {
    const turn = this.turns.get(laneId);
    if (!turn) return;
    turn.waiting = { ...waiting, since: now };
    this.save();
  }

  get(laneId: string): TurnInFlight | null {
    return this.turns.get(laneId) ?? null;
  }

  /** Everything on the list, waiting or not. */
  all(): TurnInFlight[] {
    return [...this.turns.values()];
  }

  /** Turns running now, as far as this run of Bloks knows. What a drain
   * before a restart waits on (server/drain.ts). */
  running(): TurnInFlight[] {
    return this.all().filter((turn) => !turn.waiting);
  }

  /** Still alive, said every few minutes while anything runs, so a long
   * quiet turn is not read as one Bloks lost hours ago. */
  touch(now = Date.now()) {
    const live = this.running();
    if (!live.length) return;
    for (const turn of live) turn.seenAt = now;
    this.save();
  }

  /** Bloks is stopping; what is on the list stays exactly as it is. */
  close() {
    this.closing = true;
  }
}

/** What a turn left on the list at startup gets: picked up now, offered
 * to the person with a Continue, or left alone. */
export function recoveryFor(
  turn: TurnInFlight,
  now: number,
  where: { agent: { archivedAt?: number } | null; lane: boolean },
): "continue" | "ask" | "drop" {
  // never a turn somebody stopped, or one whose agent or lane is gone or
  // was put away, or a workflow step (its run has its own way back)
  if (turn.stopped || turn.workflow) return "drop";
  if (!where.agent || where.agent.archivedAt || !where.lane) return "drop";
  // Being cut off is not standing permission to act, any more than being
  // queued is: past the same window, the person decides.
  if (now - turn.seenAt > MAX_QUEUED_RECOVERY_MS || turn.seenAt > now) return "ask";
  // and a continuation cut off in its turn would otherwise go round every
  // restart, if restarting is what keeps cutting it off
  if (turn.carriedOn) return "ask";
  return "continue";
}

/** Where a continuation runs and on whose behalf: the same lane and room,
 * and whoever asked for the turn it continues. Never the owner by
 * default when somebody else asked. */
export function carryOnTarget(turn: Pick<TurnInFlight, "laneId" | "roomId" | "requester" | "byYou">) {
  return {
    taskId: turn.laneId,
    ...(turn.roomId ? { roomId: turn.roomId } : {}),
    ...(turn.requester ? { requester: turn.requester } : {}),
    byYou: Boolean(turn.byYou),
  };
}

export type CutOffBy = "sleep" | "restart";

export const SLEPT_TEXT =
  "This computer went to sleep in the middle of your last step, which cut it off. Carry on from where you were; check what already happened before repeating anything.";

export const RESTART_TEXT =
  "Bloks stopped in the middle of your last step, which cut it off. Carry on from where you were; check what already happened before repeating anything. This note is not a new request, so on its own it is no reason to send, buy or redo anything.";

/** What the person reads. Never written as if they had said something. */
export function cutOffNotice(name: string, by: CutOffBy): string {
  return by === "sleep"
    ? `${name} was cut off when this computer slept, and is picking up where it left off.`
    : `${name} was cut off when Bloks stopped, and is picking up where it left off.`;
}

/** The same, for one that waits for the person instead. */
export function cutOffWaitingNotice(name: string): string {
  return `${name} was cut off when Bloks stopped, more than ${MAX_QUEUED_RECOVERY_MS / 3_600_000} hours ago, so it has not picked that up on its own.`;
}

/** What the agent is told: carry on, the step that was running (whose
 * result nobody saw), and anything said to it since, which it has to read
 * before acting on a plan made without it. */
export function carryOnText(by: CutOffBy, extra: { tool?: string; said?: string } = {}): string {
  return [
    by === "sleep" ? SLEPT_TEXT : RESTART_TEXT,
    extra.tool &&
      `The step running when it stopped was: ${extra.tool}. Whether it finished is not known, so check before running it again.`,
    extra.said && `Said to you since, and to read before going on with your earlier plan:\n\n${extra.said}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
