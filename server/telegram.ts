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
import { IMAGE_MAX_BYTES, VOICE_MAX_BYTES } from "./attachments.ts";
import { clamp, MAX_MESSAGE_CHARS, MAX_TELEGRAM_REPLY_CHARS } from "./limits.ts";
import { deliveries } from "./telegram-format.ts";
import { clipTelegramText, TELEGRAM_MESSAGE_CHARS } from "./telegram-reply.ts";
import { randomInt } from "node:crypto";

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
  /** New bot bindings learn the owner from a private, single-use word. */
  pairOwner?: boolean;
  ownerUserId?: number;
  ownerChatId?: number;
  generation?: string;
}

/** Supplied display context, in the same shape as an in-app reply. */
type ReplyRef = NonNullable<import("./store.ts").Message["replyTo"]>;

export interface Incoming {
  messageId?: number;
  replyToMessageId?: number;
  chatId: number;
  from: string;
  /** What was typed, or the caption under a photo or a file. */
  text: string;
  updateId: number;
  fromId?: number;
  /** The sender's @username, unchecked; telegram-people.ts validates it. */
  fromUsername?: string;
  fromBot?: boolean;
  chatType?: "private" | "group" | "supergroup" | "channel";
  anonymous?: boolean;
  /** Anything that came instead of, or as well as, text. */
  media?: Media;
  /** The supplied same-chat message being answered, without a lookup. */
  replyTo?: ReplyRef;
  /** Photos sent together arrive as separate updates sharing this. */
  album?: string;
  /** A button pressed under one of the bot's own messages, instead of
   * anything said. */
  press?: Press;
}

/**
 * A tap on a button the bot sent.
 *
 * Who pressed it is kept apart from where, because they can differ: a
 * group the bot sits in shows every member the same buttons.
 */
export interface Press {
  /** Telegram's id for the press, which the answer to it names. */
  id: string;
  /** What the bot put on the button, never more than 64 bytes. */
  data: string;
  /** The message the button is under. */
  messageId: number;
  /** The person who pressed it. */
  fromId: number;
}

/**
 * What a message carried besides text.
 *
 * Kept even for the kinds the bot cannot take, because the alternative
 * is the old behaviour: the offset moves past the update and the person
 * is left believing their agent saw a photo it never got.
 */
export type Media =
  | { kind: "voice"; fileId: string; bytes: number }
  | { kind: "image"; fileId: string; bytes: number; mime: string }
  | { kind: "file"; fileId: string; bytes: number; what: string; mime: string; name?: string }
  /** `what` is how the reply names it, plural: "videos", "stickers". */
  | { kind: "other"; what: string; bytes?: number };

/** The images a pasted image may be, so Telegram's match the app's. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A GIF also carries a document, so animation is checked first. */
const FILES: [field: string, what: string][] = [
  ["animation", "GIFs"], ["video", "videos"], ["video_note", "video messages"], ["audio", "audio files"],
];

/** Content the bot cannot take, named in the refusal. */
const OTHER: [field: string, what: string][] = [
  ["sticker", "stickers"],
  ["location", "locations"],
  ["venue", "locations"],
  ["contact", "contacts"],
  ["poll", "polls"],
  ["dice", "dice"],
  ["game", "games"],
  ["story", "stories"],
];

const sizeOf = (file: Record<string, any>): number => {
  const bytes = Number(file.file_size);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
};

function fileMedia(file: Record<string, any>, what: string): Media {
  const fileId = typeof file.file_id === "string" ? clamp(file.file_id, 1024) : undefined;
  const bytes = sizeOf(file);
  return { kind: "file", fileId: fileId ?? "", bytes, what,
    mime: typeof file.mime_type === "string" ? file.mime_type.slice(0, 120).toLowerCase() : "",
    ...(typeof file.file_name === "string" ? { name: file.file_name.slice(0, 300) } : {}),
  };
}

// Unchecked files must not get names the image/voice serving route takes.
const FILE_EXTENSIONS = new Map([
  ["application/pdf", "pdf"], ["text/plain", "txt"], ["text/csv", "csv"], ["application/json", "json"],
  ["application/zip", "zip"], ["video/mp4", "mp4"], ["video/webm", "webm"], ["video/quicktime", "mov"],
  ["audio/mpeg", "mp3"], ["audio/mp4", "m4a"], ["audio/ogg", "oga"], ["audio/wav", "wav"], ["audio/flac", "flac"],
]);
const SERVED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ogg"]);
function fileExtension(media: Extract<Media, { kind: "file" }>): string {
  const mime = media.mime.split(";")[0]!.trim();
  const known = FILE_EXTENSIONS.get(mime);
  if (known) return known;
  const ext = /\.([a-z0-9]{1,8})$/i.exec(media.name ?? "")?.[1]?.toLowerCase();
  if (ext && !SERVED_EXTENSIONS.has(ext)) return ext;
  return ["videos", "video messages", "GIFs"].includes(media.what) ? "mp4" : "bin";
}

function mediaOf(message: Record<string, any>): Media | undefined {
  const voice = message.voice;
  if (voice && typeof voice.file_id === "string") {
    return { kind: "voice", fileId: voice.file_id, bytes: Number(voice.file_size) || 0 };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    // Telegram sends every size it made; the biggest is the one worth
    // looking at, and it is usually but not promised to be the last.
    const sizes = message.photo.filter((p: any) => p && typeof p.file_id === "string");
    const area = (p: any) => (Number(p.width) || 0) * (Number(p.height) || 0);
    const biggest = sizes.reduce((best: any, p: any) => (!best || area(p) > area(best) ? p : best), null);
    if (biggest) {
      return { kind: "image", fileId: biggest.file_id, bytes: Number(biggest.file_size) || 0, mime: "image/jpeg" };
    }
  }
  for (const [field, what] of FILES) {
    if (message[field] !== undefined && message[field] !== null) return fileMedia(message[field], what);
  }
  for (const [field, what] of OTHER) {
    if (message[field] !== undefined && message[field] !== null) {
      return { kind: "other", what, ...(field === "sticker" ? { bytes: sizeOf(message[field]) } : {}) };
    }
  }
  const document = message.document;
  if (document) {
    const mime = typeof document.mime_type === "string" ? document.mime_type.slice(0, 120).toLowerCase() : "";
    // An image sent "as a file" keeps its full resolution, which is
    // often exactly why somebody sent it that way.
    if (IMAGE_MIMES.has(mime) && typeof document.file_id === "string" && document.file_id) {
      return { kind: "image", fileId: document.file_id, bytes: Number(document.file_size) || 0, mime };
    }
    if (mime.startsWith("image/")) return { kind: "other", what: `${mime.slice(6).toUpperCase()} images`, bytes: sizeOf(document) };
    return fileMedia(document, "files");
  }
  return undefined;
}

