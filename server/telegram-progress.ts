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
    const span = replySpan(this.messages(), request.id);
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

  /** Capture before another turn can start, even if waitForIdle or the
   * answer send itself has to wait. A still-queued request is not this turn. */
  ended(): void {
    if (!this.taken() || this.finished) return;
    this.finished = replySpan(this.messages(), this.requestId());
    void this.stop();
  }

  answerSpan(): readonly Message[] {
    if (!this.taken()) return [];
    return this.finished ?? replySpan(this.messages(), this.requestId());
  }

  stop(): Promise<void> {
    this.closed = true;
    this.pending = undefined;
    return this.progress.stop();
  }
}
