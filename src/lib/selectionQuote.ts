// Quoting what you selected in a message: the words as a quote keeps
// them, and where the little toolbar over a selection goes so it never
// covers it. Kept apart from the component so it can be tested without a
// DOM (src/components/chat/SelectionQuote.tsx draws it).

/** The longest quote a reply carries, as the server keeps it too: a
 * passage, not a copy of the message. */
export const QUOTE_MAX = 2000;

/**
 * Selected words as a quote: line breaks kept, runs of blank lines and
 * the spaces at line ends taken out, cut at a word past QUOTE_MAX with
 * an ellipsis. Null for a selection with no words in it.
 */
export function quoteOf(selected: string): string | null {
  const words = selected
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!words) return null;
  if (words.length <= QUOTE_MAX) return words;
  const cut = words.slice(0, QUOTE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > QUOTE_MAX * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where the toolbar goes: centred over the selection, a small gap above
 * it, or below it where there is no room above, or where a touch screen
 * puts its own menu above (`below`). Kept inside the viewport. When
 * neither side has room (a selection taller than the screen), the side
 * with more of it, clamped.
 */
export function toolbarSpot(
  selection: Box,
  toolbar: { width: number; height: number },
  viewport: { width: number; height: number },
  { below = false, gap = 8, margin = 8 }: { below?: boolean; gap?: number; margin?: number } = {},
): { top: number; left: number; side: "above" | "below" } {
  const above = selection.top - gap - toolbar.height;
  const under = selection.bottom + gap;
  const fitsAbove = above >= margin;
  const fitsBelow = under + toolbar.height <= viewport.height - margin;
  let side: "above" | "below" = below ? (fitsBelow || !fitsAbove ? "below" : "above") : fitsAbove || !fitsBelow ? "above" : "below";
  if (!fitsAbove && !fitsBelow) side = selection.top > viewport.height - selection.bottom ? "above" : "below";
  const rawTop = side === "above" ? above : under;
  const top = Math.min(Math.max(rawTop, margin), viewport.height - margin - toolbar.height);
  const centre = (selection.left + selection.right) / 2;
  const left = Math.min(Math.max(centre - toolbar.width / 2, margin), Math.max(margin, viewport.width - margin - toolbar.width));
  return { top, left, side };
}

/** The keyboard's way to quote a selection: ⌘' on a Mac, Ctrl+' elsewhere.
 * By the key's place as well as its character, for layouts where the
 * apostrophe needs Shift. */
export function isQuoteKey(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && (e.key === "'" || e.code === "Quote");
}
