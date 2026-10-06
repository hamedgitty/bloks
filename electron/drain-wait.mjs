// Waiting for the harness to finish before an update restarts it.
//
// The updater asks the harness to drain (server/drain.ts) and then waits,
// which can be twenty minutes. That is a long time to look frozen, so
// each look at the drain is passed on for the update card to show, and
// the person can stop waiting: restart now, leaving what is running to be
// picked up after the restart, or call the drain off and update later.
// Kept apart from main.mjs so the waiting can be tested without Electron.

/** Asks for a drain and polls it until it is done or somebody stops it.
 * `ask(method)` talks to /api/maintenance/drain and answers its status,
 * or null when the harness does not answer, which ends the wait: a
 * harness that does not answer has nothing to wait for. `finished`
 * settles on "done", "now" or "cancel"; a cancel also calls the drain
 * off, so what waited goes at once. */
export function drainWait(ask, { every = 2000, onProgress } = {}) {
  let outcome = null;
  let wake = () => {};
  const finished = (async () => {
    let state = await ask("POST");
    while (!outcome && state?.draining && !state.done) {
      onProgress?.(state);
      await new Promise((resolve) => {
        if (outcome) return resolve();
        const timer = setTimeout(resolve, every);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (!outcome) state = await ask("GET");
    }
    if (outcome === "cancel") await ask("DELETE");
    return outcome ?? "done";
  })();
  return {
    finished,
    /** Stops waiting: "now" to restart anyway, "cancel" to update later. */
    stop(why) {
      outcome ??= why;
      wake();
    },
  };
}
