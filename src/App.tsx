import { useEffect, useRef, useState } from "react";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import { Loader2 } from "@/components/icons";
import { StoreProvider, api, useStore } from "@/state/store";
import { usePresenceReport } from "@/lib/presence";
import { Button } from "@/components/ui/button";
import { Onboarding } from "@/components/Onboarding";
import { WorkspaceWelcome } from "@/components/WorkspaceWelcome";
import { welcomeKind } from "@/lib/workspaceWelcome";
import { INTRO_KEY, Intro, introPending } from "@/components/Intro";
import { initAnalytics, setupDone, workspaceSetupDone } from "@/lib/analytics";
import { unreadCount } from "@/lib/unread";
import { Sidebar } from "@/components/Sidebar";
import { AppRail } from "@/components/AppRail";
import { RailPageView } from "@/components/RailPages";
import { TitleBar } from "@/components/TitleBar";
import { MobileNav } from "@/components/MobileNav";
import { ChatView } from "@/components/ChatView";
import { NewAgentScreen } from "@/components/NewAgentScreen";
import { AgentSettingsPage } from "@/components/SettingsPanel";
import { RoomView } from "@/components/RoomView";
import { NewRoomDialog } from "@/components/NewRoomDialog";
import { ComputerPanel } from "@/components/ComputerPanel";
import { AutomationsPanel } from "@/components/AutomationsPanel";
import { AppSettingsPanel } from "@/components/AppSettingsPanel";
import { WorkspaceDialogs } from "@/components/WorkspaceDialogs";
import { CommandPalette } from "@/components/CommandPalette";
import { ShortcutKeys } from "@/components/Shortcuts";
import { Switcher } from "@/components/Switcher";
import { QuickAsk } from "@/components/QuickAsk";
import { NotchIsland } from "@/components/notch/NotchIsland";
import { TraceDemo } from "@/components/trace/TraceDemo";
import { Toaster, toast } from "@/components/ui/toast";
import { ConfirmHost } from "@/components/ui/confirm";
import { YourNameHost } from "@/components/YourNameDialog";
import { TerminalWindow, terminalWindowAgent } from "@/components/terminal/TerminalWindow";
import { MemberApp } from "@/components/member/MemberApp";
import { detectMode, type AppMode } from "@/lib/memberMode";
import { openWorkspaceDialog } from "@/lib/workspaces";
import { WakingStrip } from "@/components/WakingStrip";
import { HostingMoveToasts } from "@/components/hosting/HostingMoveToasts";
import { MovedBanner } from "@/components/hosting/MovedBanner";
import { t, tr } from "@/lib/i18n";

/**
 * Whatever went wrong, said over every view as an error toast. It used to
 * be drawn by the chat alone, so a room send, an engine connect in
 * Settings or a room rename that failed said nothing at all while a room
 * or Settings was open.
 *
 * Each error is its own toast, so a second failure no longer pushes the
 * first off the screen before it was read; the same words again only
 * restart the one already showing. The store keeps the error until its
 * toast goes, and the clear names that error (errorAt), so an older
 * toast leaving cannot take a newer error with it.
 */
function ErrorToasts() {
  const { state, dispatch } = useStore();
  const { error, errorAt } = state;
  useEffect(() => {
    if (!error) return;
    toast.error(error, {
      id: `error:${error}`,
      onDismiss: () => dispatch({ type: "error", message: null, at: errorAt }),
    });
  }, [error, errorAt, dispatch]);
  return null;
}

/**
 * The work panel's content, under a key that changes only when the place
 * does (a rail page, Settings, Automations, a room, the chat), so moving
 * between places fades the new one in over 150ms instead of cutting to
 * it. Opacity only: nothing moves, and the page takes clicks from its
 * first frame, so the fade never costs a wait.
 *
 * Not every change is a move worth marking. Picking another agent keeps
 * the key, so the chat does not blink on every pick; a move close on the
 * heels of the last one, which is somebody stepping through places from
 * the keyboard, lands at once; and reduce motion means no fade at all.
 */
