// A request asked again until it is answered, waiting longer each time.
//
// For the first load of the agent list, which is what ends the loading
// screen. It was asked once, so a server that answered the event stream
// but not that request (still starting up, say) left "Loading your
// agents" up for good.

/** How long to wait after each failure; the last one repeats. */
export const RETRY_WAITS = [1_000, 2_000, 4_000, 8_000, 15_000];

/** Runs `task` until it resolves. Returns a stop, for a page going away
 * or a fresh load taking over. */
export function keepTrying(
  task: () => Promise<unknown>,
  later: (run: () => void, ms: number) => unknown = setTimeout,
  cancel: (timer: any) => void = clearTimeout,
): () => void {
  let stopped = false;
  let timer: unknown = null;
  const attempt = (failures: number) => {
    task().catch(() => {
      if (stopped) return;
      timer = later(() => attempt(failures + 1), RETRY_WAITS[Math.min(failures, RETRY_WAITS.length - 1)]);
    });
  };
  attempt(0);
  return () => {
    stopped = true;
    if (timer !== null) cancel(timer);
  };
}
