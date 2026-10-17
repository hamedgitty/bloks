// Shared wire values only. Keep this module free of browser and Node owners.
// Unknown fields never pass through, including native profiles and credentials.
const oneOf = (...choices: readonly (string | boolean | null)[]) => (value: unknown) => choices.includes(value as string);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
const nonnegative = (value: unknown) => finite(value) && (value as number) >= 0;
const boolean = (value: unknown) => typeof value === "boolean";
const nullableNumber = (value: unknown) => value === null || finite(value);
const permission = oneOf("granted", "denied", "restricted", "not-determined", "unknown");

const FIELDS = {
  "theme.preference": oneOf("light", "dark", "system"),
  "theme.applied": oneOf("light", "dark"),
  "theme.saved": oneOf("light", "dark", "system", null),
  "conversations.preference": boolean,
  "conversations.applied": boolean,
  "conversations.saved": oneOf(true, false, null),
  "sidebar.preference": oneOf("full", "rail", null),
  "sidebar.applied": oneOf("full", "rail", "mobile"),
  "sidebar.foldsConfigured": boolean,
  "sidebar.saved": oneOf("full", "rail", null),
  "sidebar.savedFoldsConfigured": boolean,
  "desktop.dock": oneOf("left", "right", "bottom", "float"),
  "desktop.width": nonnegative,
  "desktop.height": nonnegative,
  "desktop.x": finite,
  "desktop.y": finite,
  "desktop.savedDock": oneOf("left", "right", "bottom", "float", null),
  "desktop.savedWidth": nullableNumber,
  "desktop.savedHeight": nullableNumber,
  "desktop.savedX": nullableNumber,
  "desktop.savedY": nullableNumber,
  "terminal.height": nonnegative,
  "terminal.open": boolean,
  "terminal.savedHeight": nullableNumber,
  "room.lens": oneOf("stream", "forum"),
  "room.savedLens": oneOf("stream", "forum", null),
  "viewport.width": nonnegative,
  "viewport.height": nonnegative,
  "window.width": nonnegative,
  "window.height": nonnegative,
  "window.x": finite,
  "window.y": finite,
  "window.maximized": boolean,
  "native.mode": oneOf("local", "remote"),
  "native.hostConfigured": boolean,
  "native.quickAskRegistered": boolean,
  "native.microphone": permission,
  "native.screen": permission,
  "native.accessibility": permission,
  "native.authCapability": oneOf("biometry", "password", "unavailable"),
  "native.updateState": oneOf("idle", "checking", "downloading", "current", "ready", "error", "dev"),
} as const;

export type DeviceSetting = keyof typeof FIELDS;
export type DeviceValue =
  | { status: "observed"; value: string | number | boolean | null }
  | { status: "unknown"; reason: "unsupported" | "unmounted" | "unavailable" | "invalid" };
export interface DeviceSettingsSnapshot {
  schema: 1;
  revision: number;
  // Client-reported wall time, never used to establish server freshness.
  observedAt: number;
  values: Record<DeviceSetting, DeviceValue>;
}

function own(object: unknown, key: string): unknown {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  const field = Object.getOwnPropertyDescriptor(object, key);
  return field && "value" in field ? field.value : undefined;
}

/** Full replacement: missing fields become unknown rather than retaining a
 * previous report's value. This whitelist accepts no arbitrary strings/keys. */
export function deviceSettingsSnapshot(raw: unknown): DeviceSettingsSnapshot | null {
  const revision = own(raw, "revision");
  const observedAt = own(raw, "observedAt");
  if (own(raw, "schema") !== 1 || !Number.isSafeInteger(revision) || (revision as number) < 0 ||
      typeof observedAt !== "number" || !Number.isFinite(observedAt)) return null;
  const input = own(raw, "values");
  const values = {} as Record<DeviceSetting, DeviceValue>;
  for (const [key, valid] of Object.entries(FIELDS)) {
    const item = own(input, key);
    const status = own(item, "status");
    const value = own(item, "value");
    const reason = own(item, "reason");
    values[key as DeviceSetting] = status === "observed" && valid(value)
      ? { status: "observed", value: value as string | number | boolean | null }
      : status === "unknown" && (reason === "unsupported" || reason === "unmounted" || reason === "unavailable")
        ? { status: "unknown", reason }
        : { status: "unknown", reason: item === undefined ? "unsupported" : "invalid" };
  }
  return { schema: 1, revision: revision as number, observedAt, values };
}
