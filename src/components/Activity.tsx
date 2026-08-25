// What is running, and what it is costing.
//
// The rest of the app shows work from whichever surface owns it: a routine
// from the calendar, a job from the board, a workflow from its own card. A
// person opening a workspace with ten agents in it wants the other view,
// the one nothing else gives: everything at once, what set each thing off,
// and what today has cost.
//
// The ordering is the design. What wants you comes first and stays first,
// because a turn that is working needs nothing from anybody and a card
// that has been open since yesterday does. Inside each group the oldest is
// at the top, since that is the one most likely to have been forgotten or
// to be stuck.
//
// Answering happens here rather than sending you somewhere. A gate is two
// buttons; going to find it in a background lane to press the same two
// buttons is the trip this panel exists to save.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Hourglass from "lucide-react/dist/esm/icons/hourglass.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { api, useStore, type Bot } from "@/state/store";
import { usePageVisible } from "@/lib/pageVisible";
import { AgentAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";

export interface Spend {
  turns: number;
  input: number;
  output: number;
  cost: number;
}

interface Running {
  threadId: string;
  botId: string;
  botName: string;
  laneTitle: string;
  kind: "you" | "routine" | "job" | "workflow";
  because: string;
  since?: number;
  context?: { used: number; limit: number; fraction: number };
}

interface Waiting {
  threadId: string;
  botId: string;
  botName: string;
  laneTitle: string;
  messageId: string;
  asks: string;
  since: number;
  kind: "approval" | "workflow";
  until?: number;
  runId?: string;
}

interface Paused {
  botId: string;
  botName: string;
  since: number;
  why: string;
  turnedAway?: number;
}

export interface Activity {
  waiting: Waiting[];
  running: Running[];
  paused: Paused[];
  agents: Array<{ botId: string; botName: string; running: number; waiting: number; today: Spend }>;
  today: Spend;
  costKnown: boolean;
  at: number;
}

/** "4 minutes", for how long something has been going. */
function elapsed(since: number | undefined, now: number): string {
  if (!since) return "";
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** "in 3 hours", for a deadline somebody has to act inside. */
function until(at: number, now: number): string {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "any moment";
  if (minutes < 90) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** 12,400 rather than 12400, and 1.2k once it stops being readable. */
function tokens(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function money(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

export function ActivityPanel() {
  const { state, dispatch } = useStore();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api("/api/activity")
      .then((a: Activity) => {
        setActivity(a);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    load();
    const timer = setInterval(load, 3_000);
    return () => clearInterval(timer);
  }, [load, visible]);

  // Elapsed times tick on their own, or a row would sit at "2m" for as
  // long as the panel is open and read as frozen. A hidden panel has no
  // reader, so the tick pauses with the page.
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [visible]);

  const close = () => dispatch({ type: "toggleActivity", open: false });
  const botOf = (id: string) => state.bots.find((b) => b.id === id);

  const goTo = (row: { botId: string; threadId: string }) => {
    dispatch({ type: "select", id: row.botId });
    dispatch({ type: "selectTask", botId: row.botId, taskId: row.threadId });
    close();
  };

  const answer = (row: Waiting, approve: boolean) => {
    if (!row.runId) return;
    setBusy(row.runId);
    api(`/api/workflows/runs/${row.runId}/answer`, {
      method: "POST",
      body: JSON.stringify({ answer: approve ? "Approve" : "Decline" }),
    })
      .then(load)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const stop = (row: Running) => {
    setBusy(row.threadId);
    api(`/api/bots/${row.botId}/interrupt`, {
      method: "POST",
      body: JSON.stringify({ taskId: row.threadId }),
    })
      .then(load)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const quiet =
    activity && !activity.waiting.length && !activity.running.length && !activity.paused?.length;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-3"
      onClick={close}
    >
      <div
        className="flex h-[80%] w-[640px] max-w-[92vw] animate-pop-in flex-col rounded-2xl border bg-popover p-4 shadow-2xl shadow-[--shadow-color] sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-foreground">Activity</div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Everything your agents are doing right now, and what today has cost.
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={close}>
            <X size={17} />
          </Button>
        </div>

        {activity && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">
            <span>
              <span className="text-foreground">{activity.today.turns}</span> turns today
            </span>
            <span>
              <span className="text-foreground">{tokens(activity.today.input + activity.today.output)}</span> tokens
            </span>
            {/* A zero here would read as "this was free" rather than as
                "nobody told us", which is the difference between a number
                and a guess. */}
            {activity.costKnown ? (
              <span>
                <span className="text-foreground">{money(activity.today.cost)}</span> where the provider says
              </span>
            ) : (
              <span>no provider in range reports a price</span>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            {error}
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {quiet && (
            <div className="rounded-2xl border border-dashed px-4 py-10 text-center">
              <div className="text-[13.5px] text-foreground">Nothing is running.</div>
              <div className="mx-auto mt-1 max-w-[380px] text-[12.5px] leading-relaxed text-muted-foreground">
                Routines, jobs and workflows show up here while they work, and anything that stops to
                ask you appears at the top.
              </div>
            </div>
          )}

          {activity?.waiting.length ? (
            <Section title="Waiting for you">
              {activity.waiting.map((row) => (
                <Row
                  key={row.messageId}
                  bot={botOf(row.botId)}
                  name={row.botName}
                  main={
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground">{row.asks}</div>
                      <div className="mt-0.5 text-[11.5px] text-warning">
                        {row.botName}
                        {row.laneTitle ? ` · ${row.laneTitle}` : ""} · asked {elapsed(row.since, now)} ago
                        {row.until ? ` · stops ${until(row.until, now)}` : ""}
                      </div>
                    </div>
                  }
                  actions={
                    row.runId ? (
                      <>
                        <Button size="sm" disabled={busy === row.runId} onClick={() => answer(row, true)}>
                          <Check size={13} /> Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === row.runId}
                          onClick={() => answer(row, false)}
                        >
                          Decline
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => goTo(row)}>
                        Answer it
                      </Button>
                    )
                  }
                />
              ))}
            </Section>
          ) : null}

          {activity?.paused?.length ? (
            <Section title="You have the wheel">
              {activity.paused.map((row) => (
                <Row
                  key={row.botId}
                  bot={botOf(row.botId)}
                  name={row.botName}
                  main={
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground">{row.botName} is waiting for you</div>
                      <div className="mt-0.5 text-[11.5px] text-warning">
                        You took over {elapsed(row.since, now)} ago. It will not start anything until
                        you hand it back
                        {row.turnedAway
                          ? `, and ${row.turnedAway} ${row.turnedAway === 1 ? "thing has" : "things have"} been turned away since.`
                          : "."}
                      </div>
                    </div>
                  }
                  actions={
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy === row.botId}
                      onClick={() => {
                        setBusy(row.botId);
                        api(`/api/bots/${row.botId}/wheel`, { method: "DELETE" })
                          .then(load)
                          .catch((e: Error) => setError(e.message))
                          .finally(() => setBusy(null));
                      }}
                    >
                      Hand it back
                    </Button>
                  }
                />
              ))}
            </Section>
          ) : null}

          {activity?.running.length ? (
            <Section title="Running">
              {activity.running.map((row) => (
                <Row
                  key={row.threadId}
                  bot={botOf(row.botId)}
                  name={row.botName}
                  main={
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground">
                        {row.botName}
                        <span className="text-muted-foreground"> · {row.laneTitle}</span>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                        {row.because}
                        {row.since ? ` · ${elapsed(row.since, now)}` : ""}
                        {row.context && row.context.fraction >= 0.5
                          ? ` · ${Math.round(row.context.fraction * 100)}% of the window`
                          : ""}
                      </div>
                    </div>
                  }
                  actions={
                    <>
                      <Button variant="secondary" size="sm" onClick={() => goTo(row)}>
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Stop this turn"
                        disabled={busy === row.threadId}
                        onClick={() => stop(row)}
                      >
                        <Square size={12} />
                      </Button>
                    </>
                  }
                />
              ))}
            </Section>
          ) : null}

          {activity?.agents.length ? (
            <Section title="Today, by agent">
              {activity.agents.map((row) => (
                <Row
                  key={row.botId}
                  bot={botOf(row.botId)}
                  name={row.botName}
                  main={
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground">{row.botName}</div>
                      <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                        {row.today.turns} {row.today.turns === 1 ? "turn" : "turns"} ·{" "}
                        {tokens(row.today.input + row.today.output)} tokens
                        {activity.costKnown && row.today.cost > 0 ? ` · ${money(row.today.cost)}` : ""}
                      </div>
                    </div>
                  }
                  actions={
                    row.waiting > 0 || row.running > 0 ? (
                      <span className="flex items-center gap-1.5 text-[11.5px]">
                        {row.waiting > 0 && (
                          <span className="flex items-center gap-1 text-warning">
                            <Hourglass size={11} />
                            {row.waiting}
                          </span>
                        )}
                        {row.running > 0 && (
                          <span className="text-muted-foreground">{row.running} running</span>
                        )}
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </Section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

/**
 * One row: a face, what it says, and what you can do about it.
 *
 * The actions sit beside the words when there is room and underneath when
 * there is not. Two buttons taking half of a phone's width leave a
 * question wrapping to four lines beside them, which is the wrong half to
 * protect.
 */
function Row({
  bot,
  name,
  main,
  actions,
}: {
  bot?: Bot;
  name: string;
  main: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border bg-card px-3 py-2.5">
      <span className="mt-0.5 shrink-0">
        {bot ? (
          <AgentAvatar bot={bot} size={24} />
        ) : (
          <span className="flex size-6 items-center justify-center rounded-lg bg-muted text-[10px] text-muted-foreground">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        {main}
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </div>
  );
}
