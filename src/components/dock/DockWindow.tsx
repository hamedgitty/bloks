// A panel of the side dock in a window of its own, in the desktop app.
//
// The same bundle as the app, loaded with ?dock=<panel>&agent=<id>&lane=<id>
// (electron/dock-window.mjs), the way a terminal window loads with
// ?terminal=. It draws that one panel for that agent's conversation and
// nothing else: no store, no sidebar. The Files panel's open files are
// this window's own; Changes and Background tasks ask the server, as the
// dock does, on a timer since no event stream comes here.
import { useEffect, useState } from "react";
import { ConfirmHost } from "@/components/ui/confirm";
import { Toaster } from "@/components/ui/toast";
import { api } from "@/state/store";
import { chatKey, dock, placeIn, useDockState } from "@/lib/dock";
import { t } from "@/lib/i18n";
import { FilesPanel } from "./FilesPanel";
import { DockedBrowser, refreshBrowserState } from "@/components/browser/BrowserPanel";
import { ChangesPanel, useLaneChanges } from "./ChangesPanel";
import { TasksPanel, useBackgroundTasks } from "./TasksPanel";
import type { DockWindowPanel } from "@/lib/dockWindow";

const TITLES = { docs: "dock.docs.label", changes: "dock.changes.label", tasks: "dock.tasks.label", browser: "dock.browser.label" } as const;

export function DockWindow({ panel, botId, laneId }: { panel: DockWindowPanel; botId: string; laneId: string }) {
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  // a new look at the changes every few seconds, standing in for the
  // events the main window hears
  const [round, setRound] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setRound((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    api("/api/bots?messages=0")
      .then((r: { bots?: Array<{ id: string; name: string; archivedAt?: number }> }) => {
        const bot = r.bots?.find((b) => b.id === botId && !b.archivedAt);
        if (bot) setName(bot.name);
        else setMissing(true);
      })
      .catch(() => setMissing(true));
  }, [botId]);
  useEffect(() => {
    document.title = name ? `${t(TITLES[panel])} · ${name}` : t(TITLES[panel]);
  }, [name, panel]);

  const key = chatKey(botId, laneId);
  const place = placeIn(useDockState(), key);
  const files = useLaneChanges(laneId, String(round), panel === "changes");
  const tasks = useBackgroundTasks(botId);
  useEffect(() => dock.setCurrent(key), [key]);
  // a server's browser sends this window no events: its state is asked
  // for again every moment while the window shows it
  useEffect(() => {
    if (panel !== "browser") return;
    const timer = setInterval(refreshBrowserState, 1_500);
    return () => clearInterval(timer);
  }, [panel]);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* the window's handle, under the traffic lights on a Mac */}
      <div className="titlebar-drag flex h-9 shrink-0 items-center justify-center border-b text-small font-medium text-muted-foreground">
        {name ? `${t(TITLES[panel])} · ${name}` : t(TITLES[panel])}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {missing ? (
          <div className="m-auto max-w-sm px-6 text-center text-body text-muted-foreground">{t("terminalWindow.thisAgentIsNotHere")}</div>
        ) : !name ? null : panel === "docs" ? (
          <FilesPanel placeKey={key} place={place} shown botId={botId} />
        ) : panel === "browser" ? (
          // the browser with its own tabs, the page laid over this window
          // in the desktop app (electron/dock-window.mjs)
          <DockedBrowser shown agent={{ id: botId, name }} />
        ) : panel === "changes" ? (
          <ChangesPanel placeKey={key} threadId={laneId} files={files} shown />
        ) : (
          <TasksPanel
            tasks={tasks}
            agentName={name}
            onShowTab={() => {}}
            onStopTab={(id) => void api(`/api/bots/${botId}/terminals/${id}`, { method: "DELETE" }).catch(() => {})}
            onOpenUrl={null}
            onOpenJob={() => {}}
          />
        )}
      </div>
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
