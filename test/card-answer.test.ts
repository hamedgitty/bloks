// An option card answered here is only answered once the answer went.
//
// The answer and the note that the card was answered used to go out side
// by side, so a refused answer still saved the card as answered and a
// reload showed a decision that never reached the agent. A failed answer
// to a permission ask left the card settled while the agent waited on.
import { test } from "node:test";
import assert from "node:assert/strict";

import { sendCardAnswer } from "../src/lib/cardAnswer.ts";
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
