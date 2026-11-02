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
import type { MachineKind } from "../../server/this-machine.ts";

function device(platform?: string): MachineKind {
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

// The same noun where a sentence puts it after "on", "to" or "from".
// English says "this Mac" in all three, but German declines it there
// ("auf diesem Mac", "auf diesen Mac") and Portuguese folds its "em" and
// "de" into it ("neste Mac", "deste Mac"), so each place has entries of
// its own and each language writes its sentence around them.

/** After "on": "keys stay on this Mac". */
export function onThisComputer(platform?: string): string {
  return t(`thisComputer.thisOn.${device(platform)}`);
}

/** After "to": "move to this PC". */
export function toThisComputer(platform?: string): string {
  return t(`thisComputer.thisTo.${device(platform)}`);
}

/** After "from": "remove from this computer". */
export function fromThisComputer(platform?: string): string {
  return t(`thisComputer.thisFrom.${device(platform)}`);
}

/** The possessive after "on": "not on your PC". */
export function onYourComputer(platform?: string): string {
  return t(`thisComputer.yourOn.${device(platform)}`);
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
 * Whether the Mac's own recognizer can hear in this window: the desktop
 * app's native helper, on a Mac. The bridge offers the call on every
 * platform, so the platform is asked too.
 */
export function macRecognizerHere(bridge: boolean, platform?: string): boolean {
  return bridge && deviceWord(platform) === "Mac";
}

/**
 * Whether meeting notes are offered here. Anything that can hear will do
 * (src/lib/hearing.ts pickEars): the page's microphone with the server's
 * hearer, in any browser, or the Mac's recognizer in the app. On a Mac in
 * the app they are offered even with nothing set up, where opening them
 * says what is missing. A hosted workspace refuses them (server/hosted.ts).
 */
export function meetingNotesHere(ears: "server" | "mac" | "none", hosted: boolean | undefined, macApp: boolean): boolean {
  return !hosted && (ears !== "none" || macApp);
}
