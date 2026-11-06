// Whether a quote is words a message holds, read past the marks a screen
// draws away: a person selects what they see (bold as plain words, a link
// as its text), while the message keeps its Markdown. An agent's or a
// member's quote that is not in the message it names is dropped, so the
// engine never hears "quoting" words someone did not write.

const plain = (text: string) =>
  text
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/[*_`#>[\]~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function quoteIn(said: string, quote: string): boolean {
  const wanted = plain(quote);
  return wanted.length > 0 && plain(said).includes(wanted);
}
