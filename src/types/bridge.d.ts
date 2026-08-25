// The desktop bridge.
//
// Everything the renderer can reach outside the browser sandbox is on this
// one object, and it is absent when the same UI runs in a plain browser
// tab. That absence is load-bearing: features that need the desktop shell
// check for it and degrade rather than throwing, which is why `pnpm dev`
// in a browser is still a usable way to work on the app.
export {};

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
      }): Promise<void>;
      onNotifyActivate(handler: (payload: { target: string }) => void): () => void;
      /** Puts a number on the Dock icon; 0 clears it. */
      badgeSet(count: number): Promise<void>;
      /** The disk path behind a dropped or picked File, or "" when the
       * file has none (a drag out of a browser, for instance). */
      filePath(file: File): string;
      /** Registers the system-wide hotkey, or clears it with null.
       * Answers with what actually took: another app may own the keys. */
      shortcutApply(accelerator: string | null): Promise<string | null>;
      quickHide(): Promise<void>;
      quickOpenMain(): Promise<void>;
      onQuickOpened(handler: () => void): () => void;
      permStatus(): Promise<{ mic: string; screen: string }>;
      /** Shows the real microphone prompt; true once granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens the matching System Settings privacy pane. macOS never
       * re-prompts once denied, so this is the only route back. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Attempts a capture so macOS registers the app in the Screen
       * Recording pane, which is a precondition for it appearing there. */
      permRequestScreen(): Promise<string>;
    };
  }
}
