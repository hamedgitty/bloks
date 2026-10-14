import type { Message } from "./store.ts";

export interface TelegramText { text: string; markdown: boolean }

export const TELEGRAM_MESSAGE_CHARS = 4_000;

export function clipTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_CHARS) return text;
  return `${text.slice(0, TELEGRAM_MESSAGE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

/** The same reply eligibility as the desktop fold, including legacy replies. */
export function botWords(m: Message): boolean {
  return m.role === "bot" && m.kind === "text" && (!m.agent || m.agent.dir === "reply") && !m.deleted && !m.quiet;
}

function startsTurn(m: Message): boolean {
  return m.role === "user" && m.kind === "text" && !m.midTurn;
}

/** What this request heard, not a turn it waited behind or a later one.
 * Waiting rows are outside the desktop transcript until delivered. A
 * delivered burst has adjacent heads; steering has no remaining head. */
export function replySpan(messages: readonly Message[], requestId: string | undefined): Message[] {
  const visible = messages.filter((m) => !m.queued && !m.unsent);
  const at = visible.findIndex((m) => m.id === requestId);
  const request = visible[at];
  if (!request || request.deleted || request.role !== "user" || request.kind !== "text") return [];
  let first = at + 1;
  if (!request.midTurn) while (first < visible.length && startsTurn(visible[first])) first++;
  let end = first;
  while (end < visible.length && !startsTurn(visible[end])) end++;
  return visible.slice(first, end);
}

export function telegramReply(messages: readonly Message[], redact: (text: string) => string): TelegramText {
  const text = messages.findLast(botWords)?.text?.trim() ?? "";
  return text ? { text, markdown: true } : telegramFallback(messages, redact);
}

/** Without reply text, carry the app's last plain notice to the phone.
 * Provider notices can quote credentials, and are not agent Markdown. */
export function telegramFallback(messages: readonly Message[], redact: (text: string) => string): TelegramText {
  const notice = messages.findLast((m) => m.role === "bot" && m.kind === "notice" && m.text?.trim() &&
    !m.deleted && !m.quiet && !m.compaction);
  const text = redact(notice?.text?.trim() ?? "") || "(the agent finished without saying anything)";
  return { text: clipTelegramText(text), markdown: false };
}
