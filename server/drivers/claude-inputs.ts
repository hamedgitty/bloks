/** Protocol wait, independent of the configurable silent-tool limit.
 * Preparation can be silent, so this is a failure deadline, not idle detection.
 * An observed model request has no deadline here. */
export const CLAUDE_COMPLETION_WAIT_MS = 15 * 60_000;

type Frame = Record<string, any>;
type Input = {
  phase: "preparing" | "requesting" | "metadata";
  remaining: number;
  result: Frame | null;
  sequence: number;
  terminal: string | null;
  expired: boolean;
};

function done(input: Input): boolean {
  return input.expired || !!(input.terminal && (input.result || input.terminal !== "completed"));
}

function root(frame: Frame): boolean {
  return frame.parent_tool_use_id == null;
}

function outcome(frame: Frame): boolean {
  return frame.is_error === true || (Array.isArray(frame.errors) && frame.errors.length > 0) ||
    (typeof frame.result === "string" && frame.result.trim().length > 0);
}

function housekeeping(frame: Frame): boolean {
  return !outcome(frame) && frame.num_turns === 0 && !frame.duration_api_ms && frame.local_command == null;
}

/** Input UUIDs belong to stdin messages, never to result.uuid. A housekeeping
 * result may echo an input before processing it, so only its lifecycle closes it. */
