// The same call, again and again.
//
// An agent that has lost the thread can call one tool with the same
// arguments over and over: a test that never passes, a page that never
// loads, a search that never finds anything. No single call looks wrong,
// and each one sends the whole session to the model again, so a loop is
// expensive long before anybody notices it. So every turn counts its calls
// by what they asked for, and the chat hears about a call made 5, 10 and
// 20 times (server/index.ts). Nothing is stopped here: a loop is a guess,
// and stopping a turn is the person's call.

import { createHash } from "node:crypto";

/** The counts at which the chat hears about a call. */
export const REPEAT_MARKS: readonly number[] = [5, 10, 20];
/** At this count the person is also told, once a turn, that the turn can
 * be stopped. */
export const REPEAT_NOTICE = 20;
/** Distinct calls one turn keeps a count for. Past this, the call used
 * longest ago is forgotten, which a loop, being the call the turn keeps
 * making, never is. */
const MAX_CALLS = 256;
/** Turns counted at once. Each lane has one turn at a time and a turn's
 * end forgets it, so this only bites when ends go missing. */
const MAX_TURNS = 512;
/** How deep into nested arguments two calls are compared. Arguments are
 * JSON a model wrote, and a recursive walk over something built to be
 * deep would run out of stack. */
const MAX_DEPTH = 32;

/**
 * What a call asked for, as a short name: the tool and its arguments,
 * normalised, then hashed.
 *
 * Normalised so the same request written two ways is one request: object
 * keys in order, strings trimmed and their runs of spaces made one.
 * Hashed so the arguments themselves go nowhere: a command line can carry
 * a key, and this rides on an event every client receives.
 */
export function callSignature(tool: string | undefined, args: unknown): string {
  return createHash("sha256")
    .update(`${tool || "tool"}\0${normalised(args, 0)}`)
    .digest("hex")
    .slice(0, 16);
}

function normalised(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return '"..."';
  if (typeof value === "string") return JSON.stringify(value.replace(/\s+/g, " ").trim());
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => normalised(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${normalised(record[key], depth + 1)}`).join(",")}}`;
  }
  return "null";
}

/** Where a turn's chip is, so moving it can take it off the old row. */
export interface ChipAt {
  threadId: string;
  messageId: string;
}

/** What the chat should say about the call just counted. */
export interface RepeatMark {
  /** How many times this turn has now made the call: a mark. */
  count: number;
  /** The row the turn's chip was on until now, to take it off: a turn
   * shows one chip, on its latest and highest mark. */
  moveFrom: ChipAt | null;
  /** The first call this turn to reach REPEAT_NOTICE: say once that the
   * turn can be stopped. */
  notice: boolean;
}

interface TurnCalls {
  calls: Map<string, number>;
  chip: (ChipAt & { count: number }) | null;
  noticed: boolean;
}

/** Each running turn's calls, counted by signature. In memory: a count is
 * about one turn, and a restart ends every turn there is. */
export class RepeatWatch {
  private turns = new Map<string, TurnCalls>();

  /** A turn starts on this lane, and counts from nothing. */
  begin(lane: string) {
    this.turns.delete(lane);
    this.turns.set(lane, { calls: new Map(), chip: null, noticed: false });
    this.trim();
  }

  /** The lane's turn is over; nothing of it is kept. */
  end(lane: string) {
    this.turns.delete(lane);
  }

  /**
   * Counts one call. Null unless the chat should say something: a call
   * reaching a mark above the turn's chip, or reaching the notice. A
   * second call reaching a mark the chip already shows changes nothing,
   * since the chip says what it would say.
   */
  note(lane: string, signature: string): RepeatMark | null {
    let turn = this.turns.get(lane);
    if (!turn) {
      // a turn this process did not see begin (a pickup on the way in)
      turn = { calls: new Map(), chip: null, noticed: false };
      this.turns.set(lane, turn);
      this.trim();
    }
    const count = (turn.calls.get(signature) ?? 0) + 1;
    // most recent last, so the first is the one used longest ago
    turn.calls.delete(signature);
    turn.calls.set(signature, count);
    if (turn.calls.size > MAX_CALLS) turn.calls.delete(turn.calls.keys().next().value!);
    if (!REPEAT_MARKS.includes(count) || (turn.chip && count <= turn.chip.count)) return null;
    // the notice comes with the chip's top mark, so it is said at most once
    const notice = count >= REPEAT_NOTICE && !turn.noticed;
    if (notice) turn.noticed = true;
    const from = turn.chip ? { threadId: turn.chip.threadId, messageId: turn.chip.messageId } : null;
    return { count, moveFrom: from, notice };
  }

  /** Where the chip for `count` went, once the row carrying it exists. */
  chipAt(lane: string, at: ChipAt, count: number) {
    const turn = this.turns.get(lane);
    if (turn && (!turn.chip || count >= turn.chip.count)) turn.chip = { ...at, count };
  }

  /** How many turns are being counted, for the tests of its bound. */
  get size() {
    return this.turns.size;
  }

  /** How many distinct calls one turn holds, for the same. */
  callsIn(lane: string) {
    return this.turns.get(lane)?.calls.size ?? 0;
  }

  private trim() {
    while (this.turns.size > MAX_TURNS) this.turns.delete(this.turns.keys().next().value!);
  }
}
