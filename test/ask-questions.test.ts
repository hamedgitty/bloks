// Several questions, one card.
//
// An engine's ask can hold several questions: Claude Code's own
// AskUserQuestion up to four, Codex's requestUserInput a list. Each was
// read as its first question with "(+N more)" after it, and only that
// one's choices were offered. Now the ask is read whole, the card steps
// through it, and the answers go back one per question. A client that
// knows only one answer still answers the first, and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";

import { answersText, keptAnswers, readAnswers, readQuestions, MAX_QUESTIONS } from "../server/harness/ask-questions.ts";
import { codexAnswers } from "../server/drivers/codex.ts";
import { answerText, answersOf, emptyStep, isAnswered, pick, reachable, stepsOf, typed } from "../src/lib/askSteps.ts";
import { sendCardAnswer } from "../src/lib/cardAnswer.ts";
import { initialState, reducer, type AppState, type Bot } from "../src/state/reducer.ts";

const claudeAsk = {
  questions: [
    { question: "Which database?", header: "Database", multiSelect: false, options: [{ label: "Postgres", description: "A server" }, { label: "SQLite", description: "" }] },
    { question: "Which features?", header: "Features", multiSelect: true, options: [{ label: "Auth" }, { label: "Billing" }] },
  ],
};

test("Claude Code's questions are read whole, each with its own options, and always take words", () => {
  const read = readQuestions(claudeAsk)!;
  assert.equal(read.length, 2);
  assert.deepEqual(read[0], {
    question: "Which database?",
    header: "Database",
    options: [{ label: "Postgres", description: "A server" }, { label: "SQLite" }],
    free: true,
  });
  assert.equal(read[1].multiple, true);
});

test("Codex says per question whether words are an answer, and which are secret", () => {
  const read = readQuestions({
    questions: [
      { id: "a", header: "Colour", question: "Which colour?", isOther: false, isSecret: false, options: [{ label: "Red" }, { label: "Red" }, { label: "Blue" }] },
      { id: "b", header: "Key", question: "Paste the key", isOther: false, isSecret: true, options: null },
    ],
  })!;
  assert.deepEqual(read.map((q) => [q.id, q.free, Boolean(q.secret), q.options.map((o) => o.label)]), [
    ["a", false, false, ["Red", "Blue"]],
    // nothing to pick, so words, whatever it said
    ["b", true, true, []],
  ]);
});

test("Bloks' own ask_user is one question, and an ask with nothing to read is none", () => {
  assert.deepEqual(readQuestions({ question: "Ship it?", choices: ["Today", "Friday"] }), [
    { question: "Ship it?", options: [{ label: "Today" }, { label: "Friday" }], free: true },
  ]);
  assert.equal(readQuestions({ command: "ls" }), undefined);
  assert.equal(readQuestions({ questions: [{ header: "" }, "nonsense"] }), undefined);
  assert.equal(readQuestions(null), undefined);
});

test("an ask longer than any engine asks is cut short, never drawn as a wall", () => {
  const many = { questions: Array.from({ length: 20 }, (_, i) => ({ question: `Q${i}?`, options: [] })) };
  assert.equal(readQuestions(many)!.length, MAX_QUESTIONS);
  const long = readQuestions({ question: "x".repeat(5_000) })!;
  assert.ok(long[0].question.length <= 1_000);
});

test("answers are read against their questions: bounded, trimmed, and single where one choice was asked", () => {
  const asked = readQuestions(claudeAsk)!;
  assert.deepEqual(readAnswers([[" SQLite ", "Postgres"], ["Auth", "Billing", "Auth"], ["extra"]], asked), [["SQLite"], ["Auth", "Billing"]]);
  // a bare string for a question is that question's one answer
  assert.deepEqual(readAnswers(["SQLite"], asked), [["SQLite"], []]);
  // nothing usable leaves the old single answer to stand
  assert.equal(readAnswers([[], [""]], asked), undefined);
  assert.equal(readAnswers("SQLite", asked), undefined);
  assert.equal(readAnswers([["x"]], []), undefined);
});

test("the answers in one string, and a secret's never kept", () => {
  const asked = readQuestions(claudeAsk)!;
  assert.equal(answersText(asked, [["SQLite"], ["Auth", "Billing"]]), "Database: SQLite\nFeatures: Auth, Billing");
  assert.equal(answersText(asked.slice(0, 1), [["SQLite"]]), "SQLite");
  const secret = readQuestions({ questions: [{ id: "k", question: "Key?", isSecret: true, isOther: true, options: [] }, { id: "n", question: "Name?", options: [] }] })!;
  assert.deepEqual(keptAnswers(secret, [["hunter-two"], ["Ada"]]), [[], ["Ada"]]);
});

