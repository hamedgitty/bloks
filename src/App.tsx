import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import { StoreProvider, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Onboarding } from "@/components/Onboarding";
import { Intro, introPending } from "@/components/Intro";
import { initAnalytics, setupDone, workspaceSetupDone } from "@/lib/analytics";
import { unreadCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { ChatView } from "@/components/ChatView";
import { NewAgentScreen } from "@/components/NewAgentScreen";
import { SettingsPanel } from "@/components/SettingsPanel";
import { PluginsPanel } from "@/components/PluginsPanel";
import { SkillsPanel } from "@/components/SkillsPanel";
import { RoomView } from "@/components/RoomView";
import { NewRoomDialog } from "@/components/NewRoomDialog";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AutomationsPanel } from "@/components/AutomationsPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
import { ProjectsPanel } from "@/components/ProjectsPanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { BriefPanel } from "./components/BriefPanel";
import { RehearsalsPanel } from "./components/RehearsalsPanel";
import { ActivityPanel } from "@/components/Activity";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutKeys } from "@/components/Shortcuts";
import { Switcher } from "@/components/Switcher";
import { QuickAsk } from "@/components/QuickAsk";

/**
 * Whatever last went wrong, said over every view. It used to be drawn by
 * the chat alone, so a room send, an engine connect in Settings or a
 * room rename that failed said nothing at all while a room or Settings
 * was open. One timer, for the error on screen: a newer error restarts
 * it rather than going early with the old one's.
 */
function ErrorNotice() {
  const { state, dispatch } = useStore();
  const { error, errorAt } = state;
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => dispatch({ type: "error", message: null, at: errorAt }), 6000);
    return () => clearTimeout(timer);
  }, [error, errorAt, dispatch]);
  if (!error) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[60px] z-[70] flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto max-w-[560px] animate-rise-in rounded-xl border border-destructive/30 bg-popover px-3.5 py-2 text-[13px] text-destructive shadow-lg shadow-(color:--shadow-color)"
      >
        {error}
      </div>
    </div>
  );
}

function Shell() {
  const { state, dispatch } = useStore();
  const room = state.bloks.find((b) => b.id === state.selectedId);
  const bot = room
    ? null
    : (state.bots.find((b) => b.id === state.selectedId && !b.hidden) ??
      state.bots.find((b) => !b.hidden) ??
      null);

  // The Dock badge mirrors the sidebar's unread dots. Absent bridge
  // means a browser tab, which has no Dock to speak of.
  const waiting = unreadCount(state.bots);
  useEffect(() => {
    window.bloks?.badgeSet?.(waiting);
  }, [waiting]);
  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden md:flex-row">
      <Sidebar />
      {/* Settings and Automations live beside the sidebar like any other
          view, so opening one never hides the agent list. */}
      {state.appSettingsOpen ? (
        <AppSettingsPanel />
      ) : state.routinesOpen ? (
        <AutomationsPanel onClose={() => dispatch({ type: "toggleRoutines", open: false })} />
      ) : room ? (
        <RoomView key={room.id} blok={room} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          {state.connected && state.hydrated ? (
            // loaded, and truly empty: the next step, not a spinner that
            // never stops
            <>
              <div className="text-[15px] font-medium text-foreground">No agents yet</div>
              <div className="max-w-[300px] text-center text-[13px] leading-relaxed">
                An agent is someone with a job: a researcher, a writer, a chief of staff. Make your first one.
              </div>
              <Button onClick={() => dispatch({ type: "toggleNewAgent", open: true })}>New agent</Button>
            </>
          ) : (
            <>
              <Loader2 size={20} className="animate-spin" />
              <div className="text-[14px]">{state.connected ? "Loading your agents…" : "Connecting to Bloks…"}</div>
              {/* a developer hint; someone who installed the app has no
                  command to run and should not be told one */}
              {!state.connected && import.meta.env.DEV && (
                <div className="text-[12px]">
                  Start it with <code className="rounded bg-muted px-1.5 py-0.5">pnpm dev:server</code>
                </div>
              )}
            </>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.pluginsOpen && <PluginsPanel />}
      {state.skillsOpen && <SkillsPanel />}
      {state.newRoomOpen && <NewRoomDialog />}
      {state.newAgentOpen && <NewAgentScreen />}
      {state.projectsOpen && <ProjectsPanel />}
      {state.memoryOpen && <MemoryPanel />}
      {state.rehearsalsOpen && <RehearsalsPanel />}
      {state.briefOpen && <BriefPanel />}
      {state.activityOpen && <ActivityPanel />}
      <CommandPalette />
      <ShortcutKeys />
      <ErrorNotice />
      {/* what is on screen, for Ctrl+Tab to come back to: a room, or one
          of an agent's conversations */}
      <Switcher
        shown={room ? { id: room.id } : bot ? { id: bot.id, lane: bot.activeTaskId ?? bot.threadId } : null}
      />
    </div>
  );
}

export default function App() {
  // The panel window loads the same bundle with a flag. It shares nothing
  // else with the workspace: no store, no stream, no intro, because it is
  // open for four seconds at a time.
  if (new URLSearchParams(location.search).has("quick")) return <QuickAsk />;

  // First launch runs the cinematic intro, then the working onboarding.
  // Two separate flags on purpose: someone who skips the intro still needs
  // setup, and someone who resets setup should not sit through the film
  // twice.
  const forced = new URLSearchParams(location.search).has("intro");
  const [introOpen, setIntroOpen] = useState(
    // never replay the film for a workspace that finished setup before the
    // intro existed; ?intro forces a showing for design review
    () => (introPending() && !setupDone()) || forced,
  );
  const [setupOpen, setSetupOpen] = useState(() => !setupDone());
  // Until the workspace answers, showing the dashboard would be a guess,
  // and a wrong guess flashes the whole app for a moment before the
  // welcome covers it. A workspace that has clearly never been set up
  // needs no wait; everyone else holds on the app's own background for
  // the few milliseconds a loopback request takes.
  const [settled, setSettled] = useState(() => introPending() && !setupDone());
  useEffect(() => {
    initAnalytics();
    // The browser's flag is only a first guess: it is per origin, and the
    // app's origin moves with its port. The workspace itself is the
    // authority, so correct course as soon as it answers. A workspace that
    // has been set up closes both; one that has not opens them, which is
    // what makes a fresh install reliably show the welcome.
    void workspaceSetupDone()
      .then((done) => {
        if (forced) return;
        setIntroOpen(done ? false : introPending());
        setSetupOpen(!done);
      })
      .finally(() => setSettled(true));
  }, [forced]);
  if (!settled) return <div className="h-full bg-background" />;
  return (
    // Reduce motion on the Mac means reduce it here: movement goes, and
    // the opacity that explains a change stays.
    <MotionConfig reducedMotion="user">
      <StoreProvider>
        <Shell />
        {setupOpen && !introOpen && <Onboarding onDone={() => setSetupOpen(false)} />}
        {introOpen && <Intro onDone={() => setIntroOpen(false)} />}
      </StoreProvider>
    </MotionConfig>
  );
}
