// A question card's steps: one per question an agent asked, however its
// card came to say them.
//
// An engine's ask carries every question it put (server/harness/
// ask-questions.ts reads them); a card from before that, or one that is
// not an engine's (a workflow's gate, an agent's setup question), says a
// single question in its title or subtitle with its choices beside it.
// Both are read here into the same steps, so the card draws one thing
// and the answer it sends always fits what was asked.

/** One question, as the card steps through it. */
export interface StepQuestion {
  question: string;
  /** The engine's short label for it, over the question. */
  header?: string;
  options: Array<{ label: string; description?: string }>;
  /** More than one option may be picked. */
  multiple?: boolean;
  /** Words of the person's own are an answer too. */
  free: boolean;
  /** Typed masked, and never kept once sent. */
  secret?: boolean;
}

/** What one step holds while the card is open. */
export interface StepDraft {
  picked: string[];
  text: string;
}

/** The card's fields this reads. */
interface QuestionCardFields {
  questions?: StepQuestion[];
  options: string[];
  runId?: string;
}

/**
 * The steps of a card. `question` is its single question as the card's
 * title or subtitle says it, for a card that carries no list. A
 * workflow's gate has exactly the answers it offers, so it takes no
 * words: anything typed would have to be read as a decline.
 */
export function stepsOf(card: QuestionCardFields, question: string): StepQuestion[] {
  if (card.questions?.length) return card.questions;
  return [{ question, options: card.options.map((label) => ({ label })), free: !card.runId }];
}

export const emptyStep = (): StepDraft => ({ picked: [], text: "" });

/** Whether a step has an answer the card could send. */
export function isAnswered(step: StepDraft | undefined): boolean {
  return Boolean(step && (step.picked.length > 0 || step.text.trim()));
}

/** A step after an option is pressed: a single choice replaces whatever
 * was there, words included; one of several is added or taken away. */
export function pick(question: StepQuestion, step: StepDraft, label: string): StepDraft {
  if (!question.multiple) return { picked: [label], text: "" };
  const picked = step.picked.includes(label) ? step.picked.filter((p) => p !== label) : [...step.picked, label];
  // kept in the order the options are offered, whatever order they were pressed in
  return { ...step, picked: question.options.map((o) => o.label).filter((l) => picked.includes(l)) };
}

/** A step after words are typed: for a single choice, words are the
 * answer instead of an option, so the option lets go. */
export function typed(question: StepQuestion, step: StepDraft, text: string): StepDraft {
  return question.multiple ? { ...step, text } : { picked: text.trim() ? [] : step.picked, text };
}

/** One step's answer as it is sent: the options picked, then the words. */
export function answerOf(step: StepDraft | undefined): string[] {
  if (!step) return [];
  const words = step.text.trim();
  return [...step.picked, ...(words ? [words] : [])];
}

/** Every step's answer, in the order asked. */
export function answersOf(steps: readonly StepDraft[]): string[][] {
  return steps.map(answerOf);
}

/** The answers in one string, for whatever reads one (the card's own
 * settled line, an older server): one question's as it is, several as
 * a line each under the question's label. */
export function answerText(questions: readonly StepQuestion[], answers: readonly string[][]): string {
  if (questions.length <= 1) return (answers[0] ?? []).join(", ");
  return questions
    .map((q, i) => ((answers[i] ?? []).length ? `${q.header || q.question}: ${answers[i].join(", ")}` : ""))
    .filter(Boolean)
    .join("\n");
}

/** The step a card can go to: any already answered, and the first that
 * is not, but none past it. */
export function reachable(steps: readonly StepDraft[], index: number): boolean {
  for (let i = 0; i < index; i++) if (!isAnswered(steps[i])) return false;
  return index >= 0 && index < steps.length;
}
