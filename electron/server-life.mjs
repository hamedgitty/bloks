// The server's life once it has started.
//
// It can die after it started: the system ends it under memory pressure,
// somebody force quits "Bloks Helper", a bug takes it down. Nothing used
// to notice. The window kept calling a port nobody answered on, and one
// opened from the Dock showed "connection refused" until Bloks was quit
// and opened again. So its exit is watched, and unless Bloks is quitting
// it is started again, after a pause that grows with each try. A server
// that keeps dying is given up on after a few tries, and the window says
// so, rather than restarted in a loop forever; one that ran a good while
// before it died has earned a full set of tries again.
//
// Stopping it is asked for first and enforced second. Killing it is
// TerminateProcess on Windows, which runs none of the server's own
// shutdown: its engines kept running, and its lock on the data folder
// stayed behind for the next start to trip on. So it is sent a message to
// stop (server/index.ts listens for it), given a moment, and only then
// killed.
//
// Plain Node on purpose, so it can be tested without Electron (see
// test/server-life.test.ts).

/** The pause before each try to bring the server back; one try each. */
export const RESTART_DELAYS = [1_000, 2_000, 5_000, 10_000, 20_000];

/** How long a server has to stay up to earn a full set of tries again. */
export const STEADY_MS = 60_000;

/** How long a server asked to stop gets before it is killed: its own
 * shutdown gives its engines a second and a half
 * (server/drivers/engine-processes.ts). */
export const STOP_WAIT_MS = 3_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watches a running server and brings it back when it dies. `start()`
 * makes one try and answers the new server, or null when none came up;
 * `quitting()` says whether Bloks is on its way out, when a server going
 * away is expected. `onBack(child)` hears about each server that came
 * back, and `onGaveUp()` about the last try failing.
 */
export function keepServerUp({
  start,
  quitting,
  onBack = () => {},
  onGaveUp = () => {},
  delays = RESTART_DELAYS,
  steadyMs = STEADY_MS,
  now = Date.now,
  wait = pause,
}) {
  let tries = 0;
  let upSince = 0;

  const revive = async () => {
    if (quitting()) return;
    if (now() - upSince >= steadyMs) tries = 0;
    // a try that does not come up counts the same as one that dies
    while (tries < delays.length) {
      await wait(delays[tries++]);
      if (quitting()) return;
      const child = await Promise.resolve()
        .then(start)
        .catch(() => null);
      if (quitting()) {
        // up just as Bloks quit, after the quit stopped the one before
        if (child) void stopServer(child);
        return;
      }
      if (child) {
        watch(child);
        onBack(child);
        return;
      }
    }
    onGaveUp();
  };

  function watch(child) {
    upSince = now();
    child.once("exit", () => void revive());
  }

  return { watch };
}

/** Asks `child` to stop, and kills it if it is still running `wait` ms
 * later. Resolves once it has exited or been killed. */
export async function stopServer(child, { wait = STOP_WAIT_MS } = {}) {
  // Electron clears the pid once the process has exited
  if (!child || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  try {
    child.postMessage({ kind: "stop" });
  } catch {
    /* nothing to ask on; the kill below still ends it */
  }
  let timer;
  const gone = await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(() => resolve(false), wait)))]);
  clearTimeout(timer);
  if (gone) return;
  try {
    child.kill();
  } catch {
    /* gone after all */
  }
}
