// Cards sent to a phone, answered with a tap.
//
// A card forwarded to Telegram carries its choices as buttons. What a
// button says when pressed is a short random token and the choice's
// place, never the request id: Telegram allows a button 64 bytes, an
// engine's request id has no such promise, and a token that means
// nothing outside this process cannot be replayed into one it was not
// made for. The token is only kept in memory, so a restart turns every
// old button into one that answers "already closed", which is the truth:
// nothing that was waiting on it is waiting any more.
//
// The same record is how a card answered somewhere else (the app, the
// phone typing, a turn that ended) is rewritten in the chat to say so,
// with its buttons gone, rather than offering a choice nobody can make.
import { randomBytes } from "node:crypto";

import { cardAsks, describeCard, type Keyboard } from "./telegram.ts";

export interface ForwardedCard {
  requestId: string;
  botId: string;
  chatId: number;
  options: string[];
  permission: boolean;
  /** What the card asks, kept so its message can be rewritten with how
   * it was answered underneath, and without how to answer it. */
  text: string;
  /** What its buttons carry, when it has any. */
  token?: string;
  /** Which message it became, once Telegram has said. */
  messageId?: number;
  /** What an answer from anywhere carried, noted just before it went,
   * since the engine only reports whether it was allowed or answered. */
  answer?: string;
  /** How it was answered, once it has been. */
  settled?: string;
  /** Its message says how, or is about to. */
  rewritten?: boolean;
  expires: number;
}

/** A card left unanswered this long is forgotten. Long enough for a
 * night's sleep; an engine has given up waiting well before it. */
export const CARD_TTL_MS = 24 * 60 * 60_000;

/** How long an answered card is remembered, for a second tap. */
const SETTLED_TTL_MS = 10 * 60_000;

/** More choices than this and they are typed, by number: a phone screen
 * of buttons is harder to read than the list. */
export const MAX_BUTTONS = 8;

/** A button shows a line, not a paragraph. The whole choice is still
 * what the agent is told. */
const BUTTON_CHARS = 60;

const TOKEN = /^([\w-]{8}):(\d{1,2})$/;

/** Allow and Deny side by side, the way a phone asks; a question's
 * choices one to a row, since they are sentences more often than words. */
export function keyboardFor(token: string, options: string[], permission: boolean): Keyboard {
  const buttons = options.map((option, i) => ({ text: option.slice(0, BUTTON_CHARS), callback_data: `${token}:${i}` }));
  return { inline_keyboard: permission ? [buttons] : buttons.map((button) => [button]) };
}

/** How a card was answered, in the words its message is rewritten with.
 * Only the person (anywhere) answers a card; an engine giving up on it,
 * or a turn ending under it, closed it without an answer. */
export function outcomeOf(card: ForwardedCard, behavior: string, source: string): string {
  if (source !== "user") return "Closed without an answer.";
  if (behavior === "allow") return "Allowed";
  if (behavior === "deny") return "Denied";
  const said = card.answer?.trim();
  return said ? `Answered: ${said.slice(0, 200)}` : "Answered";
}

/** The card's message once answered: what it asked, then how. */
export function settledText(card: ForwardedCard): string {
  return `${card.text}\n\n${card.settled ?? ""}`.trim();
}

export class CardButtons {
  /** By request id. */
  private cards = new Map<string, ForwardedCard>();
  /** Token to request id. */
  private tokens = new Map<string, string>();
  private ttlMs: number;

