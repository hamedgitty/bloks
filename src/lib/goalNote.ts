/**
 * A goal turn's note as the person reads it.
 *
 * The note Bloks writes into the lane to start a goal's next turn
 * (server/goals.ts, firstGoalNote and nextGoalNote) is written for the
 * engine: it opens by saying who it is from and closes by telling the
 * agent how to report "Goal: done". The person already knows both, and
 * read whole it is a wall of instructions in their own column. So the
 * bubble shows what moves (the goal, the next step, the check), and the
 * label says which turn it is.
 */
export function goalNoteForPerson(text: string): { body: string; turn?: { of: number; budget: number } } {
  const parts = text.split(/\n{2,}/);
  let turn: { of: number; budget: number } | undefined;
  const kept = parts.filter((part) => {
    if (part.startsWith("(From Bloks")) {
      const at = /turn (\d+) of (\d+)/.exec(part);
      const first = /up to (\d+)/.exec(part);
      if (at) turn = { of: Number(at[1]), budget: Number(at[2]) };
      else if (first) turn = { of: 1, budget: Number(first[1]) };
      return false;
    }
    return !part.startsWith("When the goal is met");
  });
  const body = kept.join("\n\n").trim();
  return { body: body || text, ...(turn ? { turn } : {}) };
}
