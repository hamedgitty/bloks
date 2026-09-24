// The composer's `/` list (#51): which skill is being typed, which ones
// match, what inserting one does, and which parts of the text to mark as
// a skill. Kept apart from the component so it can be tested without a DOM.

export interface Command {
  id: string;
  name: string;
  description: string;
  source: "library" | "engine";
}

/**
 * The `/word` being typed at the caret, or null. A slash counts anywhere
 * in the message as long as it starts a word, so "please /tl" opens the
 * list and "and/or" or a path like "src/app" do not.
 */
export function slashAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("/");
  if (start === -1) return null;
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  if (/[\s/]/.test(query)) return null;
  return { start, query };
}

/**
 * How well a command matches what was typed, higher is better, or -1 for
 * no match. An id that starts with the query beats one that contains it,
 * which beats letters found in order (the fuzzy case: "tdr" finds tldr).
 * The name is tried too, so a skill can be found by what it is called.
 */
export function score(command: Command, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 1;
  const fields = [command.id.toLowerCase(), command.name.toLowerCase()];
  let best = -1;
  for (const [i, field] of fields.entries()) {
    // the id is what gets inserted, so it edges out the name
    const weight = i === 0 ? 1 : 0.9;
    if (field.startsWith(q)) best = Math.max(best, 300 * weight - field.length);
    else if (field.includes(q)) best = Math.max(best, 200 * weight - field.indexOf(q));
    else if (inOrder(field, q)) best = Math.max(best, 100 * weight - field.length);
  }
  return best;
}

function inOrder(field: string, q: string): boolean {
  let at = 0;
  for (const ch of field) if (ch === q[at]) at++;
  return at === q.length;
}

/** Matching commands, best first, library skills ahead of engine ones on a tie. */
export function matches(commands: Command[], query: string, limit = 8): Command[] {
  return commands
    .map((c) => ({ c, s: score(c, query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || (a.c.source === b.c.source ? 0 : a.c.source === "library" ? -1 : 1) || a.c.id.localeCompare(b.c.id))
    .slice(0, limit)
    .map((x) => x.c);
}

/** The text with the half-typed `/word` replaced by the chosen command,
 * and where the caret goes after it. */
export function insert(text: string, start: number, caret: number, id: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const spaced = after.startsWith(" ") ? "" : " ";
  const next = `${text.slice(0, start)}/${id}${spaced}${after}`;
  // after the space either way, ready for the next word
  return { text: next, caret: start + id.length + 2 };
}

/**
 * The text cut into plain runs and `/id` runs for known commands, for the
 * composer to mark the skills a message carries. Every character is in
 * exactly one run, in order, so the runs laid over the textarea line up
 * with what is typed.
 */
export function segments(text: string, ids: Set<string>): Array<{ text: string; skill: boolean }> {
  const out: Array<{ text: string; skill: boolean }> = [];
  // dots only between word characters, so "/tldr." ends at the r
  const pattern = /(^|\s)(\/[A-Za-z0-9][\w-]*(?:\.[\w-]+)*)(?=$|[\s,.;:!?)])/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const token = m[2];
    const at = (m.index ?? 0) + m[1].length;
    if (!ids.has(token.slice(1))) continue;
    if (at > last) out.push({ text: text.slice(last, at), skill: false });
    out.push({ text: token, skill: true });
    last = at + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), skill: false });
  return out;
}
