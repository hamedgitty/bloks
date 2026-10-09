// How full this conversation is, where you decide what to send next
// (GitHub 224).
//
// One ring by the voice and send buttons, for the conversation being
// typed into, at every level from the first answer on: the chips only
// show theirs once a lane is a quarter full, but this is the place a
// person decides whether to send something long, run /compact or start
// a fresh conversation. Not in a room, where every agent has a context
// of its own and one ring could not say whose.
//
// Hover on a Mac, or a tap, opens a small card with the numbers, and,
// where the engine reports them, what its plan has left. Every number is
// the engine's own. No ring rather than a guess: without a reading from
// the engine and model the conversation is on now, there is nothing
// here (src/lib/contextCard.ts).
import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { composerContext, contextCard, planName, planRows, ringLabel, type PlanUsage } from "@/lib/contextCard";
import { ContextRing } from "./TaskStrip";

/** A thin bar, filled to a share. The colour is a fill, never text. */
function Bar({ fill, near }: { fill: number; near?: boolean }) {
  return (
    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out", near ? "bg-warning" : "bg-foreground/60")}
        style={{ width: `${Math.round(Math.max(0, Math.min(1, fill)) * 100)}%` }}
      />
    </div>
  );
}

export function ComposerRing({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const lane = bot.tasks?.find((t) => t.id === (bot.activeTaskId ?? bot.threadId));
  const context = composerContext(lane?.context);
  const instanceId = bot.modelSelection.instanceId;
  const [open, setOpen] = useState(false);
  // kept with the engine it is about, so a switch never shows the last
  // engine's plan while the new one is asked for
  const [heard, setHeard] = useState<{ instanceId: string; plan: PlanUsage | null } | null>(null);
  // Asked each time the card opens: a read of what the engine last said,
  // on this Mac, which nothing else brings up to date between turns. A
  // phone or a remote window is refused, and then the card has no plan.
  useEffect(() => {
    if (!open) return;
    let current = true;
    api("/api/plan-usage")
      .then((body) => current && setHeard({ instanceId, plan: body?.usage?.[instanceId] ?? null }))
      .catch(() => current && setHeard({ instanceId, plan: null }));
    return () => {
      current = false;
    };
  }, [open, instanceId]);
  if (!context) return null;

  const plan = heard?.instanceId === instanceId ? heard.plan : null;
  const card = contextCard(context);
  const rows = planRows(plan, Date.now());
  const engine = state.instances.find((i) => i.instanceId === instanceId)?.displayName;
  const named = planName(plan?.plan);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={ringLabel(context)}
            // A tap opens it, where there is no hover. It never closes it:
            // a tap anywhere else does, and so do Escape and moving away.
            onClick={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
          >
            <ContextRing fraction={context.fraction} summarised={context.summarised} size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          sideOffset={8}
          className="w-[264px] max-w-[calc(100vw-24px)] rounded-xl border bg-popover p-3 text-[12px] font-normal text-popover-foreground shadow-lg shadow-(color:--shadow-color)"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium">Context</span>
            <span className="tabular-nums text-muted-foreground">{card.share}</span>
          </div>
          <Bar fill={context.fraction} />
          <div className="mt-1.5 tabular-nums text-muted-foreground">{card.tokens}</div>
          {card.summarised && <p className="mt-1.5 leading-snug text-muted-foreground">{card.summarised}</p>}
          {rows.length > 0 && (
            <div className="mt-3 border-t pt-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">Plan usage</span>
                {(engine || named) && (
                  <span className="truncate text-muted-foreground">{[engine, named && `${named} plan`].filter(Boolean).join(", ")}</span>
                )}
              </div>
              {rows.map((row) => (
                <div key={row.id} className="mt-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span>{row.label}</span>
                    <span className={cn("tabular-nums", row.near ? "text-warning" : "text-muted-foreground")}>{row.used}</span>
                  </div>
                  <Bar fill={row.fill} near={row.near} />
                  {(row.note || row.reset) && (
                    <div className="mt-1 text-[11.5px] text-muted-foreground">
                      {[row.note, row.reset].filter(Boolean).join(". ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
