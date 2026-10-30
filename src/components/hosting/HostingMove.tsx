// Moving a workspace to the hosted machine, and back, under Hosting on the
// Plan page.
//
// One card while a move is under way or just finished: the six steps, how
// much is across, what went wrong in a sentence with Retry, and once it is
// done, the keys to enter again with a button to the page for each. With
// no move, the ways to start one: this Mac's workspace to Hosting (which
// usually starts on its own, once the machine is running), and the hosted
// workspace home (MoveHome), which is only ever asked for.
//
// The move itself is the app's (electron/hosting-move.mjs); this only
// shows it and asks it to start, stop, carry on or change.
import { useEffect, useState } from "react";
import { RotateCcw, Server } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { headline, startsIn, stillPaidLine, subline } from "@/lib/hostingMove";
import { useWorkspaces } from "@/lib/workspaces";
import type { HostingMove as Move, HostingMoveState } from "@/types/bridge";
import { SettingsSelect } from "../SettingsLayout";
import { MoveHome } from "./MoveHome";
import { MoveKeys } from "./MoveKeys";
import { MoveSteps } from "./MoveSteps";
import { said, useHostingMove } from "./useHostingMove";
import { t } from "@/lib/i18n";
import { thisComputer } from "@/lib/thisComputer";

const LOCAL = new Set(["personal", "business", "custom"]);

export function HostingMove() {
  const state = useHostingMove();
  if (!state?.available) return null;
  return <HostingMoveView state={state} />;
}

/** The card for a move as it stands, or the ways to start one. Apart from
 * the bridge, so its states can be drawn on their own. */
export function HostingMoveView({ state }: { state: HostingMoveState }) {
  const move = state.move;
  const hostedHere = window.bloks?.workspace?.kind === "hosted";
  return (
    <div className="flex flex-col gap-3">
      {move && <MoveCard move={move} state={state} />}
      {!move && !hostedHere && !state.licenceMoved && state.hostingActive && <MoveThere state={state} />}
      {!move && <MoveHome state={state} />}
    </div>
  );
}

function act(call: Promise<{ error?: string }> | undefined) {
  void said(call).catch((e: Error) => toast.error(e.message));
}

function MoveCard({ move, state }: { move: Move; state: HostingMoveState }) {
  const failed = move.phase === "failed";
  const done = move.phase === "done";
  return (
    <section
      aria-label={t("hostingHostingMove.movingAWorkspace")}
      data-setting-row="moving-a-workspace"
      className={cn("rounded-2xl border bg-card p-5", failed && "border-destructive/25")}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Server size={18} />
        </span>
        <div className="min-w-0 flex-1 basis-[240px]">
          <h2 className="text-lead font-semibold text-foreground text-balance">{headline(move)}</h2>
          <p className="mt-0.5 max-w-[60ch] text-pretty text-body text-muted-foreground">{subline(move)}</p>
        </div>
      </div>
      <div className="mt-4 sm:pl-14">
        {move.phase === "waiting" ? <Waiting move={move} /> : <MoveSteps move={move} />}
        {failed && move.error && (
          <p role="alert" className="mt-3 max-w-[62ch] text-pretty text-body text-destructive">
            {move.error}
          </p>
        )}
        {done && (
          <div className="mt-4 flex flex-col gap-3">
            <MoveKeys keys={move.keys} bloksAi={state.bloksAi && move.direction === "to-hosted"} to={move.direction === "to-hosted" ? null : move.to.name} />
            {move.direction === "to-mac" && <p className="text-pretty text-small text-muted-foreground">{stillPaidLine()}</p>}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {move.phase === "running" && move.stoppable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => act(window.bloks?.hostingMoveStop?.("stop"))}>
                {t("common.stop")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act(window.bloks?.hostingMoveStop?.("later"))}>
                {t("common.notNow")}
              </Button>
            </>
          )}
          {failed && (
            <>
              <Button size="sm" className="gap-1.5" onClick={() => act(window.bloks?.hostingMoveResume?.())}>
                <RotateCcw size={14} />
                {t("hostingHostingMove.retry")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act(window.bloks?.hostingMoveStop?.("later"))}>
                {t("common.notNow")}
              </Button>
            </>
          )}
          {(move.phase === "stopped" || move.phase === "later") && (
            <>
              <Button size="sm" onClick={() => act(window.bloks?.hostingMoveResume?.())}>
                {t("hostingHostingMove.carryOn")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => act(window.bloks?.hostingMoveDismiss?.())}>
                {t("hostingHostingMove.forgetIt")}
              </Button>
            </>
          )}
          {done && (
            <Button size="sm" variant="secondary" onClick={() => act(window.bloks?.hostingMoveDismiss?.())}>
              {t("common.done")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The few seconds before a move started on its own begins: which one
 * goes, and the way to change it or put it off. Buying is the consent, so
 * nothing is asked; this is the chance to say otherwise. */
function Waiting({ move }: { move: Move }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil(((move.startsAt ?? now) - now) / 1000));
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-pretty text-body text-foreground tabular-nums">
        {left > 0 ? startsIn(move, left) : t("hostingHostingMove.starting")}
      </p>
      <ChooseFrom label={t("hostingHostingMove.moveAnotherWorkspaceInstead")} except={move.from.id} onChoose={(id) => act(window.bloks?.hostingMoveChange?.(id))} />
      <div>
        <Button size="sm" variant="ghost" onClick={() => act(window.bloks?.hostingMoveStop?.("later"))}>
          {t("common.notNow")}
        </Button>
      </div>
    </div>
  );
}

/** A workspace of this Mac's own to move, chosen from a list. */
function ChooseFrom({ label, except, onChoose, action }: { label: string; except?: string; onChoose: (id: string) => void; action?: string }) {
  const workspaces = useWorkspaces();
  const choices = workspaces.available ? workspaces.workspaces.filter((w) => LOCAL.has(w.kind) && !w.movedTo && w.id !== except) : [];
  const [chosen, setChosen] = useState<string>("");
  const pick = chosen || choices[0]?.id || "";
  if (!choices.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="move-from" className="text-body text-muted-foreground">
        {label}
      </label>
      <SettingsSelect id="move-from" value={pick} onChange={(e) => setChosen(e.target.value)} className="min-w-[160px]">
        {choices.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </SettingsSelect>
      <Button size="sm" variant="secondary" disabled={!pick} onClick={() => onChoose(pick)}>
        {action ?? t("hostingHostingMove.moveThisOne")}
      </Button>
    </div>
  );
}

/** With Hosting running and nothing moved yet (the move that starts on
 * its own was put off, say), the way to start it by hand. */
function MoveThere({ state }: { state: HostingMoveState }) {
  return (
    <section aria-label={t("hostingHostingMove.moveToYourHostedMachine")} className="rounded-2xl border bg-card p-5">
      <h2 className="text-ui font-medium text-foreground">{t("hostingHostingMove.moveAWorkspaceToYour")}</h2>
      <p className="mt-0.5 max-w-[62ch] text-pretty text-body text-muted-foreground">
        {t(state.bloksAi ? "hostingHostingMove.everythingGoesBloksAi" : "hostingHostingMove.everythingGoes", { computer: thisComputer() })}
      </p>
      <div className="mt-3">
        <ChooseFrom
          label={t("hostingHostingMove.move")}
          action={t("hostingHostingMove.moveIt")}
          onChoose={(id) => act(window.bloks?.hostingMoveStart?.({ direction: "to-hosted", from: id }))}
        />
      </div>
    </section>
  );
}
