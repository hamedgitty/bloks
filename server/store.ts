// Agent + thread persistence. bots.json holds agent records (including the
// thread to instance binding and per-instance resume cursors: persist
// that binding from day one, because retrofitting it is painful).
// messages-<threadId>.json holds the folded transcript.
import { readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ChangesSummary } from "./checkpoints.ts";
import type { TelegramReply } from "./telegram-returns.ts";
import { setAside, writeFileAtomic } from "./atomic-write.ts";
import { DATA_DIR } from "./config.ts";
import type { Reading } from "./context.ts";
import { newId, type ModelSelection, type ThreadId } from "./contracts.ts";

export type BlokColor =
  | "green"
  | "blue"
  | "red"
  | "orange"
  | "purple"
  | "cyan"
  | "pink"
  | "yellow"
  | "teal"
  | "coral";

export type BlokShape =
  | "star"
  | "burst"
  | "diamond"
  | "bit"
  | "triangle"
  | "cloud"
  | "drop"
  | "invader";

export type BlokExpression =
  | "deadpan"
  | "friendly"
  | "focused"
  | "thinking"
  | "excited"
  | "sleepy"
  | "surprised"
  | "skeptical"
  | "worried"
  | "mischievous";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Set when the agent is genuinely blocked on this card. Its absence
   * means the card is a setup question, which can be ignored. */
  requestId?: string;
  /** The tool an approval card is about, so the answer can be
   * remembered as a rule about that tool. */
  tool?: string;
  /** Set when a workflow run is parked on this card. Answering it
   * resumes that run rather than saying anything to an agent, so it goes
   * to its own route (server/workflows.ts explains why a run waits on
   * disk rather than in memory). */
  runId?: string;
  /** Set on an approval shown to a member of a shared room: it is the
   * owner's to answer, so the member sees it waiting, without buttons. */
  ownerOnly?: boolean;
  /** In a shared room, the person whose message led to this approval.
   * They can never be the one to answer it. */
  askedFor?: string;
  /** Who answered, when it was not the owner. */
  answeredBy?: string;
  /** The turn that asked was cut off when Bloks stopped. Nothing is
   * waiting on an answer any more, and none is ever taken as one. */
  cutOff?: boolean;
  /** Present when a lead has proposed hiring a team (server/teams.ts). */
  team?: {
    room: string;
    brief: string;
    members: Array<{ name: string; title: string; description: string; skills: string[] }>;
  };
}

/** A message between two agents, as it shows in either agent's chat.
 * "in" is one that arrived from another agent and "out" is the sender's
 * own record of sending it; the person's chat shows these as compact
 * rows, and the whole exchange opens from either. "reply" is only found
 * on messages written by 2.5.14 to 2.5.16, which marked what an agent
 * said in a turn another agent started; that is `afterAgent` now. */
export interface AgentNote {
  dir: "in" | "out" | "reply";
  peerId: string;
  peerName: string;
  /** "out" only: whether it was taken, queued behind a running turn, or refused. */
  status?: "sent" | "queued" | "failed";
}

