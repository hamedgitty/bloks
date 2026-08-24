// Optional product analytics.
//
// No token ships with Bloks, so a build made from this source sends
// nothing anywhere unless whoever built it supplied one. That is the point:
// an app that reads your files should not phone home by default, and
// anyone who does not trust that can check it in one grep.
import posthog from "posthog-js";

const TOKEN = import.meta.env.VITE_POSTHOG_TOKEN;

let ready = false;

export function initAnalytics() {
  if (ready || !TOKEN) return;
  posthog.init(TOKEN, {
    api_host: "https://us.i.posthog.com",
    // Autocapture reads the text of whatever you clicked, and in this app
    // that text is your conversation. Only the events named in track()
    // ever leave the machine.
    autocapture: false,
    capture_pageview: false, // single-window desktop app, no page routes
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
    person_profiles: "identified_only",
    persistence: "localStorage",
  });
  ready = true;
  const platform = navigator.userAgent.includes("Electron") ? "desktop" : "browser";
  // Fired once per machine. A download is not an install and an install
  // is not a use, so this marks the only one of the three that means
  // anything: the app actually opened.
  if (!localStorage.getItem("bloks-installed")) {
    localStorage.setItem("bloks-installed", new Date().toISOString());
    posthog.capture("app_first_open", { platform });
  }
  posthog.capture("app_opened", { platform });
}

/**
 * Counts something. Never pass message text, agent names, file paths or
 * anything a user typed: this is for shapes and counts only, and the only
 * defence against that is the caller.
 */
export function track(event: string, props?: Record<string, number | boolean | string>) {
  if (!ready) return;
  posthog.capture(event, props);
}

// first-run setup state. Bloks never asks who you are, this only
// records that the one-time engine/permission check has been seen.
const SETUP_KEY = "bloks-setup-done";
export function setupDone(): boolean {
  return Boolean(localStorage.getItem(SETUP_KEY));
}

/**
 * The workspace's own answer, which outranks this browser's.
 *
 * localStorage is per origin, and the app's origin moves with its port,
 * so a returning user could be asked to onboard again and a new one
 * could be skipped past it. The harness knows the truth because the
 * agents are its own files; this asks it, and falls back to the local
 * flag only when the server cannot be reached at all.
 */
export async function workspaceSetupDone(): Promise<boolean> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return setupDone();
    const status = (await res.json()) as { setupDone?: boolean };
    if (status.setupDone) localStorage.setItem(SETUP_KEY, "done");
    return Boolean(status.setupDone);
  } catch {
    return setupDone();
  }
}

export function setSetupDone() {
  localStorage.setItem(SETUP_KEY, "done");
  // and durably, beside the agents themselves
  void fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupDone: true }),
  }).catch(() => {});
}
