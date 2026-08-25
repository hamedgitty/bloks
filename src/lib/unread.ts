// What the Dock badge counts.
//
// One number for the whole app: conversations with something the user
// has not seen. Archived agents are out; they stopped working, so they
// cannot have news. The currently open thread is out too, because its
// unread flag clears on selection before this ever runs.

export function unreadCount(bots: Array<{ unread?: boolean; archivedAt?: number | null }>): number {
  return bots.filter((bot) => bot.unread && !bot.archivedAt).length;
}
