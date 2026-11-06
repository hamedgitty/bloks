// What an agent asks, question by question, and the answers that go back.
//
// An engine can put several questions in one ask: Claude Code's own
// AskUserQuestion takes up to four, Codex's requestUserInput a list of
// its own. Each was read as its first question with "(+N more)" after it,
// and only that one's choices were offered, so the rest went unasked.
// Here an ask is read whole, in one shape every engine's card shares, and
// the person's answers go back one per question, in the order asked.
//
// The flat fields an ask's card has always had (its summary, the first
// question's choices) stay as they were beside this: a phone or an older
// window reads only those, and answers with one string. That string
// answers the first question, and the others go back unanswered.

/** One question of an ask, as the card draws it. */
export interface AskQuestion {
  /** The engine's own id for it, when it answers by id (Codex). */
  id?: string;
  question: string;
  /** The engine's short label for it, shown over the question. */
  header?: string;
  options: Array<{ label: string; description?: string }>;
  /** More than one option may be picked. */
  multiple?: boolean;
  /** The person may answer in words of their own. */
  free: boolean;
  /** What they type is a secret: masked as it is typed, and never kept
   * on the card once answered. */
  secret?: boolean;
}

/** One answer per question, in the order asked: the options picked and
 * any words of the person's own. An empty one leaves its question
 * unanswered. */
export type AskAnswers = string[][];

/** Past these an ask is cut short rather than drawn as a wall: more than
 * any engine asks today, and an agent that asks more is better told it
 * was not heard than answered on questions nobody read. */
export const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 10;
const MAX_QUESTION_CHARS = 1_000;
const MAX_HEADER_CHARS = 40;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
/** One answer's words, past which the rest is not the person's to send. */
const MAX_ANSWER_CHARS = 4_000;

/** What a question the person was never shown is told: the wording is
 * aimed at the model, which can put it to them on its own. */
export const NOT_SHOWN = "Not shown to the person: their app shows one question at a time. Ask this one again on its own.";

const said = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * An ask's questions, from whichever shape its tool put them in, or
 * undefined for an ask that has none to read:
 *
 *   {questions: [{question, header, options: [{label, description}], multiSelect}]}
 *       Claude Code's AskUserQuestion, which always offers an answer of
 *       one's own beside its options.
 *   {questions: [{id, header, question, isOther, isSecret, options}]}
 *       Codex's requestUserInput, which says per question whether one may.
 *   {question, choices}
 *       Bloks' own ask_user, a single question.
 */
export function readQuestions(input: unknown): AskQuestion[] | undefined {
  const ask = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const read = (q: any, free: boolean): AskQuestion | null => {
    const question = said(q?.question ?? q?.title, MAX_QUESTION_CHARS) || said(q?.header, MAX_QUESTION_CHARS);
    if (!question) return null;
    const seen = new Set<string>();
    const options: AskQuestion["options"] = [];
    for (const option of Array.isArray(q?.options) ? q.options : Array.isArray(q?.choices) ? q.choices : []) {
      const label = said(typeof option === "string" ? option : option?.label, MAX_LABEL_CHARS);
      // a label is what an answer says, so two the same would be one
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const description = typeof option === "object" ? said(option?.description, MAX_DESCRIPTION_CHARS) : "";
      options.push({ label, ...(description ? { description } : {}) });
      if (options.length === MAX_OPTIONS) break;
    }
    const header = said(q?.header, MAX_HEADER_CHARS);
    const id = said(q?.id, 200);
    return {
      ...(id ? { id } : {}),
      question,
      ...(header && header !== question ? { header } : {}),
      options,
      ...(q?.multiSelect === true && options.length > 1 ? { multiple: true } : {}),
      // a question with nothing to pick takes words, whatever it said
      free: free || options.length === 0,
      ...(q?.isSecret === true ? { secret: true } : {}),
    };
  };
  if (Array.isArray(ask.questions)) {
    const questions = ask.questions
      .slice(0, MAX_QUESTIONS)
      // Codex says whether a question takes words; Claude always does
      .map((q: any) => read(q, typeof q?.isOther === "boolean" ? q.isOther : true))
      .filter((q: AskQuestion | null): q is AskQuestion => q !== null);
    return questions.length ? questions : undefined;
  }
  if (typeof ask.question === "string") {
    const one = read({ question: ask.question, choices: ask.choices }, true);
    return one ? [one] : undefined;
  }
  return undefined;
}

/**
 * The answers a client sent, checked against the questions they answer:
 * one list of strings per question, none longer than the ask, every
 * string trimmed and bounded. Undefined when there is nothing usable,
 * which leaves the older single answer to stand.
 */
export function readAnswers(raw: unknown, questions: readonly AskQuestion[]): AskAnswers | undefined {
  if (!Array.isArray(raw) || !questions.length) return undefined;
  const answers = questions.map((question, i) => {
    const given = raw[i];
    const list = Array.isArray(given) ? given : typeof given === "string" ? [given] : [];
    const words = list.map((item) => said(item, MAX_ANSWER_CHARS)).filter(Boolean);
    // a single choice is one answer, whatever was sent for it
    return [...new Set(question.multiple ? words : words.slice(0, 1))].slice(0, MAX_OPTIONS + 1);
  });
  return answers.some((list) => list.length) ? answers : undefined;
}

/** The answers in one string: one question's as they are, several as a
 * line each under the question's label. For whatever reads one string,
 * an engine's single answer or a conversation the answer is said in. */
export function answersText(questions: readonly AskQuestion[], answers: AskAnswers): string {
  if (questions.length <= 1) return (answers[0] ?? []).join(", ");
  return questions
    .map((question, i) => {
      const list = answers[i] ?? [];
      return list.length ? `${question.header || question.question}: ${list.join(", ")}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** The answers as the card keeps them once sent: a secret's never, only
 * that it was given. */
export function keptAnswers(questions: readonly AskQuestion[], answers: AskAnswers): AskAnswers {
  return questions.map((question, i) => (question.secret ? [] : (answers[i] ?? [])));
}
