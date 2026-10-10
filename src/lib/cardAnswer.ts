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

export interface CardAnswer {
  botId: string;
  messageId: string;
  answer: string;
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
    // wherever the card happens to be shown
    const behavior = ref.answer === "Allow" ? "allow" : ref.answer === "Deny" ? "deny" : "answer";
    return api(`/api/bots/${ref.botId}/respond`, {
      method: "POST",
      body: JSON.stringify({
        requestId: card.requestId,
        behavior,
        message: behavior === "answer" ? ref.answer : undefined,
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
