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
//   They are the work, not news about it.

/** The parts of a message this decision actually depends on. */
export interface NotifiableMessage {
  role?: string;
  kind?: string;
  text?: string;
  from?: string;
  card?: { requestId?: string; title?: string };
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
  if (message.role !== "bot") return null;

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

  if (message.kind !== "text" || !message.text?.trim()) return null;
  if (watching) return null;

  // In a room, agents answer each other constantly. Only a line that
  // named you is news; the rest is them working.
  if (ctx.room) {
    if (!ctx.mentionsUser) return null;
    return { title: `${who}`, body: preview(message.text), target, urgent: false };
  }

  // A one to one reply, if this agent is allowed to interrupt.
  if (ctx.bot?.notifications === false) return null;
  return { title: who, body: preview(message.text), target, urgent: false };
}