/** Work and output stay bounded even for malformed oversized supplied fields. */
function replyDisplay(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.slice(0, 4096).replace(/\s+/g, " ").trim().slice(0, limit) || undefined;
}

/** RichText wrappers contain only display text. Unknown fields, media and
 * nested messages never become part of the excerpt. */
const RICH_TEXT_WRAPPERS = new Set([
  "bold", "italic", "underline", "strikethrough", "spoiler", "date_time",
  "text_mention", "subscript", "superscript", "marked", "code", "url",
  "email_address", "phone_number", "bank_card_number", "mention", "hashtag",
  "cashtag", "bot_command", "anchor_link", "reference", "reference_link",
]);

/** Supplied rich messages have no ordinary message.text. Bounds apply to
 * visited nodes, nesting, input text inspected and the final excerpt. */
function richReplyText(value: unknown): string | undefined {
  const rich = value as { blocks?: unknown } | null;
  if (!rich || !Array.isArray(rich.blocks)) return undefined;
  let nodes = 512;
  let input = 4096;
  let text = "";
  const write = (part: string) => { text += part.slice(0, 200 - text.length); };
  const append = (value: unknown, depth = 0): void => {
    if (--nodes < 0 || depth > 16 || text.length >= 200) return;
    if (typeof value === "string") {
      const part = value.slice(0, input);
      input -= part.length;
      write(part.replace(/\s+/g, " "));
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length && nodes > 0 && text.length < 200; i++) append(value[i], depth + 1);
    } else if (value && typeof value === "object") {
      const part = value as Record<string, unknown>;
      if (RICH_TEXT_WRAPPERS.has(String(part.type))) append(part.text, depth + 1);
      else if (part.type === "custom_emoji") append(part.alternative_text, depth + 1);
    }
  };
  for (const block of rich.blocks.slice(0, 50)) {
    if (nodes <= 0 || text.length >= 200) break;
    nodes--;
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "table" && Array.isArray(b.cells)) {
      let rows = 0;
      for (const row of b.cells.slice(0, 400)) {
        if (nodes <= 0 || text.length >= 200) break;
        nodes--;
        if (!Array.isArray(row)) continue;
        if (rows++) write("; ");
        for (let i = 0; i < Math.min(row.length, 20) && nodes > 0 && text.length < 200; i++) {
          nodes--;
          if (i) write(" | ");
          const cell = row[i];
          if (cell && typeof cell === "object" && !Array.isArray(cell)) append(cell.text);
        }
      }
    } else if (["paragraph", "heading", "pre", "footer"].includes(String(b.type))) append(b.text);
    write(" ");
  }
  return replyDisplay(text, 200);
}

/** Telegram supplies the original for same-chat replies. Never fetch its media,
 * walk nested replies or infer a target from a quote/forward/external reply. */
