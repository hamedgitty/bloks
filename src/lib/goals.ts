// How a conversation's goal reads on the chip over the composer
// (src/components/Goal.tsx). Kept apart from the component so the words
// can be tested without a DOM.
import type { LaneGoal } from "@/state/reducer";

/** The server's default and cap (GOAL_DEFAULT_BUDGET, MAX_GOAL_TURNS). */
export const DEFAULT_GOAL_TURNS = 20;
export const MAX_GOAL_TURNS = 100;
/** How many turns "More turns" gives a goal that ran out. */
export const MORE_GOAL_TURNS = 10;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where a goal stands, in the words the chip shows after its text. */
export function goalState(goal: LaneGoal): string {
  switch (goal.status) {
    case "active":
      return goal.judging ? `checking turn ${goal.turns} of ${goal.budget}` : `turn ${goal.turns} of ${goal.budget}`;
    case "paused":
      return `paused at turn ${goal.turns} of ${goal.budget}`;
    case "done":
      return `done in ${plural(goal.turns, "turn")}`;
    case "blocked":
      return goal.lastReason ? `blocked: ${goal.lastReason}` : "blocked, waiting on you";
    case "out":
      return `out of turns (${goal.turns} of ${goal.budget})`;
  }
}

/** The same, short enough for a phone's width beside the goal itself;
 * the reason a goal stopped is in its notice and the chip's title. */
export function goalStateShort(goal: LaneGoal): string {
  switch (goal.status) {
    case "active":
      return `${goal.turns} of ${goal.budget}`;
    case "paused":
      return `paused, ${goal.turns} of ${goal.budget}`;
    case "done":
      return "done";
    case "blocked":
      return "needs you";
    case "out":
      return "out of turns";
  }
}

/** The one press the chip offers besides Clear, if any: pause one that
 * is going, resume one that stopped short, or give one that ran out
 * more turns, up to the cap. A goal that is done has nothing to resume;
 * a new one is set instead. */
export function goalAction(goal: LaneGoal): { label: string; body: { status: "paused" | "active"; budget?: number } } | null {
  if (goal.status === "active") return { label: "Pause", body: { status: "paused" } };
  if (goal.status === "paused" || goal.status === "blocked") return { label: "Resume", body: { status: "active" } };
  if (goal.status === "out" && goal.budget < MAX_GOAL_TURNS) {
    return { label: "More turns", body: { status: "active", budget: Math.min(MAX_GOAL_TURNS, goal.budget + MORE_GOAL_TURNS) } };
  }
  return null;
}
