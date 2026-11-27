// Where each @name sits in a room message, longest names first and each
// span used once, matching how the server resolves addressees
// (server/bloks.ts, src/components/room/reach.ts). Shared by the room
// composer and every transcript bubble so what lights up while typing
// matches what lands in the conversation.

export interface MentionRun {
  text: string;
  mention: boolean;
}

/** Splits text into plain runs and matched @name runs, case-insensitively,
 * longest name first so "@Super Nova" never splits into "@Super" and " Nova". */
export function mentionRuns(text: string, names: readonly string[]): MentionRun[] {
  if (!text) return [];
  const unique = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!unique.length) return [{ text, mention: false }];
  const lower = text.toLowerCase();
  const taken: Array<[number, number]> = [];
  for (const name of unique) {
    const needle = `@${name.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      const end = at + needle.length;
      if (!taken.some(([s, e]) => at < e && end > s)) taken.push([at, end]);
    }
  }
  if (!taken.length) return [{ text, mention: false }];
  taken.sort((a, b) => a[0] - b[0]);
  const runs: MentionRun[] = [];
  let from = 0;
  for (const [s, e] of taken) {
    if (s > from) runs.push({ text: text.slice(from, s), mention: false });
    runs.push({ text: text.slice(s, e), mention: true });
    from = e;
  }
  if (from < text.length) runs.push({ text: text.slice(from), mention: false });
  return runs;
}
