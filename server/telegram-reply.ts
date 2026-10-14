import type { Message } from "./store.ts";

export interface TelegramText { text: string; markdown: boolean }

/** Without reply text, carry the app's last plain notice to the phone.
 * Provider notices can quote credentials, and are not agent Markdown. */
export function telegramFallback(messages: readonly Message[], redact: (text: string) => string): TelegramText {
  const notice = messages.findLast((m) => m.role === "bot" && m.kind === "notice" && m.text?.trim() &&
    !m.deleted && !m.quiet && !m.compaction);
  const text = redact(notice?.text?.trim() ?? "") || "(the agent finished without saying anything)";
  if (text.length <= 4_000) return { text, markdown: false };
  // Telegram's existing single-message cap, without half an astral character.
  const prefix = text.slice(0, 3_999).replace(/[\uD800-\uDBFF]$/, "");
  return { text: `${prefix}…`, markdown: false };
}
