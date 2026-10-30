// The desktop bridge.
//
// Everything the renderer can reach outside the browser sandbox is on this
// one object, and it is absent when the same UI runs in a plain browser
// tab. That absence is load-bearing: features that need the desktop shell
// check for it and degrade rather than throwing, which is why `pnpm dev`
// in a browser is still a usable way to work on the app.
export {};

/** What the updater is doing right now, flattened for the About card. */
export interface UpdateState {
  state: "idle" | "checking" | "downloading" | "current" | "ready" | "error" | "dev";
  version?: string;
  percent?: number;
  /** For an error: the network, GitHub's side, or the install itself. */
  reason?: "offline" | "server" | "install";
  /** Set while an install waits for running turns to finish first. */
  draining?: { running: number; deadline?: number };
  /** Set when the last restart into an update came back on the version
   * it left: that version, and the one it was meant to become. */
  notInstalled?: { from: string; to: string | null };
}

export interface CuaPermissions {
  available: boolean;
  owner?: "bloks" | "cua-driver";
  accessibility?: boolean;
  screenRecording?: boolean;
  reason?: string;
}

/** Where the notch is and how big the island's window is
 * (electron/notch.mjs), in points. */
export interface NotchGeometry {
  /** False on a display without one: the island hangs from the top
   * centre of the screen as the same black shape. */
  hasNotch: boolean;
  notchWidth: number;
  /** The menu bar's height: the island's band is the notch's own. */
  menuBar: number;
  /** The island at rest, ears and all. */
  compact: { width: number; height: number };
  /** The clear window it is drawn in. */
  frame: { width: number; height: number };
}

/** A workspace's mark: a colour and nine blocks, row by row. */
export interface WorkspaceMarkValue {
  color: string;
  pattern: string;
}

export type WorkspaceKind = "personal" | "business" | "custom" | "joined" | "hosted";
export type WorkspaceNotify = "all" | "needs-me" | "nothing";

/** One workspace as the main process tells the window about it
 * (electron/workspaces.mjs snapshot). */
export interface WorkspaceInfo {
  id: string;
  kind: WorkspaceKind;
  name: string;
  team: boolean;
  /** The mark it is drawn with here: for a joined one, yours when you
   * chose one, else its owner's. */
  mark: WorkspaceMarkValue | null;
  /** What "Back to default" goes back to: Personal's or Business's own,
   * or a joined workspace's owner's; null for a drawn one. Absent from an
   * older app. */
  markDefault?: WorkspaceMarkValue | null;
  /** An uploaded logo, as a data URL, drawn instead of the mark. */
  logo: string | null;
  /** How many people, once the Members page has said; null until then. */
  members: number | null;
  status: "starting" | "running" | "failed" | "stopped";
  /** Why it will not start, when it will not. */
  problem: string | null;
  /** Conversations with something waiting. */
  waiting: number;
  notify: WorkspaceNotify;
  mute: { muted: boolean; until: number | "forever" | null };
  dataDir: string | null;
  /** For a joined workspace: whose computer it is on. */
  host?: string;
  /** For a joined workspace: what you are there. */
  role?: "member" | "admin";
  /** For a joined workspace reached only on its owner's own network. */
  lanOnly?: boolean;
  /** Your own hosted workspace: on a machine run for you, reached through
   * Bloks Cloud. */
  remote?: boolean;
  /** A copy whose work moved to the workspace with this id, kept here,
   * paused, until it is removed (electron/hosting-move.mjs). */
  movedTo?: string;
}

export type HostingMoveStep = "pairing" | "packing" | "sending" | "unpacking" | "checking" | "done";
export type HostingMovePhase = "waiting" | "running" | "stopped" | "later" | "failed" | "done";

/** A key or connection a move left behind, with the Settings page it is
 * entered on again (server/workspace-move.ts KeyToEnter). */
export interface HostingMoveKey {
  label: string;
  page: string;
  path: string;
}

export interface HostingMoveCounts {
  agents: number;
  conversations: number;
  rooms: number;
  routines: number;
  watchers: number;
  workflows: number;
  memoryFiles: number;
}

