// What to call the machine Bloks is running on.
//
// The app was written on a Mac and the copy said so everywhere: "stays
// on this Mac", "keys stay on this Mac", "reach this Mac over your
// network". It ships on Windows and Linux too, where all of that reads
// as though somebody forgot, and the first Windows user to file an
// issue said exactly that.
//
// Two words, one rule: say "Mac" only where the thing being described
// is genuinely a Mac. Screen Recording permission, the dictation helper
// and Touch ID really are macOS, and softening those into "computer"
// would make the instructions worse. Everything else is just the
// machine the person is sitting at.
//
// Each phrase is a whole entry in the catalogue ("this Mac", "this PC"),
// not "this" put beside a noun, because a language that agrees its
// "this" with the noun has to see both.
import { t } from "./i18n.ts";

type Device = "mac" | "pc" | "computer";

function device(platform?: string): Device {
  const word = deviceWord(platform);
  return word === "Mac" ? "mac" : word === "PC" ? "pc" : "computer";
}

/** The noun, for use mid-sentence: "stays on this Mac". */
export function thisComputer(platform?: string): string {
  return t(`thisComputer.this.${device(platform)}`);
}

/** The possessive form: "reach your PC over your network". */
export function yourComputer(platform?: string): string {
  return t(`thisComputer.your.${device(platform)}`);
}

/**
 * Mac, PC, or the neutral word when we cannot tell. English on purpose:
 * it is what code compares, and the phrases above are what people read.
 *
 * Read from the browser rather than plumbed through the desktop bridge,
 * because a phone and a plain browser tab render this UI too and
 * neither has the bridge. The argument is for tests, which cannot
 * assign to navigator.
 */
export function deviceWord(platform?: string): string {
  const said =
    platform ??
    ((typeof navigator !== "undefined" && (navigator.platform || navigator.userAgent)) || "");
  if (/mac|iphone|ipad/i.test(said)) return "Mac";
  if (/win/i.test(said)) return "PC";
  return "computer";
}

/** Sentence-start forms: "This PC already has a workspace." */
export function ThisComputer(platform?: string): string {
  return t(`thisComputer.thisAtStart.${device(platform)}`);
}
export function YourComputer(platform?: string): string {
  return t(`thisComputer.yourAtStart.${device(platform)}`);
}

/**
 * The modifier a shortcut hint should name. A Windows keyboard has no
 * Command key, and "⌘Enter" there reads as a shortcut that does not exist.
 */
export function modKey(platform?: string): string {
  return deviceWord(platform) === "Mac" ? "⌘" : "Ctrl+";
}

/**
 * Whether meeting notes can run here. They listen through the native
 * macOS helper and this computer's own microphone, so they need the
 * desktop app on a Mac, and a window onto a hosted workspace is not
 * listening through either. The bridge offers the call on every platform.
 */
export function meetingNotesHere(bridge: boolean, hosted: boolean | undefined, platform?: string): boolean {
  return bridge && !hosted && deviceWord(platform) === "Mac";
}