function replyOf(message: Record<string, any>, chatId: number): ReplyRef | undefined {
  const replied = message.reply_to_message;
  if (!replied || typeof replied !== "object" || Array.isArray(replied)) return undefined;
  if (replied.chat?.id !== undefined && replied.chat.id !== chatId) return undefined;
  const author = (replied.sender_chat
    ? replyDisplay(replied.sender_chat.title, 60) ?? replyDisplay(replied.sender_chat.username, 60)
    : replyDisplay(replied.from?.first_name, 60)) ?? "Someone";
  const media = [
    ["document", "File"], ["photo", "Photo"], ["voice", "Voice message"],
    ["video", "Video"], ["video_note", "Video message"], ["audio", "Audio"],
    ["animation", "Animation"], ["sticker", "Sticker"], ["location", "Location"],
    ["venue", "Place"], ["contact", "Contact"], ["poll", "Poll"],
  ].find(([field]) => replied[field!] != null)?.[1];
  const filename = replyDisplay(replied.document?.file_name, 160);
  const excerpt = replyDisplay(message.quote?.text, 200)
    ?? replyDisplay(replied.text, 200) ?? replyDisplay(replied.caption, 200)
    ?? richReplyText(replied.rich_message)
    ?? (media ? `[${media}${media === "File" && filename ? `: ${filename}` : ""}]` : "[Message content unavailable]");
  const id = Number.isSafeInteger(chatId) && chatId !== 0 && Number.isSafeInteger(replied.message_id) && replied.message_id > 0
    ? `tg:${chatId}:${replied.message_id}` : undefined;
  return { ...(id ? { id } : {}), author, excerpt };
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
    const press = pressOf(update);
    if (press) {
      out.push(press);
      continue;
    }
    const message = update.message ?? update.edited_message;
    const chatId = Number(message?.chat?.id);
    const said = typeof message?.text === "string" ? message.text : message?.caption;
    const text = typeof said === "string" ? said.trim() : "";
    const updateId = Number(update.update_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(updateId)) continue;
    const media = mediaOf(message);
    // Joins, leaves, pins and the rest of the service messages carry
    // neither, and are nothing anybody said.
    if (!text && !media) continue;
    const replyTo = replyOf(message, chatId);
    const album = typeof message.media_group_id === "string" ? message.media_group_id.slice(0, 64) : undefined;
    out.push({
      chatId,
      updateId,
      ...(Number.isSafeInteger(message.message_id) && message.message_id > 0 ? { messageId: message.message_id } : {}),
      ...(Number.isSafeInteger(message.reply_to_message?.message_id) && message.reply_to_message.message_id > 0 ? { replyToMessageId: message.reply_to_message.message_id } : {}),
      text: text.slice(0, 4_000),
      from: String(message?.from?.first_name ?? "someone").slice(0, 60),
      ...(Number.isSafeInteger(message.from?.id) && message.from.id > 0 ? { fromId: message.from.id } : {}),
      ...(typeof message.from?.username === "string" ? { fromUsername: message.from.username.slice(0, 64) } : {}),
      ...(typeof message.from?.is_bot === "boolean" ? { fromBot: message.from.is_bot } : {}),
      ...(["private", "group", "supergroup", "channel"].includes(message.chat?.type) ? { chatType: message.chat.type } : {}),
      ...(message.sender_chat ? { anonymous: true } : {}),
      ...(media ? { media } : {}),
      ...(album ? { album } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }
  return out;
}

/** A button press, when that is what the update is. Every part of it is
 * required: a press that cannot say where it was, who made it or what it
 * carried cannot be checked, and is nothing to act on. */
function pressOf(update: Record<string, any>): Incoming | null {
  const query = update.callback_query;
  if (!query || typeof query !== "object") return null;
  const chatId = Number(query.message?.chat?.id);
  const messageId = Number(query.message?.message_id);
  const fromId = Number(query.from?.id);
  const updateId = Number(update.update_id);
  if (![chatId, messageId, fromId, updateId].every(Number.isFinite)) return null;
  if (typeof query.id !== "string" || typeof query.data !== "string") return null;
  return {
    chatId,
    updateId,
    text: "",
    from: String(query.from?.first_name ?? "someone").slice(0, 60),
    ...(typeof query.from?.is_bot === "boolean" ? { fromBot: query.from.is_bot } : {}),
    ...(["private", "group", "supergroup", "channel"].includes(query.message?.chat?.type) ? { chatType: query.message.chat.type } : {}),
    press: { id: query.id.slice(0, 100), data: query.data.slice(0, 64), messageId, fromId },
  };
}

/**
 * What to do with one message, decided without touching anything.
 *
 * Pure so the rules that matter here can be read in one place and tested
 * exhaustively, rather than being spread through a polling loop.
 */
export type Decision =
  | { kind: "pair"; chatId: number; userId?: number }
  | { kind: "deliver"; chatId: number; text: string; media?: Media; album?: string; replyTo?: ReplyRef }
  | { kind: "press"; chatId: number; press: Press }
  | { kind: "refuse"; chatId: number }
  | { kind: "ignore" };

export function decide(state: TelegramState, message: Incoming): Decision {
  const allowed = state.chatIds ?? [];
  const human = message.fromBot === false && !message.anonymous;
  const sender = message.press?.fromId ?? message.fromId;
  // Ids compared only once both are real ones: two missing ids are equal too.
  const privateOwner = human && message.chatType === "private" && Number.isSafeInteger(sender) && sender! > 0 &&
    sender === state.ownerUserId && Number.isSafeInteger(message.chatId) && message.chatId === state.ownerChatId;
  if (state.pairOwner && state.pairing && !message.press && !message.media && message.text.trim() === state.pairing) {
    return human && message.chatType === "private" && Number.isSafeInteger(sender) && sender! > 0 && Number.isSafeInteger(message.chatId) && message.chatId > 0
      ? { kind: "pair", chatId: message.chatId, userId: sender }
      : { kind: "ignore" };
  }
  if (message.press) {
    // A button answers a card, and a card can allow a command on this
    // machine, so it counts only from a paired chat and from the person
    // it was paired with: in a chat with one person the two ids are the
    // same. Anyone else who can see it, in a group, gets nothing back at
    // all, not even the refusal: there is nothing here for them.
    const { fromId } = message.press;
    const paired = privateOwner || (allowed.includes(message.chatId) && (fromId === message.chatId || allowed.includes(fromId)));
    return paired ? { kind: "press", chatId: message.chatId, press: message.press } : { kind: "ignore" };
  }
  if (privateOwner || allowed.includes(message.chatId)) {
    return {
      kind: "deliver",
      chatId: message.chatId,
      text: message.text,
      ...(message.media ? { media: message.media } : {}),
      ...(message.album ? { album: message.album } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    };
  }
  // A pairing word is single use and compared whole, so a stranger
  // guessing at it gets the same silence as a stranger who does not.
  if (!state.pairOwner && state.pairing && !message.media && message.text.trim() === state.pairing) {
    return { kind: "pair", chatId: message.chatId };
  }
  // Refuse once per chat rather than on every message: somebody who
  // found the bot and keeps typing should not get a wall of replies.
  return { kind: "refuse", chatId: message.chatId };
}

/**
 * The reply to something the bot could not pass on.
 *
 * Every one says it did not arrive, because the failure this replaces
 * was silence, and silence reads as "sent". A caption goes on without
 * it, marked so the agent knows something is missing, and the reply
 * says so: the words are the part that is hard to type again.
 */
export function notDelivered(media: Media, captioned = false): string {
  if (media.kind === "voice") {
    return captioned
      ? `I can't read voice messages here yet. ${WITHOUT} Add a speech key in Bloks Settings, or type it.`
      : "I can't read voice messages here yet, so that one did not reach your agent. Add a speech key in Bloks Settings, or type it.";
  }
  if (media.kind === "image") {
    return captioned
      ? `I can't take photos here yet. ${WITHOUT}`
      : "I can't take photos here yet, so that one did not reach your agent.";
  }
  return captioned
    ? `I can't take ${media.what} here. ${WITHOUT}`
    : `I can't take ${media.what} here, so that did not reach your agent.`;
}

/** Told to the person when their caption went on alone. */
const WITHOUT = "Your caption went to your agent without it.";

/**
 * A caption whose attachment did not arrive, with a line saying so.
 *
 * The line is for the agent: without it "what do you make of this?"
 * reads as complete, and the agent answers a question nobody asked. With
 * it, the agent can answer what it can and ask for the rest.
 */
export function withMissing(caption: string, note: string): string {
  return [caption.trim(), `[${note}]`].filter(Boolean).join("\n\n");
}

/** The word a person sends to claim the bot. Short enough to type on a
 * phone, long enough that guessing it is not a strategy. */
export function pairingWord(random?: () => number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let word = "";
  for (let i = 0; i < 8; i++) word += alphabet[random ? Math.floor(random() * alphabet.length) : randomInt(alphabet.length)];
  return word;
}

/** Telegram saying no, with the status kept so a caller can tell a
 * message it could not read from one it was sent too quickly. */
export class TelegramError extends Error {
  status: number;
  /** Seconds Telegram asked us to wait, when it asked. */
  retryAfter: number;
  constructor(status: number, retryAfter = 0) {
    super(`Telegram answered HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function call(token: string, method: string, body: unknown, timeoutMs = 15_000, signal?: AbortSignal) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await refusal(response);
  return response.json();
}

async function refusal(response: Response): Promise<TelegramError> {
  const said = (await response.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
  return new TelegramError(response.status, Number(said?.parameters?.retry_after) || 0);
}

/** Telegram slows a bot that sends quickly by asking it to wait. Waiting
 * once, when the wait is short, keeps a reply or a file from being lost
 * to it; a long wait is an error like any other. */
async function patiently<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof TelegramError) || error.status !== 429 || error.retryAfter > 30) throw error;
    await new Promise((resolve) => setTimeout(resolve, error.retryAfter * 1000));
    return attempt();
  }
}

/** Who this token belongs to, and proof that it works. */
export async function whoAmI(token: string, signal?: AbortSignal): Promise<{ id: number; username: string }> {
  const body = (await call(token, "getMe", {}, 15_000, signal)) as { ok?: boolean; result?: { id?: number; username?: string; is_bot?: boolean } };
  const username = body?.result?.username;
  const id = body?.result?.id;
  if (body.ok !== true || typeof username !== "string" || !username || username.length > 64 || !Number.isSafeInteger(id) || id! <= 0 || body.result?.is_bot !== true) throw new Error("that token was refused");
  return { id: id!, username };
}

/** One message. A long reply is several in a row, and being asked to
 * wait between them should not cost the reply its tail. */
function sendOne(token: string, body: Record<string, unknown>, canSend?: () => boolean, method = "sendMessage"): Promise<unknown> {
  return patiently(() => {
    if (canSend && !canSend()) throw new Error("the Telegram connection changed");
    return call(token, method, body);
  });
}

/** Buttons under a message, in rows. */
export interface Keyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** No buttons at all, which is how a message loses the ones it had. */
const NO_BUTTONS: Keyboard = { inline_keyboard: [] };

/**
 * One plain message, with buttons under it when given, and the id
 * Telegram gave it: a later edit or delete names the message by it.
 * Undefined when Telegram took the message without saying.
 * With silent, a status line leaves the next sound for an answer.
 */
export async function post(token: string, chatId: number, text: string, keyboard?: Keyboard, silent = false, canSend?: () => boolean): Promise<number | undefined> {
  const body = (await sendOne(token, {
    chat_id: chatId,
    text: text.slice(0, TELEGRAM_MESSAGE_CHARS),
    ...(keyboard ? { reply_markup: keyboard } : {}),
    ...(silent ? { disable_notification: true } : {}),
  }, canSend)) as { result?: { message_id?: unknown } } | null;
  const id = Number(body?.result?.message_id);
  return Number.isSafeInteger(id) ? id : undefined;
}

/** A person's explicit plain-text reply. No formatting, buttons, truncation
 * or retry after an uncertain network result. */
export async function replyText(token: string, chatId: number, text: string, messageId: number | undefined, canSend: () => boolean): Promise<void> {
  if (!text.trim() || text.length > MAX_TELEGRAM_REPLY_CHARS) throw new Error("Reply text must contain 1 to 4096 characters.");
  if (!canSend()) throw new Error("the sender's permission or Telegram connection changed");
  // Quoting their message is a courtesy. A message they deleted since
  // must not turn the reply into a refusal.
  const result = await call(token, "sendMessage", { chat_id: chatId, text, ...(messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}) }) as any;
  if (result?.ok !== true || !Number.isSafeInteger(result.result?.message_id) || result.result.message_id <= 0) {
    throw new Error("Telegram did not confirm the reply. Do not send it again automatically.");
  }
}

/** Say something else in a message the bot sent, and take its buttons
 * away: a card that has been answered should not offer to be again. */
export async function edit(token: string, chatId: number, messageId: number, text: string): Promise<void> {
  await call(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: text.slice(0, TELEGRAM_MESSAGE_CHARS),
    reply_markup: NO_BUTTONS,
  });
}

/** Only the buttons gone, for a message whose words are still true but
 * whose card nothing is waiting on any more. */
export async function unbutton(token: string, chatId: number, messageId: number): Promise<void> {
  await call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: NO_BUTTONS });
}

/** Ends the little spinner a phone shows on a pressed button, with a few
 * words about what the press did. Telegram expects one for every press. */
export async function answerPress(token: string, pressId: string, text?: string): Promise<void> {
  await call(token, "answerCallbackQuery", { callback_query_id: pressId, ...(text ? { text: text.slice(0, 190) } : {}) }, 5_000);
}

/** Rich sends and their fallback must confirm admission before accounting.
 * A malformed success is uncertain, never permission to send it again. */
function confirmReply(value: unknown): void {
  const body = value as { ok?: unknown; result?: { message_id?: unknown } } | null;
  const id = body?.result?.message_id;
  if (body?.ok !== true || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Telegram did not confirm the reply. Do not send it again automatically.");
  }
}

/**
 * Say something in a chat, all of it, in as many messages as it takes.
 *
 * With `markdown`, which is how agents write, it is shown formatted. If
 * Telegram will not take a message's formatting it answers 400, and that
 * message goes again as plain text with its links written out, so a
 * reply is never lost to its markup. Tables use generated rich HTML, with
 * legacy fallback only after a definite 400/404 rejection. Each message
 * follows the one before it, and a failure stops the rest
 * rather than leaving a gap nobody can see.
 */
export async function send(token: string, chatId: number, text: string, markdown = false, accepted?: () => void, canSend?: () => boolean): Promise<void> {
  for (const delivery of deliveries(text, markdown)) {
    if (delivery.richHtml !== undefined) {
      let fallback = false;
      let result: unknown;
      try {
        result = await sendOne(token, { chat_id: chatId, rich_message: { html: delivery.richHtml } }, canSend, "sendRichMessage");
      } catch (error) {
        // Catch only the request's definite rejection. Neither validation
        // nor a caller callback can turn confirmation into a resend.
        if (!(error instanceof TelegramError) || ![400, 404].includes(error.status)) throw error;
        fallback = true;
      }
      if (!fallback) {
        confirmReply(result);
        accepted?.();
        continue;
      }
    }
    // This is only the rejected rich chunk's fallback, already packed to
    // ordinary limits. Never rewind an earlier accepted chunk or part.
    for (const chunk of delivery.chunks) {
      let result: unknown;
      if (chunk.html === undefined) {
        result = await sendOne(token, { chat_id: chatId, text: chunk.plain }, canSend);
      } else {
        try {
          result = await sendOne(token, { chat_id: chatId, text: chunk.html, parse_mode: "HTML" }, canSend);
        } catch (error) {
          if (!(error instanceof TelegramError) || error.status !== 400) throw error;
          result = await sendOne(token, { chat_id: chatId, text: chunk.plain }, canSend);
        }
      }
      if (delivery.richHtml !== undefined) confirmReply(result);
      accepted?.();
    }
  }
}

// ── files going the other way ──────────────────────────────────────────

/** The most Telegram takes from a bot in one file. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** The most it takes as a photo; a bigger image still goes, as a file. */
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
/** Images a phone shows in the chat rather than as a file to open. */
const PHOTO_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
/** How many files come back with one answer. A turn that saved twenty
 * should not bury the chat; the rest are a tap away in the app. */
export const FILES_PER_TURN = 5;

/** A file to send: what it is called, what it is, how big, and its bytes
 * when asked for, so nothing is read that is not going to be sent. */
export interface Deliverable {
  name: string;
  mime: string;
  size: number;
  blob(): Promise<Blob>;
}

/** One file, as a form: Telegram takes uploads no other way. A big file
 * on a slow line takes a while, so the wait is a couple of minutes. */
async function upload(token: string, method: string, field: string, chatId: number, file: Deliverable, canSend?: () => boolean): Promise<void> {
  await patiently(async () => {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set(field, await file.blob(), file.name);
    if (canSend && !canSend()) throw new Error("the Telegram connection changed");
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await refusal(response);
  });
}

/** A photo when it can be one, so it shows in the chat; a file when not,
 * or when Telegram will not take it as a photo (too tall, say). */
export async function sendFile(token: string, chatId: number, file: Deliverable, canSend?: () => boolean): Promise<void> {
  const photo = PHOTO_MIMES.has(file.mime) && file.size <= PHOTO_MAX_BYTES;
  if (!photo) return upload(token, "sendDocument", "document", chatId, file, canSend);
  try {
    await upload(token, "sendPhoto", "photo", chatId, file, canSend);
  } catch (error) {
    if (!(error instanceof TelegramError) || error.status !== 400) throw error;
    await upload(token, "sendDocument", "document", chatId, file, canSend);
  }
}

/**
 * What a turn produced, sent to the chat, a few at most, one after
 * another so they arrive in order. Returns a line for the person about
 * whatever did not come (too big, past the few, or refused), or "" when
 * everything did: a file that silently never arrives reads as one the
 * agent never made.
 */
export async function sendFiles(token: string, chatId: number, files: Deliverable[], max = FILES_PER_TURN, canSend?: () => boolean): Promise<string> {
  const missing: string[] = [];
  let sent = 0;
  let over = 0;
  for (const file of files) {
    if (canSend && !canSend()) break;
    if (file.size > UPLOAD_MAX_BYTES) {
      missing.push(`${file.name} (over Telegram's 50 MB)`);
      continue;
    }
    if (sent >= max) {
      over++;
      continue;
    }
    try {
      await sendFile(token, chatId, file, canSend);
      sent++;
    } catch (error) {
      missing.push(`${file.name} (${reason(error)})`);
    }
  }
  const left = missing.length + over;
  if (over) missing.push(`${over} more ${over === 1 ? "file" : "files"} (only ${max} come with an answer)`);
  if (!left) return "";
  return `Not sent here: ${missing.join("; ")}. ${left === 1 ? "It is" : "They are"} in the app.`;
}

/** "typing" under the bot's name. Telegram shows it for five seconds
 * at most, and clears it the moment the bot sends a message. */
export async function chatAction(token: string, chatId: number): Promise<void> {
  await call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, 5_000);
}

/** A little under the five seconds Telegram shows it for, so it reads
 * as one unbroken "typing" until the answer comes. */
export const TYPING_EVERY_MS = 4_000;

/**
 * Keep saying "typing" until told to stop.
 *
 * `paused` is asked before each one, and is true while the agent waits
 * on the person: "typing" then would say the opposite of what is
 * happening. `now` says it at once, for when a pause has just ended.
 * `stop` waits for one already on its way, so it cannot land after the
 * answer and leave "typing" showing under a finished reply. A failure
 * is ignored, like a failed send.
 */
export function keepTyping(
  say: () => Promise<void>,
  paused: () => boolean,
  everyMs = TYPING_EVERY_MS,
): { now(): void; stop(): Promise<void> } {
  let stopped = false;
  let sending: Promise<void> = Promise.resolve();
  const now = () => {
    if (stopped || paused()) return;
    sending = Promise.resolve()
      .then(say)
      .catch(() => {});
  };
  const timer = setInterval(now, everyMs);
  // Nothing should keep the process alive just to say "typing".
  timer.unref?.();
  now();
  return {
    now,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await sending;
    },
  };
}

/** Take back a message the bot sent. */
export async function remove(token: string, chatId: number, messageId: number): Promise<void> {
  await call(token, "deleteMessage", { chat_id: chatId, message_id: messageId }, 5_000);
}

/** How long a turn runs before the chat is told what it is doing. Most
 * answers come sooner, and a status line for those would be noise. */
export const PROGRESS_AFTER_MS = 20_000;
/** The existing four-second throttle, now between new notes messages. */
export const PROGRESS_EVERY_MS = 4_000;

export interface ProgressHooks {
  post(text: string): Promise<number | undefined>;
  remove(messageId: number): Promise<void>;
}

/** Silent notes are new messages, in order. The delay and throttle batch
 * whole notes; only an individually oversized note is clipped. One post
 * is in flight at a time, and every returned id is removed at the end. */
export class Progress {
  private hooks: ProgressHooks;
  private paused: () => boolean;
  private afterMs: number;
  private everyMs: number;
  private notes: string[] = [];
  private messageIds: number[] = [];
  private noteVersion = 0;
  private refusedAt?: number;
  private uncertain = false;
  private due = false;
  private lastAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inFlight?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(hooks: ProgressHooks, paused: () => boolean, afterMs = PROGRESS_AFTER_MS, everyMs = PROGRESS_EVERY_MS) {
    this.hooks = hooks;
    this.paused = paused;
    this.afterMs = afterMs;
    this.everyMs = everyMs;
    this.startAt(Date.now());
  }

  /** Queue time is not work time. Steering joins an already-running turn. */
  startAt(at: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const remaining = this.afterMs - (Date.now() - at);
    this.due = remaining <= 0;
    if (this.due) this.schedule();
    else this.wait(remaining, () => { this.due = true; this.tick(); });
  }

  note(text: string): void {
    if (this.stopped || this.uncertain || !text.trim()) return;
    this.notes.push(clipTelegramText(text));
    this.noteVersion++;
    this.schedule();
  }

  /** Cancel pending notes, settle the post, then take back every known
   * message. The answer awaits this, even when a post's response is late. */
  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      this.stopped = true;
      clearTimeout(this.timer);
      this.notes = [];
      await this.inFlight;
      for (const id of this.messageIds) {
        try { await this.hooks.remove(id); } catch { /* The answer still goes. */ }
      }
    })();
  }

  private wait(ms: number, then: () => void): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      then();
    }, ms);
    this.timer.unref?.();
  }

  private schedule(): void {
    if (this.stopped || this.uncertain || !this.due || !this.notes.length || this.timer || this.inFlight ||
        (this.refusedAt !== undefined && this.noteVersion <= this.refusedAt)) return;
    this.wait(Math.max(0, this.lastAt + this.everyMs - Date.now()), () => this.tick());
  }

  private tick(): void {
    if (this.stopped || this.uncertain || !this.due || !this.notes.length || this.inFlight ||
        (this.refusedAt !== undefined && this.noteVersion <= this.refusedAt)) return;
    if (this.paused()) return this.wait(this.everyMs, () => this.tick());
    let count = 1, units = this.notes[0]!.length;
    while (count < this.notes.length && units + 2 + this.notes[count]!.length <= TELEGRAM_MESSAGE_CHARS) {
      units += 2 + this.notes[count]!.length;
      count++;
    }
    const text = this.notes.splice(0, count).join("\n\n");
    const version = this.noteVersion;
    this.lastAt = Date.now();
    this.inFlight = (async () => {
      try {
        const id = await this.hooks.post(text);
        if (id === undefined) this.uncertain = true;
        else this.messageIds.push(id);
        this.refusedAt = undefined;
      } catch (error) {
        if (error instanceof TelegramError) this.refusedAt = version;
        else this.uncertain = true; // It may have arrived without an id.
      }
    })().finally(() => {
      this.inFlight = undefined;
      if (this.uncertain) this.notes = [];
      this.schedule();
    });
  }
}