/** One move, as the main process tells the window about it. */
export interface HostingMove {
  id: string;
  direction: "to-hosted" | "to-mac";
  auto: boolean;
  from: { id: string; name: string };
  to: { id: string | null; name: string };
  replace: boolean;
  phase: HostingMovePhase;
  step: HostingMoveStep;
  startsAt: number | null;
  sent: number;
  size: number;
  error: string | null;
  code: string | null;
  keys: HostingMoveKey[] | null;
  doneAt: number | null;
  announced: boolean;
  stoppable: boolean;
  starting: string;
  done: string | null;
}

export interface HostingMoveState {
  available: boolean;
  /** The account says the hosted machine is running. */
  hostingActive: boolean;
  /** The plan includes Bloks AI. */
  bloksAi: boolean;
  /** This licence moved a workspace to Hosting already. */
  licenceMoved: boolean;
  move: HostingMove | null;
  hosted: Array<{ id: string; name: string }>;
  copies: Array<{ id: string; name: string; kind: WorkspaceKind; to: string }>;
}

export interface HostingMoveTarget {
  id: string;
  name: string;
  kind: WorkspaceKind;
  /** Null while its server has not said. */
  empty: boolean | null;
  /** A copy a workspace's work was moved out of. */
  copy: boolean;
}

export type WorkspacesState =
  | { available: false }
  | {
      available: true;
      current: string;
      workspaces: WorkspaceInfo[];
      /** The licence's plan, kept by the app for every workspace here
       * (electron/account-plan.mjs): absent until a server has said,
       * null for no licence. */
      plan?: "cloud" | "team" | null;
      /** "Same accent in every workspace". */
      sameAccent?: boolean;
      /** "Show working agents in the notch"; absent off macOS, where
       * there is no notch to show them in. */
      notch?: boolean;
      /** "Close to the tray"; absent off Windows (electron/tray.mjs). */
      tray?: boolean;
      /** What the person is called in their own workspaces, once they
       * have said; null until then. Absent from an older app. */
      ownerName?: string | null;
    };

/** What a workspace action answers: done, or why not, in words to show. */
export type WorkspaceAnswer = { ok?: boolean; id?: string; error?: string; code?: string };

