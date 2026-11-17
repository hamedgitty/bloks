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

/** Longer than any room's pass needs, with its relay address and name. */
const ROOM_PASS_LIMIT = 4096;

/**
 * An invite handed over by bloks.dev's "Open in Bloks", or a QR scanned
 * on this Mac, as bloks://join#<fragment>. A workspace's invite is its
 * code, exactly as typed (a dash, any case), sometimes with where the
 * inviting computer answers on this network after a "~". A shared room's
 * invite is the invite itself, a base64url pass far longer than a code
 * (server/index.ts inviteLink), and is passed on only when it reads as
 * one. Either goes on as text for the join dialog to read the way it
 * reads anything pasted; it opens nothing by itself.
 */
export function joinLink(raw) {
  const text = String(raw ?? "");
  if (!/^bloks:\/\/join\/?#/i.test(text) || text.length > ROOM_PASS_LIMIT) return null;
  const fragment = text.slice(text.indexOf("#") + 1);
  if (roomPass(fragment)) return { kind: "join", fragment };
  // a code is 8 of the readable characters, give or take dashes and spaces
  if (text.length > 200 || !/^[0-9A-Za-z\s\-~.:[\]%]{8,120}$/.test(fragment)) return null;
  try {
    return { kind: "join", fragment: decodeURIComponent(fragment) };
  } catch {
    return null;
  }
}

/** Whether a fragment is a shared room's invite: base64url of the JSON
 * the room's computer writes, naming an invite. */
function roomPass(fragment) {
  if (!/^[A-Za-z0-9_-]{40,4000}$/.test(fragment)) return false;
  try {
    const invite = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8"));
    return invite?.v === 1 && typeof invite.i === "string" && invite.i.startsWith("inv_") && typeof invite.s === "string" && typeof invite.t === "string";
  } catch {
    return false;
  }
}

/**
 * bloks://plan, the way bloks.dev sends somebody back after a checkout
 * or a change in billing: it opens Settings on Plan, which looks again.
 * Nothing else rides on it; a path or a query is not read.
 */
export function planLink(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === "bloks:" && url.hostname === "plan" ? { kind: "plan" } : null;
  } catch {
    return null;
  }
}

/**
 * bloks://install?url=<https link to a team or a skill>, the "Install in
 * Bloks" button on a catalogue page or anywhere else. The address rides
 * on as text, and only an https one: the app fetches it, checks it the
 * way it checks a file dropped on it, and shows the same review, so a
 * link can open a review but never install anything by itself.
 */
export function installLink(raw) {
  const text = String(raw ?? "");
  if (text.length > 2200) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "bloks:" || url.hostname !== "install") return null;
    const target = url.searchParams.get("url") ?? "";
    if (target.length > 2048) return null;
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return { kind: "install", url: parsed.toString() };
  } catch {
    return null;
  }
}

/** The bloks:// link among a launch's arguments, or null. */
export function linkInArgv(argv) {
  return (Array.isArray(argv) ? argv : []).find((arg) => typeof arg === "string" && arg.startsWith("bloks://")) ?? null;
}
