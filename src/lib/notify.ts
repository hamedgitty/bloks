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
//   Approvals always interrupt. A blocked agent is doing nothing until
//   you answer, and that is the whole reason the phone buzzes too.
//
//   A settled reply interrupts only if that agent is allowed to, and
//   only when you are not already looking at it.
//
//   Agents talking to each other in a room stay silent unless they named
//   you, because six agents thinking out loud is not six notifications.
//
//   Nothing interrupts when you are looking straight at it. A banner for
//   a message already on your screen is noise with extra steps.
//
//   Tool activity, screen frames, artifacts and notices never interrupt.
//   They are the work, not news about it. The one notice that is news is
//   where a goal ended up, and while a conversation works toward one,
//   its turns' replies are the work too: the goal's end is said once,
//   when it comes, rather than twenty times on the way.
//
//   A quiet check-in never interrupts. Its agent answered QUIET because
//   nothing needed you, and what a check-in says on the way to deciding
//   that waits for the end of its turn (CheckInHold), so the commentary
//   of a run that turns out quiet is never news either.

/** The parts of a message this decision actually depends on. */
const ENGINE_OUT =
  /credit balance is too low|insufficient[_ ](?:quota|credits|funds|balance)|billing|payment required|\b402\b|out of credits|exceed your available credits|usage limit|limit (?:reached|exceeded)|quota|rate[ _-]?limit|\b429\b|not (?:logged|signed) in|sign in/i;

export interface NotifiableMessage {
  role?: string;
  kind?: string;
  text?: string;
  from?: string;
  card?: { requestId?: string; title?: string };
  /** Part of a quiet check-in (server/store.ts). */
  quiet?: boolean;
  /** A notice about the conversation's goal (server/goals.ts). */
  goal?: string;
}

export interface NotifyContext {
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
  /** The user's own name, for deciding whether a room line named them. */
  mentionsUser?: boolean;
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
  if (message.role !== "bot" || message.quiet) return null;

  const who = ctx.room ? ctx.room.name : (ctx.bot?.name ?? "An agent");
  const target = ctx.room ? ctx.room.id : (ctx.bot?.id ?? ctx.threadId);
  // Looking at it already: the message is on screen, and a banner about
  // something you can see is the definition of noise.
  const watching = ctx.focused && ctx.selectedId === target;

  // An agent that stopped to ask. This one outranks everything, including
  // the per-agent switch: the work is halted until it is answered.
  if (message.kind === "options" && message.card?.requestId) {
    if (watching) return null;
    return {
      title: ctx.room ? `${who}: someone needs you` : `${who} needs you`,
      body: preview(message.card.title || "An agent is waiting for your answer."),
      target,
      urgent: true,
    };
  }

  // Where a goal ended up. Blocked has stopped the work until the person
  // answers, the same as a question; done or out of turns is news the
  // way a finished reply is, from an agent allowed to interrupt. Set and
  // paused are the person's own doing, or said by something louder.
  if (message.kind === "notice" && message.goal) {
    if (watching) return null;
    if (message.goal === "blocked") {
      return { title: `${who} needs you`, body: preview(message.text || "A goal is waiting on you."), target, urgent: true };
    }
    if ((message.goal === "done" || message.goal === "out") && ctx.bot?.notifications !== false) {
      return { title: who, body: preview(message.text ?? ""), target, urgent: false };
    }
    return null;
  }

  // An agent that could not answer because its engine is out: credits, a
  // plan limit, a sign-in. Its work is stopped until the person acts, the
  // same as a question, so it is said even when the agent is otherwise
  // quiet. The words match server/failover.ts, which reads the same errors.
  if (message.kind === "notice" && message.text && ENGINE_OUT.test(message.text)) {
    if (watching) return null;
    return { title: `${who} could not answer`, body: preview(message.text), target, urgent: true };
  }

  if (message.kind !== "text" || !message.text?.trim()) return null;
  if (watching) return null;

  // In a room, agents answer each other constantly. Only a line that
  // named you is news; the rest is them working.
  if (ctx.room) {
    if (!ctx.mentionsUser) return null;
    return { title: `${who}`, body: preview(message.text), target, urgent: false };
  }

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
 * each reply is held here rather than announced, the newest replacing
 * the one before, and the end of the turn lets go of the last of them
 * unless it was quiet. Only replies are held: an agent stopping to ask
 * is news the moment it happens, check-in or not.
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
   * null when there is none or it was quiet. */
  release(threadId: string): M | null {
    const last = this.held.get(threadId) ?? null;
    this.held.delete(threadId);
    return last && !last.quiet ? last : null;
  }
}
