// The Plan page's line to this computer's server (GET /api/plan), kept
// outside React so the answer outlives the page: Settings opened again
// draws the last answer at once and looks again behind it.
//
// It also owns coming back from bloks.dev. Opening an offer or billing
// arms a watch on the window; the next time the window is focused, within
// a while, the plan is asked fresh. The server's fresh look moves every
// gate (members, shared rooms, workspaces online) the moment the plan
// changed, and this end says so once, with a small moment when it went
// up. The watch is armed by the click itself, so it works whatever page
// the person is on when they come back.
import { useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { cameBack, planChange, planKey, type PlanKey, type PlanSnapshot } from "./plan.ts";

export interface PlanState {
  snapshot: PlanSnapshot | null;
  loading: boolean;
  /** A failed read, also shown when the last successful answer is retained. */
  problem: string | null;
  /** A change a fresh look just found, for the page's moment. */
  news: { words: string; up: boolean; at: number } | null;
}

let state: PlanState = { snapshot: null, loading: false, problem: null, news: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<PlanState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

let asking: Promise<PlanSnapshot | null> | null = null;

/** Asks the server, fresh when somebody may just have changed it. */
export function loadPlan(fresh = false): Promise<PlanSnapshot | null> {
  if (asking && !fresh) return asking;
  const before: PlanKey | null = state.snapshot && (state.snapshot.account || !state.snapshot.licence.present) ? planKey(state.snapshot) : null;
  set({ loading: true });
  const run = fetch(`/api/plan${fresh ? "?fresh=1" : ""}`, { headers: { accept: "application/json" } })
    .then(async (res) => {
      // A slower earlier refresh must not restore data after a newer
      // response revoked access or reported a different subscription.
      if (asking !== run) return state.snapshot;
      if (res.status === 401 || res.status === 403) {
        set({ snapshot: null, news: null, loading: false, problem: "Only the authorized owner can view this workspace's subscription. Check that this device is connected as its owner." });
        return null;
      }
      if (!res.ok) throw new Error(String(res.status));
      const snapshot = (await res.json()) as PlanSnapshot;
      if (asking !== run) return state.snapshot;
      const known = snapshot.account || !snapshot.licence.present;
      const change = fresh && known ? planChange(before, planKey(snapshot)) : null;
      set({ snapshot, loading: false, problem: null, ...(!known ? { news: null } : change ? { news: { ...change, at: Date.now() } } : {}) });
      if (change) {
        if (change.up) toast.success(change.words, { id: "plan-change" });
        else toast(change.words, { id: "plan-change" });
      }
      return snapshot;
    })
    .catch(() => {
      if (asking !== run) return state.snapshot;
      // what was shown stays shown; the page says it could not look
      set({ loading: false, problem: state.snapshot
        ? "Couldn't refresh this workspace's subscription. Showing previously loaded details, which may be out of date."
        : "Bloks couldn't read this workspace's subscription just now. Its plan is unknown until it can be reached." });
      return state.snapshot;
    })
    .finally(() => {
      if (asking === run) asking = null;
    });
  asking = run;
  return run;
}

export function usePlan(): PlanState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** The page has shown the moment; it is not shown twice. */
export function clearPlanNews() {
  if (state.news) set({ news: null });
}

// ── coming back from bloks.dev ─────────────────────────────────────────

let openedAt: number | null = null;
let lastLook = 0;
let armed = false;

function onFocus() {
  if (!cameBack(openedAt)) {
    disarm();
    return;
  }
  // a window focused twice in a breath is one return
  if (Date.now() - lastLook < 4000) return;
  lastLook = Date.now();
  void loadPlan(true).then(() => {
    if (state.news) disarm();
  });
}

function onVisible() {
  if (document.visibilityState === "visible") onFocus();
}

function disarm() {
  if (!armed) return;
  armed = false;
  openedAt = null;
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisible);
}

/** Somebody is off to bloks.dev: look again when they are back. */
export function watchForReturn() {
  openedAt = Date.now();
  lastLook = 0;
  if (armed) return;
  armed = true;
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
}

/**
 * Opens one of the site's offers. In the desktop app the main process
 * opens it, adding the licence in the fragment for bloks.dev alone; a
 * browser tab has no licence to add and opens the link as it is.
 */
export async function openOffer(url: string): Promise<boolean> {
  watchForReturn();
  if (window.bloks?.planOpen) return window.bloks.planOpen(url);
  // the app's windows hand a new window to the browser and answer null,
  // so what window.open returns says nothing either way
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

/** Opens a page of the site with no key attached: billing, or plans. */
export function openSite(url: string) {
  watchForReturn();
  window.open(url, "_blank", "noopener,noreferrer");
}
