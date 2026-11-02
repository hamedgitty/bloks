// `bloks quiet`: an agent finishes the turn it is in quietly, when nothing
// in it needs the person (QA-198). The bare quiet word still works; this is
// the explicit way to say the same thing, decided by the server rather than
// read from the words.
//
// What is here is the part that is not tied to a running server: which
// rows a quiet turn may hold, which writes belong to the turn that was
// finished, and whose words are on their way into it. server/index.ts
// keeps the gate for each lane and acts on it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyPhase } from "./reply-notifications.ts";
import type { Message } from "./store.ts";

/** What a quiet turn may leave behind: its words, its tool calls, the
 * screen it ended on and a compaction marker. A card, a file, a chart or
 * an ask is something for the person. */
export const quietKind = (m: Message) =>
  m.role === "bot" && !m.deleted && (m.kind === "text" || m.kind === "activity" || m.kind === "screen" || (m.kind === "notice" && Boolean(m.compaction)));

/** Which turn a write comes from: a runtime event's (turnId), or a request
 * made with a turn's own credential (seq, the lane's turn count at mint).
 * Entered once per event and once per request, and gone when it returns. */
export type Writer = { lane: string; turnId?: string; seq?: number };
export const writer = new AsyncLocalStorage<Writer | undefined>();

/** A text item saved quiet after the finish, with what its delivery would
 * have needed, so a cancel gives it back exactly as it would have gone. */
export type HiddenText = { id: string; turnId?: string; phase?: ReplyPhase; synthetic?: boolean; spoke: boolean };

export interface QuietGate {
  /** The lane turn it was accepted in (laneTurns) and its runtime turn. */
  seq: number;
  turnId: string;
  /** superseded: something for the person came after, so the turn ends
   * as usual, and a later call is refused. */
  state: "accepted" | "superseded";
  /** For a check-in: its prompt and the rows it had at the call, all
   * quiet kinds, which a quiet end folds together with `rows`. */
  promptId?: string;
  checked: string[];
  /** This turn's rows written since, all quiet kinds. */
  rows: string[];
  hidden: HiddenText[];
}

/** Whether a row just written in `laneId` is the finished turn's own. The
 * lane alone never makes it so: the write has to carry the same runtime
 * turn, or the same turn's credential. What a person or another agent
 * says, and what waits for a later turn, never belongs. */
export function belongs(gate: QuietGate, laneId: string, m: Message, w: Writer | undefined): boolean {
  if (!w || w.lane !== laneId || m.role !== "bot" || m.queued || m.unsent) return false;
  return w.turnId !== undefined ? w.turnId === gate.turnId : w.seq !== undefined && w.seq === gate.seq;
}

/** Words on their way into a lane's running turn (steerOne), counted per
 * lane turn, so a quiet finish cannot pass words the engine may already
 * have. A settle from an earlier turn changes nothing of a later one. */
export class SteerHolds {
  private lanes = new Map<string, { seq: number; inflight: number; tainted: boolean }>();

  hold(laneId: string, seq: number): void {
    let h = this.lanes.get(laneId);
    if (h?.seq !== seq) this.lanes.set(laneId, (h = { seq, inflight: 0, tainted: false }));
    h.inflight++;
  }

  release(laneId: string, seq: number): void {
    const h = this.lanes.get(laneId);
    if (h?.seq === seq && h.inflight > 0) h.inflight--;
  }

  /** The steer threw: the words may have reached the engine. */
  taint(laneId: string, seq: number): void {
    const h = this.lanes.get(laneId);
    if (h?.seq === seq) h.tainted = true;
  }

  refusal(laneId: string, seq: number): "input_uncertain" | "input_arriving" | null {
    const h = this.lanes.get(laneId);
    if (h?.seq !== seq) return null;
    return h.tainted ? "input_uncertain" : h.inflight > 0 ? "input_arriving" : null;
  }
}

export type QuietRefusal =
  | "not_running" | "not_eligible" | "person_in_turn" | "input_arriving" | "input_uncertain"
  | "open_request" | "already_shown" | "superseded";

export const QUIET_ACCEPTED = {
  ok: true,
  quiet: "accepted",
  effect: "when this turn ends",
  next: "End your turn now. Anything you write from here is kept out of the person's attention, unless it is a card, a file or a question for them.",
};

export function quietRefused(reason: QuietRefusal) {
  return {
    ok: false,
    quiet: "refused",
    reason,
    error: `This turn will not finish quietly (${reason}). Answer substantively; do not answer QUIET.`,
  };
}
