/** Codex's statement about one completed assistant item, not an audience guess. */
export interface CodexItemText {
  phase: string | null;
  questions: "none" | "present" | "unknown";
}
export interface CodexText extends CodexItemText {
  v: 1;
  turnId: string;
  itemId: string;
  origin: "agent" | "person" | "other" | "unknown";
  display: "progress" | "full";
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function codexItemText(item: { phase?: unknown; questions?: unknown }): CodexItemText {
  return {
    phase: typeof item.phase === "string" && item.phase.length <= 64 && !/[\x00-\x1f\x7f]/.test(item.phase) ? item.phase : null,
    questions: item.questions === null || (Array.isArray(item.questions) && item.questions.length === 0) ? "none" : Array.isArray(item.questions) ? "present" : "unknown",
  };
}
export function codexTextFor(item: CodexItemText | undefined, turnId: unknown, itemId: unknown, origin: CodexText["origin"]): CodexText | undefined {
  if (!item || !identity(turnId) || !identity(itemId)) return undefined;
  return { v: 1, turnId, itemId, ...item, origin, display: origin === "agent" && item.phase === "commentary" && item.questions === "none" ? "progress" : "full" };
}
export interface ProgressMessage {
  id: string;
  role: string;
  kind?: string;
  text?: string;
  from?: string;
  agent?: unknown;
  via?: unknown;
  queued?: boolean;
  midTurn?: boolean;
  joinedTurnId?: string;
  codexText?: CodexText;
}
/** Item-time attention rule. Missing or new metadata never makes text quieter. */
export function isProgressText(c: CodexText | null | undefined): boolean {
  return Boolean(c && c.v === 1 && identity(c.turnId) && identity(c.itemId) && c.origin === "agent" && c.phase === "commentary" && c.questions === "none" && c.display === "progress");
}
export function itemProgress(message: { role?: string; kind?: string; codexText?: CodexText } | null | undefined): boolean {
  return message?.role === "bot" && message.kind === "text" && isProgressText(message.codexText);
}
/** Presentation only, linear in the loaded history. No stored transitions or news. An incomplete page may omit a person join;
 * in that case retain ordinary visibility until the facts are loaded. */
export function progressIds(history: readonly ProgressMessage[], isRunning: (message: ProgressMessage, index: number) => boolean, headKnown = true, tailKnown = true): ReadonlySet<string> {
  const progress = new Set<string>();
  if (!tailKnown) return progress;
  const knownTurns = new Set<string>();
  const knownLanes = new Set<string>();
  const joined = new Set<string>();
  const finals = new Set<string>();
  const lastCommentary = new Map<string, string>();
  const latest = new Map<string, string>();
  for (const m of history) {
    // A committed new input bounds the direct lane's turn. In a room,
    // a later native turn ID bounds that speaker even with an older page missing.
    if (m.role === "user" && m.kind === "text" && !m.midTurn && !m.queued) knownLanes.add(m.from ?? "");
    if (m.role === "user" && m.midTurn && !m.queued && !m.agent && !m.via && m.joinedTurnId) joined.add(m.joinedTurnId);
    const c = m.codexText;
    if (!c || c.v !== 1 || !identity(c.turnId)) continue;
    const lane = m.from ?? "";
    const previous = latest.get(lane);
    if (headKnown || knownLanes.has(lane) || (previous && previous !== c.turnId)) knownTurns.add(c.turnId);
    latest.set(lane, c.turnId);
    if (m.text?.trim() && c.phase === "final_answer") finals.add(c.turnId);
    if (m.text?.trim() && c.phase === "commentary") lastCommentary.set(c.turnId, m.id);
  }
  for (let index = 0; index < history.length; index++) {
    const m = history[index];
    if (m.role !== "bot" || m.kind !== "text" || !itemProgress(m)) continue;
    const turn = m.codexText!.turnId;
    if (!knownTurns.has(turn) || joined.has(turn)) continue;
    const ended = !isRunning(m, index) || latest.get(m.from ?? "") !== turn;
    if (ended && !finals.has(turn) && lastCommentary.get(turn) === m.id) continue;
    progress.add(m.id);
  }
  return progress;
}
