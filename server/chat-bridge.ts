// A shared room, carried into a group chat.
//
// A room can be linked to one channel in Slack or Discord. Everything said
// in the room is said in the channel, and what people say to the agents in
// the channel is said in the room. The rules are the shared room's rules,
// not new ones: a person in the channel is a guest of the room, the owner
// lets each one in, approvals come back to the owner, the room's cap is the
// room's cap. The channel is only another window onto the same room.
//
// What this file adds is the part a group chat needs and a room did not:
//
//   Nothing is heard unless it is addressed. A channel is full of talk that
//   is not for the agents, and reading it all would be both rude and
//   expensive. A message wakes the room only when it names the bot or an
//   agent in the room; everything else is never read past this function.
//
//   Nobody is heard unless they were let in. The first time a stranger
//   addresses the agents they are told, once, that the owner decides, and
//   the owner is asked, the same way a joiner from an invite link is.
//
//   Bots are never heard. Another bot in the channel (another Bloks, a CI
//   notifier, this bridge's own echoes) cannot start a turn, which is the
//   cheapest loop protection there is: two agents cannot talk each other
//   into a bill across a chat they both sit in.
//
// Pure, so the rules can be read in one place and tested exhaustively.
// The transports (server/slack.ts, server/discord.ts) only move bytes.

export type ChatPlatform = "slack" | "discord";

export const PLATFORM_NAME: Record<ChatPlatform, string> = { slack: "Slack", discord: "Discord" };

/** A room's link to one channel. Lives on the room's sharing settings. */
export interface ChatLink {
  platform: ChatPlatform;
  channelId: string;
  /** What the owner saw when choosing it, for the panel. */
  channelName: string;
  /** People in the channel the owner turned away. They are not asked
   * about again, and not answered. */
  declined?: string[];
}

/** One message from a channel, reduced to what the room needs. */
export interface ChatMessage {
  platform: ChatPlatform;
  channelId: string;
  /** The sender's id on that platform. Never a display name: names can
   * be changed by their owner, ids cannot. */
  userId: string;
  userName: string;
  /** Text with the platform's mention syntax already turned into plain
   * @names by the transport, except the bot's own mention, which the
   * transport reports as `addressedBot`. */
  text: string;
  /** Whether the message mentioned this bridge's own bot user. */
  addressedBot: boolean;
  /** From a bot, a webhook or an app, including this bridge itself. */
  fromBot: boolean;
  /** The platform's id for the message, so a reply can thread under it. */
  messageId: string;
}

export type Decision =
  | { kind: "ignore"; why: "not-linked" | "bot" | "not-addressed" | "declined" | "empty" }
  /** A stranger asked for the agents. Tell them once, ask the owner. */
  | { kind: "knock" }
  /** A person the owner let in. Post into the room as them. */
  | { kind: "post"; personId: string; text: string };

/**
 * What to do with one channel message.
 *
 * `personFor` answers whether this sender is a person already in the room
 * (by platform and id); `agentNames` is the room's agents, so "@Nova" in
 * plain text counts as addressing the room.
 */
export function decide(
  link: ChatLink | null | undefined,
  message: ChatMessage,
  personFor: (platform: ChatPlatform, userId: string) => string | null,
  agentNames: string[],
): Decision {
  if (!link || link.platform !== message.platform || link.channelId !== message.channelId) {
    return { kind: "ignore", why: "not-linked" };
  }
  if (message.fromBot) return { kind: "ignore", why: "bot" };
  const text = message.text.trim();
  if (!text && !message.addressedBot) return { kind: "ignore", why: "empty" };
  if (!message.addressedBot && !namesAnAgent(text, agentNames)) return { kind: "ignore", why: "not-addressed" };
  const personId = personFor(message.platform, message.userId);
  if (personId) return { kind: "post", personId, text: text || "Hello" };
  if (link.declined?.includes(message.userId)) return { kind: "ignore", why: "declined" };
  return { kind: "knock" };
}

/** Whether text names one of the room's agents with an @, as a word. */
export function namesAnAgent(text: string, agentNames: string[]): boolean {
  const lower = text.toLowerCase();
  return agentNames.some((name) => {
    const needle = `@${name.toLowerCase()}`;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      const after = lower[at + needle.length];
      // "@Nova," and "@Nova" count; "@Novak" does not
      if (after === undefined || !/[a-z0-9_]/.test(after)) return true;
      at = lower.indexOf(needle, at + 1);
    }
    return false;
  });
}

/** What the channel is told the first time a stranger asks. Said once per
 * person, so a channel is never filled with the same line. */
export function knockReply(userName: string, ownerName: string): string {
  return `${userName}, the agents here answer people ${ownerName} has let into this room. ${ownerName} has been asked.`;
}

/** Who a room line was said by, as the channel shows it. */
export type Speaker = { kind: "agent"; name: string } | { kind: "person"; name: string } | { kind: "notice" };

/**
 * A room message as the channel shows it. The bridge posts as one bot, so
 * the speaker's name leads the line; agents and people are told apart by
 * how the name is set, the way a transcript would.
 */
export function outbound(platform: ChatPlatform, speaker: Speaker, text: string): string {
  const body = neutralise(platform, clip(text, platform === "discord" ? 1_900 : 3_900));
  // Slack bolds with one asterisk and italicises with an underscore;
  // Discord bolds with two
  if (speaker.kind === "notice") return platform === "slack" ? `_${body}_` : `*${body}*`;
  const name = escape(platform, speaker.name);
  if (speaker.kind === "person") return `${name}: ${body}`;
  return platform === "slack" ? `*${name}* ${body}` : `**${name}** ${body}`;
}

/** Nothing the room says may ping a whole channel. */
function neutralise(platform: ChatPlatform, text: string): string {
  if (platform === "discord") return text.replace(/@(everyone|here)/gi, "@\u200b$1");
  return text.replace(/<!(channel|here|everyone)[^>]*>/gi, "@$1").replace(/<@([A-Z0-9]+)>/g, "@$1");
}

function escape(platform: ChatPlatform, text: string): string {
  if (platform === "slack") return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.replace(/([*_`~|>\\])/g, "\\$1").replace(/@/g, "@\u200b");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A per room brake on how often agents may start turns, whoever asked.
 *
 * Hop limits already stop two agents naming each other forever in one
 * chain. This catches the rest: a busy channel, a person pasting the same
 * request ten times, a chain that restarts because a person keeps poking
 * it. Past the limit the room says so once and waits.
 */
export class TurnBrake {
  private starts = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit = 12, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a turn start and says whether it may go ahead. */
  allow(roomId: string, now = Date.now()): boolean {
    const recent = (this.starts.get(roomId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.starts.set(roomId, recent);
      return false;
    }
    recent.push(now);
    this.starts.set(roomId, recent);
    return true;
  }
}
