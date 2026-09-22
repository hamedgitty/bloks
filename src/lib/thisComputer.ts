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

/** The noun, for use mid-sentence: "stays on this Mac". */
export function thisComputer(platform?: string): string {
  return `this ${deviceWord(platform)}`;
}

/** The possessive form: "reach your PC over your network". */
export function yourComputer(platform?: string): string {
  return `your ${deviceWord(platform)}`;
}

/**
 * Mac, PC, or the neutral word when we cannot tell.
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
