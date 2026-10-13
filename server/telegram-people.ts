// Admission and return identity belong to this bot, not to a chat grant.
import { createHash, randomUUID } from "node:crypto";
import type { Incoming } from "./telegram.ts";
import type { AgentTelegram, TelegramConfig } from "./telegram-bots.ts";
import { MAX_NAME_CHARS, MAX_TELEGRAM_PEOPLE, MAX_PENDING_TELEGRAM_PEOPLE, MAX_TELEGRAM_REPLY_CHARS } from "./limits.ts";

export interface TelegramPerson {
  id: string;
  userId: number;
  name: string;
  chatId: number;
  state: "pending" | "allowed" | "declined" | "removed";
  grant: string;
  cardId?: string;
  first?: { text: string; messageId?: number };
  /** Persist before sending, so a failure is not retried on every knock. */
  notice?: "sending" | "sent" | "uncertain";
  cardSend?: "sending" | "sent" | "uncertain";
  telegramCardId?: number;
  holdReported?: string;
}

/** Server-created. It is never read from a message-create or edit body. */
export interface TelegramSender {
  botId: string;
  bindingGeneration: string;
  personId: string;
  userId: number;
  name: string;
  grant: string;
  chatId: number;
  messageId?: number;
  requester: string;
}

export interface TelegramUpgradeNotice {
  chatId: number;
  state: "pending" | "sending" | "sent" | "failed" | "uncertain";
}

export const TELEGRAM_PEOPLE_UPGRADE = "Telegram needs the pairing word again to identify the owner. The owner gets it in this agent's settings. Everyone else can message this bot to ask to be let in.";

export function telegramPersonName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) || "Someone";
}

export function isPrivateTelegramHuman(message: Incoming): boolean {
  return !message.press && message.fromBot === false && !message.anonymous && message.chatType === "private" &&
    Number.isSafeInteger(message.fromId) && message.fromId! > 0 && Number.isSafeInteger(message.chatId) && message.chatId > 0;
}

export function knockTelegram(state: AgentTelegram, message: Incoming): { person?: TelegramPerson; fresh: boolean; capped: boolean } {
  if (!isPrivateTelegramHuman(message)) return { fresh: false, capped: false };
  const known = state.people?.[String(message.fromId)];
  if (known) return { person: known, fresh: false, capped: false };
  const people = Object.values(state.people ?? {});
  if (people.length >= MAX_TELEGRAM_PEOPLE || people.filter((p) => p.state === "pending").length >= MAX_PENDING_TELEGRAM_PEOPLE) {
    return { fresh: false, capped: true };
  }
  const text = message.text.slice(0, MAX_TELEGRAM_REPLY_CHARS) + (message.media ? "\n(Media was not downloaded before admission. Ask the sender to send it again.)" : "");
  return { fresh: true, capped: false, person: {
    id: randomUUID(), userId: message.fromId!, name: telegramPersonName(message.from), chatId: message.chatId,
    state: "pending", grant: randomUUID(), first: { text, ...(message.messageId ? { messageId: message.messageId } : {}) },
  } };
}

export function telegramSender(botId: string, state: AgentTelegram, person: TelegramPerson, messageId?: number): TelegramSender {
  const requester = "telegram:" + createHash("sha256").update(JSON.stringify([botId, state.generation, person.id, person.grant, person.chatId])).digest("hex").slice(0, 32);
  return { botId, bindingGeneration: state.generation, personId: person.id, userId: person.userId, name: person.name, grant: person.grant, chatId: person.chatId, ...(messageId ? { messageId } : {}), requester };
}

export function telegramSenderCurrent(state: AgentTelegram | undefined, sender: TelegramSender): boolean {
  const person = state?.people?.[String(sender.userId)];
  return Boolean(state?.enabled && state.token && state.generation === sender.bindingGeneration &&
    person?.state === "allowed" && person.id === sender.personId && person.grant === sender.grant &&
    person.chatId === sender.chatId && telegramSender(sender.botId, state, person).requester === sender.requester);
}

export function migrateTelegramPeople(before: TelegramConfig): TelegramConfig {
  if (before.version === 2) return before;
  const notices = (chats: number[] = []): TelegramUpgradeNotice[] => [...new Set(chats)].filter((id) => Number.isSafeInteger(id)).map((chatId) => ({ chatId, state: "pending" }));
  const bots = Object.fromEntries(Object.entries(before.bots ?? {}).map(([id, state]) => [id, {
    ...state, generation: randomUUID(), chatIds: [], people: {}, upgradeNotices: notices(state.chatIds),
    ...(state.ownerUserId === undefined ? { pairing: null } : {}),
  }]));
  const pending = before.pending ? { ...before.pending, chatIds: [], upgradeNotices: notices(before.pending.chatIds) } : undefined;
  return { ...before, version: 2, bots, ...(pending ? { pending } : {}) };
}
