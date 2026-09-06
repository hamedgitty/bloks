// Reaching your agents from a phone you have not installed anything on.
//
// The iPhone app is the better answer for people who want an app. This
// is for the rest of it: a borrowed phone, an Android, a laptop in
// somebody else's kitchen. You message a bot, an agent answers, and the
// conversation lands in the same thread as everything else.
//
// It runs on this Mac and talks to Telegram directly. No relay, nothing
// new listening on a port, and no inbound connection at all: long
// polling means the machine asks Telegram whether anything arrived,
// which is the same direction of travel as every other call the app
// makes and needs no router touched.
//
// Two things carry the security of it, and both are deliberate.
//
//   Nobody who is not on the list gets an answer. A bot's username is
//   discoverable, so anybody can message it. An unknown chat is refused
//   once, plainly, and never reaches an agent: without that, a stranger
//   would be talking to something with a shell on this machine.
//
//   The first person to say the pairing word owns the bot. Chat ids are
//   not guessable and there is no directory of them, so the honest way
//   to learn yours is to have you send it. The word is single use and
//   the pairing closes behind it.
import { clamp } from "./limits.ts";

const API = "https://api.telegram.org";

export interface TelegramState {
  /** Bot token from BotFather. Lives in the secrets file. */
  token?: string;
  /** Chats allowed to talk to this workspace. */
  chatIds?: number[];
  /** Which agent answers. Unset means the first one. */
  botId?: string;
  /** Set while a pairing word is outstanding. */
  pairing?: string | null;
  /** Where the last poll got to. */
  offset?: number;
  enabled?: boolean;
}

export interface Incoming {
  chatId: number;
  from: string;
  text: string;
  updateId: number;
}

/** What Telegram sends back from getUpdates, reduced to what we use. */
export function parseUpdates(payload: unknown): Incoming[] {
  const result = (payload as { ok?: boolean; result?: unknown[] })?.result;
  if (!Array.isArray(result)) return [];
  const out: Incoming[] = [];
  for (const raw of result) {
    // Entries are whatever the wire held: a null or a number in the list
    // should cost that entry, not the whole batch.
    if (!raw || typeof raw !== "object") continue;
    const update = raw as Record<string, any>;
    const message = update.message ?? update.edited_message;
    const chatId = Number(message?.chat?.id);
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    const updateId = Number(update.update_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(updateId) || !text) continue;
    out.push({
      chatId,
      updateId,
      text: text.slice(0, 4_000),
      from: String(message?.from?.first_name ?? "someone").slice(0, 60),
    });
  }
  return out;
}

/**
 * What to do with one message, decided without touching anything.
 *
 * Pure so the rules that matter here can be read in one place and tested
 * exhaustively, rather than being spread through a polling loop.
 */
export type Decision =
  | { kind: "pair"; chatId: number }
  | { kind: "deliver"; chatId: number; text: string }
  | { kind: "refuse"; chatId: number }
  | { kind: "ignore" };

export function decide(state: TelegramState, message: Incoming): Decision {
  const allowed = state.chatIds ?? [];
  if (allowed.includes(message.chatId)) {
    return { kind: "deliver", chatId: message.chatId, text: message.text };
  }
  // A pairing word is single use and compared whole, so a stranger
  // guessing at it gets the same silence as a stranger who does not.
  if (state.pairing && message.text.trim() === state.pairing) {
    return { kind: "pair", chatId: message.chatId };
  }
  // Refuse once per chat rather than on every message: somebody who
  // found the bot and keeps typing should not get a wall of replies.
  return { kind: "refuse", chatId: message.chatId };
}

/** The word a person sends to claim the bot. Short enough to type on a
 * phone, long enough that guessing it is not a strategy. */
export function pairingWord(random: () => number = Math.random): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let word = "";
  for (let i = 0; i < 8; i++) word += alphabet[Math.floor(random() * alphabet.length)];
  return word;
}

async function call(token: string, method: string, body: unknown, timeoutMs = 15_000) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
  return response.json();
}

/** Who this token belongs to, and proof that it works. */
export async function whoAmI(token: string): Promise<{ username: string }> {
  const body = (await call(token, "getMe", {})) as { result?: { username?: string } };
  const username = body?.result?.username;
  if (!username) throw new Error("that token was refused");
  return { username };
}

export async function send(token: string, chatId: number, text: string): Promise<void> {
  // Telegram refuses anything over 4096, and a long answer arriving as
  // an error is worse than one arriving trimmed.
  await call(token, "sendMessage", { chat_id: chatId, text: text.slice(0, 4_000) });
}

/**
 * Ask once for whatever has arrived.
 *
 * Long polling with a short timeout: long enough that an idle workspace
 * is not hammering Telegram, short enough that quitting the app does not
 * wait half a minute for a socket to close.
 */
export async function poll(token: string, offset: number): Promise<Incoming[]> {
  const body = await call(
    token,
    "getUpdates",
    { offset, timeout: 20, allowed_updates: ["message"] },
    30_000,
  );
  return parseUpdates(body);
}

/** The offset to ask from next time: one past the highest seen. */
export function nextOffset(current: number, messages: Incoming[]): number {
  return messages.reduce((highest, message) => Math.max(highest, message.updateId + 1), current);
}

/** Trim a token to something storable, without judging its shape: the
 * format is Telegram's to change, and getMe is the real check. */
export function cleanToken(value: unknown): string | undefined {
  return clamp(value, 120);
}
