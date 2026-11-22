// What the side dock's Changes panel reads off the server's answers
// (src/components/dock/ChangesPanel.tsx): a conversation's changed files
// and their totals, and a diff as numbered rows whichever shape it came
// in (a conversation's from server/checkpoints.ts, git's from
// server/git-changes.ts). No React and no page: the tests read it.

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  checkpointId: string;
  at: number;
  /** How many of the conversation's turns changed it. */
  turns: number;
  big?: boolean;
  added?: number;
  removed?: number;
}

/** Lines gained and lost across every file, for the + menu and the head
 * of the list. */
export function changeTotals(files: readonly ChangedFile[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added ?? 0;
    removed += f.removed ?? 0;
  }
  return { files: files.length, added, removed };
}

/** "+12 −3", or nothing when there is nothing to count. */
export function totalsLabel(files: readonly ChangedFile[]): string | undefined {
  if (!files.length) return undefined;
  const { added, removed } = changeTotals(files);
  return `+${added} −${removed}`;
}

export interface NumberedLine {
  kind: "same" | "add" | "del" | "gap";
  text: string;
  old?: number;
  new?: number;
  skipped?: number;
}

/** A diff as rows to draw, numbered on both sides. A conversation's diff
 * comes as lines with gaps; git's as hunks, a gap drawn between two. */
export function numberedDiff(diff: {
  lines?: ReadonlyArray<{ kind: "same" | "add" | "del" | "gap"; text: string; old?: number; new?: number; skipped?: number }>;
  hunks?: ReadonlyArray<{ lines: ReadonlyArray<{ kind: "same" | "add" | "del"; text: string; old?: number; new?: number }> }>;
}): NumberedLine[] {
  if (diff.lines) return diff.lines.map((l) => ({ ...l }));
  const rows: NumberedLine[] = [];
  (diff.hunks ?? []).forEach((hunk, at) => {
    if (at > 0) rows.push({ kind: "gap", text: "" });
    for (const line of hunk.lines) rows.push({ ...line });
  });
  return rows;
}

/** What tells one answer about a conversation's changes from the next:
 * the turns' change cards it holds, and whether any was undone since. */
export function changesRound(messages: ReadonlyArray<{ kind?: string; id: string; changes?: { reverted?: unknown; rehearsal?: { state: string } } }>): string {
  let round = "";
  for (const m of messages) {
    if (m.kind !== "changes" || !m.changes) continue;
    round += `${m.id}${m.changes.reverted ? "r" : ""}${m.changes.rehearsal?.state ?? ""};`;
  }
  return round;
}