export interface Message {
  /** Between two agents rather than with the person; see AgentNote. */
  agent?: AgentNote;
  /** Said in this agent's own chat during a turn another agent's message
   * started. Context only: it was not sent to that agent (an agent does
   * that with \`bloks say\`), so it is shown in full like any reply, with
   * a link to the exchange, and never as a message between them. */
  afterAgent?: { peerId: string; peerName: string };
  /** Set on a room message that was said in the room's linked chat
   * channel, so the bridge does not say it there a second time. */
  via?: "slack" | "discord" | "whatsapp" | "watcher" | "email" | "webhook" | "routine";
  /** The routine's name and start mode when this message was written. */
  routine?: { name?: string; manual: boolean };
  /** The user's selection on a decision component; distinct from the agent's recommendation. */
  decisionChoice?: number;
  id: string;
  role: "bot" | "user";
  /** Which agent spoke, in a room with more than one. Absent in solo
   * chats, where the agent is unambiguous. */
  from?: string;
  /** A notice that is something happening in the room (someone joined,
   * someone left) rather than something going wrong. */
  event?: boolean;
  /** A notice marking where the engine compacted its own session, and by
   * how much. A line in the conversation, not a warning, and never news:
   * it marks nothing unread and is not carried into a linked channel. */
  compaction?: { before: number | null; after: number | null; idle?: boolean };
  /** Which person wrote a user message in a shared room: a person id from
   * server/people.ts. Absent means the owner, which is every message
   * written before rooms could be shared. */
  author?: string;
  kind:
    | "text"
    | "options"
    | "activity"
    | "screen"
    | "notice"
    | "artifact"
    | "connector"
    | "secret"
    | "component"
    | "changes";
  text?: string;
  card?: OptionCardData;
  /** component messages: an answer that is not a paragraph. Validated in
   * server/components.ts before it ever reaches a screen, because what
   * arrives is JSON an agent wrote. */
  component?: Record<string, unknown>;
  /** changes messages: what a turn did to the files in its folder, and
   * whether it has been undone. See server/checkpoints.ts. */
  changes?: ChangesSummary;
  /** activity messages: tool name + outcome */
  /** `stopped`: the turn ended before this call reported back, so it
   * will never say whether it worked. */
  tool?: { name: string; ok?: boolean; stopped?: boolean };
  /** screen messages: what the agent's desktop looked like, base64 */
  png?: string;
  mime?: string;
  /** set when this message answers an earlier one */
  replyTo?: { id?: string; author: string; excerpt: string };
  /** artifact messages: a file the agent saved to its deliverables dir */
  artifact?: { name: string; mime: string; size: number };
  /** Sent while the lane was busy; drains into the next turn. Not part
   * of the conversation until then: it is moved to the end of the
   * transcript when it goes (Store.moveToEnd). */
  queued?: boolean;
  /** When it was queued. Written since 2.5.19; a queued message without
   * it predates recovery after a restart and is never run by it. */
  queuedAt?: number;
  /** Server-only return address for a Telegram request queued during
   * drain. Preserved on edits, never accepted from a client body. */
  telegramReply?: TelegramReply;
  /** Server-only: the Claude instance that accepted this queued text.
   * Null means it was accepted on another engine; absent is a legacy queue.
   * Derive command dispatch from the current text, including after edits. */
  commandInstance?: string | null;
  /** When a queued message stopped waiting and went to the turn that
   * answers it, which is also its `at` from then on, since that is when
   * it entered the conversation. With `queuedAt` it says how long it waited. Absent on a
   * message that never waited, one still waiting, one never sent, and
   * one that went before this was recorded. */
  deliveredAt?: number;
  /** Queued, then never sent: it was still waiting when Bloks restarted
   * and was too old, or too old a format, to run unattended. Kept in the
   * transcript for the person to send again if it still matters. */
  unsent?: boolean;
  /** A notice about a turn cut off too long ago to pick up on its own:
   * the lane it belongs to, for the Continue button, and `done` once it
   * has been pressed or the conversation has moved on. */
  carryOn?: { laneId: string; done?: boolean };
  /** When this message was last edited. Absent means never. */
  editedAt?: number;
  /** Taken back. The row stays so replies pointing at it still make
   * sense and the transcript keeps its shape, but the words are gone
   * and no engine sees it again. */
  deleted?: boolean;
  /** Rewound: the conversation was taken back to before this message
   * (with `deleted`, so no engine sees it). The words stay on disk so
   * the chat can show what was rewound; the time says which rewind. */
  rewound?: number;
  /** Who reacted with what. The key is the emoji; the values are who
   * pressed it, "user" for the person and an agent id for an agent, so
   * a room can show that Kat and you both agreed without a second
   * message saying so. */
  reactions?: Record<string, string[]>;
  /** secret messages: a value the agent asked for, saved server-side
   * and handed to turns as an environment variable, never in text */
  secret?: {
    envName: string;
    label: string;
    hint?: string;
    status: "needs-value" | "saved" | "dismissed";
    resumeKey?: string;
    resumed?: boolean;
  };
  /** connector messages: an app the agent asked the user to connect */
  connector?: {
    slug: string;
    label: string;
    status: "needs-auth" | "authorizing" | "connected" | "failed" | "dismissed";
    authUrl?: string;
    /** Cards planted by one request share this; the task resumes when
     * every card wearing it is connected. */
    resumeKey?: string;
    resumed?: boolean;
    error?: string;
  };
  at: number;
}

/** One lane of work: its own transcript, its own provider session, its
 * own busy flag. The id doubles as the threadId everywhere. */
