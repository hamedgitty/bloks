// The only thing the renderer can see of the desktop shell.
//
// Context isolation stays on, so the page never touches Node, never
// touches ipcRenderer, and cannot invent channel names. It gets the
// functions listed here and nothing else. That matters more than usual in
// this app: the renderer displays text written by models and fetched from
// web pages, so it should be treated as capable of trying anything.
//
// Each subscribe function returns its own unsubscribe rather than exposing
// a removeListener, so a caller can only ever detach the handler it
// actually attached.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

/** Wraps an event channel as subscribe-returning-unsubscribe. */
function subscription(channel) {
  return (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

/**
 * The workspace this page belongs to, with the theme and accent the app
 * keeps for it (electron/main.mjs, workspaces:boot), asked before the
 * page's own scripts run. Every workspace is an origin of its own, and an
 * origin's storage starts empty, so without this a workspace opened for
 * the first time would draw itself in the default theme and then flip.
 * The page's storage is the same storage the page reads, from here.
 */
const boot = (() => {
  let said = null;
  try {
    said = ipcRenderer.sendSync("workspaces:boot");
  } catch {
    return null;
  }
  if (!said) return null;
  try {
    if (said.theme) localStorage.setItem("bloks-theme", said.theme);
    else {
      // the first workspace to open after the update hands over the
      // theme it already had, so nobody's choice is lost
      const mine = localStorage.getItem("bloks-theme");
      if (mine) ipcRenderer.invoke("prefs:theme", mine).catch(() => {});
    }
    if (said.accent) localStorage.setItem("bloks-accent", said.accent);
    // the language the same way, except that none kept means "System",
    // which is what an empty storage already says
    if (said.language) localStorage.setItem("bloks-language", said.language);
    else {
      const mine = localStorage.getItem("bloks-language");
      if (mine) ipcRenderer.invoke("prefs:language", mine).catch(() => {});
    }
  } catch {
    /* storage refused; the page falls back to its defaults */
  }
  return said.workspace ?? null;
})();

contextBridge.exposeInMainWorld("bloks", {
  /** Which workspace this page is, or null outside one. */
  workspace: boot,
  // the workspaces on this computer (electron/workspaces.mjs)
  workspacesState: () => ipcRenderer.invoke("workspaces:state"),
  onWorkspaces: subscription("workspaces:state"),
  workspaceSwitch: (id, options) => ipcRenderer.invoke("workspaces:switch", id, options),
  workspaceLeave: (id, options) => ipcRenderer.invoke("workspaces:leave", id, options),
  workspaceRole: (role) => ipcRenderer.invoke("workspaces:role", role),
  workspaceHost: (name) => ipcRenderer.invoke("workspaces:host", name),
  workspaceCreate: (input) => ipcRenderer.invoke("workspaces:create", input),
  workspaceUpdate: (id, patch) => ipcRenderer.invoke("workspaces:update", id, patch),
  workspaceReroll: (id) => ipcRenderer.invoke("workspaces:reroll", id),
  workspaceMute: (id, choice) => ipcRenderer.invoke("workspaces:mute", id, choice),
  workspaceRetry: (id) => ipcRenderer.invoke("workspaces:retry", id),
  workspaceReorder: (ids) => ipcRenderer.invoke("workspaces:reorder", ids),
  workspaceDelete: (id) => ipcRenderer.invoke("workspaces:delete", id),
  workspaceLogoPick: (id) => ipcRenderer.invoke("workspaces:logo-pick", id),
  workspaceLogoClear: (id) => ipcRenderer.invoke("workspaces:logo-clear", id),
  /** How many people this workspace has, for the switcher (Members). */
  workspaceMembers: (count) => ipcRenderer.invoke("workspaces:members", count),
  // a workspace joined from this Mac (src/components/members/JoinWorkspaceDialog)
  workspaceJoined: (input) => ipcRenderer.invoke("workspaces:joined", input),
  // your own hosted workspace, from a pairing link the Plan page asked for
  workspaceHosted: (input) => ipcRenderer.invoke("workspaces:hosted", input),
  // moving a workspace to the hosted machine and back (electron/hosting-move.mjs)
  hostingMoveState: () => ipcRenderer.invoke("hosting:move-state"),
  onHostingMove: subscription("hosting:move"),
  hostingMoveStart: (input) => ipcRenderer.invoke("hosting:move-start", input),
  hostingMoveChange: (id) => ipcRenderer.invoke("hosting:move-change", id),
  hostingMoveStop: (how) => ipcRenderer.invoke("hosting:move-stop", how),
  hostingMoveResume: () => ipcRenderer.invoke("hosting:move-resume"),
  hostingMoveDismiss: () => ipcRenderer.invoke("hosting:move-dismiss"),
  hostingMoveAnnounced: () => ipcRenderer.invoke("hosting:move-announced"),
  hostingMoveOpenSettings: (page) => ipcRenderer.invoke("hosting:move-open-settings", page),
  hostingMoveRemoveCopy: (id) => ipcRenderer.invoke("hosting:move-remove-copy", id),
  hostingMoveTargets: () => ipcRenderer.invoke("hosting:move-targets"),
  hostingMovePreview: (id) => ipcRenderer.invoke("hosting:move-preview", id),
  prefsTheme: (theme) => ipcRenderer.invoke("prefs:theme", theme),
  prefsLanguage: (language) => ipcRenderer.invoke("prefs:language", language),
  onLanguage: subscription("prefs:language"),
  prefsAccent: (accent) => ipcRenderer.invoke("prefs:accent", accent),
  prefsSameAccent: (on, showing) => ipcRenderer.invoke("prefs:same-accent", on, showing),
  prefsNotch: (on) => ipcRenderer.invoke("prefs:notch", on),
  prefsTray: (on) => ipcRenderer.invoke("prefs:tray", on),
  // the island in the notch (electron/notch.mjs)
  notchHover: (over) => ipcRenderer.invoke("notch:hover", over),
  notchOpen: (target) => ipcRenderer.invoke("notch:open", target),
  notchGeometry: () => ipcRenderer.invoke("notch:geometry"),
  onNotchGeometry: subscription("notch:geometry"),
  /** What a banner clicked before this page loaded was about. */
  pendingNotifyTarget: () => ipcRenderer.invoke("notify:pending"),

  screenFrame: () => ipcRenderer.invoke("screen:frame"),

  notifyShow: (notice) => ipcRenderer.invoke("notify:show", notice),
  badgeSet: (count) => ipcRenderer.invoke("badge:set", count),
  appLog: (text) => ipcRenderer.invoke("app:log", String(text)),
  // Where a dropped or picked File actually lives. Chromium stopped
  // putting the path on the File object; this is the sanctioned bridge.
  filePath: (file) => webUtils.getPathForFile(file),
  // a HEIC photo the composer was given, as a JPEG (electron/main.mjs)
  heicAsJpeg: (bytes) => ipcRenderer.invoke("image:heic-as-jpeg", bytes),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),

  settingsObservation: () => ipcRenderer.invoke("settings:observation"),
  appVersion: () => ipcRenderer.invoke("app:version"),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  updateRestartNow: () => ipcRenderer.invoke("update:restart-now"),
  updateLater: () => ipcRenderer.invoke("update:later"),
  updateNotInstalledSeen: () => ipcRenderer.invoke("update:not-installed-seen"),
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  // a Bloks on another computer (electron/remote.mjs)
  remoteStatus: () => ipcRenderer.invoke("remote:status"),
  remoteConnect: (link) => ipcRenderer.invoke("remote:connect", link),
  remoteDisconnect: () => ipcRenderer.invoke("remote:disconnect"),
  onRemoteState: subscription("remote:state"),
  onUpdateState: subscription("update:state"),
  shortcutApply: (accelerator) => ipcRenderer.invoke("shortcut:apply", accelerator),
  quickHide: () => ipcRenderer.invoke("quick:hide"),
  quickOpenMain: () => ipcRenderer.invoke("quick:open-main"),
  // an agent's terminal in a window of its own (electron/terminal-window.mjs)
  terminalWindow: (botId) => ipcRenderer.invoke("terminal:window", botId),
  // the Bloks browser beside the chat (electron/app-browser.mjs): where
  // its panel is, what the person does in it, and what it is showing
  browserState: () => ipcRenderer.invoke("browser:state"),
  browserBounds: (rect) => ipcRenderer.invoke("browser:bounds", rect),
  browserDo: (action, arg) => ipcRenderer.invoke("browser:do", action, arg),
  onBrowserState: subscription("browser:state"),
  onBrowserReveal: subscription("browser:reveal"),
  onQuickOpened: subscription("quick:opened"),
  onNotifyActivate: subscription("notify:activate"),
  // bloks:// links from the website (electron/main.mjs)
  onLink: subscription("link:open"),
  pendingLink: () => ipcRenderer.invoke("link:pending"),
  // the system share sheet, for a workspace invite's link (electron/main.mjs)
  shareLink: (url) => ipcRenderer.invoke("share:link", url),
  // the Plan page: an offer opened with the licence attached, and the
  // licence copied, both without the page ever holding it (electron/main.mjs)
  planOpen: (url) => ipcRenderer.invoke("plan:open", url),
  licenceCopy: () => ipcRenderer.invoke("licence:copy"),
  // the macOS menu bar's own items, Settings among them (electron/app-menu.mjs)
  onMenuCommand: subscription("menu:command"),
  pendingMenuCommand: () => ipcRenderer.invoke("menu:pending"),
  speechStart: () => ipcRenderer.invoke("speech:start"),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  // meeting notes: the helper's long-running mode (electron/speech.mjs)
  meetingStart: (options) => ipcRenderer.invoke("meeting:start", options),
  meetingStop: () => ipcRenderer.invoke("meeting:stop"),
  onMeetingLine: subscription("meeting:line"),
  onMeetingEnd: subscription("meeting:end"),
  onSpeechTranscript: subscription("speech:transcript"),
  onSpeechEnd: subscription("speech:end"),

  /** Whether this Mac can prove who is at the keyboard, and the prompt
   * that does it. Answers a word: biometry, password, granted, denied,
   * cancelled, or unavailable. */
  authStatus: () => ipcRenderer.invoke("auth:status"),
  authConfirm: (reason) => ipcRenderer.invoke("auth:confirm", reason),

  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permRequestScreen: () => ipcRenderer.invoke("perm:request-screen"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  cuaPermissions: () => ipcRenderer.invoke("cua:permissions"),
  cuaRequestPermissions: () => ipcRenderer.invoke("cua:request-permissions"),
});
