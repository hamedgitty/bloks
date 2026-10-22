// Admission and return identity belong to this bot, not to a chat grant.
import { createHash, randomUUID } from "node:crypto";
import type { Incoming } from "./telegram.ts";
import type { AgentTelegram, TelegramConfig } from "./telegram-bots.ts";
import { MAX_CLOSED_TELEGRAM_PEOPLE, MAX_NAME_CHARS, MAX_TELEGRAM_PEOPLE, MAX_PENDING_TELEGRAM_PEOPLE, MAX_TELEGRAM_REPLY_CHARS } from "./limits.ts";

export interface TelegramPerson {
  id: string;
  userId: number;
  name: string;
  /** Their @username when they have one. A first name is chosen freely
   * and two strangers can share it; the id and username tell them apart. */
  username?: string;
  /** Learned only from a private message, never from a group knock. */
  chatId?: number;
  state: "pending" | "allowed" | "declined" | "removed";
  /** When they were declined or taken out, so the oldest closed record
   * is the one forgotten when there are too many. */
  closedAt?: number;
  grant: string;
  cardId?: string;
  first?: { text: string; messageId?: number; destination?: TelegramDestination };
  /** Persist before sending, so a failure is not retried on every knock. */
  notice?: "sending" | "sent" | "uncertain";
  cardSend?: "sending" | "sent" | "uncertain";
  telegramCardId?: number;
  holdReported?: string;
  /** The owner gave this person full access to the agent on Telegram
   * (GitHub 320): their words run as its ordinary turns, with its own
   * tools, engine and permissions, and are answered in their own chat.
   * Only while they are let in, and only ever set by the owner. */
  full?: boolean;
  holdAudience?: string;
}

/** Server-created. It is never read from a message-create or edit body. */
export interface TelegramDestination {
  chatId: number;
  messageId?: number;
  group?: { title: string; threadId?: number };
}

export interface TelegramSender extends TelegramDestination {
  botId: string;
  bindingGeneration: string;
  personId: string;
  userId: number;
  name: string;
  grant: string;
  requester: string;
}

/** Owner trust is independent of the group this particular turn answers. */
export interface TelegramOwnerGroup extends TelegramDestination {
  owner: true;
  botId: string;
  bindingGeneration: string;
  userId: number;
  name: string;
  requester: "owner";
  group: { title: string; threadId?: number };
}

export type TelegramReplySender = TelegramSender | TelegramOwnerGroup;

export function telegramAudience(sender?: TelegramDestination & { botId: string; bindingGeneration: string }): string {
  return sender?.group ? JSON.stringify([sender.botId, sender.bindingGeneration, sender.chatId, sender.group.threadId ?? null]) : "private";
}

export function telegramSenderLabel(sender: TelegramReplySender): string {
  return sender.group ? `${sender.name} in ${sender.group.title}` : sender.name;
}

export function validTelegramDestination(destination: TelegramDestination): boolean {
  if (destination.group && (typeof destination.group !== "object" || Array.isArray(destination.group) ||
    typeof destination.group.title !== "string" || !destination.group.title.trim())) return false;
  return Number.isSafeInteger(destination.chatId) && (destination.group ? destination.chatId < 0 : destination.chatId > 0) &&
    (!destination.group || (Number.isSafeInteger(destination.messageId) && destination.messageId! > 0 &&
      (destination.group.threadId === undefined || (Number.isSafeInteger(destination.group.threadId) && destination.group.threadId > 0))));
}

export interface TelegramUpgradeNotice {
  chatId: number;
  state: "pending" | "sending" | "sent" | "failed" | "uncertain";
}

export const TELEGRAM_PEOPLE_UPGRADE = "Telegram needs the pairing word again to identify the owner. The owner gets it in this agent's settings. Everyone else can message this bot to ask to be let in.";

/** Control characters and the invisible marks that reorder or hide text
 * go, as in a routine's name: a name chosen to read as someone else's on
 * the admission card is the attack this card exists to stop. */
export function telegramPersonName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) || "Someone";
}

/** Telegram usernames are 5 to 32 letters, digits and underscores. */
export function telegramUsername(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : undefined;
}

/** Waiting and let-in people count toward the cap. Declined and removed
 * ones do not, or a hundred knocks would shut the door for good. */
export function activeTelegramPeople(state: AgentTelegram | undefined): TelegramPerson[] {
  return Object.values(state?.people ?? {}).filter((p) => p.state === "pending" || p.state === "allowed");
}

export function isPrivateTelegramHuman(message: Incoming): boolean {
  return !message.press && message.fromBot === false && !message.anonymous && message.chatType === "private" &&
    Number.isSafeInteger(message.fromId) && message.fromId! > 0 && Number.isSafeInteger(message.chatId) && message.chatId > 0;
}

