// The product's writing voice, and the one part of it that is enforced
// rather than asked for.
//
// The style line goes into every agent's system prompt. Instructions
// leak, so prose also gets its dashes turned into commas on the way to
// the transcript. Fenced code is left exactly as written, and an unspaced
// en dash stays put because that is a number range, not punctuation.

export const HOUSE_STYLE =
  "Write plainly, the way a capable colleague writes. Never use em dashes or en dashes; use a comma, a colon, parentheses, or a separate sentence instead. Skip preamble and throat-clearing, do not open by restating the question, and cut adjectives that carry no information.";

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
