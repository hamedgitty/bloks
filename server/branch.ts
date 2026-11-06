// Branch from here: a new conversation with the same agent that starts
// from one of its answers in another, so the person can try a different
// direction without losing the conversation they have.
//
// The copy is the conversation up to and including that answer as it
// reads on screen, then one line saying where it came from. Nothing in
// it is live. A card that was still waiting is closed, a changes card
// cannot undo the original's files from here, and whatever carried a
// message to or from somewhere else (a Telegram return address, a place
// in a queue, a turn's own id) stays with the original. What is taken
// back, never sent or only waiting was never part of the conversation,
// so it stays out, and so do the markers of the original engine's own
// session, which the branch never had.
//
// The agent's next turn in the branch starts a new session told the
// copied words (freshTurnText, why "branch"), the way a rewound
// conversation's does. An engine's own fork copies a session to its end,
// never to a chosen answer, so it is not used.
//
// The rules about the messages and the title are here. Who may branch,
// and when, is server/index.ts's, beside rewind.
import { dismissedPreparation } from "./preparation-state.ts";
import type { Message, TaskRecord } from "./store.ts";

/** A lane's title is one short line (the PATCH route clamps it here). */
export const TITLE_MAX = 40;

/** Said in the line that opens a branch, for every client that only
 * draws a notice's text. */
export const SHARED_FILES = "Files in the workspace are shared with the original.";

/** What a lane remembers about the conversation it was branched from. */
export type BranchOrigin = NonNullable<TaskRecord["branch"]>;

/**
 * Where a branch from this message would start, or why there is none.
 * Only one of the agent's own answers: a branch from the person's words
 * is what Rewind does, and a message to or from another agent, a card or
 * a tool call is not an answer to carry on from.
 */
export function branchPoint(messages: readonly Message[], messageId: unknown): number | string {
  const index = typeof messageId === "string" ? messages.findIndex((m) => m.id === messageId) : -1;
  const target = messages[index];
  if (!target || target.deleted) return "That answer is no longer here to branch from.";
  const answer =
    target.role === "bot" &&
    target.kind === "text" &&
    Boolean(target.text?.trim()) &&
    !target.takeBack &&
    (!target.agent || target.agent.dir === "reply");
  if (!answer) return "Branch from one of the agent's answers. To go back to before your own message, use Rewind.";
  return index;
}

/** Whether a message is part of the conversation a branch copies. */
function carried(m: Message): boolean {
  if (m.deleted || m.queued || m.unsent || dismissedPreparation(m)) return false;
  // facts about the original engine's session, not about the conversation
  if (m.compaction || m.sessionReset) return false;
  return true;
}

/**
 * The messages a branch starts with: everything carried up to and
 * including `upTo`, each under a new id from `mint`, keeping when it was
 * said. A reply that points at a message the copy holds points at its
 * copy; one that points at something left out keeps its quote and loses
 * the link.
 */
