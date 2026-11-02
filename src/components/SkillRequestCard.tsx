// A new skill an agent asks to add to the library and use itself
// (server/skill-requests.ts). The card is the whole review: what the skill
// is called, the id it will keep, when it is for, and, a press away, its
// instructions and every supporting file, exactly as the agent sent them.
// Add puts it in the library and gives it to the agent; Not now leaves
// everything as it was. A skill is read into the turns of every agent that
// has it, so nothing is added until the person presses Add here.
import { useState } from "react";
import { Check, Loader2, ShieldAlert } from "@/components/icons";
import { api, type SkillRequestPlan } from "@/state/store";
import { formatNumber, t } from "@/lib/i18n";
import { SkillFiles } from "./SkillFiles";

const shell = "w-full max-w-[560px] animate-rise-in overflow-hidden rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)]";
const eyebrow = "text-caption font-semibold uppercase tracking-[0.1em] text-brand-ink";
const primary =
  "flex items-center gap-1.5 rounded-xl bg-brand-ink px-3.5 py-2 text-ui font-medium text-brand-foreground transition-[transform,filter] duration-150 hover:brightness-95 active:scale-[0.98] disabled:opacity-60";
const quiet = "rounded-xl px-3 py-2 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:opacity-60";

interface Shown {
  body: string;
  files: Array<{ path: string; text: string }>;
}

export function SkillRequestCard({ plan, messageId }: { plan: SkillRequestPlan; messageId: string }) {
  const [busy, setBusy] = useState<"add" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(false);
  const route = `/api/skill-requests/${encodeURIComponent(plan.laneId)}/${encodeURIComponent(messageId)}`;
  const pending = !plan.outcome;

  const answer = (add: boolean) => {
    setBusy(add ? "add" : "decline");
    setError(null);
    api(`${route}/${add ? "add" : "decline"}`, { method: "POST", body: "{}" })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  const review = () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (shown) return;
    setLoading(true);
    setError(null);
    api(route)
      .then((r: Shown) => setShown({ body: r.body, files: r.files ?? [] }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex gap-3 px-4 py-2">
      <span className="w-[112px] shrink-0 text-body text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-body text-foreground">{value}</span>
    </div>
  );
  const heading =
    plan.outcome === "added"
      ? t("skillRequest.added")
      : plan.outcome === "declined"
        ? t("skillRequest.declined")
        : plan.outcome === "failed"
          ? t("skillRequest.notAdded")
          : plan.outcome === "replaced"
            ? t("skillRequest.replaced")
            : t("skillRequest.eyebrow");
  const canReview = pending || plan.outcome === "added";

  return (
    <div className={shell}>
      <div className="px-4 pt-4">
        <div className={eyebrow}>{heading}</div>
        <div className="mt-1 text-lead font-semibold text-foreground">
          {t(plan.attach ? "skillRequest.titleUse" : "skillRequest.title", { name: plan.agentName, skill: plan.name })}
        </div>
      </div>
      <div className="mt-3 flex flex-col divide-y border-t">
        {row(t("common.name"), plan.name)}
        {row(t("skillRequest.id"), <span className="font-mono text-small">{plan.skillId}</span>)}
        {row(t("skillRequest.whenToUse"), plan.description)}
        {row(
          t("common.instructions"),
          plan.files.length
            ? t("skillRequest.sizeWithFiles", { chars: formatNumber(plan.chars), count: plan.files.length })
            : t("skillRequest.size", { chars: formatNumber(plan.chars) }),
        )}
        {plan.attach && row(t("skillRequest.usedBy"), plan.agentName)}
        {plan.why && row(t("skillRequest.why"), <span className="whitespace-pre-wrap">{plan.why}</span>)}
      </div>
      {pending && (
        <div className="flex items-start gap-2.5 border-t bg-warning/10 px-4 py-2.5">
          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" />
          <div className="text-body leading-relaxed text-warning">{t("skillsPanel.agentsUsingThisSkillFollow")}</div>
        </div>
      )}
      {canReview && (
        <div className="border-t px-4 py-2.5">
          <button
            type="button"
            onClick={review}
            aria-expanded={open}
            className="text-body font-medium text-brand-ink underline-offset-2 hover:underline"
          >
            {open ? t("skillRequest.hideSkill") : t("skillRequest.readSkill")}
          </button>
          {open && (
            <div className="mt-2.5">
              {loading ? (
                <div className="flex items-center gap-2 text-small text-muted-foreground">
                  <Loader2 size={13} className="animate-spin" />
                  {t("skillFiles.loading")}
                </div>
              ) : shown ? (
                <>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-xl border bg-muted/40 p-3 font-mono text-small leading-relaxed text-foreground">
                    {shown.body}
                  </pre>
                  <SkillFiles
                    className="mt-3"
                    files={shown.files.map((f) => ({ path: f.path, size: new TextEncoder().encode(f.text).length }))}
                    read={(path) => Promise.resolve(shown.files.find((f) => f.path === path)?.text ?? "")}
                  />
                </>
              ) : null}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-3">
        {plan.outcome === "added" ? (
          <span className="flex items-center gap-1.5 text-body text-muted-foreground">
            <Check size={14} />
            {plan.attached ? t("skillRequest.addedSentenceUse", { name: plan.agentName }) : t("skillRequest.addedSentence")}
          </span>
        ) : plan.outcome === "declined" ? (
          <span className="text-body text-muted-foreground">{t("skillRequest.declinedSentence")}</span>
        ) : plan.outcome === "failed" ? (
          <span className="text-body text-muted-foreground">{t("skillRequest.failedSentence", { error: plan.error ?? "" })}</span>
        ) : plan.outcome === "replaced" ? (
          <span className="text-body text-muted-foreground">{t("skillRequest.replacedSentence", { name: plan.agentName })}</span>
        ) : (
          <>
            <button onClick={() => answer(true)} disabled={busy !== null} className={primary}>
              {busy === "add" && <Loader2 size={14} className="animate-spin" />}
              {t("common.add")}
            </button>
            <button onClick={() => answer(false)} disabled={busy !== null} className={quiet}>
              {t("common.notNow")}
            </button>
            <span className="text-small text-muted-foreground">{t("skillRequest.onlyIfYouSay")}</span>
          </>
        )}
        {error && <div role="alert" className="w-full text-body text-destructive">{error}</div>}
      </div>
    </div>
  );
}
