// Which URLs are the app's own page. Plain Node on purpose, so it can be
// tested outside Electron (see test/navigation.test.ts).

/** True when `url` is the app's page itself: the same origin as the
 * page the window was given, port included, and only over http(s). */
export function sameAppOrigin(url, appUrl) {
  try {
    const own = new URL(appUrl);
    if (own.protocol !== "http:" && own.protocol !== "https:") return false;
    return new URL(url).origin === own.origin;
  } catch {
    return false;
  }
}
