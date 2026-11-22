// The side dock's Background tasks panel
// (src/components/dock/TasksPanel.tsx): what a conversation's agent has
// running beside the chat. Its own terminal tabs (`bloks terminal run`),
// running or finished, and the jobs from the job board it took and has
// not finished (server/jobs.ts). No React and no page: the tests read it.

export type BackgroundTask =
  | { kind: "terminal"; id: string; title: string; command: string; running: boolean; startedAt: number; exitCode?: number | null; urls?: string[] }
  | { kind: "job"; id: string; title: string; threadId?: string; since: number };

interface ShellLike {
  id: string;
  title: string;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  agent?: { command: string };
  urls?: string[];
}

interface JobLike {
  id: string;
  title: string;
  state: string;
  claimedBy?: string;
  claimedAt?: number;
  postedAt: number;
  threadId?: string;
}

/** The agent's own tabs, newest first, then the jobs it took that are
 * still under way. The person's own tabs are theirs, and not listed. */
export function backgroundTasks(shells: readonly ShellLike[], jobs: readonly JobLike[], botId: string): BackgroundTask[] {
  const tabs: BackgroundTask[] = shells
    .filter((s) => s.agent)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => ({
      kind: "terminal" as const,
      id: s.id,
      title: s.title,
      command: s.agent!.command,
      running: !s.exitedAt,
      startedAt: s.startedAt,
      ...(s.exitedAt ? { exitCode: s.exitCode ?? null } : {}),
      ...(s.urls?.length ? { urls: s.urls } : {}),
    }));
  const taken: BackgroundTask[] = jobs
    .filter((j) => j.claimedBy === botId && j.state === "claimed")
    .map((j) => ({ kind: "job" as const, id: j.id, title: j.title, ...(j.threadId ? { threadId: j.threadId } : {}), since: j.claimedAt ?? j.postedAt }));
  return [...tabs, ...taken];
}

/** How many are under way: running tabs and jobs not finished. */
export function runningCount(tasks: readonly BackgroundTask[]): number {
  return tasks.filter((task) => task.kind === "job" || task.running).length;
}