export interface TaskRecord {
  /** Which provider instance last dispatched here. A different one next
   * time means that engine missed everything since and needs the story
   * replayed. Never shipped to clients. */
  lastInstanceId?: string;
  /** The CLI command this lane's engine was last told to run. A resumed
   * session told something else gets a note saying so. Never shipped. */
  briefedCli?: string;
  id: ThreadId;
  title: string;
  busy?: boolean;
  /** Something landed here that nobody has read. Per lane, so opening an
   * agent can go to the conversation that pinged you rather than the one
   * you last had open; the agent's own flag is "any of these". */
  unread?: boolean;
  /** The folder this lane's session is pinned to. Engines key their
   * sessions to a directory, so a lane keeps the folder its first turn
   * ran in even if the bot's setting changes later. null means "the
   * default", a cloud run, or the workspace. */
  cwd?: string | null;
  /** Lifetime spend in this lane, folded in as each turn settles. */
  usage?: { input: number; output: number; turns: number };
  /** What this lane looked like before the part we still send whole.
   * Written when a conversation fills up: see server/context.ts. */
  context?: {
    summary: string;
    /** How many of this lane's text messages the summary covers, counted
     * from the start, so the next transcript knows where to resume. */
    through: number;
    at: number;
    /** Where micro-compaction took over, when it has. Before this index
     * the summary covers everything; from here to `through` it covers
     * what the agent said and the person's own messages are still sent
     * whole. Absent means the whole covered part is in the summary. */
    microFrom?: number;
  };
  /** Input tokens on the last turn, which is the closest thing to "how
   * full is this lane" that a provider tells us. */
  lastInput?: number;
  /** How full this lane's session is, in the engine's own numbers, with
   * the engine and model that measured it (server/context.ts). Preferred
   * to `lastInput` wherever it belongs to the engine the lane is on. */
  reading?: Reading;
  /** Per-engine conversation cursors, one set per lane so parallel
   * lanes never share a session. */
  resumeCursors: Record<string, unknown>;
  createdAt: number;
}

/** How many lanes an agent keeps open. Once three, which ran out as soon
 * as each conversation was about one thing, and sooner still because
 * routines and other background work open lanes of their own. This bound
 * is only about keeping the list sane; each lane still runs one turn at a
 * time. */
export const MAX_TASKS = 20;

export interface BotRecord {
  id: string;
  /** The ACTIVE task's id. Kept as an alias of activeTaskId so the many
   * places that mean "the conversation on screen" keep working. */
  threadId: ThreadId;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: BlokColor;
  shape?: BlokShape;
  /** Named capabilities; folded into the provider persona. */
  skills?: string[];
  /** Library skills this agent has attached, by id (see server/skills.ts). */
  skillIds?: string[];
  /** How senior this agent is in a room, 1 to 5. The most senior member
   * of a room carries the final call when members disagree. */
  seniority?: number;
  /** The agent that hired this one, when an agent did. One of the two
   * relationships that let one agent stop another's turn (GitHub 141). */
  hiredBy?: string;
  /** How hard the engine should think, where the engine has the dial.
   * Unset means the engine's own default. */
  effort?: "low" | "medium" | "high";
  mascotExpression?: BlokExpression | null;
  /** Set when the user uploaded their own picture for this agent. The
   * value is the upload time, so clients can cache-bust with it. Absent
   * means the pixel avatar, which is the identity everything else keys
   * off; a photo is a skin over it, never a replacement for it. */
  avatarAt?: number | null;
  unread: boolean;
  modelSelection: ModelSelection;
  /** The engine that answers when this one runs out: a usage limit, a
   * rate limit, no credit, an outage (server/failover.ts). Unset means
   * a turn that hits one of those just fails, as it always did. */
  backupSelection?: ModelSelection | null;
  /** Where each engine thinks this conversation got to. Opaque to us;
   * handed straight back on the next turn. */
  resumeCursors: Record<string, unknown>;
  /** Where this agent is allowed to act. Left unset it decides for
   * itself: its own box if it has one, otherwise this Mac. "sandbox" is
   * a Linux container on this machine: isolated shell and files, no
   * display. */
  computer?: "cloud" | "sandbox" | "local" | "off" | null;
  /** The folder new turns run in. Unset means the agent's own
   * workspace; a path means the user chose a project folder. */
  cwd?: string | null;
  /** Whether this agent may reach the shared Composio connectors. The
   * key is workspace-wide; the grant is per agent. Unset means yes. */
  composio?: boolean;
  /** Whether this agent has a browser of its own, driven through the
   * debugging protocol. Unset means no: a browser is a real process,
   * so it is granted rather than assumed. */
  browser?: boolean;
  /** Ids of user-registered MCP servers this agent may use. */
  mcpServers?: string[];
  /** How this agent sounds. Unset means it has no voice yet. */
  voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string } | null;
  /** Read replies aloud as they settle, even outside a call. Off by
   * default: speech is billed per character. */
  speakReplies?: boolean;
  /** False keeps Claude Code's plugin and settings hooks out of this
   * agent's turns: a plugin's session-start text otherwise arrives in the
   * agent's context, where it reads like an injected instruction. */
  engineHooks?: boolean;
  /** Components this agent may not answer with. By exclusion rather than
   * by grant: withholding one from one agent should not touch anybody
   * else, and a list of everything permitted goes stale as the gallery
   * grows. See server/components.ts. */
  withoutComponents?: string[];
  /** Held in place in the sidebar rather than sorted by activity. */
  pinned?: boolean;
  /** Where a pinned agent stands among the pins of its section, 1 first,
   * rooms and agents counted together. Null on a pin given no place yet,
   * which stands after the placed ones, and on an agent that is not
   * pinned. Null rather than absent once it has been set, so a client
   * merging a patch cannot keep a place the agent no longer has. The
   * order itself is compareRows in src/lib/sections.ts. */
  pinOrder?: number | null;
  /** When this agent last had something to do with the person, in ms:
   * the person's own message to it, a reply in a turn the person
   * started, or anything asking something of them (server/activity.ts,
   * towardYou). Another agent's message, a routine, a watcher or a job
   * waking it, does not move it. 0 means never; absent only on a record
   * from before this was kept, until the first start seeds it from the
   * transcripts. Unpinned agents sort by it, most recent first. */
  activeWithYouAt?: number;
  hidden?: boolean;
  /** The sidebar heading this agent files under. One namespace shared
   * with rooms; absent or null means the plain Agents list. */
  section?: string | null;
  /**
   * How much this agent may do without asking. "ask" (and absent) is
   * every consequential action carding; "edits" waves file changes
   * through and asks about the rest; "auto" waves everything through.
   * Deny rules outrank every mode: a mode is a wider allow, never a
   * way past something the user forbade.
   */
  approvals?: "ask" | "edits" | "auto" | "full";
  /**
   * Retired rather than destroyed. Set instead of the record being
   * deleted, so an agent stops appearing and stops working without
   * taking its conversations, its rules, its rooms or its key with it.
   * The same shape a finished project uses.
   *
   * Kept in lockstep with `hidden`, which is the only one an older
   * client understands: an archived agent that was not also hidden would
   * still be in an older phone's list, live and unanswerable.
   */
  archivedAt?: number;
  /** The agent that archived it, when one did rather than the person,
   * and the note it left: which work it judged finished (GitHub 148). */
  archivedBy?: string;
  archiveNote?: string;
  /** Derived: true while ANY task runs. Task-level busy is the gate;
   * this stays for sidebar and composer affordances. */
  busy?: boolean;
  tasks: TaskRecord[];
  activeTaskId: ThreadId;
  createdAt: number;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");

