// How tall the composer grows, and which of its edges fade.
//
// Kept apart from the component so the arithmetic can be tested without
// a DOM. The component measures; this decides.

/** How many lines the composer grows to before it scrolls. */
export const MAX_LINES = 8;
/** How far a line fades as it scrolls out past an edge. */
export const FADE_PX = 4;
/** Fully clear at a fading edge before the fade starts. Covers the
 * textarea's own padding, where the descenders of the line beyond still
 * sit when the composer is scrolled to its end. Clear plus fade stays
 * under the gap between the edge and the nearest whole line's glyphs at
 * either end (about 7px at this size), so a fully visible line is never
 * dimmed. */
export const CLEAR_PX = 3;

/**
 * The tallest the composer gets: a whole number of lines plus its padding.
 * A flat pixel ceiling lands between lines, and then a scrolled composer
 * always shows part of one sliced off against its border (#50).
 */
export function composerCeiling(lineHeight: number, paddingTop: number, paddingBottom: number): number {
  const line = lineHeight > 0 ? lineHeight : 24;
  return Math.ceil(MAX_LINES * line + paddingTop + paddingBottom);
}

/**
 * A mask that fades each edge with text beyond it, or "" when there is
 * none. An edge with nothing past it stays sharp, so a composer that is
 * not scrolling is untouched.
 */
export function edgeMask(scrollTop: number, clientHeight: number, scrollHeight: number): string {
  const above = scrollTop > 1;
  const below = scrollTop + clientHeight < scrollHeight - 1;
  if (!above && !below) return "";
  const top = above ? `transparent, transparent ${CLEAR_PX}px, black ${CLEAR_PX + FADE_PX}px` : "black";
  const bottom = below
    ? `black calc(100% - ${CLEAR_PX + FADE_PX}px), transparent calc(100% - ${CLEAR_PX}px), transparent`
    : "black";
  return `linear-gradient(to bottom, ${top}, ${bottom})`;
}
