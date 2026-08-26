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

contextBridge.exposeInMainWorld("bloks", {
  screenFrame: () => ipcRenderer.invoke("screen:frame"),

  notifyShow: (notice) => ipcRenderer.invoke("notify:show", notice),
  badgeSet: (count) => ipcRenderer.invoke("badge:set", count),
  // Where a dropped or picked File actually lives. Chromium stopped
  // putting the path on the File object; this is the sanctioned bridge.
  filePath: (file) => webUtils.getPathForFile(file),
  pickFolder: () => ipcRenderer.invoke("dialog:pick-folder"),

  appVersion: () => ipcRenderer.invoke("app:version"),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  onUpdateState: subscription("update:state"),
  shortcutApply: (accelerator) => ipcRenderer.invoke("shortcut:apply", accelerator),
  quickHide: () => ipcRenderer.invoke("quick:hide"),
  quickOpenMain: () => ipcRenderer.invoke("quick:open-main"),
  onQuickOpened: subscription("quick:opened"),
  onNotifyActivate: subscription("notify:activate"),
  speechStart: () => ipcRenderer.invoke("speech:start"),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  onSpeechTranscript: subscription("speech:transcript"),
  onSpeechEnd: subscription("speech:end"),

  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permRequestScreen: () => ipcRenderer.invoke("perm:request-screen"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
});
