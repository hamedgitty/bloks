// How long a skill is, measured the way the server measures it (#165).
//
// The server counts the instructions after the frontmatter comes off, in
// characters. The editor has to count the same thing, or it either lets
// through a skill the server refuses or refuses one the server would take.
// Kept apart from the component so the two can be tested against each
// other.

/** The same limit as MAX_SKILL_CHARS in server/skills.ts. */
export const MAX_SKILL_CHARS = 16_000;

/** The instructions in a markdown document: everything after the
 * frontmatter, trimmed. Mirrors parseMarkdown in server/skills.ts. */
export function skillBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return (match ? match[2] : markdown).trim();
}

/** Characters as a person counts them: code points, so an emoji or a
 * rare CJK character is one, not two. */
export function skillLength(markdown: string): number {
  return [...skillBody(markdown)].length;
}
