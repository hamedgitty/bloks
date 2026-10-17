// A finite safe bridge result from already-owned UI/native state. No profile,
// arbitrary channel, auth helper, permission prompt, updater action or files.
export function nativeSettingsObservation({ window, remote, shortcut, update, media }) {
  const observed = (value) => ({ status: "observed", value });
  const unknown = { status: "unknown", reason: "unsupported" };
  const bounds = window && !window.isDestroyed() ? window.getBounds() : null;
  return {
    "window.width": bounds ? observed(bounds.width) : unknown,
    "window.height": bounds ? observed(bounds.height) : unknown,
    "window.x": bounds ? observed(bounds.x) : unknown,
    "window.y": bounds ? observed(bounds.y) : unknown,
    "window.maximized": bounds ? observed(window.isMaximized()) : unknown,
    "native.mode": observed(remote ? "remote" : "local"),
    "native.hostConfigured": observed(Boolean(remote)),
    "native.quickAskRegistered": observed(Boolean(shortcut)),
    "native.microphone": observed(media("microphone") ?? "unknown"),
    "native.screen": observed(media("screen") ?? "unknown"),
    // Existing auth:status starts a helper and CUA permission discovery can
    // load a driver. Inspection must not invoke either to fill these fields.
    "native.authCapability": unknown,
    "native.accessibility": unknown,
    "native.updateState": observed(update),
  };
}
