// The macOS menu bar.
//
// Electron's stock menu served until the app wanted one item of its own:
// Settings…, with ⌘, beside it, where every Mac app keeps it. A menu bar
// is replaced whole or not at all, so this is the stock menu written out
// item for item, with that one addition and a Help menu that says
// something about this app instead of linking to Electron's website.
//
// Two things are kept off it on purpose. No item takes a key the window
// already answers to (⌘K, ⌘N, ⌘F, ⌘/, ⌘↩ and the rest in
// src/lib/shortcuts.ts): a menu key equivalent is heard before the page,
// and a menu that took one of those would quietly break it. And Reload and
// the developer tools appear only in a build run from source, the same
// rule the window keeps on Windows and Linux: they are for working on the
// app, and an installed one has no use for them.
//
// The conversation tabs' keys are the exception, because a Mac lists a
// tab's keys in its menus (GitHub 401): New Conversation ⌘T and Close
// Conversation ⌘W under File, the window's Close moved to ⌘⇧W beside
// them, and Previous and Next Conversation ⌘⇧[ and ⌘⇧] under Window.
// These choices are played to the page as the keys they name
// (src/lib/conversationKeys.ts), so the page's own rules still decide
// what each press does, the terminal's tabs and a dialog's included,
// whichever of the two hears the key first.
//
// Quit is an item of its own rather than the stock role, because ⌘Q in a
// Bloks window may ask to be held or pressed again first
// (electron/quit-guard.mjs). `quit` is told whether the choice came from
// the key; one made with the mouse quits at once, as the role did.
//
// Built by a function with no Electron in it, so a test can read the
// template without starting the app. The roles bring their own keys (⌘Z,
// ⌘C and so on), exactly as the stock menu had them. Their labels are
// given here, in the person's language (electron/menu-words.mjs): the
// stock ones are English whatever the app is set to read in.

/** The menu's words for the conversation tabs, carried to the window in
 * front rather than to the workspace's (electron/main.mjs). */
export const TAB_COMMANDS = ["newConversation", "closeConversation", "previousConversation", "nextConversation"];

/**
 * @param {{ name: string; packaged: boolean; command: (word: "settings" | "shortcuts" | (typeof TAB_COMMANDS)[number]) => void; quit: (byKey: boolean) => void; words: (key: string, params?: Record<string, string>) => string }} options
 *   `command` carries a menu choice to the window it is for; `quit` is
 *   Quit, from its key or not; `words` says each label in the person's
 *   language.
 */
export function appMenuTemplate({ name, packaged, command, quit, words: w }) {
  return [
    {
      // macOS names this menu after the app whatever the label says
      label: name,
      submenu: [
        { role: "about", label: w("menu.about", { name }) },
        { type: "separator" },
        { label: w("menu.settings"), accelerator: "CmdOrCtrl+,", click: () => command("settings") },
        { type: "separator" },
        { role: "services", label: w("menu.services") },
        { type: "separator" },
        { role: "hide", label: w("menu.hide", { name }) },
        { role: "hideOthers", label: w("menu.hideOthers") },
        { role: "unhide", label: w("menu.showAll") },
        { type: "separator" },
        {
          label: w("menu.quit", { name }),
          accelerator: "CmdOrCtrl+Q",
          // macOS says when a choice came from its key equivalent
          click: (_item, _window, event) => quit(Boolean(event?.triggeredByAccelerator)),
        },
      ],
    },
    {
      label: w("menu.file"),
      submenu: [
        { label: w("menu.newConversation"), accelerator: "CmdOrCtrl+T", click: () => command("newConversation") },
        { type: "separator" },
        { label: w("menu.closeConversation"), accelerator: "CmdOrCtrl+W", click: () => command("closeConversation") },
        // the stock ⌘W, moved aside the way a browser's Close Window is
        { role: "close", label: w("menu.closeWindow"), accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    {
      // Copy and paste in every text field live here: on a Mac the
      // keys are the menu's, and without these items they do nothing.
      label: w("menu.edit"),
      submenu: [
        { role: "undo", label: w("menu.undo") },
        { role: "redo", label: w("menu.redo") },
        { type: "separator" },
        { role: "cut", label: w("menu.cut") },
        { role: "copy", label: w("menu.copy") },
        { role: "paste", label: w("menu.paste") },
        { role: "pasteAndMatchStyle", label: w("menu.pasteAndMatchStyle") },
        { role: "delete", label: w("menu.delete") },
        { role: "selectAll", label: w("menu.selectAll") },
        { type: "separator" },
        {
          label: w("menu.speech"),
          submenu: [
            { role: "startSpeaking", label: w("menu.startSpeaking") },
            { role: "stopSpeaking", label: w("menu.stopSpeaking") },
          ],
        },
      ],
    },
    {
      label: w("menu.view"),
      submenu: [
        ...(packaged
          ? []
          : [
              { role: "reload", label: w("menu.reload") },
              { role: "forceReload", label: w("menu.forceReload") },
              { role: "toggleDevTools", label: w("menu.toggleDevTools") },
              { type: "separator" },
            ]),
        { role: "resetZoom", label: w("menu.actualSize") },
        { role: "zoomIn", label: w("menu.zoomIn") },
        { role: "zoomOut", label: w("menu.zoomOut") },
        { type: "separator" },
        { role: "togglefullscreen", label: w("menu.toggleFullScreen") },
      ],
    },
    {
      // the window role is what makes macOS list the open windows here
      role: "window",
      label: w("menu.window"),
      submenu: [
        { role: "minimize", label: w("menu.minimize") },
        { role: "zoom", label: w("menu.zoom") },
        { type: "separator" },
        { label: w("menu.previousConversation"), accelerator: "CmdOrCtrl+Shift+[", click: () => command("previousConversation") },
        { label: w("menu.nextConversation"), accelerator: "CmdOrCtrl+Shift+]", click: () => command("nextConversation") },
        { type: "separator" },
        { role: "front", label: w("menu.bringAllToFront") },
      ],
    },
    {
      // No key here: ⌘/ belongs to the window, which also has to hear it
      // in a browser and on Windows and Linux, where there is no menu.
      role: "help",
      label: w("menu.help"),
      submenu: [{ label: w("menu.keyboardShortcuts"), click: () => command("shortcuts") }],
    },
  ];
}
