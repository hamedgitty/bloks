// "Close to the tray" on Windows (GitHub 446): with it on, the window's
// close button hides the window, Bloks keeps running, and an icon in the
// notification area brings the window back or quits. Off unless turned
// on. A Mac keeps running with its window closed anyway, so the setting
// is not there. No Electron here, so a test can read the choice.

/** Whether Bloks has a tray icon: on Windows, with the setting on. */
export function trayOn(platform, prefs) {
  return platform === "win32" && prefs?.tray === true;
}

/** Whether the close button hides the window instead of closing it. A
 * quit of any kind (the tray's Quit, an update, the system shutting
 * down) has set `quitting` first, and is never held here. */
export function closeHides(platform, prefs, quitting) {
  return trayOn(platform, prefs) && !quitting;
}
