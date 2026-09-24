// Discord, for rooms linked to a Discord channel (server/chat-bridge.ts).
//
// The gateway is a connection this computer opens to Discord, so like
// Telegram and Slack nothing listens here and no address is published.
// One bot token does everything. The bot needs the Message Content intent
// switched on in the developer portal, or every message arrives with its
// text blanked and nobody can ever address the agents; the settings screen
// says so, because Discord's own error for it is a closed socket.
import type { ChatMessage } from "./chat-bridge.ts";

// overridable only so a test can stand in for Discord
const API = process.env.BLOKS_DISCORD_API || "https://discord.com/api/v10";

/** Guilds, guild messages, and the text of those messages. */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export function cleanToken(raw: unknown): string | null {
  const t = typeof raw === "string" ? raw.trim().replace(/^Bot\s+/i, "") : "";
  return /^[A-Za-z0-9_.-]{50,100}$/.test(t) ? t : null;
}

async function call(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bot ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Discord said ${(json as { message?: string }).message ?? res.status}`);
  return json;
}

export async function whoAmI(token: string): Promise<{ userId: string; name: string }> {
  const me = await call(token, "GET", "/users/@me");
  return { userId: String(me.id), name: String(me.username ?? "bot") };
}

/** Text channels in every server the bot is in, for the picker. */
export async function channels(token: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  const guilds = (await call(token, "GET", "/users/@me/guilds")) as Array<{ id: string; name: string }>;
  for (const guild of guilds.slice(0, 25)) {
    const list = (await call(token, "GET", `/guilds/${guild.id}/channels`).catch(() => [])) as Array<Record<string, any>>;
    for (const c of list) {
      // 0 is a text channel, 5 an announcement channel
      if (c.type === 0 || c.type === 5) out.push({ id: String(c.id), name: `#${c.name} (${guild.name})` });
    }
  }
  return out;
}

export async function post(token: string, channelId: string, text: string): Promise<void> {
  // nothing the room says pings anyone, whatever the text contains
  await call(token, "POST", `/channels/${channelId}/messages`, { content: text, allowed_mentions: { parse: [] } });
}

/** One MESSAGE_CREATE as a ChatMessage, or null for anything that is not
 * text in a guild channel. */
export function parseMessage(d: Record<string, any>, botUserId: string): ChatMessage | null {
  if (!d || typeof d.channel_id !== "string" || !d.author) return null;
  const raw = typeof d.content === "string" ? d.content.slice(0, 4_000) : "";
  const mentions = Array.isArray(d.mentions) ? (d.mentions as Array<Record<string, any>>) : [];
  const addressedBot = mentions.some((m) => String(m.id) === botUserId) || new RegExp(`<@!?${botUserId}>`).test(raw);
  const nameOf = (id: string) => {
    const m = mentions.find((x) => String(x.id) === id);
    return m ? String(m.global_name || m.username || "someone") : "someone";
  };
  const text = raw
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${nameOf(id)}`)
    .replace(/<#(\d+)>/g, "#channel")
    .replace(/<@&(\d+)>/g, "@role")
    .trim();
  return {
    platform: "discord",
    channelId: d.channel_id,
    userId: String(d.author.id),
    userName: String(d.member?.nick || d.author.global_name || d.author.username || "Someone").slice(0, 40),
    text,
    addressedBot,
    fromBot: Boolean(d.author.bot) || Boolean(d.webhook_id) || String(d.author.id) === botUserId,
    messageId: String(d.id ?? ""),
  };
}

/** A gateway connection that reconnects by itself until stopped. */
export class DiscordGateway {
  private ws: WebSocket | null = null;
  private stopped = false;
  private seq: number | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private delay = 1_000;
  botUserId = "";
  onStatus: (state: "connecting" | "connected" | "error", detail?: string) => void = () => {};

  private readonly token: string;
  private readonly onMessage: (message: ChatMessage) => void;
  constructor(token: string, onMessage: (message: ChatMessage) => void) {
    this.token = token;
    this.onMessage = onMessage;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearBeat();
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  private clearBeat() {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  private retry(detail?: string) {
    if (this.stopped) return;
    if (detail) this.onStatus("error", detail);
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, 60_000);
    setTimeout(() => void this.connect(), wait).unref?.();
  }

  private async connect() {
    if (this.stopped) return;
    this.onStatus("connecting");
    let url: string;
    try {
      url = String((await call(this.token, "GET", "/gateway/bot")).url);
    } catch (e) {
      return this.retry((e as Error).message);
    }
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    this.ws = ws;
    ws.onmessage = (frame) => this.receive(ws, String(frame.data));
    ws.onclose = (event) => {
      this.clearBeat();
      if (this.ws === ws) this.ws = null;
      // 4014 is Discord refusing an intent the portal has not switched on
      this.retry(
        event.code === 4014
          ? "Switch on Message Content Intent for this bot in the Discord developer portal."
          : event.code === 4004
            ? "Discord did not accept that bot token."
            : undefined,
      );
    };
    ws.onerror = () => {};
  }

  private receive(ws: WebSocket, data: string) {
    let frame: { op: number; d: any; s: number | null; t: string | null };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof frame.s === "number") this.seq = frame.s;
    switch (frame.op) {
      case 10: {
        this.clearBeat();
        const every = Number(frame.d?.heartbeat_interval) || 41_250;
        this.beat = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 1, d: this.seq }));
          } catch {}
        }, every);
        this.beat.unref?.();
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: "bloks", device: "bloks" } },
          }),
        );
        return;
      }
      case 1:
        ws.send(JSON.stringify({ op: 1, d: this.seq }));
        return;
      case 7:
      case 9:
        // asked to reconnect, or the session is gone: start over
        try {
          ws.close();
        } catch {}
        return;
      case 0:
        if (frame.t === "READY") {
          this.botUserId = String(frame.d?.user?.id ?? "");
          this.delay = 1_000;
          this.onStatus("connected");
        } else if (frame.t === "MESSAGE_CREATE") {
          const message = parseMessage(frame.d, this.botUserId);
          if (message) this.onMessage(message);
        }
    }
  }
}
