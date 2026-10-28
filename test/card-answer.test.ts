// An option card answered here is only answered once the answer went.
//
// The answer and the note that the card was answered used to go out side
// by side, so a refused answer still saved the card as answered and a
// reload showed a decision that never reached the agent. A failed answer
// to a permission ask left the card settled while the agent waited on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isApproval, sendCardAnswer, waitingQuestions } from "../src/lib/cardAnswer.ts";
import { initialState, reducer, type AppState, type Bot } from "../src/state/reducer.ts";

const withCard = (card: Record<string, unknown>): AppState => ({
  ...initialState,
  bots: [
    {
      id: "a",
      threadId: "t-a",
      name: "Ada",
      title: "",
      description: "",
      notifications: true,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "claude", model: "m" },
      messages: [{ id: "c1", role: "bot", kind: "options", at: 1, card: { title: "Which?", subtitle: "", options: ["A", "B"], ...card } }],
    } as Bot,
  ],
});

const answered = (state: AppState) => state.bots[0].messages[0].card?.answered;

test("a refused answer is not saved as answered, and the card can be pressed again", async () => {
  let state = reducer(withCard({}), { type: "answerCard", botId: "a", messageId: "c1", answer: "A" });
  assert.equal(answered(state), "A");
  const calls: string[] = [];
  const errors: unknown[] = [];
  const api = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method} ${path}`);
    if (path === "/api/bots/a/messages") throw new Error("Ada is archived. Restore it to give it work.");
    return {};
  };
  await sendCardAnswer(
    api,
    { botId: "a", messageId: "c1", answer: "A" },
    undefined,
    () => (state = reducer(state, { type: "cardReopened", botId: "a", messageId: "c1" })),
    (e) => errors.push(e),
  );
  assert.deepEqual(calls, ["POST /api/bots/a/messages"]);
  assert.equal((errors[0] as Error).message, "Ada is archived. Restore it to give it work.");
  assert.equal(answered(state), undefined);
});

test("an answer that went is then remembered on the card, in that order", async () => {
  const calls: string[] = [];
  await sendCardAnswer(
    async (path, init) => (calls.push(`${init?.method} ${path} ${init?.body}`), {}),
    { botId: "a", messageId: "c1", answer: "B" },
    undefined,
    () => assert.fail("nothing to put back"),
    () => assert.fail("nothing went wrong"),
  );
  assert.deepEqual(calls, [
    'POST /api/bots/a/messages {"text":"B"}',
    'PATCH /api/bots/a/cards/c1 {"answered":"B"}',
  ]);
});

test("a typed answer goes to the lane the card is in, not whichever one the server has open", async () => {
  // Unnamed, it landed in whichever lane the server last heard was open,
  // and another device may have opened a different one since the card was
  // shown. The store names the lane on screen (typedLane); this sends it.
  const calls: string[] = [];
  await sendCardAnswer(
    async (path, init) => (calls.push(`${init?.method} ${path} ${init?.body}`), {}),
    { botId: "a", messageId: "c1", answer: "Thursday works", taskId: "t-plans" },
    undefined,
    () => assert.fail("nothing to put back"),
    () => assert.fail("nothing went wrong"),
  );
  assert.equal(calls[0], 'POST /api/bots/a/messages {"text":"Thursday works","taskId":"t-plans"}');
});

test("a permission answer that did not reach the agent puts the card back", async () => {
  let state = reducer(withCard({ requestId: "r1" }), { type: "answerCard", botId: "a", messageId: "c1", answer: "Allow" });
  const errors: unknown[] = [];
  await sendCardAnswer(
    async () => {
      throw new Error("provider unavailable");
    },
    { botId: "a", messageId: "c1", answer: "Allow" },
    { requestId: "r1" },
    () => (state = reducer(state, { type: "cardReopened", botId: "a", messageId: "c1" })),
    (e) => errors.push(e),
  );
  assert.equal(errors.length, 1);
  assert.equal(answered(state), undefined);
});

test("a question an engine is waiting on is not an approval", () => {
  // "Allow all" counted every card with a request behind it, and allowed
  // a question waiting beside the approvals, which answers nothing
  // (GitHub 254). The cards as the server sends them:
  assert.equal(isApproval({ requestId: "r1", title: "Approval needed", tool: "Bash" }), true);
  assert.equal(isApproval({ requestId: "r2", title: "Approval needed" }), true);
  assert.equal(isApproval({ requestId: "r3", title: "Your agent has a question" }), false);
  assert.equal(isApproval({ title: "Which?" }), false, "a setup question has nothing waiting on it at all");
});

test("a workflow question that had already closed stays as the server left it", async () => {
  // its route settles the card itself, and a refusal there means closed,
  // so putting it back would offer a question nobody is asking any more
  const errors: unknown[] = [];
  await sendCardAnswer(
    async () => {
      throw new Error("that question has already closed");
    },
    { botId: "a", messageId: "c1", answer: "Approve" },
    { runId: "run-1" },
    () => assert.fail("a closed question is not reopened"),
    (e) => errors.push(e),
  );
  assert.equal(errors.length, 1);
});

// A question Codex asks without stopping waits above the composer while
// the work goes on (GitHub 415). Only a live engine question goes there.
const asked = (id: string, card: Record<string, unknown>) => ({
  id,
  kind: "options",
  card: { title: "Your agent has a question", subtitle: "Which one?", options: [], requestId: `r-${id}`, ...card },
});

test("only an engine's own question still owed an answer waits above the composer, oldest first", () => {
  const messages = [
    { id: "words", kind: "text" },
    asked("first", {}),
    asked("approval", { title: "Approval needed" }),
    asked("tool", { tool: "Bash" }),
    asked("answered", { answered: "B" }),
    asked("dismissed", { dismissed: true }),
    asked("closed", { closed: "The agent stopped" }),
    asked("cut", { cutOff: true }),
    asked("withdrawn", { answered: "Closed without an answer", closed: "Kat withdrew this question. No answer is needed.", withdrawn: true }),
    asked("gate", { runId: "run-1" }),
    asked("setup", { requestId: undefined }),
    asked("second", { options: ["A", "B"] }),
  ];
  assert.deepEqual(
    waitingQuestions(messages).map((m) => m.id),
    ["first", "second"],
  );
});

test("an answer takes the question out of the dock at once, and a refused one puts it back", () => {
  const live = withCard({ title: "Your agent has a question", subtitle: "Which?", requestId: "r1" });
  assert.equal(waitingQuestions(live.bots[0].messages).length, 1);
  const pressed = reducer(live, { type: "answerCard", botId: "a", messageId: "c1", answer: "A" });
  assert.equal(waitingQuestions(pressed.bots[0].messages).length, 0);
  const reopened = reducer(pressed, { type: "cardReopened", botId: "a", messageId: "c1" });
  assert.equal(waitingQuestions(reopened.bots[0].messages).length, 1);
});
