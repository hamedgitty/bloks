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
import { clamp, MAX_MESSAGE_CHARS } from "./limits.ts";

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
  /** What was typed, or the caption under a photo or a file. */
  text: string;
  updateId: number;
  /** Anything that came instead of, or as well as, text. */
  media?: Media;
  /** Photos sent together arrive as separate updates sharing this. */
  album?: string;
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
  /** `what` is how the reply names it, plural: "videos", "stickers". */
  | { kind: "other"; what: string };

/** The images a pasted image may be, so Telegram's match the app's. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Message fields that mean content the bot has no way to pass on, and
 * what to call each in the reply. Order matters: a GIF arrives with a
 * `document` beside its `animation`, so it is named before files are. */
const OTHER: [field: string, what: string][] = [
  ["animation", "GIFs"],
  ["video", "videos"],
  ["video_note", "video messages"],
  ["sticker", "stickers"],
  ["audio", "audio files"],
  ["location", "locations"],
  ["venue", "locations"],
  ["contact", "contacts"],
  ["poll", "polls"],
  ["dice", "dice"],
  ["game", "games"],
  ["story", "stories"],
];

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
  for (const [field, what] of OTHER) {
    if (message[field] !== undefined && message[field] !== null) return { kind: "other", what };
  }
  const document = message.document;
  if (document && typeof document.file_id === "string") {
    const mime = String(document.mime_type ?? "").toLowerCase();
    // An image sent "as a file" keeps its full resolution, which is
    // often exactly why somebody sent it that way.
    if (IMAGE_MIMES.has(mime)) {
      return { kind: "image", fileId: document.file_id, bytes: Number(document.file_size) || 0, mime };
    }
    if (mime.startsWith("image/")) return { kind: "other", what: `${mime.slice(6).toUpperCase()} images` };
    return { kind: "other", what: "files" };
  }
  return undefined;
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
    const said = typeof message?.text === "string" ? message.text : message?.caption;
    const text = typeof said === "string" ? said.trim() : "";
    const updateId = Number(update.update_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(updateId)) continue;
    const media = mediaOf(message);
    // Joins, leaves, pins and the rest of the service messages carry
    // neither, and are nothing anybody said.
    if (!text && !media) continue;
    const album = typeof message.media_group_id === "string" ? message.media_group_id.slice(0, 64) : undefined;
    out.push({
      chatId,
      updateId,
      text: text.slice(0, 4_000),
      from: String(message?.from?.first_name ?? "someone").slice(0, 60),
      ...(media ? { media } : {}),
      ...(album ? { album } : {}),
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
  | { kind: "deliver"; chatId: number; text: string; media?: Media; album?: string }
  | { kind: "refuse"; chatId: number }
  | { kind: "ignore" };

export function decide(state: TelegramState, message: Incoming): Decision {
  const allowed = state.chatIds ?? [];
  if (allowed.includes(message.chatId)) {
    return {
      kind: "deliver",
      chatId: message.chatId,
      text: message.text,
      ...(message.media ? { media: message.media } : {}),
      ...(message.album ? { album: message.album } : {}),
    };
  }
  // A pairing word is single use and compared whole, so a stranger
  // guessing at it gets the same silence as a stranger who does not.
  if (state.pairing && !message.media && message.text.trim() === state.pairing) {
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
 * was silence, and silence reads as "sent". A caption is not sent on
 * its own either: "what do you make of this?" without the this is a
 * different message from the one the person wrote.
 */
export function notDelivered(media: Media, captioned = false): string {
  const said =
    media.kind === "voice"
      ? "I can't read voice messages here yet, so that one did not reach your agent. Add a speech key in Bloks Settings, or type it."
      : media.kind === "image"
        ? "I can't take photos here yet, so that one did not reach your agent."
        : `I can't take ${media.what} here, so that did not reach your agent.`;
  return captioned && media.kind !== "voice" ? `${said} Its caption was not sent on its own either.` : said;
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
 * The bytes of a file somebody sent the bot.
 *
 * Two calls: getFile names where Telegram keeps it, then the file is
 * fetched from there. The size is checked against what getFile claims
 * before anything is downloaded, and again after, since a claim is not
 * a promise.
 */
export async function download(token: string, fileId: string, maxBytes: number): Promise<Uint8Array> {
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

/** The card, as a message a phone can answer. */
export function describeCard(card: { title?: string; subtitle?: string; options?: string[] }): string {
  const lines = [card.title || "Your agent needs you"];
  if (card.subtitle) lines.push(card.subtitle.slice(0, 600));
  const options = card.options ?? [];
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

/** A transcript, with the audio it came from kept beside it so the
 * thread can play it back. */
export function voiceText(path: string, said: string): string {
  return `<voice-message path="${attr(path)}" note="${VOICE_NOTE}" />\n\n${said}`;
}

/** A caption and its photos, in the shape the app's composer sends a
 * pasted image in, so nothing downstream can tell them apart. */
export function imagesText(caption: string, paths: string[]): string {
  return [caption.trim(), ...paths.map((path) => `<attached-image path="${attr(path)}" />`)]
    .filter(Boolean)
    .join("\n\n");
}

/** Everything the inbox needs from outside, so the rules can be tested
 * without Telegram, a vendor or a disk. */
export interface InboxHooks {
  state(): TelegramState;
  /** Never throws: a reply that fails to send is not worth a crash. */
  send(chatId: number, text: string): Promise<void>;
  pair(chatId: number): Promise<void>;
  refuse(chatId: number): Promise<void>;
  download(fileId: string, maxBytes: number): Promise<Uint8Array>;
  /** Null when there is no speech key, which gets a different reply
   * from a vendor that has one and fails. */
  transcriber(): ((audio: Uint8Array) => Promise<string>) | null;
  /** Throws when the bytes are not an image the app would take. */
  saveImage(bytes: Uint8Array): string;
  saveVoice(bytes: Uint8Array): string;
  /** A card forwarded to this chat and not yet answered. */
  waiting(chatId: number): { options: string[]; permission: boolean } | undefined;
  answer(chatId: number, read: { option?: string; free?: string }): Promise<void>;
  /** Start a turn with this text. Returns at once; the reply follows. */
  deliver(chatId: number, text: string): void;
}

const reason = (error: unknown) => (error instanceof Error && error.message) || "something went wrong";

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
    if (decision.kind === "pair") return hooks.pair(decision.chatId);
    if (decision.kind === "refuse") return hooks.refuse(decision.chatId);
    if (decision.kind !== "deliver") return;
    const { chatId, media } = decision;
    if (media && message.album) return this.hold(message);
    if (media?.kind === "other") return hooks.send(chatId, notDelivered(media, Boolean(decision.text)));
    if (media?.kind === "voice") return this.voice(chatId, media);
    // A photo is never an answer to a card. It is something new to look
    // at, and reading it as "yes" would be a guess.
    if (media?.kind === "image") return this.photos([message]);
    const waiting = hooks.waiting(chatId);
    if (waiting) return this.answer(chatId, waiting, decision.text);
    hooks.deliver(chatId, decision.text);
  }

  /** Lets every album still waiting go now, and waits for them. */
  async flush(): Promise<void> {
    for (const key of [...this.albums.keys()]) this.release(key);
    await Promise.all(this.releasing);
  }

  /** Text, typed or heard, read as the answer to a card. Free text
   * answers a question; an approval needs one of its options, so
   * anything else asks again rather than guessing. */
  private async answer(chatId: number, waiting: { options: string[]; permission: boolean }, text: string) {
    const read = interpretAnswer(text, waiting.options);
    if (waiting.permission && !read.option) return this.hooks.send(chatId, "Reply 1 or 2, or yes / no.");
    await this.hooks.answer(chatId, read);
    await this.hooks.send(chatId, "Sent.");
  }

  private async voice(chatId: number, media: Extract<Media, { kind: "voice" }>): Promise<void> {
    const { hooks } = this;
    // A misheard "no" is a "yes" to something that runs on this machine,
    // so an approval is answered by typing. Asked before the audio goes
    // anywhere, and again after, in case a card arrived meanwhile.
    const typed = "That one needs a typed answer. Reply 1 or 2, or yes / no.";
    if (hooks.waiting(chatId)?.permission) return hooks.send(chatId, typed);
    const transcribe = hooks.transcriber();
    if (!transcribe) return hooks.send(chatId, notDelivered(media));
    let audio: Uint8Array;
    try {
      audio = await hooks.download(media.fileId, VOICE_MAX_BYTES);
    } catch (error) {
      return hooks.send(
        chatId,
        `I couldn't get that voice message (${reason(error)}), so it did not reach your agent. Try again, or type it.`,
      );
    }
    let said: string;
    try {
      said = (await transcribe(audio)).trim().slice(0, MAX_MESSAGE_CHARS);
    } catch (error) {
      return hooks.send(
        chatId,
        `I couldn't transcribe that voice message (${reason(error)}), so it did not reach your agent. Try again, or type it.`,
      );
    }
    if (!said) {
      return hooks.send(chatId, "I couldn't make out any words in that voice message, so it did not reach your agent.");
    }
    const waiting = hooks.waiting(chatId);
    if (waiting?.permission) return hooks.send(chatId, typed);
    if (waiting) return this.answer(chatId, waiting, said);
    let path: string;
    try {
      path = hooks.saveVoice(audio);
    } catch (error) {
      return hooks.send(chatId, `I couldn't keep that voice message (${reason(error)}), so it did not reach your agent.`);
    }
    hooks.deliver(chatId, voiceText(path, said));
  }

  /** One photo, or a whole album, as one message: every image that could
   * be taken, the caption, and a word about anything that could not. */
  private async photos(parts: Incoming[]): Promise<void> {
    const { hooks } = this;
    const chatId = parts[0]!.chatId;
    const paths: string[] = [];
    const problems = new Set<string>();
    for (const part of parts) {
      const media = part.media;
      if (media?.kind !== "image") {
        problems.add(media?.kind === "other" ? `I can't take ${media.what}` : "only photos go in an album");
        continue;
      }
      try {
        if (media.bytes > IMAGE_MAX_BYTES) throw new Error("it is over 10 MB");
        paths.push(hooks.saveImage(await hooks.download(media.fileId, IMAGE_MAX_BYTES)));
      } catch (error) {
        problems.add(reason(error));
      }
    }
    const caption = parts
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n");
    if (paths.length) hooks.deliver(chatId, imagesText(caption, paths));
    if (!problems.size) return;
    const why = [...problems].join("; ");
    await hooks.send(
      chatId,
      parts.length === 1
        ? `I couldn't take that photo (${why}), so it did not reach your agent.`
        : paths.length
          ? `${parts.length - paths.length} of those ${parts.length} did not reach your agent (${why}). The rest did.`
          : `None of those ${parts.length} reached your agent (${why}).`,
    );
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
    const done: Promise<void> = this.photos(held.parts)
      .catch(() => {})
      .finally(() => this.releasing.delete(done));
    this.releasing.add(done);
  }
}
