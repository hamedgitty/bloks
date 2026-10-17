import type { Message } from "./store.ts";

/** A snapshot of already saved text, never another transcript message. */
export type ReplyPreview = Pick<Message, "id" | "at" | "role" | "kind" | "text" | "from" | "quiet" | "deleted">;
export type ReplyPhase = "commentary" | "final_answer";
interface Attempt {
  turnId: string;
  threadId: string;
  botId: string;
  goalOwned: boolean;
  last?: ReplyPreview;
  final?: ReplyPreview;
}

/** One bounded record per active lane, discarded at that attempt's end.
 * A successful empty backup cannot inherit its failed predecessor's words. */
export class ReplyNotifications {
  private active = new Map<string, Attempt>();

  start(laneId: string, turnId: string | undefined, threadId: string, botId: string, goalOwned: boolean): void {
    this.active.delete(laneId);
    if (turnId) this.active.set(laneId, { turnId, threadId, botId, goalOwned });
  }

  text(laneId: string, turnId: string | undefined, message: Message, phase?: ReplyPhase, synthetic = false): void {
    const a = this.active.get(laneId);
    if (synthetic || !a || a.turnId !== turnId || message.role !== "bot" || message.kind !== "text" || !message.text?.trim() || message.quiet || message.deleted) return;
    // Terminal presentation (PR314) is not final-answer provenance.
    if (phase === "commentary") return;
    const { id, at, role, kind, text, from, quiet, deleted } = message;
    const preview: ReplyPreview = { id, at, role, kind, text, ...(from ? { from } : {}), ...(quiet ? { quiet } : {}), ...(deleted ? { deleted } : {}) };
    a.last = preview;
    if (phase === "final_answer") a.final = preview;
  }

  take(laneId: string, turnId: string | undefined): Attempt | undefined {
    const a = this.active.get(laneId);
    if (!a || a.turnId !== turnId) return;
    this.active.delete(laneId);
    return a;
  }
}

export function settledReply(attempt: Attempt | undefined, end: {
  ok: boolean; stopReason?: string | null; continues: boolean; quiet: boolean; maintenance: boolean;
}): { kind: "reply.settled"; threadId: string; botId: string; turnId: string; message: ReplyPreview } | null {
  if (!attempt || !end.ok || end.stopReason === "interrupted" || end.continues || end.quiet || end.maintenance || attempt.goalOwned) return null;
  const message = attempt.final ?? attempt.last;
  return message ? { kind: "reply.settled", threadId: attempt.threadId, botId: attempt.botId, turnId: attempt.turnId, message } : null;
}
