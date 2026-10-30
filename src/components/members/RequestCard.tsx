// Somebody asking to join, at the top of Members (design: Mac-Approve).
//
// The four words are the biggest thing on the card because comparing them
// is the whole point: the person asking reads theirs out, and if any word
// differs, somebody else may hold the invite. Letting them in is the one
// primary action, and it names who is being let in.
import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { initials, tintOf, type JoinRequest } from "@/lib/members";
import { formatList, t, type MessageKey } from "@/lib/i18n";

const ON_DEVICE: Record<JoinRequest["device"], MessageKey> = {
  iphone: "requestCard.onIphone",
  mac: "requestCard.onMac",
  pc: "requestCard.onPc",
  computer: "requestCard.onComputer",
  browser: "requestCard.onBrowser",
};

function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t("requestCard.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("requestCard.minutesAgo", { minutes: m });
  return t("requestCard.hoursAgo", { hours: Math.round(m / 60) });
}

export function RequestCard({
  request,
  onApprove,
  onDecline,
}: {
  request: JoinRequest;
  onApprove: () => Promise<void>;
  onDecline: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = request.name.split(" ")[0] || request.name;
  const words = (request.phrase ?? "").split(" ").filter(Boolean);
  const facts = [
    request.forName ? t("requestCard.fromInviteFor", { name: request.forName }) : t("requestCard.fromAnInvite"),
    request.role === "admin" ? t("requestCard.asAdmin") : t("requestCard.asMember"),
    // a kind this card does not know yet (a newer workspace's) is a computer
    t(ON_DEVICE[request.device] ?? "requestCard.onComputer"),
    ago(request.at),
    ...(request.password === "correct" ? [t("requestCard.passwordCorrect")] : []),
  ];

  const act = async (which: "in" | "out", run: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <section
      aria-label={t("requestCard.asking", { name: request.name })}
      className="flex animate-rise-in flex-col gap-[18px] rounded-[18px] border border-warning/40 bg-card px-6 py-[22px] shadow-[0_0_0_4px_color-mix(in_srgb,var(--warning)_8%,transparent)]"
    >
      <div className="flex items-center gap-3.5">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full font-semibold text-white/90"
          style={{ background: tintOf(request.inviteId) }}
          aria-hidden
        >
          {initials(request.name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[16px] font-semibold text-foreground">{t("requestCard.asking", { name: request.name })}</span>
          <span className="text-pretty text-body text-muted-foreground">{facts.join(" · ")}</span>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-pretty text-body text-foreground/80">{t("requestCard.askToRead", { name: first })}</span>
        <div role="group" aria-label={t("requestCard.checkWords", { words: formatList(words, { type: "unit", style: "short" }) })} className="grid grid-cols-4 gap-2.5 max-sm:grid-cols-2">
          {words.map((word, i) => (
            <div key={i} className="flex flex-col gap-0.5 rounded-xl border bg-muted/50 px-3.5 py-3">
              <span className="text-caption font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="truncate text-[20px] font-bold leading-tight text-foreground">{word}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-[200px] flex-1 text-pretty text-small text-muted-foreground">
          {t("requestCard.ifAnyWordIsDifferent")}
        </span>
        <Button variant="outline" size="lg" disabled={busy !== null} onClick={() => void act("out", onDecline)}>
          {busy === "out" && <Loader2 size={14} className="animate-spin" />}
          {t("common.decline")}
        </Button>
        <Button size="lg" disabled={busy !== null} onClick={() => void act("in", onApprove)}>
          {busy === "in" && <Loader2 size={14} className="animate-spin" />}
          {t("requestCard.theyMatch", { name: first })}
        </Button>
      </div>
      {error && (
        <p role="alert" className="-mt-2 text-body text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