  constructor(ttlMs = CARD_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * A card on its way to a chat: the words to send and the buttons to
   * send under them. A question with no choices has no buttons, and is
   * answered by typing as it always was.
   */
  forward(
    card: { requestId: string; botId: string; chatId: number; permission: boolean; title?: string; subtitle?: string; options?: string[] },
    now = Date.now(),
  ): { text: string; keyboard?: Keyboard } {
    this.prune(now);
    const options = card.options ?? [];
    const token = options.length && options.length <= MAX_BUTTONS ? this.newToken() : undefined;
    this.forget(card.requestId);
    this.cards.set(card.requestId, {
      requestId: card.requestId,
      botId: card.botId,
      chatId: card.chatId,
      options,
      permission: card.permission,
      text: cardAsks(card),
      expires: now + this.ttlMs,
      ...(token ? { token } : {}),
    });
    if (token) this.tokens.set(token, card.requestId);
    return {
      text: describeCard(card, Boolean(token)),
      ...(token ? { keyboard: keyboardFor(token, options, card.permission) } : {}),
    };
  }

  /**
   * Telegram said which message the card became. Returns the card when
   * it was answered before Telegram said, so the caller can rewrite it
   * now; nothing else could have.
   */
  sent(requestId: string, messageId: number): ForwardedCard | undefined {
    const card = this.cards.get(requestId);
    if (!card) return undefined;
    card.messageId = messageId;
    if (card.settled === undefined || card.rewritten) return undefined;
    card.rewritten = true;
    return card;
  }

  /**
   * A button pressed in `chatId`, under message `messageId`, carrying
   * `data`. The card is settled before anything is sent to the engine,
   * so the engine reporting the answer back does not rewrite it twice.
   * A card answered already says how, so a second tap changes nothing;
   * one this process never sent, or sent to another chat, or under
   * another message, is null.
   */
  press(
    chatId: number,
    messageId: number,
    data: string,
    now = Date.now(),
  ): { card: ForwardedCard; option: string } | { settled: string } | null {
    this.prune(now);
    const match = TOKEN.exec(data);
    const requestId = match ? this.tokens.get(match[1]!) : undefined;
    const card = requestId ? this.cards.get(requestId) : undefined;
    if (!card || card.chatId !== chatId) return null;
    if (card.messageId !== undefined && card.messageId !== messageId) return null;
    if (card.settled !== undefined) return { settled: card.settled };
    const option = card.options[Number(match![2])];
    if (option === undefined) return null;
    card.answer = option;
    this.settled(card, card.permission ? (option === card.options[0] ? "Allowed" : "Denied") : `Answered: ${option.slice(0, 200)}`, now);
    card.rewritten = true;
    return { card, option };
  }

  /** What an answer is about to carry, from wherever it was given. */
  expect(requestId: string, answer: string | undefined): void {
    const card = this.cards.get(requestId);
    if (card && card.settled === undefined && answer !== undefined) card.answer = answer;
  }

  /**
   * The card was answered, or closed. Returns it, settled, when its
   * message should be rewritten now: not when a press already did that,
   * and not before Telegram has said which message it is (see `sent`).
   */
  settle(requestId: string, outcome: (card: ForwardedCard) => string, now = Date.now()): ForwardedCard | undefined {
    const card = this.cards.get(requestId);
    if (!card || card.settled !== undefined) return undefined;
    this.settled(card, outcome(card), now);
    if (card.messageId === undefined) return undefined;
    card.rewritten = true;
    return card;
  }

  /** A press that did not reach the engine says so instead. */
  reword(card: ForwardedCard, settled: string): void {
    card.settled = settled;
  }

  private settled(card: ForwardedCard, outcome: string, now: number): void {
    card.settled = outcome;
    // Kept a little while, so a second tap is told what the first did,
    // and then let go: an answered card needs no day of memory.
    card.expires = Math.min(card.expires, now + SETTLED_TTL_MS);
  }

  private newToken(): string {
    for (;;) {
      const token = randomBytes(6).toString("base64url");
      if (!this.tokens.has(token)) return token;
    }
  }

  private forget(requestId: string): void {
    const card = this.cards.get(requestId);
    if (!card) return;
    this.cards.delete(requestId);
    if (card.token) this.tokens.delete(card.token);
  }

  private prune(now: number): void {
    for (const [requestId, card] of this.cards) if (card.expires < now) this.forget(requestId);
  }
}
