// Branch from here, as the app offers it (server/branch.ts has the rules).
//
// Whether the item is pressable, and the reason it is greyed when it is
// not: the server refuses the same things and says the same, so the
// reason shows before anyone presses into a refusal. And what the line
// at the top of a branch says about where it came from. Only words here.
import type { Message, TaskSummary } from "@/state/reducer";
import { t } from "./i18n.ts";

type Lane = Pick<TaskSummary, "state" | "noBranch"> & { settling?: boolean };

/**
 * Why Branch from here is greyed in this conversation, or null when it
 * can be pressed. What the conversation is comes first (a rehearsal, the
 * team's), then what it is doing (a turn running, or its changes card
 * still being made), then whether the agent has room for another.
 */
export function branchBlocked(lane: Lane | undefined, o: { name: string; lanes: number; max: number; working: boolean }): string | null {
  if (lane?.noBranch) return t(`branch.no.${lane.noBranch}`);
  if (o.working || (lane && lane.state !== "idle") || lane?.settling) return t("branch.working", { name: o.name });
  if (o.lanes >= o.max) return t("branch.full", { name: o.name, count: o.max });
  return null;
}

/** The conversation a branch came from, by its title now, or null when
 * it has been closed and the line is no longer a way back to it. */
export function branchSource(
  branch: NonNullable<Message["branch"]>,
  lanes: ReadonlyArray<Pick<TaskSummary, "id" | "title">> | undefined,
): { title: string } | null {
  if (branch.gone) return null;
  // an agent record without its lanes listed cannot say, so it is taken
  // at the server's word that the conversation is there
  if (!lanes) return { title: branch.title };
  const lane = lanes.find((l) => l.id === branch.from);
  return lane ? { title: lane.title } : null;
}