export class ClaudeInputs {
  private inputs = new Map<string, Input>();
  private seenResults = new Set<string>();
  private seenRequests = new Set<string>();
  private sequence = 0;
  private asking = false;
  private updated: number;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.updated = now();
  }

  private advance(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.updated);
    this.updated = now;
    if (this.asking) return;
    for (const input of this.inputs.values()) {
      if (!done(input) && input.phase !== "requesting") input.remaining -= elapsed;
    }
  }

  private owned(frame: Frame, afterTerminal = false): Input[] {
    const ids = new Set<string>();
    if (typeof frame.user_message_uuid === "string") ids.add(frame.user_message_uuid);
    if (Array.isArray(frame.user_message_uuids)) {
      for (const id of frame.user_message_uuids) if (typeof id === "string") ids.add(id);
    }
    return [...ids].flatMap((id) => {
      const input = this.inputs.get(id);
      return input && !input.expired && (!input.terminal || (afterTerminal && input.terminal === "completed" && !input.result)) ? [input] : [];
    });
  }

  /** Register before writing: a child can answer synchronously in a test or pipe. */
  register(id: string): void {
    this.advance();
    if (this.inputs.has(id)) return;
    this.inputs.set(id, {
      phase: "preparing", remaining: CLAUDE_COMPLETION_WAIT_MS,
      result: null, sequence: 0, terminal: null, expired: false,
    });
  }

  /** A failed stdin write did not admit a steer. */
  forget(id: string): void {
    this.advance();
    this.inputs.delete(id);
  }

  requesting(frame: Frame): boolean {
    this.advance();
    if (!root(frame) || frame.type !== "system" || frame.subtype !== "status" || frame.status !== "requesting") return false;
    if (typeof frame.uuid === "string" && this.seenRequests.has(frame.uuid)) return false;
    const inputs = this.owned({ user_message_uuids: frame.user_message_uuids });
    if (!inputs.length) return false;
    if (typeof frame.uuid === "string") this.seenRequests.add(frame.uuid);
    for (const input of inputs) {
      // Production status frames have UUIDs. An unattributed duplicate without
      // one must not reopen a finished request's metadata wait.
      if (typeof frame.uuid !== "string" && input.phase === "metadata") continue;
      input.phase = "requesting";
      if (input.result && housekeeping(input.result)) input.result = null;
    }
    return true;
  }

  result(frame: Frame): boolean {
    this.advance();
    if (!root(frame) || frame.type !== "result") return false;
    if (typeof frame.uuid === "string" && this.seenResults.has(frame.uuid)) return false;
    const inputs = this.owned(frame, true);
    if (!inputs.length) return false;
    if (typeof frame.uuid === "string") this.seenResults.add(frame.uuid);
    const sequence = ++this.sequence;
    for (const input of inputs) {
      if (input.phase === "requesting") {
        input.phase = "metadata";
        input.remaining = CLAUDE_COMPLETION_WAIT_MS;
      }
      // Repeated resume housekeeping cannot erase an answer or provider error.
      if (input.result && !housekeeping(input.result) && housekeeping(frame)) continue;
      input.result = structuredClone(frame);
      input.sequence = sequence;
    }
    return true;
  }

  terminal(frame: Frame): boolean {
    this.advance();
    if (!root(frame) || frame.type !== "command_lifecycle" ||
        !["completed", "failed", "cancelled", "discarded", "refused"].includes(frame.state)) return false;
    const input = this.inputs.get(frame.command_uuid);
    if (!input || input.terminal || input.expired) return false;
    input.terminal = frame.state;
    if (!input.result && input.phase === "requesting") {
      input.phase = "metadata";
      input.remaining = CLAUDE_COMPLETION_WAIT_MS;
    }
    return true;
  }

  setAsking(asking: boolean): void {
    this.advance();
    this.asking = asking;
  }

  /** Observed process exit is a boundary too, including a genuine empty turn.
   * A result for A still cannot make an accepted but unanswered B complete. */
  exited(): boolean {
    this.advance();
    let missing = false;
    for (const input of this.inputs.values()) {
      if (!input.result) missing = true;
      else input.terminal ??= "completed";
    }
    return !missing;
  }

  poll(): { expired: string[]; answeredFallback: string[] } {
    this.advance();
    const expired: string[] = [];
    const answeredFallback: string[] = [];
    for (const [id, input] of this.inputs) {
      if (this.asking || done(input) || input.phase === "requesting" || input.remaining > 0) continue;
      if (input.result && outcome(input.result)) {
        input.terminal = "completed";
        answeredFallback.push(id);
      } else {
        input.expired = true;
        expired.push(id);
      }
    }
    return { expired, answeredFallback };
  }

  get nextWaitMs(): number | null {
    this.advance();
    if (this.asking) return null;
    const waits = [...this.inputs.values()]
      .filter((input) => !done(input) && input.phase !== "requesting")
      .map((input) => Math.max(0, input.remaining));
    return waits.length ? Math.min(...waits) : null;
  }

  get ready(): boolean {
    return this.inputs.size > 0 && [...this.inputs.values()].every((input) => input.terminal === "completed" && input.result && !input.expired);
  }

  get selectedResult(): Frame | null {
    const results = [...this.inputs.values()].filter(input => input.result);
    // An unanswered steer can have its own empty resume housekeeping.
    // That provisional frame must not replace an earlier delivered outcome
    // or its accounting when the steer later expires.
    const settled = results.filter(input => input.terminal === "completed" || !housekeeping(input.result!));
    const latest = (settled.length ? settled : results).sort((a, b) => b.sequence - a.sequence)[0];
    return latest?.result ? structuredClone(latest.result) : null;
  }

  /** A later accepted input's success cannot erase an earlier provider
   * failure. Accounting still uses the latest cumulative result. */
  get failureResult(): Frame | null {
    const failed = [...this.inputs.values()].filter(input => input.result &&
      (input.result.is_error === true || input.result.errors?.length > 0 || input.result.stop_reason === "refusal"))
      .sort((a, b) => b.sequence - a.sequence)[0];
    return failed?.result ? structuredClone(failed.result) : null;
  }

  get failedTerminal(): string | null {
    for (const [id, input] of this.inputs) {
      if (input.terminal && input.terminal !== "completed") return `Claude Code ${input.terminal} input ${id}.`;
    }
    return null;
  }

  get pendingCount(): number {
    return [...this.inputs.values()].filter((input) => !done(input)).length;
  }
}
