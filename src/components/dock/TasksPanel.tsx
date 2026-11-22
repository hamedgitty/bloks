// The side dock's Background tasks panel: what the conversation's agent
// has running beside the chat (src/lib/backgroundTasks.ts). Its own
// terminal tabs, each with what it runs, whether it still runs and the
// addresses it printed, to show in the terminal, open in the browser or
// stop; and the jobs it took from the job board and has not finished, to
// open where the work is. The person's own tabs are never listed here.
import { useEffect, useState } from "react";
import { Bot, Briefcase, Globe, SquareTerminal, X } from "@/components/icons";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { backgroundTasks, type BackgroundTask } from "@/lib/backgroundTasks";
import { t } from "@/lib/i18n";
import type { TerminalInfo } from "@/lib/useTerminalStream";

/** How often the list is asked for again while the window can be seen. */
const ASK_MS = 6_000;

/** The agent's background tasks, asked for on a timer: its own tabs from
 * the terminal routes (this computer only; elsewhere there are none) and
 * the job board. */
export function useBackgroundTasks(botId: string): BackgroundTask[] {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      const [shells, jobs] = await Promise.all([
        api(`/api/bots/${botId}/terminals`).then((r: { terminals?: TerminalInfo[] }) => r.terminals ?? []).catch(() => []),
        api("/api/jobs").then((r: { jobs?: unknown[] }) => (Array.isArray(r.jobs) ? r.jobs : [])).catch(() => []),
      ]);
      if (!live) return;
      setTasks(backgroundTasks(shells, jobs as Parameters<typeof backgroundTasks>[1], botId));
      timer = setTimeout(() => void ask(), document.visibilityState === "hidden" ? ASK_MS * 5 : ASK_MS);
    };
    void ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [botId]);
  return tasks;
}

export function TasksPanel({
  tasks,
  agentName,
  onShowTab,
  onStopTab,
  onOpenUrl,
  onOpenJob,
}: {
  tasks: readonly BackgroundTask[];
  agentName: string;
  onShowTab: (id: string) => void;
  onStopTab: (id: string) => void;
  onOpenUrl: ((url: string) => void) | null;
  onOpenJob: (threadId: string) => void;
}) {
  if (!tasks.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Bot size={18} />
        </div>
        <p className="text-ui font-medium text-foreground">{t("dock.tasks.none")}</p>
        <p className="max-w-[38ch] text-pretty text-body text-muted-foreground">{t("dock.tasks.noneHint", { name: agentName })}</p>
      </div>
    );
  }
  return (
    <ul aria-label={t("dock.tasks.label")} className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
      {tasks.map((task) =>
        task.kind === "terminal" ? (
          <li key={`t:${task.id}`} className="rounded-lg border bg-background px-2.5 py-2">
            <div className="flex items-center gap-2">
              <SquareTerminal size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{task.title}</span>
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 text-caption",
                  task.running ? "text-foreground" : task.exitCode ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {task.running && <span aria-hidden className="size-1.5 rounded-full bg-working motion-safe:animate-pulse" />}
                {task.running ? t("dock.tasks.running") : task.exitCode ? t("dock.tasks.failed", { code: String(task.exitCode) }) : t("dock.tasks.ended")}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-caption text-muted-foreground" title={task.command}>
              {task.command}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => onShowTab(task.id)} className="h-6 rounded-md px-2 text-small text-foreground outline-none transition-colors duration-150 hover:bg-accent">
                {t("dock.tasks.show")}
              </button>
              {onOpenUrl &&
                task.urls?.map((url) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => onOpenUrl(url)}
                    className="flex h-6 items-center gap-1 rounded-md px-2 text-small text-foreground outline-none transition-colors duration-150 hover:bg-accent"
                  >
                    <Globe size={12} aria-hidden />
                    <span className="font-mono">{url.replace(/^https?:\/\//, "")}</span>
                  </button>
                ))}
              {task.running && (
                <button
                  type="button"
                  onClick={() => onStopTab(task.id)}
                  className="ml-auto flex h-6 items-center gap-1 rounded-md px-2 text-small text-muted-foreground outline-none transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive"
                >
                  <X size={12} aria-hidden />
                  {t("dock.tasks.stop")}
                </button>
              )}
            </div>
          </li>
        ) : (
          <li key={`j:${task.id}`} className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-2">
            <Briefcase size={14} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-medium text-foreground">{task.title}</span>
              <span className="text-caption text-muted-foreground">{t("dock.tasks.job")}</span>
            </span>
            {task.threadId && (
              <button type="button" onClick={() => onOpenJob(task.threadId!)} className="h-6 shrink-0 rounded-md px-2 text-small text-foreground outline-none transition-colors duration-150 hover:bg-accent">
                {t("dock.tasks.open")}
              </button>
            )}
          </li>
        ),
      )}
    </ul>
  );
}
