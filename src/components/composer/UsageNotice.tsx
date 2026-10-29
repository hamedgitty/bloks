// A compact usage status outside the writing box, beside its engine controls.
// The server decides which notices apply and their severity. Existing refresh
// triggers and dismissal IDs stay with the conversation; only presentation lives here.
import { useEffect, useState } from "react";
import { X } from "@/components/icons";
import { api, openLaneWorking, useStore, type Bot } from "@/state/store";
import { usePageVisible } from "@/lib/pageVisible";
import { noticeCountsDown, noticeLine, noticeSource, noticeTitle, noticeToShow, readDismissed, readNotices, saveDismissed, withDismissed, type UsageNotice as Said } from "@/lib/usageNotice";
import { t } from "@/lib/i18n";

const EVERY_MS = 60_000;

export function UsageNotice({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const laneId = bot.activeTaskId ?? bot.threadId;
  const working = openLaneWorking(bot);
  const visible = usePageVisible();
  // kept with the conversation it is about, so a switch never shows the
  // last one's notice while the new one is asked for
  const [heard, setHeard] = useState<{ laneId: string; notices: Said[] } | null>(null);
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    api(`/api/usage-notices?thread=${encodeURIComponent(laneId)}`)
      .then((body) => current && setHeard({ laneId, notices: readNotices(body) }))
      // an older server has no such route, and a failed read is no news
      .catch(() => current && setHeard({ laneId, notices: [] }));
    return () => {
      current = false;
    };
  }, [laneId, working, visible, tick, bot.modelSelection.instanceId]);

  useEffect(() => {
    if (!visible) return;
    const again = () => setTick((n) => n + 1);
    const timer = window.setInterval(again, EVERY_MS);
    window.addEventListener("focus", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
    };
  }, [visible]);

  const notice = heard?.laneId === laneId ? noticeToShow(heard.notices, dismissed) : null;
  if (!notice) return null;
  const now = Date.now();
  const details = noticeLine(notice, now);
  const source = noticeSource(notice, state.instances);
  const dismiss = () =>
    setDismissed((was) => {
      const next = withDismissed(was, notice.id);
      saveDismissed(next);
      return next;
    });
  const viewUsage = () => dispatch({ type: "openUsage", botId: bot.id, section: "limits" });
  // Read the complete changed status, urgently only when work is blocked.
  // A plan countdown changes every minute, so there only the title is
  // live: the clock stays readable beside it without repeating the alert.
  const live = { role: notice.level === "stop" ? "alert" : "status", "aria-atomic": "true" } as const;
  const countsDown = noticeCountsDown(notice);

  return (
    <div {...(countsDown ? {} : live)} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pt-1.5 text-small">
      <p className="min-w-0 basis-48 flex-1 leading-snug [overflow-wrap:anywhere]">
        <span {...(countsDown ? live : {})} className={notice.level === "stop" ? "font-semibold text-destructive" : "font-medium text-foreground"}>
          {t("composerUsageNotice.title", { source, title: noticeTitle(notice, now) })}
        </span>
        <span className="text-muted-foreground">{` · ${details}`}</span>
      </p>
      <button
        type="button"
        onClick={viewUsage}
        className="h-7 shrink-0 rounded-lg px-1.5 font-medium text-foreground underline-offset-2 hover:bg-accent hover:underline"
      >
        {t("composerUsageNotice.viewUsage")}
      </button>
      <button
        type="button"
        onClick={dismiss}
        // Dismiss without taking the caret out of the message being written.
        onPointerDown={(event) => event.preventDefault()}
        aria-label={t("composerUsageNotice.dismissUsageNotice")}
        title={t("composerUsageNotice.dismissUsageNotice")}
        className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}
