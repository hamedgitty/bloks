// What the update card says, and one more look before an update installs.
//
// A downloaded update waits for the person to restart into it, sometimes
// for days, and another release can come out meanwhile. Installing the
// old one then means a second restart straight after the first, so the
// app keeps looking past it, and looks once more when the person asks to
// restart: a newer release downloads and is the one that installs, and
// the same release again comes straight from the cache (GitHub 247).
// What those looks must not do is take the restart off the card while
// they run, or when one fails because the computer is offline.
// Kept apart from main.mjs so the rules can be tested without Electron.

/** The state frame an updater event leaves, given the one before, or
 * null when the card should go on saying what it says. While an update
 * waits to be installed, a look, a look that finds nothing new or the
 * same version, and a look that fails all leave it waiting. */
export function updateFrame(current, event, detail = {}) {
  const waiting = current.state === "ready";
  switch (event) {
    case "checking":
      return waiting ? null : { state: "checking" };
    case "available":
      return waiting && detail.version === current.version ? null : { state: "downloading", version: detail.version };
    case "not-available":
      return waiting ? null : { state: "current" };
    case "progress":
      return waiting ? null : { state: "downloading", version: current.version, percent: detail.percent };
    case "downloaded":
      return { state: "ready", version: detail.version };
    case "error":
      return waiting ? null : { state: "error", reason: detail.reason };
    default:
      return null;
  }
}

/** Whether the look every few hours goes ahead: not while one is
 * already looking or downloading. One waiting to be installed is looked
 * past, since a release since then is the one to install. */
export function mayLookAgain(current) {
  return current.state !== "checking" && current.state !== "downloading";
}

/** One more look before a downloaded update installs, waiting for a
 * newer release to download when it finds one (the card shows the
 * download meanwhile). A look that has not answered within `within` ms
 * is not waited for, and a look or a download that fails leaves what
 * had already downloaded to install: the updater's error event has
 * logged why. */
export async function newestBeforeInstall(updater, { within = 20_000 } = {}) {
  let timer;
  try {
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, within);
    });
    const result = await Promise.race([updater.checkForUpdates(), late]);
    clearTimeout(timer);
    await result?.downloadPromise;
  } catch {
    clearTimeout(timer);
  }
}
