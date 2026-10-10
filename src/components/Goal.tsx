// A conversation's goal, on screen: the chip over the composer while one
// exists, and the dialog that sets one (server/goals.ts has the rules).
//
// The chip is the goal's whole state in one line, because a goal works
// while nobody is watching and the first thing anyone wants on coming
// back is where it got to: which turn of how many, or how it ended and
// why. Its buttons are the two decisions that are the person's alone,
// whether it goes on and whether it exists at all.
import { useEffect, useState } from "react";
import Target from "lucide-react/dist/esm/icons/target.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { DEFAULT_GOAL_TURNS, goalAction, goalState, goalStateShort } from "@/lib/goals";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function goalPath(botId: string, taskId: string) {
  return `/api/bots/${botId}/tasks/${taskId}/goal`;
}

/** The chip over the composer, while the open conversation has a goal. */
export function GoalChip({ bot }: { bot: Bot }) {
  const laneId = bot.activeTaskId ?? bot.threadId;
  const goal = bot.tasks?.find((t) => t.id === laneId)?.goal;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a different goal, or the same one moving on, clears what the last
  // press said
  useEffect(() => setError(null), [goal?.startedAt, goal?.status]);
  if (!goal) return null;

  const change = (init: RequestInit) => {
    setBusy(true);
    setError(null);
    api(goalPath(bot.id, laneId), init)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const tone =
    goal.status === "active"
      ? "text-brand"
      : goal.status === "done"
        ? "text-success"
        : goal.status === "blocked" || goal.status === "out"
          ? "text-warning"
          : "text-muted-foreground";
  const action = goalAction(goal);

  return (
    // a block around it, as the composer has: an auto margin straight
    // inside the chat's column would size the chip to its words
    <div className="px-4 md:px-6">
      <div className="mx-auto mb-1 max-w-[760px] animate-rise-in">
        <div
          className={cn(
            "flex items-center gap-2 rounded-xl border bg-card py-1 pl-3 pr-1 text-[12.5px]",
            goal.status === "blocked" && "border-warning/40 bg-warning/5",
          )}
          title={[goal.text, goal.check && `Done when \`${goal.check}\` passes`, goal.lastReason].filter(Boolean).join("\n")}
        >
          <Target
            size={14}
            className={cn("shrink-0", tone, goal.status === "active" && goal.judging && "animate-pulse motion-reduce:animate-none")}
            aria-hidden
          />
          {/* the goal gives way to where it stands: a long goal is cut
              short, never the turn count or how it ended */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1 py-1" aria-live="polite">
            <span className="min-w-0 truncate text-foreground">
              <span className="font-medium">Goal:</span> {goal.text}
            </span>
            <span className="shrink-0 text-muted-foreground sm:hidden">· {goalStateShort(goal)}</span>
            <span className="hidden max-w-[55%] shrink-0 truncate text-muted-foreground sm:inline">· {goalState(goal)}</span>
          </span>
          {action && (
            <button
              onClick={() => change({ method: "PATCH", body: JSON.stringify(action.body) })}
              disabled={busy}
              className="shrink-0 rounded-lg px-2 py-1 font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              {action.label}
            </button>
          )}
          <button
            onClick={() => change({ method: "DELETE" })}
            disabled={busy}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="Clear the goal"
            aria-label="Clear the goal"
          >
            <X size={13} />
          </button>
        </div>
        {error && <div className="mt-1 px-1 text-[12px] text-destructive">{error}</div>}
      </div>
    </div>
  );
}

/**
 * "Set a goal": what done looks like, an optional check, and how many
 * turns it may take. Opened from a conversation's menu, or by sending
 * `/goal` with nothing after it. A goal already there is the starting
 * point, since the usual reason to open this again is to change it.
 */
export function GoalDialog() {
  const { state, dispatch } = useStore();
  const target = state.goalFor;
  const bot = target ? state.bots.find((b) => b.id === target.botId) : undefined;
  const lane = target ? bot?.tasks?.find((t) => t.id === target.taskId) : undefined;
  const current = lane?.goal;
  const [text, setText] = useState("");
  const [check, setCheck] = useState("");
  const [turns, setTurns] = useState(String(DEFAULT_GOAL_TURNS));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!target) return;
    setText(current?.text ?? "");
    setCheck(current?.check ?? "");
    setTurns(String(current?.budget ?? DEFAULT_GOAL_TURNS));
    setError(null);
    // only when it opens: a goal moving on underneath is not a reason to
    // throw away what is being typed
  }, [target?.botId, target?.taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!target || !bot || !lane) return null;

  const close = () => dispatch({ type: "closeGoal" });
  const going = current && current.status !== "done";
  const submit = () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    api(goalPath(bot.id, lane.id), {
      method: "PUT",
      body: JSON.stringify({ text: text.trim(), check: check.trim() || undefined, budget: turns.trim() || undefined }),
    })
      .then(close)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="w-[calc(100vw-32px)] max-w-[460px]">
        <DialogTitle>Set a goal</DialogTitle>
        <DialogDescription>
          {bot.name} keeps working, turn after turn, until it is done, it needs you, or it runs out of turns.
          {going && " This replaces the goal it has now."}
        </DialogDescription>
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">What does done look like?</span>
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              maxLength={2_000}
              rows={3}
              placeholder="The importer handles every file in samples/, and the README says how to run it"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-foreground">
              Check <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <Input
              value={check}
              onChange={(e) => setCheck(e.target.value)}
              maxLength={500}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="pnpm test"
              className="font-mono text-[13px]"
            />
            <span className="text-[11.5px] leading-relaxed text-muted-foreground">
              Runs in this conversation&rsquo;s folder after each turn, for up to five minutes. The goal only counts as
              done when it exits 0.
            </span>
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-medium text-foreground">Most turns it may take</span>
            <Input
              value={turns}
              onChange={(e) => setTurns(e.target.value.replace(/\D/g, "").slice(0, 3))}
              inputMode="numeric"
              aria-label="Most turns it may take"
              className="w-20 text-right tabular-nums"
            />
          </label>
          {error && <div className="text-[12.5px] text-destructive">{error}</div>}
          <div className="mt-1 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim() || saving}>
              Start
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
