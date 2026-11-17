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

/** The path a workspace extension's framed document is served under
 * (server/extension-routes.ts). */
const EXTENSION_FRAME = /^\/api\/extensions\/[a-z0-9][a-z0-9-]{1,39}\/frame\/[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Whether a frame in the app's window is an extension's document trying
 * to go somewhere else. A sandboxed frame may always navigate itself,
 * and a policy cannot stop it, so in a plain browser a document could
 * leave with whatever it saw in the address it goes to. Here the app
 * refuses: a frame showing an extension's document may load that same
 * document again (its own reload) and nothing else, anywhere.
 */
export function leavesExtensionFrame(fromUrl, toUrl) {
  let from;
  try {
    from = new URL(String(fromUrl ?? ""));
  } catch {
    return false;
  }
  if ((from.protocol !== "http:" && from.protocol !== "https:") || !EXTENSION_FRAME.test(from.pathname)) return false;
  try {
    const to = new URL(String(toUrl ?? ""));
    return !(to.origin === from.origin && to.pathname === from.pathname);
  } catch {
    return true;
  }
}
