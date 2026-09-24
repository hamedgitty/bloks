// Slack, for rooms linked to a Slack channel (server/chat-bridge.ts).
//
// Socket Mode, the same direction of travel as Telegram's long polling:
// this computer opens a connection to Slack and Slack sends events down
// it. Nothing listens on a port, no public address is needed, and no
// router is touched. It costs the owner a second token (the app-level one,
// xapp-), which is what Socket Mode is authorised by; the bot token
// (xoxb-) is what posts.
//
// Scopes the app needs, and why:
//   channels:history, groups:history   read messages in channels it is in
//   channels:read, groups:read         list those channels for the picker
//   chat:write                         post the room's side
//   users:read                         a person's name, from their id
import type { ChatMessage } from "./chat-bridge.ts";

// overridable only so a test can stand in for Slack
const API = process.env.BLOKS_SLACK_API || "https://slack.com/api";

export interface SlackTokens {
  botToken: string;
  appToken: string;
}

export function cleanBotToken(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  return /^xoxb-[A-Za-z0-9-]{20,}$/.test(t) ? t : null;
}

export function cleanAppToken(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim() : "";
  return /^xapp-[A-Za-z0-9-]{20,}$/.test(t) ? t : null;
}

async function call(token: string, method: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": body ? "application/json; charset=utf-8" : "application/x-www-form-urlencoded",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!json.ok) throw new Error(`Slack said ${json.error ?? res.status}`);
  return json;
}

/** Who the bot is, which also proves the token works. */
export async function whoAmI(botToken: string): Promise<{ userId: string; team: string }> {
  const me = await call(botToken, "auth.test");
  return { userId: String(me.user_id), team: String(me.team ?? "Slack") };
}

/** Channels the bot has been added to, for the picker. */
export async function channels(botToken: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const res = await call(botToken, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) if (c.is_member) out.push({ id: String(c.id), name: `#${c.name}` });
    cursor = res.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

export async function post(botToken: string, channelId: string, text: string): Promise<void> {
  await call(botToken, "chat.postMessage", { channel: channelId, text, unfurl_links: false, unfurl_media: false });
}

/**
 * One Slack event as a ChatMessage, or null for anything that is not a
 * person's (or a bot's) new message. Names are resolved by the caller;
 * this only reads the wire.
 */
export function parseEvent(
  event: Record<string, any>,
  botUserId: string,
): (Omit<ChatMessage, "userName" | "text"> & { rawText: string }) | null {
  if (!event || event.type !== "message") return null;
  // edits, deletions, joins and topic changes are not somebody speaking
  if (event.subtype && event.subtype !== "thread_broadcast" && event.subtype !== "bot_message") return null;
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const rawText = typeof event.text === "string" ? event.text.slice(0, 4_000) : "";
  const fromBot = Boolean(event.bot_id) || event.subtype === "bot_message" || event.user === botUserId;
  const userId = typeof event.user === "string" ? event.user : typeof event.bot_id === "string" ? event.bot_id : "";
  if (!channelId || !userId) return null;
  return {
    platform: "slack",
    channelId,
    userId,
    rawText,
    addressedBot: rawText.includes(`<@${botUserId}>`),
    fromBot,
    messageId: String(event.ts ?? ""),
  };
}

/** Slack's markup to plain text: the bot's own mention dropped, other
 * people's mentions as @name, links as their text, entities decoded. */
export function plainText(raw: string, botUserId: string, nameOf: (id: string) => string | undefined): string {
  return raw
    .replace(new RegExp(`<@${botUserId}>`, "g"), "")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${nameOf(id) ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)[^>]*>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * A Socket Mode connection that reconnects by itself until stopped. Each
 * envelope is acknowledged at once, before it is handled: Slack resends
 * anything not acknowledged within three seconds, and a turn takes longer.
 */
export class SlackSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private delay = 1_000;
  private seen = new Set<string>();
  private names = new Map<string, string>();
  botUserId = "";
  onStatus: (state: "connecting" | "connected" | "error", detail?: string) => void = () => {};

  private readonly tokens: SlackTokens;
  private readonly onMessage: (message: ChatMessage) => void;
  constructor(tokens: SlackTokens, onMessage: (message: ChatMessage) => void) {
    this.tokens = tokens;
    this.onMessage = onMessage;
  }

  async start() {
    this.stopped = false;
    try {
      this.botUserId = (await whoAmI(this.tokens.botToken)).userId;
    } catch (e) {
      this.onStatus("error", (e as Error).message);
      return this.retry();
    }
    await this.connect();
  }

  stop() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  private retry() {
    if (this.stopped) return;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, 60_000);
    setTimeout(() => void this.connect(), wait).unref?.();
  }

  private async connect() {
    if (this.stopped) return;
    this.onStatus("connecting");
    let url: string;
    try {
      url = String((await call(this.tokens.appToken, "apps.connections.open")).url);
    } catch (e) {
      this.onStatus("error", (e as Error).message);
      return this.retry();
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onmessage = (frame) => void this.receive(ws, String(frame.data));
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.retry();
    };
    ws.onerror = () => {};
  }

  private async receive(ws: WebSocket, data: string) {
    let envelope: Record<string, any>;
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    if (envelope.type === "hello") {
      this.delay = 1_000;
      this.onStatus("connected");
      return;
    }
    if (envelope.type === "disconnect") {
      try {
        ws.close();
      } catch {}
      return;
    }
    if (envelope.envelope_id) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type !== "events_api") return;
    const parsed = parseEvent(envelope.payload?.event, this.botUserId);
    if (!parsed) return;
    // a redelivery after a reconnect is the same message, not a new one
    const key = `${parsed.channelId}:${parsed.messageId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 2_000) this.seen = new Set([...this.seen].slice(-1_000));

    const mentioned = [...parsed.rawText.matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]);
    await Promise.all([parsed.userId, ...mentioned].map((id) => this.name(id)));
    const { rawText, ...rest } = parsed;
    this.onMessage({
      ...rest,
      userName: this.names.get(parsed.userId) ?? "Someone",
      text: plainText(rawText, this.botUserId, (id) => this.names.get(id)),
    });
  }

  private async name(id: string): Promise<void> {
    if (this.names.has(id) || !/^[UW]/.test(id)) return;
    try {
      const res = await fetch(`${API}/users.info?user=${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${this.tokens.botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as Record<string, any>;
      const profile = json.user?.profile ?? {};
      const name = String(profile.display_name || profile.real_name || json.user?.name || "").trim();
      if (name) this.names.set(id, name.slice(0, 40));
    } catch {}
  }
}