function PlaceFade({ place, children }: { place: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  const last = useRef({ place, at: 0, fade: false });
  if (last.current.place !== place) {
    const now = performance.now();
    last.current = { place, at: now, fade: now - last.current.at > 350 };
  }
  const fade = last.current.fade && !reduce;
  return (
    <motion.div
      key={place}
      initial={fade ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col md:flex-row"
    >
      {children}
    </motion.div>
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
  // The main rail is always there (beside a phone-narrow window's header
  // there is no room for it, and that header carries the same doors);
  // the chat's own sidebar only while Chat is the place.
  // An agent's settings are a page like the others, in the panel where
  // its chat was, so they have the panel to themselves.
  const agentSettings = state.settingsOpen && bot !== null && !room;
  const chatPlace = !state.appSettingsOpen && !state.routinesOpen && !state.page && !agentSettings;
  // the workspace's own pages are Settings pages like the rest, in the
  // same shell, so moving between them is not a change of place
  const place = state.appSettingsOpen
    ? "settings"
    : state.routinesOpen
      ? "automations"
      : state.page
        ? `page:${state.page}`
        : agentSettings
          ? "agent-settings"
          : room
            ? "room"
            : "chat";
  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-sidebar">
      <TitleBar />
      <MobileNav />
      {/* your hosted workspace waking up, said once for the whole window */}
      <WakingStrip />
      {/* this copy's work moved to another machine, and what to do about it */}
      <MovedBanner />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <div className="hidden h-full md:flex">
        <AppRail />
      </div>
      {/* Everything beside the rail sits on one panel, set in from the
          window's top with a rounded corner, so the rail reads as the
          frame and the panel as the work. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:flex-row md:rounded-tl-xl md:border-l md:border-t">
      {chatPlace ? <Sidebar /> : <div className="md:hidden"><Sidebar /></div>}
      <PlaceFade place={place}>
      {state.appSettingsOpen ? (
        <AppSettingsPanel />
      ) : state.routinesOpen ? (
        <AutomationsPanel onClose={() => dispatch({ type: "toggleRoutines", open: false })} />
      ) : state.page ? (
        <RailPageView page={state.page} />
      ) : agentSettings && bot ? (
        <AgentSettingsPage key={bot.id} bot={bot} />
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
              <div className="text-lead font-medium text-foreground">{t("app.noAgentsYet")}</div>
              <div className="max-w-[300px] text-center text-body leading-relaxed">
                {t("app.anAgentHasAJob")}
              </div>
              <Button onClick={() => dispatch({ type: "toggleNewAgent", open: true })}>{t("app.newAgent")}</Button>
            </>
          ) : (
            <>
              <Loader2 size={20} className="animate-spin" />
              <div className="text-ui">{state.connected ? t("app.loadingYourAgents") : t("app.connectingToBloks")}</div>
              {/* a developer hint; someone who installed the app has no
                  command to run and should not be told one */}
              {!state.connected && import.meta.env.DEV && (
                <div className="text-small">
                  {tr("app.startWith", { command: <code className="rounded bg-muted px-1.5 py-0.5">pnpm dev:server</code> })}
                </div>
              )}
            </>
          )}
        </main>
      )}
      </PlaceFade>
      {/* In the panel's row, to the right of the work. Left outside it,
          as a child of the window's column, it took the full height and
          squeezed the chat and the sidebar to nothing. */}
      {state.computerOpen && bot && <ComputerPanel bot={bot} />}
      </div>
      </div>
      {state.newRoomOpen && <NewRoomDialog />}
      {state.newAgentOpen && <NewAgentScreen />}
      <CommandPalette />
      <WorkspaceDialogs />
      <ShortcutKeys />
      <ErrorToasts />
      {/* what is on screen, for Ctrl+Tab to come back to: a room, or one
          of an agent's conversations */}
      <Switcher
        shown={room ? { id: room.id } : bot ? { id: bot.id, lane: bot.activeTaskId ?? bot.threadId } : null}
      />
    </div>
  );
}

/**
 * The film is for a person's first Bloks, not for each workspace they
 * make: a workspace other than Personal, or one just made, opens on the
 * working welcome alone. Its storage is its own origin's, so without this
 * every new workspace would start the film again.
 */
function skipFilmForWorkspace() {
  const ws = window.bloks?.workspace;
  const made = new URLSearchParams(location.search).get("welcome") === "workspace";
  if (!made && (!ws || ws.kind === "personal")) return;
  try {
    if (!localStorage.getItem(INTRO_KEY)) localStorage.setItem(INTRO_KEY, String(Date.now()));
  } catch {
    /* storage refused: the film shows, which is only a film */
  }
}

