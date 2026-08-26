import { useEffect, useState } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import { StoreProvider, useStore } from "@/state/store";
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
import { ActivityPanel } from "@/components/Activity";
import { CommandPalette } from "@/components/CommandPalette";
import { QuickAsk } from "@/components/QuickAsk";

function Shell() {
  const { state, dispatch } = useStore();
  const room = state.bloks.find((b) => b.id === state.selectedId);
  const bot = room ? null : (state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0]);

  // The Dock badge mirrors the sidebar's unread dots. Absent bridge
  // means a browser tab, which has no Dock to speak of.
  const waiting = unreadCount(state.bots);
  useEffect(() => {
    window.bloks?.badgeSet?.(waiting);
  }, [waiting]);
  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden md:flex-row">
      <Sidebar />
      {/* Automations lives beside the sidebar like any other view, so
          opening it never hides the agent list. */}
      {state.routinesOpen ? (
        <AutomationsPanel onClose={() => dispatch({ type: "toggleRoutines", open: false })} />
      ) : room ? (
        <RoomView blok={room} />
      ) : bot ? (
        <ChatView bot={bot} />
      ) : (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
          <div className="text-[14px]">
            {state.connected ? "No agents yet" : "Connecting to the Bloks server…"}
          </div>
          {!state.connected && (
            <div className="text-[12px]">
              Start it with <code className="rounded bg-muted px-1.5 py-0.5">pnpm dev:server</code>
            </div>
          )}
        </main>
      )}
      {state.settingsOpen && bot && <SettingsPanel bot={bot} />}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      {state.appSettingsOpen && <AppSettingsPanel />}
      {state.pluginsOpen && <PluginsPanel />}
      {state.skillsOpen && <SkillsPanel />}
      {state.newRoomOpen && <NewRoomDialog />}
      {state.newAgentOpen && <NewAgentScreen />}
      {state.projectsOpen && <ProjectsPanel />}
      {state.activityOpen && <ActivityPanel />}
      <CommandPalette />
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
    <StoreProvider>
      <Shell />
      {setupOpen && !introOpen && <Onboarding onDone={() => setSetupOpen(false)} />}
      {introOpen && <Intro onDone={() => setIntroOpen(false)} />}
    </StoreProvider>
  );
}
