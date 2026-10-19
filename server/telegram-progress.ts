import type { Message } from "./store.ts";
import { botWords, replySpan } from "./telegram-reply.ts";
import type { Progress } from "./telegram.ts";

/** Observe the solo turn that took one phone request. The display owns
 * its buffer and transport; this owns the request and completion boundary. */
export class TurnProgress {
  private began = false;
  private lastSeen?: string;
  private pending?: string;
  private closed = false;
  private finished?: Message[];
  private join?: { after?: string; accepted: boolean };
  private progress: Progress;
  private messages: () => readonly Message[];
  private requestId: () => string | undefined;
  private startedAt: () => number | undefined;

  constructor(progress: Progress, messages: () => readonly Message[], requestId: () => string | undefined, startedAt: () => number | undefined) {
    this.progress = progress;
    this.messages = messages;
    this.requestId = requestId;
    this.startedAt = startedAt;
  }

  /** A steer can finish before its successful RPC resumes the caller and
   * saves the input row. Keep one intake boundary until that decision. */
  joining(): void {
    this.join = { after: this.messages().findLast(m => !m.queued && !m.unsent)?.id, accepted: false };
  }

  joined(accepted: boolean): void {
    if (!this.join) return;
    if (!accepted) {
      this.join = undefined;
      this.finished = undefined; // the old turn did not consume this request
    } else {
      this.join.accepted = true;
      if (this.finished !== undefined) void this.stop();
    }
  }

  private span(): Message[] {
    if (!this.join) return replySpan(this.messages(), this.requestId());
    const rows = this.messages();
    const at = this.join.after === undefined ? -1 : rows.findIndex(m => m.id === this.join!.after);
    if (this.join.after !== undefined && at < 0) return [];
    return rows.slice(at + 1).filter(m => !m.queued && !m.unsent);
  }

  private taken(): Message | undefined {
    const request = this.messages().find((m) => m.id === this.requestId());
    return request && request.role === "user" && request.kind === "text" && !request.queued && !request.unsent && !request.deleted ? request : undefined;
  }

  /** Completed stored bot text, after the request joined its turn. A
   * single cursor also catches early notes written while startTurn resolves. */
  observe(): void {
    if (this.closed || this.finished) return;
    const request = this.taken();
    if (!request) return;
    if (!this.began) {
      this.began = true;
      const start = request.midTurn ? this.startedAt() ?? request.at : request.deliveredAt ?? this.startedAt() ?? request.at;
      this.progress.startAt(start);
    }
    const span = this.span();
    const after = this.lastSeen ? span.findIndex((m) => m.id === this.lastSeen) + 1 : 0;
    for (const m of span.slice(after)) {
      if (botWords(m) && m.text) {
        this.flush();
        this.pending = m.id;
      } else if (m.role === "bot" && m.kind === "activity" && m.tool && !m.deleted && !m.quiet) this.flush();
    }
    this.lastSeen = span.at(-1)?.id ?? this.lastSeen;
  }

  /** A last text may be the reply, even when turn/completed arrives later.
   * A following tool or another visible text confirms it as a work note. */
  private flush(): void {
    const note = this.messages().find((m) => m.id === this.pending);
    this.pending = undefined;
    if (note && botWords(note) && note.text) this.progress.note(note.text);
  }

  /** Capture before another turn can start, even if the waiter or the
   * answer send itself has to wait. A still-queued request is not this turn. */
  ended(): void {
    if (this.finished !== undefined || (!this.taken() && !this.join)) return;
    this.finished = this.span();
    // A refusal discards this tentative end and queues a different turn.
    if (this.join?.accepted !== false) void this.stop();
  }

  /** Empty output is still a completed request. */
  get completed(): boolean {
    return this.finished !== undefined && this.join?.accepted !== false;
  }

  answerSpan(): readonly Message[] {
    if (!this.taken()) return [];
    return this.finished ?? this.span();
  }

  stop(): Promise<void> {
    this.closed = true;
    this.pending = undefined;
    return this.progress.stop();
  }
}
