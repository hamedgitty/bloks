import { SettingsReporter, type ReportAdmission } from "./settings-reporter.ts";
import type {} from "../types/bridge.d.ts";
import type { DeviceSetting, DeviceValue } from "./settings-observation.ts";
import { isSettingsStorageKey, storedDeviceSettings } from "./settings-stored.ts";

type Observation = Partial<Record<DeviceSetting, DeviceValue>>;
const owners = new Map<symbol, () => Observation>();
const reporter = new SettingsReporter({
  capture: () => {
    const values: Observation = storedDeviceSettings({ getItem: (key) => localStorage.getItem(key) });
    for (const key of ["theme.preference", "theme.applied", "conversations.preference", "conversations.applied", "sidebar.preference",
      "sidebar.applied", "sidebar.foldsConfigured", "desktop.dock", "desktop.width", "desktop.height", "desktop.x", "desktop.y",
      "terminal.height", "terminal.open", "room.lens"] as const) values[key] = { status: "unknown", reason: "unmounted" };
    if (typeof window !== "undefined") {
      values["viewport.width"] = { status: "observed", value: window.innerWidth };
      values["viewport.height"] = { status: "observed", value: window.innerHeight };
    }
    for (const read of owners.values()) Object.assign(values, read());
    return values;
  },
  native: typeof window !== "undefined" && window.bloks?.settingsObservation
    ? () => window.bloks!.settingsObservation!() : undefined,
});

/** Registers an already-mounted committed owner, never mounts or reads a
 * hidden control. Cleanup reports absence without persisting preferences. */
export function observeCommittedSettings(read: () => Observation): () => void {
  const key = Symbol();
  owners.set(key, read);
  reporter.changed();
  return () => { owners.delete(key); reporter.changed(); };
}

export function disconnectSettingsReports() { reporter.disconnect(); }
export function settingsViewportChanged() { reporter.changed(); }
export function settingsStorageChanged(key: string | null) { if (isSettingsStorageKey(key)) reporter.changed(); }

function safeAdmission(raw: unknown): ReportAdmission | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<ReportAdmission>;
  return typeof a.capability === "string" && /^[A-Za-z0-9_-]{43}$/.test(a.capability) &&
    typeof a.label === "string" && a.label.length <= 128 && typeof a.generation === "string" && a.generation.length <= 128 &&
    typeof a.lifetimeMs === "number" && Number.isFinite(a.lifetimeMs) && a.lifetimeMs <= 60_000 && a.lifetimeMs > 0
    ? { label: a.label, generation: a.generation, capability: a.capability, lifetimeMs: a.lifetimeMs } : null;
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("settings reporting unavailable");
  return response.json();
}

/** Consumed before sequence/reducer/notification handling. Private control
 * material never becomes an ordinary frame, action, URL or diagnostic. */
export function consumeSettingsControl(raw: unknown, streamStarted: number): boolean {
  if (!raw || typeof raw !== "object" || (raw as { kind?: unknown }).kind !== "settings-report") return false;
  reporter.disconnect();
  const control = raw as { windowKey?: unknown; admission?: ReportAdmission; unavailable?: boolean };
  const a = safeAdmission(control.admission);
  if (control.unavailable || typeof control.windowKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(control.windowKey) ||
      control.admission !== undefined && !a) return true;
  const windowKey = control.windowKey;
  // Include the event-stream request's transit time conservatively. The
  // actual expiry is always checked by the server monotonic clock.
  let first: ReportAdmission | null = a ? { ...a, lifetimeMs: Math.max(0, a.lifetimeMs - (performance.now() - streamStarted)) } : null;
  reporter.connect({
    admit: async () => {
      if (first) { const result = first; first = null; return result; }
      return safeAdmission((await post("/api/settings/device-session", { action: "renew", windowKey })).admission);
    },
    post: async (admission, sequence, snapshot) => {
      await post("/api/settings/device-report", { windowKey, admission, sequence, snapshot });
    },
  });
  return true;
}
