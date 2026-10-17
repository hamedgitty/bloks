// What is worth interrupting somebody for.
//
// Agents work while you are elsewhere, which is the point of them; the
// price is that they generate events all day. A workspace that notifies
// on every one of them gets muted within a week, and a muted workspace
// silently drops the one message that mattered.
//
// So the policy is written down here, once, as a pure function, rather
// than scattered across the places that happen to see an event:
//
//   Unanswered questions and approvals interrupt. A stopped process
//   alone has not asked the person to decide anything.
//
//   A settled reply interrupts only if that agent is allowed to, and
//   only when you are not already looking at it.
//
//   An agent's room mention stays silent. A person naming somebody is
//   handled by the server's targeted phone wake.
//
//   Nothing interrupts when you are looking straight at it. A banner for
//   a message already on your screen is noise with extra steps.
//
//   A hold, a blocked goal or an engine failure is a record for its owner,
//   not a question for the person. Goal results follow the reply switch,
//   and while a conversation works toward one,
//   its turns' replies are the work too: the goal's end is said once,
//   when it comes, rather than twenty times on the way.
//
//   A quiet check-in never interrupts. Its agent answered QUIET because
//   nothing needed you, and what a check-in says on the way to deciding
//   that waits for the end of its turn (CheckInHold), so the commentary
//   of a run that turns out quiet is never news either. Reply banners use
//   the server's settled decision; CheckInHold retains only speech timing.

/** The parts of a message this decision actually depends on. */
export interface NotifiableMessage {
  role?: string;
  kind?: string;
  text?: string;
  from?: string;
  card?: { requestId?: string; runId?: string; title?: string; subtitle?: string; answered?: string; dismissed?: boolean };
  deleted?: boolean;
  /** Part of a quiet check-in (server/store.ts). */
  quiet?: boolean;
  /** A notice about the conversation's goal (server/goals.ts). */
  goal?: string;
  /** Agents stopped at the workspace turn limit (server/agent-chain.ts). */
  chainHeld?: boolean;
}

export interface NotifyContext {
  /** A dedicated server decision after recovery and quiet settlement. */
  replySettled?: boolean;
  /** Is the app focused right now? */
  focused: boolean;
  /** The conversation on screen, agent or room. */
  selectedId: string;
  /** Where this message landed. */
  threadId: string;
  /** The agent that owns the thread, if it is a one to one. */
  bot?: { id: string; name: string; notifications?: boolean };
  /** The room it landed in, if it is a room. */
  room?: { id: string; name: string };
  /** The conversation it landed in is working toward a goal right now. */
  goalRunning?: boolean;
}

export interface Notice {
  title: string;
  body: string;
  /** What to open when the banner is clicked. */
  target: string;
  /** Approvals get to be loud; everything else is quiet. */
  urgent: boolean;
  /** The agent's face, when it has one, so a stack of banners reads as
   * people rather than as one app repeating itself. */
  avatar?: string;
}

const MAX_BODY = 180;

/** One line of a transcript, clipped to something a banner can hold. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_BODY ? `${flat.slice(0, MAX_BODY - 1)}…` : flat;
}

/**
 * Whether this message should raise a banner, and what it should say.
 * Null means stay quiet, which is the answer most of the time.
 */
export function noticeFor(message: NotifiableMessage, ctx: NotifyContext): Notice | null {
  if (message.role !== "bot" || message.quiet || message.deleted) return null;

  const who = ctx.room ? ctx.room.name : (ctx.bot?.name ?? "An agent");
  const target = ctx.room ? ctx.room.id : (ctx.bot?.id ?? ctx.threadId);
  // Looking at it already: the message is on screen, and a banner about
  // something you can see is the definition of noise.
  const watching = ctx.focused && ctx.selectedId === target;

  // An agent that stopped to ask. This one outranks everything, including
  // the per-agent switch: the work is halted until it is answered.
  if (message.kind === "options" && message.card && !message.card.answered && !message.card.dismissed && (message.card.requestId || message.card.runId)) {
    if (watching) return null;
    return {
      title: ctx.room ? `${who}: someone needs you` : `${who} needs you`,
      body: preview(message.card.runId
        ? `${message.card.title || "Approval needed"} ${message.card.subtitle || ""}`
        : message.card.subtitle || message.card.title || "An agent is waiting for your answer."),
      target,
      urgent: true,
    };
  }

  // Finished goals follow the person's existing reply switch. A blocked
  // goal alone asks no question, so it stays in the conversation.
  if (message.kind === "notice" && message.goal) {
    if (watching) return null;
    if ((message.goal === "done" || message.goal === "out") && ctx.bot?.notifications !== false) {
      return { title: who, body: preview(message.text ?? ""), target, urgent: false };
    }
    return null;
  }

  if (message.kind !== "text" || !message.text?.trim() || !ctx.replySettled) return null;
  if (watching) return null;

  // An agent's room mention is coordination, not a person's ask.
  // Human mentions still use the server's targeted phone wake.
  if (ctx.room) return null;

  // A one to one reply, if this agent is allowed to interrupt, and not
  // one on the way to a goal, whose end is said when it comes.
  if (ctx.bot?.notifications === false || ctx.goalRunning) return null;
  return { title: who, body: preview(message.text), target, urgent: false };
}

/**
 * What a check-in says, held until its turn ends.
 *
 * The server marks the frames of a quiet routine's turn (`checkIn`), and
 * only the end of the turn says whether it had anything for you: its
 * last words are QUIET, already marked quiet, or they are a report. So
 * speech is held here, the newest replacing the one before, and the raw
 * end of the turn lets go of the last of them unless it was quiet. This
 * preserves the existing speech behavior, not notification authority:
 * reply banners come only from reply.settled after server recovery decisions.
 */
export class CheckInHold<M extends NotifiableMessage = NotifiableMessage> {
  private held = new Map<string, M>();

  /** Whether this frame's message waits for the end of its turn. */
  holds(message: M, checkIn: boolean): boolean {
    return checkIn && message.role === "bot" && message.kind === "text";
  }

  hold(threadId: string, message: M): void {
    this.held.set(threadId, message);
  }

  /** The turn in this thread ended: its last reply, to announce, or
   * null when there is none or it was quiet. Speech only. */
  release(threadId: string): M | null {
    const last = this.held.get(threadId) ?? null;
    this.held.delete(threadId);
    return last && !last.quiet ? last : null;
  }
}

/** Connection-scoped freshness and bounded request-card deduplication.
 * Consume before attention policy, even when the person is watching. */
export class NoticeDelivery {
  private seen = Infinity;
  private keys = new Set<string>();
  reconnect(): void { this.seen = Infinity; this.keys.clear(); }
  hello(sequence: number): void { this.seen = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : Infinity; this.keys.clear(); }
  take(sequence: unknown, key: string): boolean {
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= this.seen) return false;
    this.seen = sequence;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > 512) this.keys.delete(this.keys.values().next().value!);
    return true;
  }
}