export default function App() {
  // The panel window loads the same bundle with a flag. It shares nothing
  // else with the workspace: no store, no stream, no intro, because it is
  // open for four seconds at a time.
  const asked = new URLSearchParams(location.search);
  if (asked.has("quick")) return <QuickAsk />;
  // So does an agent's terminal popped out into a window of its own.
  const terminalFor = terminalWindowAgent(location.search);
  if (terminalFor) return <TerminalWindow botId={terminalFor} />;
  // And the island in the notch, in a clear window over the menu bar,
  // which reads the working agents and nothing else.
  if (asked.has("notch")) return <NotchIsland demo={asked.has("demo")} />;
  // the trace panel with a made-up turn, to look at without an engine
  if (asked.get("trace") === "demo") return <TraceDemo />;
  return <WhichApp />;
}

/**
 * The owner's app, or a member's. Decided once, as the page loads: a
 * workspace this app runs itself is the owner's without asking; a joined
 * one asks the member routes whether this credential is a member's
 * (src/lib/memberMode.ts), and draws the member's app if so. Until it
 * knows, the window holds on its own background for the moment a
 * loopback request takes.
 */
function WhichApp() {
  const [mode, setMode] = useState<AppMode | null>(null);
  useEffect(() => {
    void detectMode(window.bloks?.workspace?.kind).then(setMode);
  }, []);
  if (!mode) return <div className="h-full bg-background" />;
  if (mode.mode !== "owner") {
    return (
      <MotionConfig reducedMotion="user">
        <MemberApp mode={mode} />
        <ConfirmHost />
        <YourNameHost />
        <Toaster />
      </MotionConfig>
    );
  }
  return <OwnerApp />;
}

function OwnerApp() {
  // First launch runs the cinematic intro, then the working onboarding.
  // Two separate flags on purpose: someone who skips the intro still needs
  // setup, and someone who resets setup should not sit through the film
  // twice.
  const forced = new URLSearchParams(location.search).has("intro");
  if (!forced) skipFilmForWorkspace();
  const [introOpen, setIntroOpen] = useState(
    // never replay the film for a workspace that finished setup before the
    // intro existed; ?intro forces a showing for design review
    () => (introPending() && !setupDone()) || forced,
  );
  const [setupOpen, setSetupOpen] = useState(() => !setupDone());
  // While the person is using Bloks here, their phone stays quiet
  // (src/lib/presence.ts). The owner's app only: a member's phone is theirs.
  usePresenceReport((body) => api("/api/presence", { method: "POST", body: JSON.stringify(body) }));
  // Until the workspace answers, showing the dashboard would be a guess,
  // and a wrong guess flashes the whole app for a moment before the
  // welcome covers it. A workspace that has clearly never been set up
  // needs no wait; everyone else holds on the app's own background for
  // the few milliseconds a loopback request takes.
  const [settled, setSettled] = useState(() => introPending() && !setupDone());
  useEffect(() => {
    // sent here from a joined workspace's switcher to join another one:
    // joining runs on this computer's own server, which this page has
    if (new URLSearchParams(location.search).get("open") === "join") openWorkspaceDialog("join");
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
  // A hosted workspace that is asleep takes its time to answer that first
  // question, and the window says why rather than staying blank. Below the
  // title bar's height, clear of the window's own buttons.
  if (!settled) {
    return (
      <div className="flex h-full flex-col bg-background">
        <WakingStrip className="mt-11" follow />
      </div>
    );
  }
  return (
    // Reduce motion on the Mac means reduce it here: movement goes, and
    // the opacity that explains a change stays.
    <MotionConfig reducedMotion="user">
      <StoreProvider>
        <Shell />
        {/* a workspace made beside Personal gets a welcome about what was
            chosen for it, not the whole first run again */}
        {setupOpen &&
          !introOpen &&
          (welcomeKind(window.bloks?.workspace) === "workspace" ? (
            <WorkspaceWelcome onDone={() => setSetupOpen(false)} />
          ) : (
            <Onboarding onDone={() => setSetupOpen(false)} />
          ))}
        {introOpen && <Intro onDone={() => setIntroOpen(false)} />}
        {/* over everything, the welcome included: a question, or a word
            about what just happened, is never behind what it is about */}
        <ConfirmHost />
        <YourNameHost />
        <HostingMoveToasts />
        <Toaster />
      </StoreProvider>
    </MotionConfig>
  );
}