declare global {
  interface Window {
    /** Set when this UI runs at bloks.dev/web rather than in the app:
     * which computer it reaches, and a way to disconnect this browser. */
    bloksWeb?: {
      readonly host: string;
      forget(): Promise<void>;
    };
    bloks?: {
      /** One frame of this Mac's screen as a data: URL. Goes through the
       * main process so macOS attributes Screen Recording to the app. */
      screenFrame(): Promise<string | null>;

      /** Which workspace this page is, said before the page drew; null
       * outside one (a development run, a Bloks on another computer). */
      workspace?: { id: string; kind: WorkspaceKind; name: string; mark: WorkspaceMarkValue | null } | null;
      /** The workspaces on this computer (electron/workspaces.mjs). */
      workspacesState?(): Promise<WorkspacesState>;
      onWorkspaces?(handler: (state: WorkspacesState) => void): () => void;
      /** With `open: "join"`, the workspace opens on the join dialog. */
      workspaceSwitch?(id: string, options?: { open?: "join" }): Promise<WorkspaceAnswer>;
      /** Leaves a joined workspace: tells its owner, forgets its
       * credentials and its place in the list. `force` forgets it here
       * even when the owner's computer cannot be told. */
      workspaceLeave?(id: string, options?: { force?: boolean }): Promise<WorkspaceAnswer & { told?: boolean; unreachable?: boolean }>;
      /** What you are in the joined workspace this page shows. */
      workspaceRole?(role: "member" | "admin"): Promise<void>;
      /** What the owner of the joined workspace this page shows is called. */
      workspaceHost?(name: string): Promise<void>;
      workspaceCreate?(input: {
        kind: "business" | "custom";
        name: string;
        team: boolean;
        mark: WorkspaceMarkValue | null;
        /** Your name, asked for as a Team workspace is made. */
        ownerName?: string;
      }): Promise<WorkspaceAnswer>;
      workspaceUpdate?(
        id: string,
        /** `mark: null` goes back to the default, where there is one. */
        patch: Partial<{ name: string; kind: "business" | "custom"; team: boolean; notify: WorkspaceNotify; mark: WorkspaceMarkValue | null }>,
      ): Promise<WorkspaceAnswer>;
      workspaceReroll?(id: string): Promise<WorkspaceAnswer>;
      /** One of 15m, 1h, 3h, 8h, 24h, forever, or "off". */
      workspaceMute?(id: string, choice: string): Promise<WorkspaceAnswer>;
      workspaceRetry?(id: string): Promise<WorkspaceAnswer>;
      workspaceReorder?(ids: string[]): Promise<WorkspaceAnswer>;
      /** Moves its folder to the Trash; never Personal. */
      workspaceDelete?(id: string): Promise<WorkspaceAnswer>;
      workspaceLogoPick?(id: string): Promise<WorkspaceAnswer>;
      workspaceLogoClear?(id: string): Promise<WorkspaceAnswer>;
      /** How many people this workspace has, for the switcher's count. */
      workspaceMembers?(count: number): Promise<void>;
      /** Keeps a joined workspace's credentials and lists it; with `open`,
       * switches to it. */
      workspaceJoined?(input: {
        profile: { relayUrl: string | null; relayToken: string | null; deviceId: string; deviceToken: string; lan?: string | null };
        role?: "member" | "admin";
        name: string;
        mark: WorkspaceMarkValue | null;
        host?: string;
        open: boolean;
      }): Promise<WorkspaceAnswer>;
      /** Spends a pairing link to your own hosted workspace (asked for on
       * the Plan page) as a device of yours, and lists it, or points the
       * one listed at it; with `open`, switches to it. */
      workspaceHosted?(input: { link: string; open?: boolean }): Promise<WorkspaceAnswer>;
      /** Moving a workspace to the hosted machine and back. */
      hostingMoveState?(): Promise<HostingMoveState>;
      onHostingMove?(handler: (state: HostingMoveState) => void): () => void;
      /** `to` names a workspace here for a move home, with `replace` when
       * it is the copy the work came from; none makes a new one. */
      hostingMoveStart?(input: { direction: "to-hosted" | "to-mac"; from: string; to?: string | null; replace?: boolean; name?: string }): Promise<WorkspaceAnswer>;
      hostingMoveChange?(id: string): Promise<WorkspaceAnswer>;
      hostingMoveStop?(how: "stop" | "later"): Promise<WorkspaceAnswer>;
      hostingMoveResume?(): Promise<WorkspaceAnswer>;
      hostingMoveDismiss?(): Promise<WorkspaceAnswer>;
      hostingMoveAnnounced?(): Promise<void>;
      hostingMoveOpenSettings?(page: string): Promise<WorkspaceAnswer>;
      hostingMoveRemoveCopy?(id: string): Promise<WorkspaceAnswer>;
      hostingMoveTargets?(): Promise<{ targets: HostingMoveTarget[] }>;
      /** What a move out of that workspace carries and leaves behind. */
      hostingMovePreview?(id: string): Promise<WorkspaceAnswer & { counts?: HostingMoveCounts | null; keys?: HostingMoveKey[] }>;
      /** The theme is the person's, kept across every workspace. */
      prefsTheme?(theme: "light" | "dark" | "system"): Promise<void>;
      /** The language is the person's too ("system" or a language's code);
       * the menu bar is rebuilt in it. */
      prefsLanguage?(language: string): Promise<void>;
      /** A language chosen in another workspace's window. */
      onLanguage?(handler: (language: string) => void): () => void;
      /** The accent is this workspace's own. */
      prefsAccent?(accent: string): Promise<void>;
      /** Turns the one accent for every workspace on or off; answers the
       * accent this window should draw in now. */
      prefsSameAccent?(on: boolean, showing: string): Promise<string | null>;
      /** What a banner clicked before this page loaded was about. */
      pendingNotifyTarget?(): Promise<string | null>;
      /** Shows the working agents in the notch, or takes the island away. */
      prefsNotch?(on: boolean): Promise<void>;
      /** Turns "Close to the tray" on or off (Windows). */
      prefsTray?(on: boolean): Promise<void>;
      /** The island's page: the pointer is over the island, or has left
       * it, so its window takes the mouse or lets it through. */
      notchHover?(over: boolean): Promise<void>;
      /** Brings the app forward on that conversation. */
      notchOpen?(target: { botId: string; taskId: string }): Promise<void>;
      notchGeometry?(): Promise<NotchGeometry | null>;
      onNotchGeometry?(handler: (geometry: NotchGeometry) => void): () => void;

      /** Dictation, handled by a native helper rather than the web speech
       * APIs, which are not available offline. */
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string; level?: number }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;

      /** Current mic and screen permission: granted, denied, not-determined
       * or unknown. */
      notifyShow(notice: {
        title: string;
        body: string;
        target: string;
        urgent: boolean;
        avatar?: string;
      }): Promise<void>;
      onNotifyActivate(handler: (payload: { target: string }) => void): () => void;
      /** Meeting notes: long-running on-device transcription. */
      meetingStart?(options: { system: boolean }): Promise<void>;
      meetingStop?(): Promise<void>;
      onMeetingLine?(
        handler: (line: { segment?: string; partial?: boolean; text?: string; who?: "you" | "them"; level?: number; notice?: string; error?: string }) => void,
      ): () => void;
      onMeetingEnd?(handler: (payload: { code: number }) => void): () => void;
      /** bloks:// links from the website (electron/main.mjs). */
      onLink?(handler: (link: { kind: "team"; slug: string } | { kind: "join"; fragment: string } | { kind: "plan" } | { kind: "install"; url: string }) => void): () => void;
      pendingLink?(): Promise<{ kind: "team"; slug: string } | { kind: "join"; fragment: string } | { kind: "plan" } | { kind: "install"; url: string } | null>;
      /** Opens one of bloks.dev's offers in the browser, the licence added
       * in the fragment by the main process for bloks.dev alone; false for
       * a link it will not open. */
      planOpen?(url: string): Promise<boolean>;
      /** Copies the licence the app keeps; false when it keeps none. */
      licenceCopy?(): Promise<boolean>;
      /** The system share sheet for a workspace invite's link; false where
       * there is none, and the caller copies instead. */
      shareLink?(url: string): Promise<boolean>;
      /** A choice from the macOS menu bar for this window to carry out
       * (electron/app-menu.mjs), and one made while no window was
       * listening yet. The conversation ones are played to the page as
       * their keys (src/lib/conversationKeys.ts) and never wait. */
      onMenuCommand?(
        handler: (
          command:
            | "settings"
            | "shortcuts"
            | "newConversation"
            | "closeConversation"
            | "previousConversation"
            | "nextConversation",
        ) => void,
      ): () => void;
      pendingMenuCommand?(): Promise<"settings" | "shortcuts" | null>;
      /** Puts a number on the Dock icon; 0 clears it. */
      badgeSet(count: number): Promise<void>;
      /** A line for the app's own log, in the app's logs folder; an
       * older app has no such bridge. */
      appLog?(text: string): Promise<void>;
      /** The disk path behind a dropped or picked File, or "" when the
       * file has none (a drag out of a browser, for instance). */
      filePath(file: File): string;
      /** A HEIC photo's bytes as a JPEG's, made by macOS, which the page
       * cannot do itself; null off macOS or for bytes that are not one.
       * An older app has no such bridge. */
      heicAsJpeg?(bytes: Uint8Array): Promise<Uint8Array | null>;
      /** The native folder picker; null when the user cancels. */
      pickFolder(): Promise<string | null>;

      /** The installed app's own version string. */
      appVersion(): Promise<string>;
      /** The window's native state for a settings inspection, read only
       * when one asks (electron/settings-observation.mjs). */
      settingsObservation?(): Promise<unknown>;
      /** Whether this app runs its own Bloks or uses one on another
       * computer through Bloks Cloud (electron/remote.mjs). */
      remoteStatus?(): Promise<{ mode: "local" } | { mode: "remote"; host: string; connected: boolean; revoked?: boolean }>;
      /** Pairs with another computer from a bloks-server pairing link, then restarts the app. */
      remoteConnect?(link: string): Promise<{ ok?: boolean; error?: string }>;
      /** Back to this computer's own Bloks, then restarts the app. */
      remoteDisconnect?(): Promise<{ ok: boolean }>;
      onRemoteState?(callback: (state: { host: string; connected: boolean; revoked?: boolean }) => void): () => void;
      /** One frame of updater state: idle, checking, downloading (with
       * percent), current, ready (with version), error, or dev. */
      /** Quit and start again. For settings that only apply at start. */
      relaunch?(): Promise<void>;
      updateState(): Promise<UpdateState>;
      updateCheck(): Promise<UpdateState>;
      /** Quits and hands over to the installer; only sane on "ready".
       * Answers only when the wait for running turns is called off: a
       * restart that goes ahead ends the app before it can. */
      updateInstall(): Promise<unknown>;
      /** While an install waits for running turns: stop waiting and
       * install, or call the wait off and update later. */
      updateRestartNow?(): Promise<void>;
      updateLater?(): Promise<void>;
      /** The card saying an update did not install has been closed. */
      updateNotInstalledSeen?(): Promise<void>;
      onUpdateState(handler: (state: UpdateState) => void): () => void;
      /** Registers the system-wide hotkey, or clears it with null.
       * Answers with what actually took: another app may own the keys. */
      shortcutApply(accelerator: string | null): Promise<string | null>;
      quickHide(): Promise<void>;
      quickOpenMain(): Promise<void>;
      /** An agent's terminal in a window of its own, or the one already
       * open brought forward. Absent in an app older than tabs. */
      terminalWindow?(botId: string): Promise<void>;
      /** The Bloks browser beside the chat (electron/app-browser.mjs):
       * what it shows, where its panel is (null when off screen, and the
       * tab hides), what the person does in it, and the app asking for
       * the panel when an agent starts browsing. Absent in an older app. */
      browserState?(): Promise<import("../lib/appBrowser").AppBrowserState | null>;
      browserBounds?(rect: { x: number; y: number; width: number; height: number } | null): Promise<import("../lib/appBrowser").AppBrowserState | null>;
      browserDo?(action: import("../lib/appBrowser").BrowserDo, arg?: string): Promise<{ ok?: boolean; error?: string; url?: string }>;
      onBrowserState?(handler: (state: import("../lib/appBrowser").AppBrowserState) => void): () => void;
      onBrowserReveal?(handler: (payload: { by?: string }) => void): () => void;
      onQuickOpened(handler: () => void): () => void;
      /** Whether this Mac can prove who is at the keyboard: "biometry",
       * "password", or "unavailable". */
      authStatus(): Promise<"biometry" | "password" | "unavailable">;
      /** Raises the Touch ID prompt. "granted", "denied", "cancelled",
       * or "unavailable" when the Mac cannot ask at all. */
      authConfirm(
        reason: string,
      ): Promise<"granted" | "denied" | "cancelled" | "unavailable">;

      permStatus(): Promise<{ mic: string; screen: string }>;
      /** Shows the real microphone prompt; true once granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens the matching System Settings privacy pane. macOS never
       * re-prompts once denied, so this is the only route back. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Attempts a capture so macOS registers the app in the Screen
       * Recording pane, which is a precondition for it appearing there. */
      permRequestScreen(): Promise<string>;
      /** Computer use's two grants, read for Bloks itself when it runs the
       * driver ("bloks"), or for a separately installed CuaDriver. */
      cuaPermissions?(): Promise<CuaPermissions>;
      /** Asks macOS for both on Bloks' behalf, then reports again. */
      cuaRequestPermissions?(): Promise<CuaPermissions>;
    };
  }
}