/** Writes a file so that it is either the old one or the new one, never
 * half of each: written aside, then renamed over. A crash mid-save used to
 * leave bots.json cut short, and a bots.json that does not parse loads as
 * no agents at all. Not flushed: these are rewritten on every message. */
function writeWhole(file: string, text: string) {
  writeFileAtomic(file, text, undefined, { flush: false });
}
const messagesFile = (threadId: string) => join(DATA_DIR, `messages-${threadId}.json`);

const COLORS: BlokColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

const SHAPES: BlokShape[] = [
  "star",
  "burst",
  "diamond",
  "bit",
  "triangle",
  "cloud",
  "drop",
  "invader",
];

/** Seed content for a new agent. The client sends role-specific copy from
 * its template library; these are the fallbacks for a blank agent. */
export interface NewBotProfile {
  name?: string;
  title?: string;
  description?: string;
  color?: BlokColor;
  shape?: BlokShape;
  skills?: string[];
  skillIds?: string[];
  seniority?: number;
  greeting?: string;
  setup?: { title: string; subtitle: string; options: string[] };
}

const DEFAULT_GREETING = "I'm ready. Tell me what you need and I'll get to work.";

export class Store {
  bots: BotRecord[] = [];
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;
  /** Told about every message as it is written. Messages arrive through
   * forty-odd doors, and something that cares about all of them (who the
   * person has been with, in server/index.ts) watches this one instead. */
  onAppend?: (threadId: string, message: Message) => void;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch (error) {
      // Kept aside rather than lost: the first save after this would
      // otherwise write no agents over every agent there was.
      setAside(BOTS_FILE, error);
      this.bots = [];
    }
    // busy never survives a restart, no turn does either
    for (const b of this.bots) {
      b.busy = false;
      // bots saved before lanes existed adopt their single thread as the
      // first task, cursors and all
      if (!Array.isArray(b.tasks) || b.tasks.length === 0) {
        b.tasks = [
          {
            id: b.threadId,
            title: "General",
            resumeCursors: b.resumeCursors ?? {},
            createdAt: b.createdAt,
          },
        ];
        b.activeTaskId = b.threadId;
      }
      for (const t of b.tasks) t.busy = false;
      if (!b.activeTaskId || !b.tasks.some((t) => t.id === b.activeTaskId)) {
        b.activeTaskId = b.tasks[0].id;
        b.threadId = b.tasks[0].id;
      }
    }
  }

  private saveBots() {
    writeWhole(BOTS_FILE, JSON.stringify(this.bots, null, 2));
  }

  messagesFor(threadId: string): Message[] {
    let list = this.messages.get(threadId);
    if (!list) {
      try {
        list = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
      } catch (error) {
        setAside(messagesFile(threadId), error);
        list = [];
      }
      this.messages.set(threadId, list!);
    }
    return list!;
  }

  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message {
    const full: Message = { id: newId(), at: Date.now(), ...message };
    const list = this.messagesFor(threadId);
    list.push(full);
    writeWhole(messagesFile(threadId), JSON.stringify(list, null, 2));
    this.onAppend?.(threadId, full);
    return full;
  }

  /**
   * Add or remove one reaction, and say which happened.
   *
   * Toggling is the whole interaction: pressing the same emoji twice
   * takes yours back off, and the last person to leave takes the chip
   * with them rather than leaving an empty zero behind.
   */
  toggleReaction(
    threadId: string,
    messageId: string,
    emoji: string,
    who: string,
  ): { message: Message; added: boolean } | null {
    const message = this.messagesFor(threadId).find((m) => m.id === messageId);
    if (!message) return null;

    const reactions = { ...(message.reactions ?? {}) };
    const current = reactions[emoji] ?? [];
    const had = current.includes(who);
    const next = had ? current.filter((id) => id !== who) : [...current, who];

    if (next.length === 0) delete reactions[emoji];
    else reactions[emoji] = next;

    // an empty map is absence, not an empty object on every message
    const patched = this.patchMessage(threadId, messageId, {
      reactions: Object.keys(reactions).length ? reactions : undefined,
    });
    return patched ? { message: patched, added: !had } : null;
  }

  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null {
    const list = this.messagesFor(threadId);
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return null;
    // A patch that never mentions the card keeps it: most patches are a
    // reaction or a tool result and have no business erasing the ask.
    // But a patch that says `card: undefined` means it, which is how a
    // message taken back stops being answerable. `??` could not tell the
    // two apart, so it kept the card on every deletion.
    const card = "card" in patch ? patch.card : list[idx].card;
    list[idx] = { ...list[idx], ...patch, card };
    writeWhole(messagesFile(threadId), JSON.stringify(list, null, 2));
    return list[idx];
  }

  /**
   * Takes messages out of where they are and puts them at the end of the
   * transcript, in the order given, each changed by `patch` on the way.
   * A queued message waits outside the conversation and enters it when
   * it goes, after everything said while it waited, so the order on disk
   * is the order the agent heard things in (GitHub 170). Ids stay as
   * they are, so a reply, an edit or a deletion still finds the message.
   */
  moveToEnd(threadId: string, messageIds: readonly string[], patch: (m: Message) => Partial<Message>): Message[] {
    const list = this.messagesFor(threadId);
    const moved: Message[] = [];
    for (const id of messageIds) {
      const idx = list.findIndex((m) => m.id === id);
      if (idx === -1) continue;
      const [message] = list.splice(idx, 1);
      moved.push({ ...message, ...patch(message) });
    }
    if (!moved.length) return [];
    list.push(...moved);
    writeWhole(messagesFile(threadId), JSON.stringify(list, null, 2));
    return moved;
  }

  /** Several request markers change together, without moving their
   * transcript positions. A crash cannot leave half a burst claimed. */
  patchMessages(threadId: string, messageIds: readonly string[], patch: (m: Message) => Partial<Message>): Message[] {
    const ids = new Set(messageIds);
    const changed: Message[] = [];
    const list = this.messagesFor(threadId);
    for (let i = 0; i < list.length; i++) if (ids.has(list[i].id)) {
      list[i] = { ...list[i], ...patch(list[i]) };
      changed.push(list[i]);
    }
    if (changed.length) writeWhole(messagesFile(threadId), JSON.stringify(list, null, 2));
    return changed;
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  /** Any lane's thread resolves to its bot, not just the active one. */
  botByThread(threadId: string) {
    return this.bots.find((b) => b.tasks.some((t) => t.id === threadId)) ?? null;
  }

  /** Creates an agent, seeded with its role's own greeting and, when the
   * caller brings one, its setup question. No question is invented for a
   * caller that sent none: answering one only posts its text, so a stock
   * "how should we work together" asks about approvals without setting
   * them, on every agent another agent hires. */
  createBot(profile: NewBotProfile = {}): BotRecord {
    const bot: BotRecord = {
      id: newId(),
      threadId: newId(),
      name: profile.name?.trim() || "Assistant",
      title: profile.title ?? "",
      description: profile.description ?? "",
      notifications: true,
      color: profile.color ?? COLORS[this.bots.length % COLORS.length],
      // colors cycle by 10 and shapes by 8, so pairings vary for 40 agents
      shape: profile.shape ?? SHAPES[this.bots.length % SHAPES.length],
      ...(profile.skills?.length ? { skills: profile.skills } : {}),
      ...(profile.skillIds?.length ? { skillIds: profile.skillIds } : {}),
      ...(profile.seniority ? { seniority: profile.seniority } : {}),
      unread: false,
      modelSelection: this.defaultSelection(),
      resumeCursors: {},
      createdAt: Date.now(),
      // nothing with the person yet; a route the person made it through
      // says otherwise
      activeWithYouAt: 0,
      tasks: [],
      activeTaskId: "",
    };
    bot.tasks = [{ id: bot.threadId, title: "General", resumeCursors: {}, createdAt: bot.createdAt }];
    bot.activeTaskId = bot.threadId;
    this.bots.unshift(bot);
    this.saveBots();
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "text",
      text: profile.greeting?.trim() || DEFAULT_GREETING,
    });
    if (profile.setup) {
      this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: profile.setup });
    }
    return bot;
  }

  /**
   * Retire an agent. The record stays, so everything about it stays.
   *
   * `hidden` moves with it rather than being a second switch somebody
   * has to remember: one of them set without the other is either an
   * agent in the list that cannot answer, or one out of the list that
   * can. Written here so no call site can get the pair wrong.
   */
  archiveBot(id: string, now: number, by?: { botId: string; note?: string }): BotRecord | null {
    const bot = this.bot(id);
    if (!bot || bot.archivedAt) return null;
    const before = { hidden: bot.hidden, archivedBy: bot.archivedBy, archiveNote: bot.archiveNote };
    bot.archivedAt = now;
    bot.hidden = true;
    if (by) {
      bot.archivedBy = by.botId;
      if (by.note) bot.archiveNote = by.note;
      else delete bot.archiveNote;
    }
    try {
      this.saveBots();
    } catch (e) {
      // not saved is not archived: the agent stays as it was, in service
      delete bot.archivedAt;
      bot.hidden = before.hidden;
      bot.archivedBy = before.archivedBy;
      bot.archiveNote = before.archiveNote;
      if (bot.hidden === undefined) delete bot.hidden;
      if (bot.archivedBy === undefined) delete bot.archivedBy;
      if (bot.archiveNote === undefined) delete bot.archiveNote;
      throw e;
    }
    return bot;
  }

  /**
   * And back again, into the list and into service.
   *
   * Keyed on either flag, not on archivedAt alone. A workspace written by
   * an older build has agents with `hidden` and no `archivedAt`, and the
   * drawer lists them by `hidden`: keying on the new field only would
   * have left every one of those with a Restore button that answered 404
   * and a delete button that worked.
   */
  restoreBot(id: string): BotRecord | null {
    const bot = this.bot(id);
    if (!bot || (!bot.archivedAt && !bot.hidden)) return null;
    delete bot.archivedAt;
    delete bot.hidden;
    delete bot.archivedBy;
    delete bot.archiveNote;
    this.saveBots();
    return bot;
  }

  deleteBot(id: string): boolean {
    const bot = this.bot(id);
    if (!bot) return false;
    this.bots = this.bots.filter((b) => b.id !== id);
    for (const task of bot.tasks) {
      this.messages.delete(task.id);
      try {
        unlinkSync(messagesFile(task.id));
      } catch {}
    }
    this.saveBots();
    return true;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.bot(id);
    if (!bot) return null;
    Object.assign(bot, patch);
    this.saveBots();
    return bot;
  }

  /** Several agents at once, written once: moving one pin renumbers its
   * neighbours, and a file written per neighbour is a file half written
   * if anything stops partway. Returns the agents that exist. */
  patchBots(changes: ReadonlyArray<{ id: string; patch: Partial<BotRecord> }>): BotRecord[] {
    const changed: BotRecord[] = [];
    for (const { id, patch } of changes) {
      const bot = this.bot(id);
      if (!bot) continue;
      Object.assign(bot, patch);
      changed.push(bot);
    }
    if (changed.length) this.saveBots();
    return changed;
  }

  /** Cursors are per-lane: the thread that produced the session owns it. */
  setResumeCursor(threadId: string, instanceId: string, cursor: unknown) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    found.task.resumeCursors[instanceId] = cursor;
    this.saveBots();
  }

  taskByThread(threadId: string): { bot: BotRecord; task: TaskRecord } | null {
    for (const bot of this.bots) {
      const task = bot.tasks.find((t) => t.id === threadId);
      if (task) return { bot, task };
    }
    return null;
  }

  /** `extra` lets a lane past the cap: rehearsals run in lanes of their
   * own and should not have to wait for one of yours to close. */
  createTask(botId: string, title: string, extra = 0): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot || bot.tasks.length >= MAX_TASKS + extra) return null;
    const task: TaskRecord = { id: newId(), title, resumeCursors: {}, createdAt: Date.now() };
    bot.tasks.push(task);
    this.setActiveTask(botId, task.id);
    return task;
  }

  setActiveTask(botId: string, taskId: string): boolean {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!bot || !task) return false;
    bot.activeTaskId = task.id;
    bot.threadId = task.id;
    this.saveBots();
    return true;
  }

  /** Closing a lane deletes it and its transcript. General, the first
   * lane, is never closed; it is cleared instead. */
  deleteTask(botId: string, taskId: string): "ok" | "busy" | "missing" | "general" {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!bot || !task) return "missing";
    if (task.busy) return "busy";
    if (task === bot.tasks[0]) return "general";

    bot.tasks = bot.tasks.filter((t) => t.id !== taskId);
    this.dropTranscript(task.id);
    // a closed lane's unread goes with it
    bot.unread = bot.tasks.some((t) => t.unread);
    if (bot.activeTaskId === task.id) {
      this.setActiveTask(botId, bot.tasks[0].id);
    } else {
      this.saveBots();
    }
    return "ok";
  }

  /** Clearing a lane empties it in place: the same id and title, with a
   * fresh transcript and session. */
  clearTask(botId: string, taskId: string): "ok" | "busy" | "missing" {
    const bot = this.bot(botId);
    const index = bot?.tasks.findIndex(({ id }) => id === taskId) ?? -1;
    if (!bot || index < 0) return "missing";

    const task = bot.tasks[index];
    if (task.busy) return "busy";

    bot.tasks[index] = { id: task.id, title: task.title, resumeCursors: {}, createdAt: Date.now() };
    this.dropTranscript(task.id);
    bot.unread = bot.tasks.some(({ unread }) => unread);
    this.saveBots();
    return "ok";
  }

  private dropTranscript(taskId: string) {
    this.messages.delete(taskId);
    try {
      unlinkSync(messagesFile(taskId));
    } catch {}
  }

  /** Read or unread, one lane at a time, with the agent's flag following
   * as "any lane unread" so every older reader of it stays right. */
  markLane(botId: string, taskId: string, unread: boolean) {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!bot || !task) return;
    task.unread = unread || undefined;
    bot.unread = bot.tasks.some((t) => t.unread);
    this.saveBots();
  }

  patchTaskTitle(botId: string, taskId: string, title: string) {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!task || !title.trim()) return;
    task.title = title.trim();
    this.saveBots();
  }

  /** A lane's folder is decided once, on its first turn. */
  pinTaskCwd(threadId: string, cwd: string | null): string | null {
    const found = this.taskByThread(threadId);
    if (!found) return cwd;
    if (found.task.cwd === undefined) {
      found.task.cwd = cwd;
      this.saveBots();
    }
    return found.task.cwd;
  }

  /** A settled turn's tokens fold into its lane's lifetime tally. */
  addTaskUsage(threadId: string, input: number, output: number, fill?: number) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    const safe = (n: number) => Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));
    const usage = found.task.usage ?? { input: 0, output: 0, turns: 0 };
    usage.input += safe(input);
    usage.output += safe(output);
    usage.turns += 1;
    found.task.usage = usage;
    // The last turn's input is how full this lane was, which is what the
    // ring shows. A running total is a different question. A turn that
    // compacted the session says how full it is now instead (`fill`).
    found.task.lastInput = safe(fill ?? input);
    this.saveBots();
  }

  /** Tool calls in a thread that never reported back, marked stopped:
   * the turn they belonged to is over, so no answer is coming and a
   * spinner would say an agent is working when it is not. `from` limits
   * it to one member's calls in a room. Returns what changed. */
  settleOpenTools(threadId: string, from?: string): Message[] {
    const changed: Message[] = [];
    for (const message of this.messagesFor(threadId)) {
      if (message.kind !== "activity" || !message.tool || message.tool.ok !== undefined || message.tool.stopped) continue;
      if (from !== undefined && message.from !== from) continue;
      const patched = this.patchMessage(threadId, message.id, { tool: { ...message.tool, stopped: true } });
      if (patched) changed.push(patched);
    }
    return changed;
  }

  /** Questions and approvals in a thread that a stopped engine was
   * waiting on, settled as cut off. The engine process that held each
   * request is gone, and a new one may number its own requests the same
   * way, so an answer to an old card must never reach it as permission.
   * A workflow's card waits on disk rather than on an engine, and stays. */
  settleOpenAsks(threadId: string): Message[] {
    const changed: Message[] = [];
    for (const message of this.messagesFor(threadId)) {
      const card = message.card;
      if (message.kind !== "options" || !card?.requestId || card.runId || card.answered || card.dismissed) continue;
      const patched = this.patchMessage(threadId, message.id, {
        card: { ...card, answered: "Cut off when Bloks stopped", cutOff: true },
      });
      if (patched) changed.push(patched);
    }
    return changed;
  }

  /** A lane starts a new engine session on its next turn, replaying
   * only what is still in its transcript. Every engine's cursor goes,
   * because each of them remembers the part being taken back. */
  forgetLaneSessions(threadId: string) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    found.task.resumeCursors = {};
    delete found.task.lastInstanceId;
    // a reading measured a session that is not coming back
    delete found.task.reading;
    this.saveBots();
  }

  /** A new engine session on the lane's next turn, without the old one's
   * context: every cursor goes, but the engine that served it is kept, so
   * the next turn is not treated as an engine that missed the conversation
   * and handed the whole transcript instead (GitHub 139). The transcript
   * itself stays. */
  startFreshSession(threadId: string) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    found.task.resumeCursors = {};
    delete found.task.reading;
    this.saveBots();
  }

  /**
   * Fold an engine's word on how full a lane is into what the lane knows.
   * A part it did not say keeps its last value, but only from the same
   * engine and model: a window measured by another is not this one's.
   */
  noteReading(
    threadId: string,
    by: { instanceId: string; model: string | null },
    said: { used: number | null; window: number | null },
    at = Date.now(),
  ) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    const was = found.task.reading;
    const same = was && was.instanceId === by.instanceId && (was.model ?? null) === by.model ? was : null;
    const used = said.used ?? same?.used ?? 0;
    const window = said.window ?? same?.window ?? null;
    const next = { used: Math.max(0, Math.round(used)), window, instanceId: by.instanceId, model: by.model, at };
    found.task.reading = next;
    // a tool loop restates the same numbers often; the file is written
    // when they change, not each time they are said
    if (same && same.used === next.used && same.window === next.window) return;
    this.saveBots();
  }

  /** Record what a lane's earlier messages were folded into. */
  setTaskContext(
    threadId: string,
    context: { summary: string; through: number; at: number; microFrom?: number } | null,
  ) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    if (context) found.task.context = context;
    else delete found.task.context;
    this.saveBots();
  }

  markTaskDispatched(botId: string, taskId: string, instanceId: string, cli?: string): void {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const cliChanged = cli !== undefined && task.briefedCli !== cli;
    if (task.lastInstanceId === instanceId && !cliChanged) return;
    task.lastInstanceId = instanceId;
    if (cliChanged) task.briefedCli = cli;
    this.saveBots();
  }

  /** The task gate flips here; bot.busy is recomputed as the rollup. */
  setTaskBusy(threadId: string, busy: boolean): BotRecord | null {
    const found = this.taskByThread(threadId);
    if (!found) return null;
    found.task.busy = busy;
    found.bot.busy = found.bot.tasks.some((t) => t.busy);
    this.saveBots();
    return found.bot;
  }

  /** First-run seed: one agent so the app never opens empty.
   *
   *  Deliberately not called "your first agent". Setup ends at the agent
   *  picker, so by the time anyone reads this Nova may well be the
   *  second agent in the list, sitting under a role the user chose. The
   *  copy has to be true either way. */
  seedIfEmpty() {
    if (this.bots.length) return;
    this.createBot({
      name: "Nova",
      title: "Generalist",
      color: "blue",
      shape: "star",
      greeting:
        "I'm Nova, and I'll take anything you throw at me. Tell me what you need, or make more of us, each with its own job.",
    });
  }
}
