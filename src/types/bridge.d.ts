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
}

export interface CuaPermissions {
  available: boolean;
  owner?: "bloks" | "cua-driver";
  accessibility?: boolean;
  screenRecording?: boolean;
  reason?: string;
}

declare global {
  interface Window {
    bloks?: {
      /** One frame of this Mac's screen as a data: URL. Goes through the
       * main process so macOS attributes Screen Recording to the app. */
      screenFrame(): Promise<string | null>;

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
      /** Puts a number on the Dock icon; 0 clears it. */
      badgeSet(count: number): Promise<void>;
      /** The disk path behind a dropped or picked File, or "" when the
       * file has none (a drag out of a browser, for instance). */
      filePath(file: File): string;
      /** The native folder picker; null when the user cancels. */
      pickFolder(): Promise<string | null>;

      /** The installed app's own version string. */
      appVersion(): Promise<string>;
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
      /** Quits and hands over to the installer; only sane on "ready". */
      updateInstall(): Promise<void>;
      onUpdateState(handler: (state: UpdateState) => void): () => void;
      /** Registers the system-wide hotkey, or clears it with null.
       * Answers with what actually took: another app may own the keys. */
      shortcutApply(accelerator: string | null): Promise<string | null>;
      quickHide(): Promise<void>;
      quickOpenMain(): Promise<void>;
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
