// bloks:// links, as the system hands them to the app. Plain Node on
// purpose, so they can be tested outside Electron (see
// test/links.test.ts).
//
// macOS hands a link over with open-url. Windows and Linux pass it as an
// argument instead: to a second launch when Bloks is already running,
// which hands it on, and to the launch itself when the link is what
// opened Bloks.

/** A link worth passing on, or null. Only a gallery team by name is
 * understood: a link cannot point the app at an arbitrary address. */
export function teamLink(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "bloks:" || url.hostname !== "team") return null;
    const slug = url.pathname.replace(/^\/+|\/+$/g, "");
    return /^[a-z0-9-]{1,60}$/.test(slug) ? { kind: "team", slug } : null;
  } catch {
    return null;
  }
}

/** The bloks:// link among a launch's arguments, or null. */
export function linkInArgv(argv) {
  return (Array.isArray(argv) ? argv : []).find((arg) => typeof arg === "string" && arg.startsWith("bloks://")) ?? null;
}