test("a Codex reply answers each question by id, whatever order the card showed them in", () => {
  const raw = [
    { id: "q1", question: "Which colour?", options: [{ label: "Red" }] },
    { id: "", question: "", options: [] },
    { id: "q2", question: "Which size?", options: [{ label: "S" }] },
  ];
  const shown = readQuestions({ questions: raw })!;
  assert.equal(shown.length, 2, "the question with nothing to read was not shown");
  assert.deepEqual(codexAnswers(raw, shown, "answer", "Red, S", "user", [["Red"], ["S"]]), {
    q1: { answers: ["Red"] },
    1: { answers: ["No answer was given. Use your best judgment."] },
    q2: { answers: ["S"] },
  });
});

test("a single string answers a Codex ask's first question; anything else is said to all of them", () => {
  const raw = [{ id: "q1", question: "A?" }, { id: "q2", question: "B?" }];
  const shown = readQuestions({ questions: raw })!;
  const single = codexAnswers(raw, shown, "answer", "Yes", "user");
  assert.deepEqual(single.q1, { answers: ["Yes"] });
  assert.match(single.q2.answers[0], /not shown/i);
  // put aside, or timed out: about the ask, not one of its questions
  assert.deepEqual(codexAnswers(raw, shown, "deny", "Dismissed by user.", "user"), { q1: { answers: ["Dismissed by user."] }, q2: { answers: ["Dismissed by user."] } });
  assert.deepEqual(codexAnswers(raw, shown, "answer", undefined, "timeout").q2, { answers: ["No answer was given. Use your best judgment."] });
});

test("a card's steps: an engine's questions, or the one question its title says", () => {
  const steps = stepsOf({ questions: readQuestions(claudeAsk), options: ["Postgres", "SQLite"] }, "Which database? (+1 more)");
  assert.equal(steps.length, 2);
  assert.deepEqual(stepsOf({ options: ["Yes", "No"] }, "Go on?"), [{ question: "Go on?", options: [{ label: "Yes" }, { label: "No" }], free: true }]);
  // a workflow's gate takes only the answers it offers
  assert.equal(stepsOf({ options: ["Approve", "Reject"], runId: "r1" }, "Ship?")[0].free, false);
});

test("a single choice replaces what was there, words included; several are kept in the order offered", () => {
  const [single, multiple] = readQuestions(claudeAsk)!;
  let step = typed(single, emptyStep(), "MySQL");
  assert.deepEqual(step, { picked: [], text: "MySQL" });
  step = pick(single, step, "SQLite");
  assert.deepEqual(step, { picked: ["SQLite"], text: "" });
  // words for a single choice let the option go
  assert.deepEqual(typed(single, step, "Neither"), { picked: [], text: "Neither" });

  let many = pick(multiple, emptyStep(), "Billing");
  many = pick(multiple, many, "Auth");
  assert.deepEqual(many.picked, ["Auth", "Billing"]);
  many = typed(multiple, many, " and SSO ");
  assert.deepEqual(answersOf([many]), [["Auth", "Billing", "and SSO"]]);
  assert.deepEqual(pick(multiple, many, "Auth").picked, ["Billing"]);
});

test("a step can be reached once every one before it is answered, and no further", () => {
  const steps = [{ picked: ["A"], text: "" }, emptyStep(), emptyStep()];
  assert.equal(isAnswered(steps[0]), true);
  assert.equal(reachable(steps, 0), true);
  assert.equal(reachable(steps, 1), true);
  assert.equal(reachable(steps, 2), false);
  assert.equal(reachable(steps, 3), false);
  assert.equal(answerText(readQuestions(claudeAsk)!, [["SQLite"], ["Auth"]]), "Database: SQLite\nFeatures: Auth");
});

const withQuestionCard = (): AppState => ({
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
      messages: [{ id: "c1", role: "bot", kind: "options", at: 1, card: { title: "Your agent has a question", subtitle: "Which database? (+1 more)", options: ["Postgres", "SQLite"], requestId: "r1", questions: readQuestions(claudeAsk) } }],
    } as Bot,
  ],
});

test("a card answered question by question sends each answer, with the old single one beside them", async () => {
  const state = reducer(withQuestionCard(), { type: "answerCard", botId: "a", messageId: "c1", answer: "Database: Allow", answers: [["Allow"], ["Auth"]] });
  const card = state.bots[0].messages[0].card!;
  assert.deepEqual(card.answers, [["Allow"], ["Auth"]], "the card does not show what was just sent");
  const bodies: any[] = [];
  const api = async (_path: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return { ok: true };
  };
  await sendCardAnswer(api, { botId: "a", messageId: "c1", answer: "Database: Allow", answers: [["Allow"], ["Auth"]] }, card, () => {}, () => {});
  // an option that happens to read "Allow" is still an answer, not a yes
  assert.deepEqual(bodies[0], { requestId: "r1", behavior: "answer", message: "Database: Allow", answers: [["Allow"], ["Auth"]] });

  // and one that did not go puts the card back with nothing answered
  const reopened = reducer(state, { type: "cardReopened", botId: "a", messageId: "c1" });
  assert.equal(reopened.bots[0].messages[0].card!.answered, undefined);
  assert.equal(reopened.bots[0].messages[0].card!.answers, undefined);
});
