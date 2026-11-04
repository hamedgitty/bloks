// The browser inside the Bloks window: what is the desktop app's alone.
//
// Its rules and an agent's commands are shared with the browser a server
// with no app behind it keeps for itself (server/browser-core.mjs), so
// the two can never come to answer the same page differently. What is
// left here is only the app's: the session each workspace browses in,
// and how a tab's page dialogs reach those shared rules. main.mjs owns
// the Electron half, the WebContentsView for each tab and the window it
// sits in.

export * from "../server/browser-core.mjs";

/** Each workspace browses in a session of its own, kept on disk: its
 * cookies and sign-ins are that workspace's, and never the app's. */
export function partitionFor(workspaceId) {
  const safe = String(workspaceId ?? "").replace(/[^\w-]/g, "_").slice(0, 64) || "personal";
  return `persist:bloks-browser-${safe}`;
}

/** How long the person's own step counts as the one that ran into a
 * "leave this page?", for their yes to make it again. */
const STEP_MS = 2_000;

/**
 * A tab's page dialogs, held for whoever has the wheel (AppBrowser
 * dialogOpened) instead of the way Electron does them: a message box
 * over the whole window for an alert or a confirm, and no prompt at all.
 *
 * Electron hands each dialog to the tab's webContents as an internal
 * event, "-run-dialog", with the callback that answers it, and its own
 * handler is the one listener on it; this takes that listener's place.
 * An Electron without the event leaves its own boxes, as before, and
 * says so once in the log. Chromium letting a dialog go by itself (the
 * page went, or reloaded) is "-cancel-dialogs".
 *
 * A "leave this page?" is put to "will-prevent-unload" instead, to be
 * answered there and then, before anybody could be asked. The answer is
 * stay, never leave; a yes afterwards lets the next try through
 * (tab.leaving), and makes it again when the person's own step in the
 * panel was the one that tried (tab.redo, kept by main.mjs browser:do).
 */
export function holdDialogs({ browser, tab, tabId, contents, log = () => {}, now = Date.now }) {
  if (contents.listenerCount("-run-dialog") === 0) log("browser: this Electron has no dialog handler to stand in for; page dialogs show as Electron draws them");
  contents.removeAllListeners("-run-dialog");
  contents.on("-run-dialog", (info, callback) => {
    let answered = false;
    browser.dialogOpened(tabId, {
      type: info?.dialogType,
      message: info?.messageText,
      defaultPrompt: info?.defaultPromptText,
      answer: (accept, text) => {
        if (answered || contents.isDestroyed?.()) return;
        answered = true;
        callback(Boolean(accept), accept ? String(text ?? "") : "");
      },
    });
  });
  contents.on("-cancel-dialogs", () => browser.dialogClosed(tabId));
  contents.on("will-prevent-unload", (event) => {
    if ((tab.leaving ?? 0) > now()) {
      tab.leaving = 0;
      event.preventDefault();
      return;
    }
    const redo = tab.redo && now() - tab.redo.at < STEP_MS ? tab.redo.run : null;
    tab.redo = null;
    browser.dialogOpened(tabId, { type: "beforeunload", held: false, redo });
  });
}