/**
 * The bytes of a file somebody sent the bot.
 *
 * Two calls: getFile names where Telegram keeps it, then the file is
 * fetched from there. The size is checked against what getFile claims
 * before anything is downloaded, and again after, since a claim is not
 * a promise.
 */
export async function download(token: string, fileId: string, maxBytes: number): Promise<Uint8Array> {
  // A phone on a train and a laptop on hotel wifi drop connections, and
  // one more go is usually all it takes. Only a timeout or a lost
  // connection is tried again: a file that is too big will be too big
  // the second time as well.
  try {
    return await fetchFile(token, fileId, maxBytes);
  } catch (error) {
    if (!dropped(error)) throw error;
  }
  try {
    return await fetchFile(token, fileId, maxBytes);
  } catch (error) {
    const why = dropped(error);
    throw why ? new Error(why) : error;
  }
}

/** What went wrong, in the words the person is told, when it was the
 * line rather than the file; null for anything else. */
function dropped(error: unknown): string | null {
  const name = (error as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timed out";
  // fetch reports a refused, reset or cut off connection as a TypeError.
  if (error instanceof TypeError) return "the connection dropped";
  return null;
}

async function fetchFile(token: string, fileId: string, maxBytes: number): Promise<Uint8Array> {
  const body = (await call(token, "getFile", { file_id: fileId })) as {
    result?: { file_path?: string; file_size?: number };
  };
  const path = body?.result?.file_path;
  if (!path) throw new Error("Telegram did not hand it over");
  const tooBig = new Error(`it is over ${Math.round(maxBytes / (1024 * 1024))} MB`);
  if (Number(body.result?.file_size) > maxBytes) throw tooBig;
  const response = await fetch(`${API}/file/bot${token}/${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Telegram answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw tooBig;
  if (!bytes.length) throw new Error("it arrived empty");
  return bytes;
}

/**
 * Ask once for whatever has arrived.
 *
 * Long polling with a short timeout: long enough that an idle workspace
 * is not hammering Telegram, short enough that quitting the app does not
 * wait half a minute for a socket to close.
 */
export async function poll(token: string, offset: number, signal?: AbortSignal): Promise<Incoming[]> {
  const body = await call(
    token,
    "getUpdates",
    // Presses as well as messages: a card is answered with a tap.
    { offset, timeout: 20, allowed_updates: ["message", "callback_query"] },
    30_000,
    signal,
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

/**
 * Read an answer typed on a phone against the choices a card offered.
 *
 * A number picks by position. yes/ok/allow/approve pick the first
 * option and no/deny/decline the second, because that is what every
 * approval card and every workflow gate offers in that order. Anything
 * else is the answer itself, which is right for a question and wrong
 * for an approval, so the caller decides whether free text is allowed.
 */
export function interpretAnswer(text: string, options: string[]): { option?: string; free?: string } {
  const said = text.trim();
  const n = Number(said);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return { option: options[n - 1] };
  const lower = said.toLowerCase();
  const exact = options.find((o) => o.toLowerCase() === lower);
  if (exact) return { option: exact };
  if (/^(y|yes|ok|okay|sure|allow|approve|go|do it)\b/.test(lower) && options[0]) return { option: options[0] };
  if (/^(n|no|nope|deny|decline|stop|don'?t)\b/.test(lower) && options[1]) return { option: options[1] };
  return { free: said };
}

/** What a card asks, without how to answer it: all that is still true of
 * it once it has been answered. */
export function cardAsks(card: { title?: string; subtitle?: string }): string {
  return [card.title || "Your agent needs you", ...(card.subtitle ? [card.subtitle.slice(0, 600)] : [])].join("\n");
}

/** The card, as a message a phone can answer. With buttons its choices
 * are under it to tap, so the words are only what it asks; without, they
 * are numbered to type. Typing a number or yes / no works either way. */
export function describeCard(card: { title?: string; subtitle?: string; options?: string[] }, buttons = false): string {
  const lines = [cardAsks(card)];
  const options = card.options ?? [];
  if (buttons && options.length) return lines.join("\n");
  if (options.length) {
    lines.push("");
    options.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
    lines.push("", "Reply with a number, or yes / no.");
  } else {
    lines.push("", "Reply with your answer.");
  }
  return lines.join("\n");
}

// ── what arrives, turned into what the agent reads ─────────────────────

/** Said on the message itself, so every engine is told the same way that
 * these words were heard rather than typed. */
const VOICE_NOTE =
  "Transcribed from a voice message. Names, numbers and spellings may be misheard; check them before acting on them.";

/** How long an album waits for the rest of itself after its latest photo.
 * Telegram sends each photo as its own update, sometimes a poll apart. */
export const ALBUM_WAIT_MS = 1_500;

/** Paths are written into a prompt, so they stay inside their quotes
 * whatever the home folder is called. Matches the app's composer. */
function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

/** The note when a caption came with the recording, so the agent can
 * tell the words that were typed from the ones that were heard. */
const CAPTIONED_VOICE_NOTE =
  "Typed caption first, then transcribed from a voice message. Names, numbers and spellings in the transcript may be misheard; check them before acting on them.";

/** A transcript, with the audio it came from kept beside it so the
 * thread can play it back. A caption goes first, the way a photo's does. */
export function voiceText(path: string, said: string, caption = ""): string {
  const note = caption.trim() ? CAPTIONED_VOICE_NOTE : VOICE_NOTE;
  const words = [caption.trim(), said].filter(Boolean).join("\n\n");
  return `<voice-message path="${attr(path)}" note="${note}" />\n\n${words}`;
}

/** A caption and its photos, in the shape the app's composer sends a
 * pasted image in, so nothing downstream can tell them apart. */
export function imagesText(caption: string, paths: string[]): string {
  return [caption.trim(), ...paths.map((path) => `<attached-image path="${attr(path)}" />`)]
    .filter(Boolean)
    .join("\n\n");
}

function attachmentsText(caption: string, paths: { kind: "image" | "file"; path: string }[]): string {
  return [caption.trim(), ...paths.map(({ kind, path }) => `<attached-${kind} path="${attr(path)}" />`)]
    .filter(Boolean).join("\n\n");
}

const ITEM_NAMES = new Map([
  ["videos", "video"], ["video messages", "video message"], ["audio files", "audio file"], ["GIFs", "GIF"],
  ["files", "file"], ["stickers", "sticker"], ["locations", "location"], ["contacts", "contact"],
  ["polls", "poll"], ["dice", "die"], ["games", "game"], ["stories", "story"],
]);

function mediaName(media: Media): string {
  if (media.kind === "voice") return "voice message";
  if (media.kind === "image") return "photo";
  return ITEM_NAMES.get(media.what) ?? (media.what.endsWith(" images") ? "image" : "attachment");
}

function mediaDescription(media: Media, capital = true): string {
  const name = mediaName(media);
  const article = /^[aeiou]/i.test(name) ? "an" : "a";
  const what = `${capital ? article[0]!.toUpperCase() + article.slice(1) : article} ${name}`;
  if (!("bytes" in media)) return what;
  return `${what} (${media.bytes ? `${media.bytes} bytes` : "size not provided"})`;
}

const refusalNote = (media: Media, why: string) => `${mediaDescription(media)} did not arrive (${why}).`;
const fileAdvice = (media: Extract<Media, { kind: "file" }>) =>
  `Telegram bots have a 20 MB limit. Try a ${media.what === "files" ? "smaller file" : "shorter clip"}.`;

/** Everything the inbox needs from outside, so the rules can be tested
 * without Telegram, a vendor or a disk. */
export interface InboxHooks {
  state(): TelegramState;
  /** Never throws: a reply that fails to send is not worth a crash. */
  send(chatId: number, text: string): Promise<void>;
  pair(chatId: number, userId?: number): Promise<void>;
  refuse(chatId: number): Promise<void>;
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Null when there is no speech key, which gets a different reply
   * from a vendor that has one and fails. */
  transcriber(): ((audio: Uint8Array) => Promise<string>) | null;
  /** Throws when the bytes are not an image the app would take. */
  saveImage(bytes: Uint8Array): string;
  saveVoice(bytes: Uint8Array): string;
  saveFile(bytes: Uint8Array, extension: string): string;
  /** A card forwarded to this chat and not yet answered. */
  waiting(chatId: number, source?: Incoming): { options: string[]; permission: boolean } | undefined;
  /** `waiting` is the card `waiting` named for this message. */
  answer(chatId: number, read: { option?: string; free?: string }, waiting?: { options: string[]; permission: boolean }): Promise<void>;
  /** A button pressed in a paired chat, by the person it is paired with. */
  press(chatId: number, press: Press): Promise<void>;
  /** Start a turn with this text. Returns at once; the reply follows. */
  deliver(chatId: number, text: string, replyTo?: ReplyRef, source?: Incoming): void;
}

const reason = (error: unknown) => (error instanceof Error && error.message) || "something went wrong";

/** Said when an approval's answer was unclear. */
const ASK_AGAIN = "Tap a button on the card, or reply yes / no.";

/**
 * Where each message from Telegram goes, and what the person is told
 * when it cannot go anywhere.
 */
export class Inbox {
  private albums = new Map<string, { parts: Incoming[]; timer: ReturnType<typeof setTimeout> }>();
  private releasing = new Set<Promise<void>>();
  private hooks: InboxHooks;
  private albumWaitMs: number;

  constructor(hooks: InboxHooks, albumWaitMs = ALBUM_WAIT_MS) {
    this.hooks = hooks;
    this.albumWaitMs = albumWaitMs;
  }

  async take(message: Incoming): Promise<void> {
    const { hooks } = this;
    // Pairing is checked before anything is opened. A stranger's photo
    // is never downloaded and a stranger's voice is never sent to a
    // vendor to be heard; they get the same one refusal as text does.
    const decision = decide(hooks.state(), message);
    if (decision.kind === "pair") return hooks.pair(decision.chatId, decision.userId);
    if (decision.kind === "refuse") return hooks.refuse(decision.chatId);
    if (decision.kind === "press") return hooks.press(decision.chatId, decision.press);
    if (decision.kind !== "deliver") return;
    const { chatId, media, replyTo } = decision;
    if (media && message.album) return this.hold(message);
    if (media?.kind === "other") {
      const note = `${mediaDescription(media)} came with this and did not arrive (Bloks can't take ${media.what} from Telegram).`;
      return this.missed(chatId, decision.text, note, notDelivered(media), notDelivered(media, true),
        refusalNote(media, `Bloks can't take ${media.what} from Telegram`), replyTo, message);
    }
    if (media?.kind === "voice") return this.voice(chatId, media, decision.text, replyTo, message);
    // A photo is never an answer to a card. It is something new to look
    // at, and reading it as "yes" would be a guess.
    if (media?.kind === "image" || media?.kind === "file") return this.attachments([message]);
    const waiting = hooks.waiting(chatId, message);
    if (waiting) return this.answer(chatId, waiting, decision.text);
    hooks.deliver(chatId, decision.text, replyTo, message);
  }

  /** Lets every album still waiting go now, and waits for them. */
  async flush(): Promise<void> {
    for (const key of [...this.albums.keys()]) this.release(key);
    await Promise.all(this.releasing);
  }

  /** Text, typed or heard, read as the answer to a card. Free text
   * answers a question; an approval needs one of its options, so
   * anything else asks again rather than guessing. An approval always
   * goes with its buttons, so that is where the person is pointed; a
   * number still works for anyone who types one. */
  private async answer(chatId: number, waiting: { options: string[]; permission: boolean }, text: string) {
    const read = interpretAnswer(text, waiting.options);
    if (waiting.permission && !read.option) return this.hooks.send(chatId, ASK_AGAIN);
    await this.hooks.answer(chatId, read, waiting);
    await this.hooks.send(chatId, "Sent.");
  }

  /**
   * An attachment that could not be passed on. With no caption the agent
   * gets its type and reason. With one, the caption
   * goes to the agent as a new message, never as the answer to a card,
   * marked with what was missing and why.
   */
  private async missed(chatId: number, caption: string, note: string, alone: string, captioned: string, standalone: string, replyTo?: ReplyRef, source?: Incoming) {
    this.hooks.deliver(chatId, withMissing(caption, caption ? note : standalone), replyTo, source);
    await this.hooks.send(chatId, caption ? captioned : alone);
  }

  private async voice(chatId: number, media: Extract<Media, { kind: "voice" }>, caption = "", replyTo?: ReplyRef, source?: Incoming): Promise<void> {
    const { hooks } = this;
    // A misheard "no" is a "yes" to something that runs on this machine,
    // so an approval is answered by typing. Asked before the audio goes
    // anywhere, and again after, in case a card arrived meanwhile.
    const typed = `That one needs a tap or a typed answer. ${ASK_AGAIN}`;
    if (hooks.waiting(chatId, source)?.permission) return hooks.send(chatId, typed);
    const lost = (why: string, alone: string, captioned: string) =>
      this.missed(chatId, caption, `A voice message came with this and did not arrive (${why}).`, alone, captioned, refusalNote(media, why), replyTo, source);
    const transcribe = hooks.transcriber();
    if (!transcribe) {
      return lost("there is no speech key to transcribe it", notDelivered(media), notDelivered(media, true));
    }
    let audio: Uint8Array;
    try {
      audio = await hooks.download(media.fileId, VOICE_MAX_BYTES);
    } catch (error) {
      const why = reason(error);
      return lost(
        why,
        `I couldn't get that voice message (${why}), so it did not reach your agent. Try again, or type it.`,
        `I couldn't get that voice message (${why}). ${WITHOUT} Try again, or type it.`,
      );
    }
    let said: string;
    try {
      said = (await transcribe(audio)).trim().slice(0, MAX_MESSAGE_CHARS);
    } catch (error) {
      const why = reason(error);
      return lost(
        `it could not be transcribed: ${why}`,
        `I couldn't transcribe that voice message (${why}), so it did not reach your agent. Try again, or type it.`,
        `I couldn't transcribe that voice message (${why}). ${WITHOUT} Try again, or type it.`,
      );
    }
    if (!said) {
      return lost(
        "no words could be made out in it",
        "I couldn't make out any words in that voice message, so it did not reach your agent.",
        `I couldn't make out any words in that voice message. ${WITHOUT}`,
      );
    }
    const waiting = hooks.waiting(chatId, source);
    if (waiting?.permission) return hooks.send(chatId, typed);
    if (waiting) return this.answer(chatId, waiting, [caption, said].filter(Boolean).join("\n\n"));
    let path: string;
    try {
      path = hooks.saveVoice(audio);
    } catch (error) {
      const why = reason(error);
      return lost(
        `it could not be kept: ${why}`,
        `I couldn't keep that voice message (${why}), so it did not reach your agent.`,
        `I couldn't keep that voice message (${why}). ${WITHOUT}`,
      );
    }
    hooks.deliver(chatId, voiceText(path, said, caption), replyTo, source);
  }

  /** One attachment, or a whole album, as one message: every file that could
   * be taken, the caption, and a word about anything that could not. */
  private async attachments(parts: Incoming[]): Promise<void> {
    const { hooks } = this;
    const chatId = parts[0]!.chatId;
    // One composer target, chosen in arrival order before any download outcome.
    const replyTo = parts.find((part) => part.replyTo)?.replyTo;
    const paths: { kind: "image" | "file"; path: string }[] = [];
    const caption = parts.map((part) => part.text).filter(Boolean).join("\n\n");
    const onlyImages = parts.every((part) => part.media?.kind === "image");
    const advice = new Set<string>();
    // Said to the person, and to the agent, which hears about Bloks
    // rather than from it.
    const problems = new Set<string>();
    const told = new Set<string>();
    for (const part of parts) {
      const media = part.media;
      if (media?.kind !== "image" && media?.kind !== "file") {
        problems.add(media?.kind === "other" ? `I can't take ${media.what}` : "only images and files go in an album");
        const why = media?.kind === "other" ? `Bloks can't take ${media.what} from Telegram` : "only images and files are taken from an album";
        told.add(media ? `${mediaDescription(media, false)}: ${why}` : why);
        continue;
      }
      let sizeOrDownload = false;
      try {
        const max = media.kind === "image" ? IMAGE_MAX_BYTES : VOICE_MAX_BYTES;
        if (!media.fileId) throw new Error("Telegram did not provide a file ID");
        sizeOrDownload = true;
        if (media.bytes > max) throw new Error(`it is over ${max / (1024 * 1024)} MB`);
        const bytes = await hooks.download(media.fileId, max);
        sizeOrDownload = false;
        const path = media.kind === "image" ? hooks.saveImage(bytes) : hooks.saveFile(bytes, fileExtension(media));
        paths.push({ kind: media.kind, path });
      } catch (error) {
        problems.add(reason(error));
        told.add(caption && onlyImages ? reason(error) : `${mediaDescription(media, false)}: ${reason(error)}`);
        if (media.kind === "file" && sizeOrDownload) advice.add(fileAdvice(media));
      }
    }
    if (!problems.size) return hooks.deliver(chatId, attachmentsText(caption, paths), replyTo, parts[0]);
    const why = [...problems].join("; ");
    const toAgent = [...told].join("; ");
    const missing = parts.length - paths.length;
    const noun = onlyImages ? "photos" : "attachments";
    const hint = advice.size ? ` ${[...advice].join(" ")}` : "";
    if (parts.length === 1) {
      const media = parts[0]!.media!;
      return this.missed(
        chatId,
        caption,
        `${media.kind === "image" ? "A photo" : mediaDescription(media)} came with this and did not arrive (${why}).`,
        `I couldn't take that ${mediaName(media)} (${why}), so it did not reach your agent.${hint}`,
        `I couldn't take that ${mediaName(media)} (${why}). ${WITHOUT}${hint}`,
        refusalNote(media, why),
        replyTo,
        parts[0],
      );
    }
    if (!paths.length) {
      return this.missed(
        chatId,
        caption,
        `${parts.length} ${noun} came with this and none of them arrived (${toAgent}).`,
        `None of those ${parts.length} reached your agent (${why}).${hint}`,
        `None of those ${parts.length} reached your agent (${why}). Your caption went without them.${hint}`,
        `${parts.length} ${noun} did not arrive, none reached the agent (${toAgent}).`,
        replyTo,
        parts[0],
      );
    }
    // The agent is told what is missing beside what came, so it does not
    // describe an album of three as if two were all of it.
    const note = `${missing} of ${parts.length} ${noun} did not arrive (${toAgent}).`;
    hooks.deliver(chatId, attachmentsText(withMissing(caption, note), paths), replyTo, parts[0]);
    await hooks.send(chatId, `${missing} of those ${parts.length} did not reach your agent (${why}). The rest did.${hint}`);
  }

  private hold(message: Incoming): void {
    const key = `${message.chatId}:${message.album}`;
    const held = this.albums.get(key);
    if (held) clearTimeout(held.timer);
    this.albums.set(key, {
      parts: [...(held?.parts ?? []), message],
      timer: setTimeout(() => this.release(key), this.albumWaitMs),
    });
  }

  private release(key: string): void {
    const held = this.albums.get(key);
    if (!held) return;
    this.albums.delete(key);
    clearTimeout(held.timer);
    const done: Promise<void> = this.attachments(held.parts)
      .catch(() => {})
      .finally(() => this.releasing.delete(done));
    this.releasing.add(done);
  }
}
