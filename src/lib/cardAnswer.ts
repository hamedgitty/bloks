// An answer to an option card, sent after the card already shows it.
//
// The card settles the moment it is pressed, which is only honest if a
// refusal takes that back. Two ways it did not: the answer and the note
// that the card was answered went out side by side, so a message the
// server refused still saved the card as answered, and the next reload
// showed a decision that never reached the agent; and a permission
// answer that failed left the card settled here while the agent still
// waited on it. Now the note follows the answer, and an answer that did
// not go puts the card back, so it can be pressed again.

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** Whether a card asks for a yes or a no on something the agent wants to
 * do, as opposed to asking a question. A request id does not say which:
 * an engine's own question tool arrives as a permission request too. The
 * server tells them apart, leaves the tool off a question's card and
 * titles it as one, and this reads that. */
export function isApproval(card: { requestId?: string; tool?: string; title?: string }): boolean {
  return Boolean(card.requestId) && (Boolean(card.tool) || card.title === "Approval needed");
}

/** A card as the transcript carries it, as far as waitingQuestions reads. */
interface CardMessage {
  id: string;
  kind?: string;
  card?: {
    requestId?: string;
    tool?: string;
    title?: string;
    runId?: string;
    answered?: string;
    dismissed?: boolean;
    closed?: string;
    cutOff?: boolean;
  };
}

/**
 * The questions an engine has asked and is still owed an answer for, the
 * oldest first: what sits above the composer while the transcript goes on
 * under it (GitHub 415). Codex asks some of them without stopping, and
 * one left where it was asked scrolled away as the work went on.
 *
 * Only an engine's own live ask. An approval has the composer's tray. A
 * workflow's gate waits on disk and an agent's setup question is safe to
 * leave, so either could sit over the box for days; both stay in the
 * conversation where they were asked.
 */
export function waitingQuestions<M extends CardMessage>(messages: readonly M[]): M[] {
  return messages.filter((m) => {
    const card = m.kind === "options" ? m.card : undefined;
    if (!card?.requestId || card.runId || isApproval(card)) return false;
    return !card.answered && !card.dismissed && !card.closed && !card.cutOff;
  });
}

export interface CardAnswer {
  botId: string;
  messageId: string;
  answer: string;
  /** One answer per question, for an engine's question that carries its
   * questions. `answer` goes beside them for a server that reads only
   * one string. */
  answers?: string[][];
  roomId?: string;
  /** The agent's lane the card is in (typedLane). Without it the server
   * puts the answer in whichever lane it last heard was open. */
  taskId?: string;
}

export function sendCardAnswer(
  api: Api,
  ref: CardAnswer,
  card: { runId?: string; requestId?: string } | undefined,
  reopen: () => void,
  showError: (e: unknown) => void,
): Promise<void> {
  const failed = (e: unknown) => {
    showError(e);
    reopen();
  };
  if (card?.runId) {
    // A workflow run is parked on this card. Answering resumes the run,
    // which is a different thing from saying something to an agent, so
    // it goes to its own route. That route marks the card answered
    // itself: this one can be in a room, and the card route only reaches
    // an agent's own thread. Its refusal means the question had already
    // closed, and the card says so on its own, so it is not put back.
    return api(`/api/workflows/runs/${card.runId}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: ref.answer }),
    }).then(() => {}, showError);
  }
  if (card?.requestId) {
    // a live provider ask settles against the agent that raised it,
    // wherever the card happens to be shown. Answers per question are
    // always an answer, even one whose option reads "Allow".
    const behavior = ref.answers ? "answer" : ref.answer === "Allow" ? "allow" : ref.answer === "Deny" ? "deny" : "answer";
    return api(`/api/bots/${ref.botId}/respond`, {
      method: "POST",
      body: JSON.stringify({
        requestId: card.requestId,
        behavior,
        message: behavior === "answer" ? ref.answer : undefined,
        ...(ref.answers ? { answers: ref.answers } : {}),
      }),
    }).then(() => {}, failed);
  }
  if (ref.roomId) {
    return api(`/api/bloks/${ref.roomId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: ref.answer }),
    }).then(() => {}, failed);
  }
  return api(`/api/bots/${ref.botId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: ref.answer, ...(ref.taskId ? { taskId: ref.taskId } : {}) }),
  }).then(
    // Remembering that a card was dealt with is a nicety, not a
    // correctness requirement, so a failure here is allowed to pass.
    () =>
      api(`/api/bots/${ref.botId}/cards/${ref.messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ answered: ref.answer }),
      }).then(
        () => {},
        () => {},
      ),
    failed,
  );
}