export function branchCopy(messages: readonly Message[], upTo: number, mint: () => string): Message[] {
  const kept = messages.slice(0, upTo + 1).filter(carried);
  const ids = new Map(kept.map((m) => [m.id, mint()]));
  return kept.map((m) => {
    const {
      // where it waited, and how it was going to be sent
      queued: _queued,
      waitsFor: _waitsFor,
      waitsUntil: _waitsUntil,
      preparation: _preparation,
      commandInstance: _commandInstance,
      namedSkills: _namedSkills,
      joinedTurnId: _joinedTurnId,
      // who it answers on another app, as that connection was then
      telegramReply: _telegramReply,
      telegramBinding: _telegramBinding,
      fromSignal: _fromSignal,
      // a local service's admission is for the lane it was let into
      serviceWake: _serviceWake,
      // the original's own pending business: a cut-off turn to pick up,
      // held messages still to go in with its next turn
      carryOn: _carryOn,
      heldSays: _heldSays,
      chainHoldKey: _chainHoldKey,
      // what a waiting message's mentions held, for the turn that took it
      mentionContext: _mentionContext,
      ...rest
    } = m;
    const copy: Message = { ...rest, id: ids.get(m.id)! };
    if (m.replyTo) {
      const { id, ...quote } = m.replyTo;
      copy.replyTo = id && ids.has(id) ? { ...quote, id: ids.get(id)! } : quote;
    }
    if (m.card) {
      // An engine waits on the original's request, if anything still does;
      // the copy's buttons would answer nobody.
      const { requestId: _requestId, runId: _runId, ...card } = m.card;
      copy.card = card.answered || card.dismissed ? card : { ...card, dismissed: true };
    }
    if (m.secret) {
      const { resumeKey: _resumeKey, resumed: _resumed, ...secret } = m.secret;
      copy.secret = secret.status === "needs-value" ? { ...secret, status: "dismissed" } : secret;
    }
    if (m.connector) {
      const { resumeKey: _resumeKey, resumed: _resumed, authUrl: _authUrl, ...connector } = m.connector;
      copy.connector = connector.status === "connected" ? connector : { ...connector, status: "dismissed" };
    }
    // The files are the workspace's, shared with the original, and Undo
    // is the original's: undone from here, its own card would never know.
    if (m.changes) copy.changes = { ...m.changes, copied: true };
    return copy;
  });
}

/** The line after the copied messages, in English for any client that
 * draws only a notice's text; the app draws it from `branch`. */
export function dividerText(title: string, gone = false): string {
  return gone
    ? `Branched from a conversation that was deleted. ${SHARED_FILES}`
    : `Branched from ${title}. ${SHARED_FILES}`;
}

/** The line itself, waiting for an id. */
export function branchDivider(source: { id: string; title: string }, messageId: string, at: number): Omit<Message, "id"> {
  return {
    role: "bot",
    kind: "notice",
    event: true,
    text: dividerText(source.title),
    branch: { from: source.id, messageId, title: source.title },
    at,
  };
}

/** The copy of the answer a branch starts from, in the branch's own
 * messages: the last one copied, just before its line. The app replies to
 * it there when the branch was opened with a quote. */
export function branchAnswerId(messages: readonly Message[]): string | undefined {
  const line = messages.findIndex((m) => m.branch);
  return line > 0 ? messages[line - 1]!.id : undefined;
}

/** A title that already says it is a branch, and the title under it. */
const BRANCHED = /\s\(branch(?: \d+)?\)$/;

/**
 * "Plan the launch (branch)", then "(branch 2)", "(branch 3)" for the
 * ones after it. A branch of a branch is numbered with the others of the
 * conversation it came from rather than called "(branch) (branch)", and
 * the number is the first one free among the agent's conversations, so
 * no two read the same. A long title is shortened to leave room for the
 * suffix within TITLE_MAX.
 */
export function branchTitle(source: string, taken: readonly string[]): string {
  const stem = source.replace(BRANCHED, "").trim() || source.trim();
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " (branch)" : ` (branch ${n})`;
    const room = TITLE_MAX - suffix.length;
    const base = stem.length > room ? `${stem.slice(0, room - 1).trimEnd()}…` : stem;
    const title = `${base}${suffix}`;
    if (!used.has(title)) return title;
  }
}

/** What the transcript replay counts a summary's `through` against: the
 * settled words, as foldContext and buildTranscript read them. */
const settled = (list: readonly Message[]) =>
  list.filter((m) => m.kind === "text" && m.text && !m.deleted && !m.queued && !dismissedPreparation(m) && !m.unsent).length;

/**
 * The original's running summary, when it covers only what the branch
 * holds: the copy keeps the settled words in the same order, so the
 * summary of the first `through` of them is the branch's too. One that
 * reaches past the branch point would tell the branch what came after
 * it, so it stays behind, and the branch's first turn folds its own.
 */
export function carriedSummary(
  context: TaskRecord["context"],
  source: readonly Message[],
  upTo: number,
  copy: readonly Message[],
): TaskRecord["context"] {
  if (!context) return undefined;
  const words = settled(source.slice(0, upTo + 1));
  if (settled(copy) !== words || context.through > words) return undefined;
  return { ...context };
}
