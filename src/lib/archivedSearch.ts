// The search in the Archived agents dialog (GitHub 538): a long list of
// agents put away is read by name or by role, so those are what a query
// is matched against, as the person types.

/**
 * The archived agents a query finds, in the order they were given. Each
 * word has to be part of the name or the role, in any case; a blank
 * query finds them all, so clearing it brings the whole list back.
 */
export function archivedMatching<T extends { name: string; title?: string }>(bots: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...bots];
  return bots.filter((bot) => {
    const hay = `${bot.name} ${bot.title ?? ""}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}