export function knockTelegram(state: AgentTelegram, message: Incoming, group?: TelegramDestination): { person?: TelegramPerson; fresh: boolean; capped: boolean; forget?: string[] } {
  if (group ? !group.group || !validTelegramDestination(group) || group.chatId !== message.chatId ||
    (message.chatType !== "group" && message.chatType !== "supergroup") || message.fromBot !== false || message.anonymous || message.automaticForward || !Number.isSafeInteger(message.fromId) || message.fromId! <= 0 : !isPrivateTelegramHuman(message)) return { fresh: false, capped: false };
  const known = state.people?.[String(message.fromId)];
  if (known) return { person: known, fresh: false, capped: false };
  const active = activeTelegramPeople(state);
  if (active.length >= MAX_TELEGRAM_PEOPLE || active.filter((p) => p.state === "pending").length >= MAX_PENDING_TELEGRAM_PEOPLE) {
    return { fresh: false, capped: true };
  }
  // Closed records stay bounded too: past the bound the longest closed
  // is forgotten, and that person may knock again.
  const closed = Object.entries(state.people ?? {}).filter(([, p]) => p.state === "declined" || p.state === "removed")
    .sort(([, a], [, b]) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const forget = closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_TELEGRAM_PEOPLE + 1)).map(([key]) => key);
  const text = message.text.slice(0, MAX_TELEGRAM_REPLY_CHARS) + (message.media ? "\n(Media was not downloaded before admission. Ask the sender to send it again.)" : "");
  const username = telegramUsername(message.fromUsername);
  return { fresh: true, capped: false, ...(forget.length ? { forget } : {}), person: {
    id: randomUUID(), userId: message.fromId!, name: telegramPersonName(message.from), ...(username ? { username } : {}), ...(!group ? { chatId: message.chatId } : {}),
    state: "pending", grant: randomUUID(), first: { text, ...(message.messageId ? { messageId: message.messageId } : {}), destination: group ?? { chatId: message.chatId, messageId: message.messageId } },
  } };
}

/** How the owner tells this person from anyone else of the same name. */
export function telegramPersonHandle(person: Pick<TelegramPerson, "userId" | "username">): string {
  return `${person.username ? `@${person.username}, ` : ""}Telegram id ${person.userId}`;
}

/** Others on this bot who go by the same name, ignoring case. */
export function telegramNamesakes(state: AgentTelegram | undefined, person: Pick<TelegramPerson, "id" | "name">): TelegramPerson[] {
  const name = person.name.toLocaleLowerCase();
  return Object.values(state?.people ?? {}).filter((p) => p.id !== person.id && p.name.toLocaleLowerCase() === name);
}

export function telegramSender(botId: string, state: AgentTelegram, person: TelegramPerson, messageId?: number, destination?: TelegramDestination): TelegramSender {
  const requester = "telegram:" + createHash("sha256").update(JSON.stringify([botId, state.generation, person.id, person.grant])).digest("hex").slice(0, 32);
  return { botId, bindingGeneration: state.generation, personId: person.id, userId: person.userId, name: person.name, grant: person.grant, ...(destination ?? { chatId: person.chatId!, ...(messageId ? { messageId } : {}) }), requester };
}

export function telegramSenderCurrent(state: AgentTelegram | undefined, sender: TelegramSender): boolean {
  const person = state?.people?.[String(sender.userId)];
  return Boolean(state?.enabled && state.token && state.generation === sender.bindingGeneration &&
    person?.state === "allowed" && person.id === sender.personId && person.grant === sender.grant &&
    validTelegramDestination(sender) && (sender.group || person.chatId === sender.chatId) &&
    (telegramSender(sender.botId, state, person).requester === sender.requester ||
      // Pending private messages from PR2 remain person turns. Their old
      // requester included the learned private chat, which groups do not.
      (!sender.group && "telegram:" + createHash("sha256").update(JSON.stringify([sender.botId, state.generation, person.id, person.grant, person.chatId])).digest("hex").slice(0, 32) === sender.requester)));
}

export function telegramOwnerGroupCurrent(state: AgentTelegram | undefined, sender: TelegramOwnerGroup): boolean {
  return Boolean(state?.enabled && state.token && state.generation === sender.bindingGeneration &&
    sender.owner === true && sender.requester === "owner" && Number.isSafeInteger(sender.userId) && sender.userId > 0 && sender.userId === state.ownerUserId &&
    sender.group && validTelegramDestination(sender));
}

export function telegramReplySenderCurrent(state: AgentTelegram | undefined, sender: TelegramReplySender): boolean {
  return "owner" in sender ? telegramOwnerGroupCurrent(state, sender) : telegramSenderCurrent(state, sender);
}

/** A sender who still holds the owner's grant of full access: the same
 * person, grant, chat and connection, and that grant still full. Every
 * change to it makes a new grant, so a sender from before is not one. */
export function telegramDelegateCurrent(state: AgentTelegram | undefined, sender: TelegramSender): boolean {
  return !sender.group && telegramSenderCurrent(state, sender) && state?.people?.[String(sender.userId)]?.full === true;
}

/** The same person under the same grant, or both nobody: whose words may
 * join a turn, and whose turns are kept apart. */
export function sameTelegramDelegate(a: TelegramSender | undefined, b: TelegramSender | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.requester === b.requester);
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
