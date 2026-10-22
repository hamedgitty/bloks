/** Actual elapsed time, never the calendar block's intended height. */
export function runElapsed(run: { state: string; startedAt: number; endedAt?: number }): string {
  if (run.state === "running") return "Running";
  if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.endedAt) || run.endedAt! < run.startedAt) {
    return "Duration unavailable";
  }
  const seconds = Math.round((run.endedAt! - run.startedAt) / 1000);
  if (seconds < 1) return "Less than a second";
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} sec` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

type Source = { kind: "agent"; id: string; taskId: string } | { kind: "room"; id: string };

/** Only the conversation recorded for this run. A missing lane must not
 * quietly become the agent's current conversation or a newly made one. */
export function runSource(
  routine: { targetKind: "agent" | "room"; targetId: string },
  run: { threadId?: string },
  bots: readonly { id: string; threadId: string; tasks?: readonly { id: string }[] }[],
  rooms: readonly { id: string }[],
): Source | null {
  if (!run.threadId) return null;
  if (routine.targetKind === "room") {
    return run.threadId === routine.targetId && rooms.some((room) => room.id === routine.targetId)
      ? { kind: "room", id: routine.targetId }
      : null;
  }
  const bot = bots.find((bot) => bot.id === routine.targetId);
  return bot && (bot.tasks?.some((task) => task.id === run.threadId) || bot.threadId === run.threadId)
    ? { kind: "agent", id: bot.id, taskId: run.threadId }
    : null;
}
