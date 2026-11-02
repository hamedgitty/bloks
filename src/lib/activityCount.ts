// How many things are running, waiting on you, and suggested, for the
// rail's dots and the Overview line. One poll for the whole app: every
// surface that shows a count reads this, so the rail, the drawer on a
// phone and the Overview page never run timers of their own against the
// same endpoint. It runs while something is showing it and the window is
// visible, every five seconds.
import { useSyncExternalStore } from "react";
import { wakeFetch } from "./waking.ts";

export interface ActivityCount {
  running: number;
  waiting: number;
  suggested: number;
  /** Incidents that need the person, and automations stopped for
   * failing (server/incidents.ts): things to look at, as waiting is. */
  failed: number;
  /** Lines open on the person's list (server/todos.ts): things an agent
   * found they have to do themselves. */
  todos: number;
}

let count: ActivityCount = { running: 0, waiting: 0, suggested: 0, failed: 0, todos: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
/** How often the counts are asked for while something shows them. */
export const POLL_MS = 5_000;
/** When the counts were last asked for, so a listener that leaves and
 * comes straight back does not ask again before the poll would. */
let askedAt = -Infinity;

function load() {
  askedAt = Date.now();
  // while a hosted workspace wakes, these wait in the page for it as one
  // read each, rather than one more every five seconds (src/lib/waking.ts)
  void Promise.all([
    wakeFetch("/api/activity").then((r) => (r.ok ? r.json() : null)),
    wakeFetch("/api/skills/proposals").then((r) => (r.ok ? r.json() : null)),
  ])
    .then(([a, s]) => {
      const next = {
        running: a?.running?.length ?? 0,
        waiting: a?.waiting?.length ?? 0,
        suggested: s?.proposals?.length ?? 0,
        failed: failedCount(a?.incidents ?? [], a?.failing ?? []),
        todos: typeof a?.todos === "number" ? a.todos : 0,
      };
      if (
        next.running === count.running &&
        next.waiting === count.waiting &&
        next.suggested === count.suggested &&
        next.failed === count.failed &&
        next.todos === count.todos
      ) return;
      count = next;
      for (const listener of listeners) listener();
    })
    .catch(() => {});
}

/** Things that failed and want the person: incidents put to them, and
 * routines or watchers stopped for failing, a stopped one counted once
 * when its own incident is among the first. */
export function failedCount(
  incidents: ReadonlyArray<{ subject?: string; state?: string }>,
  failing: ReadonlyArray<{ kind?: string; id?: string }>,
): number {
  const asking = incidents.filter((i) => i.state === "needs-you");
  const said = new Set(asking.map((i) => i.subject));
  return asking.length + failing.filter((f) => !said.has(`${f.kind}:${f.id}`)).length;
}

/** Polling runs only while someone is listening and the page is shown. */
function sync() {
  const want = listeners.size > 0 && document.visibilityState !== "hidden";
  if (want && !timer) {
    if (Date.now() - askedAt >= POLL_MS) load();
    timer = setInterval(load, POLL_MS);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", sync);

/** One function for every render. React subscribes again whenever it is
 * handed a different one, and the rail renders on every frame the event
 * stream brings: written inline, each frame dropped the poll and started
 * it over, two requests a frame, hundreds a minute while agents worked. */
export function subscribeActivityCount(listener: () => void): () => void {
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    sync();
  };
}

const currentCount = () => count;

export function useActivityCount(): ActivityCount {
  return useSyncExternalStore(subscribeActivityCount, currentCount);
}
