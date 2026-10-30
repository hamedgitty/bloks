// The line across the top of a workspace whose work moved elsewhere.
//
// The copy left behind is kept, never deleted, and can still be opened and
// read. What it does on its own has stopped (routines, watchers,
// workflows, and the Telegram, Slack and Discord bots, so no token is
// polled from two places), and this says so, with the two things worth
// doing: going to where the work is now, and removing this copy. While a
// move is being carried, the same line says the workspace is paused for
// it, and offers to put the move off instead.
import { useCallback, useEffect, useState } from "react";
import { Server } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { said, useHostingMove } from "./useHostingMove";
import { t } from "@/lib/i18n";
import { thisComputer } from "@/lib/thisComputer";

interface Mark {
  to: "hosted" | "mac";
  name: string;
  workspaceId: string | null;
  pending: boolean;
}

/** The banner's sentence for a mark, in the same words as movedWords in
 * server/moved-mark.ts. A copy moved home sits on the hosted machine,
 * which cannot tell what the person's own computer is, so that side says
 * "your computer"; a copy moved to hosted sits on the computer this runs on. */
export function movedLine(mark: Mark): string {
  if (mark.to === "mac") return mark.pending ? t("movedBanner.line.movingMac") : t("movedBanner.line.movedMac");
  return mark.pending ? t("movedBanner.line.movingHosted") : t("movedBanner.line.movedHosted", { computer: thisComputer() });
}

export function MovedBanner() {
  const [mark, setMark] = useState<Mark | null>(null);
  const move = useHostingMove();
  // the mark alone: what a move counts is not worth reading on every focus
  const look = useCallback(() => {
    fetch("/api/workspace/move/moved")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setMark(body?.moved ?? null))
      .catch(() => {});
  }, []);
  // asked as the page opens, when the window comes back, and whenever the
  // app says a move changed
  useEffect(() => {
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [look]);
  useEffect(look, [look, move?.move?.phase, move?.move?.step, move?.copies.length]);
  if (!mark) return null;
  return <MovedBannerView mark={mark} hostedId={move?.hosted[0]?.id ?? null} />;
}

export function MovedBannerView({ mark, hostedId }: { mark: Mark; hostedId: string | null }) {
  const here = window.bloks?.workspace ?? null;
  const goTo = mark.workspaceId ?? (mark.to === "hosted" ? hostedId : null);
  const open = () => {
    if (goTo) void said(window.bloks?.workspaceSwitch?.(goTo)).catch((e: Error) => toast.error(e.message));
  };
  const remove = async () => {
    if (!here) return;
    const personal = here.kind === "personal";
    const ok = await confirm({
      title: t("movedBanner.remove.title", { name: here.name, computer: thisComputer() }),
      body: personal ? t("movedBanner.remove.personal") : t("movedBanner.remove.other", { name: here.name }),
      confirmLabel: t("movedBanner.removeFromThisMac", { computer: thisComputer() }),
      destructive: true,
    });
    if (!ok) return;
    void said(window.bloks?.hostingMoveRemoveCopy?.(here.id)).catch((e: Error) => toast.error(e.message));
  };
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-2 border-b bg-muted/60 px-4 py-2 text-small text-foreground">
      <span className="flex min-w-0 items-center gap-2">
        <Server size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="text-pretty">{movedLine(mark)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {mark.pending ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void said(window.bloks?.hostingMoveStop?.("later")).catch(() => {})}>
            {t("common.notNow")}
          </Button>
        ) : (
          <>
            {goTo && window.bloks?.workspaceSwitch && (
              <Button size="sm" variant="secondary" className="h-7" onClick={open}>
                {mark.to === "hosted" ? t("movedBanner.openHosted") : t("movedBanner.openNamed", { name: mark.name })}
              </Button>
            )}
            {here && window.bloks?.hostingMoveRemoveCopy && (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => void remove()}>
                {t("movedBanner.removeFromThisMac", { computer: thisComputer() })}
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  );
}
