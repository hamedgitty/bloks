// Telegram belongs to one agent. Tokens and pairing state stay in the
// private config, separate from the agent records sent to a client.
import { randomUUID } from "node:crypto";
import { pairingWord, type TelegramState } from "./telegram.ts";
import type { TelegramPerson, TelegramUpgradeNotice } from "./telegram-people.ts";
import { MAX_TELEGRAM_PEOPLE, MAX_PENDING_TELEGRAM_PEOPLE } from "./limits.ts";

export interface AgentTelegram extends TelegramState {
  generation: string;
  telegramId?: number;
  username?: string;
  ownerUserId?: number;
  ownerChatId?: number;
  people?: Record<string, TelegramPerson>;
  upgradeNotices?: TelegramUpgradeNotice[];
  admissionFull?: boolean;
  upgradeAppNotice?: string;
}

/** The old fields are read only for migration. Once migrated, no token or
 * chat grant lives at the top level. A missing agent keeps the old record
 * private and stopped until the owner chooses where it belongs. */
export interface TelegramConfig extends TelegramState {
  version?: 1 | 2;
  bots?: Record<string, AgentTelegram>;
  migratedBotId?: string;
  pending?: TelegramState & { upgradeNotices?: TelegramUpgradeNotice[] };
  migrationError?: string;
}

type Agent = { id: string; hidden?: boolean };

export function migrateTelegram(before: TelegramConfig | undefined, agents: readonly Agent[]): TelegramConfig {
  if (before?.version === 1 || before?.version === 2) return before;
  const bots = { ...(before?.bots ?? {}) };
  if (!before?.token) return { version: 1, bots };
  // An explicit choice is never replaced by the first available agent.
  const owner = before.botId ? agents.find((agent) => agent.id === before.botId) : agents.find((agent) => !agent.hidden);
  const legacy: TelegramState = {
    token: before.token,
    enabled: before.enabled,
    offset: before.offset,
    chatIds: [...(before.chatIds ?? [])],
    ...(before.botId ? { botId: before.botId } : {}),
  };
  if (!owner || bots[owner.id]) {
    return {
      version: 1, bots, pending: legacy,
      migrationError: !owner ? "The agent for your previous Telegram bot is no longer here. Choose an agent for it." : "This agent already has a Telegram bot. Choose an agent for your previous bot.",
    };
  }
  bots[owner.id] = legacyBinding(legacy);
  return { version: 1, bots, migratedBotId: owner.id };
}

export function legacyBinding(legacy: TelegramState & { upgradeNotices?: TelegramUpgradeNotice[] }): AgentTelegram {
  return {
    token: legacy.token, enabled: legacy.enabled === true,
    offset: legacy.offset ?? 0, chatIds: [...(legacy.chatIds ?? [])],
    // A word someone used to pair another chat must not identify the owner.
    pairing: null, generation: randomUUID(),
    ...(legacy.upgradeNotices ? { upgradeNotices: legacy.upgradeNotices, people: {} } : {}),
  };
}

export function pairedChats(state: AgentTelegram): number[] {
  return [...new Set([...(state.chatIds ?? []), ...(state.ownerChatId === undefined ? [] : [state.ownerChatId])])];
}

/** Only the verified private owner reaches this inbox. People have a
 * separate inbox whose answers can never approve an owner card. */
export function inboxState(state: AgentTelegram): TelegramState {
  return { ...state, pairOwner: true };
}

export function telegramStatus(state: AgentTelegram | undefined) {
  return {
    configured: Boolean(state?.token), enabled: state?.enabled === true,
    paired: state ? pairedChats(state).length : 0,
    legacyPaired: state?.chatIds?.length ?? 0,
    ownerPaired: state?.ownerUserId !== undefined,
    needsOwnerPairing: Boolean(state?.token && state.ownerUserId === undefined),
    pairing: state?.pairing ?? null, username: state?.username ?? null,
    people: Object.values(state?.people ?? {}).map(({ id, name, state }) => ({ id, name, state })),
    upgradeNotices: state?.upgradeNotices?.map(({ state }) => ({ state })) ?? [],
    admissionFull: Object.values(state?.people ?? {}).length >= MAX_TELEGRAM_PEOPLE ||
      Object.values(state?.people ?? {}).filter((p) => p.state === "pending").length >= MAX_PENDING_TELEGRAM_PEOPLE,
  };
}

/** getMe has already validated the token. Rotation to the same Telegram
 * bot keeps its owner and offset, but never its in-flight transport work. */
export function replaceTelegramToken(before: AgentTelegram | undefined, token: string, me: { id: number; username: string }): AgentTelegram {
  const same = before?.telegramId === me.id || before?.token === token;
  const next = same && before ? { ...before } : { chatIds: [], offset: 0, pairing: null };
  return { ...next, token, telegramId: me.id, username: me.username, generation: randomUUID(), enabled: true };
}

export function ownerPairing(state: AgentTelegram): AgentTelegram {
  return { ...state, pairing: pairingWord(), enabled: true };
}
