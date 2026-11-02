// The product's writing voice, and the one part of it that is enforced
// rather than asked for.
//
// The style line goes into every agent's system prompt. Instructions
// leak, so prose also gets its dashes turned into commas on the way to
// the transcript. Fenced code is left exactly as written, and an unspaced
// en dash stays put because that is a number range, not punctuation.

export const HOUSE_STYLE =
  "Write plainly, the way a capable colleague writes. Never use em dashes or en dashes; use a comma, a colon, parentheses, or a separate sentence instead. Skip preamble and throat-clearing, do not open by restating the question, and cut adjectives that carry no information. People scan rather than read: put the answer in your first sentence, keep a reply as short as it can be and still be complete, and never restate what a card or a file already shows.";

/** The last thing every agent reads before it answers. Kept short and
 * plain, because a rule buried in a paragraph is a rule a model skims.
 * `drawn` is whether this agent's replies can carry interface (its
 * briefing taught it); without that there is nothing to point it to. */
export function replyRules(drawn: boolean): string {
  return [
    "## How to reply",
    "- Your first sentence is the answer.",
    "- Say only what the person needs, in as few words as that takes. No tips, extras or sign-offs nobody asked for.",
    "- An ordinary answer stays in the chat unless a file is asked for.",
    drawn &&
      "- A comparison, prices or numbers, or options to choose between: answer in the chat with an openui block, not a file and not a list in prose, even if earlier replies in this conversation did it another way. Make a file only when the person asks for a page, a report or something to keep.",
    "- When you made a file in this turn, your whole reply is one or two sentences: what it is and its headline. Never list what is in it, never add a tip, and never say where it is: the card under your reply already shows it.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function houseStyle(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/)
    .map((chunk, i) =>
      i % 2
        ? chunk
        : chunk
            .replace(/ *— */g, ", ")
            .replace(/ +– +/g, ", ")
            .replace(/,\s*,+/g, ",")
            .replace(/([,:;])\s*,/g, "$1"),
    )
    .join("");
}
