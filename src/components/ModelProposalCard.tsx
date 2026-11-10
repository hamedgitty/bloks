// Models an agent proposed for other agents (server/model-proposals.ts).
// The card is the whole list: each agent, the engine and model it is on,
// and the engine and model proposed, with a switch of engine marked,
// since another engine has other tools and other safeguards. Apply
// changes every one of them or none, and Keep leaves them all, so what
// the owner reads here is exactly what changes.
import { useState } from "react";
import { ArrowRight, Check, Loader2 } from "@/components/icons";
import { api, type ModelProposalPlan, type ModelSidePlan } from "@/state/store";
import { t } from "@/lib/i18n";

const shell = "w-full max-w-[560px] animate-rise-in overflow-hidden rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)]";
const eyebrow = "text-caption font-semibold uppercase tracking-[0.1em] text-brand-ink";
const primary =
  "flex items-center gap-1.5 rounded-xl bg-brand-ink px-3.5 py-2 text-ui font-medium text-brand-foreground transition-[transform,filter] duration-150 hover:brightness-95 active:scale-[0.98] disabled:opacity-60";
const quiet = "rounded-xl px-3 py-2 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-60";

/** A model and the engine it runs on, the model first: that is what
 * changes most often, and the engine is said under it. */
function Side({ side, strong, engineMoves }: { side: ModelSidePlan; strong?: boolean; engineMoves?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className={`break-words text-body text-foreground ${strong ? "font-medium" : ""}`}>{side.label}</span>
      <span className={`break-words text-small ${engineMoves ? "font-medium text-brand-ink" : "text-muted-foreground"}`}>{side.engine}</span>
    </span>
  );
}

export function ModelProposalCard({ plan, messageId }: { plan: ModelProposalPlan; messageId: string }) {
  const [busy, setBusy] = useState<"apply" | "keep" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = (apply: boolean) => {
    setBusy(apply ? "apply" : "keep");
    setError(null);
    api(`/api/model-proposals/${encodeURIComponent(plan.laneId)}/${encodeURIComponent(messageId)}/${apply ? "apply" : "keep"}`, {
      method: "POST",
      body: "{}",
    })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };
  const heading =
    plan.outcome === "changed"
      ? t("modelProposal.applied")
      : plan.outcome === "kept"
        ? t("modelProposal.kept")
        : plan.outcome === "failed"
          ? t("modelProposal.notChanged")
          : t("modelProposal.eyebrow");
  return (
    <div className={shell}>
      <div className="px-4 pt-4">
        <div className={eyebrow}>{heading}</div>
        <div className="mt-1 text-lead font-semibold text-foreground">{t("modelProposal.title", { name: plan.agentName, count: plan.targets.length })}</div>
      </div>
      <ul className="mt-3 flex flex-col divide-y border-t">
        {plan.targets.map((target) => {
          const moves = target.from.instanceId !== target.to.instanceId;
          return (
            <li key={target.botId} className="flex flex-col gap-1.5 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-body font-medium text-foreground">{target.name}</span>
                {moves && <span className="shrink-0 rounded-md bg-accent px-1.5 py-0.5 text-caption text-foreground">{t("modelProposal.newEngine")}</span>}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3">
                <Side side={target.from} />
                <span className="mt-1 text-muted-foreground">
                  <ArrowRight size={14} />
                  <span className="sr-only">{t("modelProposal.to")}</span>
                </span>
                <Side side={target.to} strong engineMoves={moves} />
              </div>
            </li>
          );
        })}
        {plan.why && (
          <li className="flex gap-3 px-4 py-2">
            <span className="w-[112px] shrink-0 text-body text-muted-foreground">{t("settingsProposal.why")}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-body text-foreground">{plan.why}</span>
          </li>
        )}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3">
        {plan.outcome === "changed" ? (
          <span className="flex items-center gap-1.5 text-body text-muted-foreground">
            <Check size={14} /> {t("modelProposal.appliedSentence")}
          </span>
        ) : plan.outcome === "kept" ? (
          <span className="text-body text-muted-foreground">{t("modelProposal.keptSentence")}</span>
        ) : plan.outcome === "failed" ? (
          <span className="text-body text-muted-foreground">{t("modelProposal.failedSentence", { error: plan.error ?? "" })}</span>
        ) : (
          <>
            <button onClick={() => answer(true)} disabled={busy !== null} className={primary}>
              {busy === "apply" && <Loader2 size={14} className="animate-spin" />}
              {t("modelProposal.apply")}
            </button>
            <button onClick={() => answer(false)} disabled={busy !== null} className={quiet}>
              {t("common.keep")}
            </button>
            <span className="text-small text-muted-foreground">{t("modelProposal.onlyIfYouApply")}</span>
          </>
        )}
        {error && <div className="w-full text-body text-destructive">{error}</div>}
      </div>
    </div>
  );
}
