// Agent + thread persistence. bots.json holds agent records (including the
// thread to instance binding and per-instance resume cursors: persist
// that binding from day one, because retrofitting it is painful).
// messages-<threadId>.json holds the folded transcript.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
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
  /** Set when a workflow run is parked on this card. Answering it
   * resumes that run rather than saying anything to an agent, so it goes
   * to its own route (server/workflows.ts explains why a run waits on
   * disk rather than in memory). */
  runId?: string;
  /** Present when a lead has proposed hiring a team (server/teams.ts). */
  team?: {
    room: string;
    brief: string;
    members: Array<{ name: string; title: string; description: string; skills: string[] }>;
  };
}

export interface Message {
  id: string;
  role: "bot" | "user";
  /** Which agent spoke, in a room with more than one. Absent in solo
   * chats, where the agent is unambiguous. */
  from?: string;
  kind:
    | "text"
    | "options"
    | "activity"
    | "screen"
    | "notice"
    | "artifact"
    | "connector"
    | "secret"
    | "component";
  text?: string;
  card?: OptionCardData;
  /** component messages: an answer that is not a paragraph. Validated in
   * server/components.ts before it ever reaches a screen, because what
   * arrives is JSON an agent wrote. */
  component?: Record<string, unknown>;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: what the agent's desktop looked like, base64 */
  png?: string;
  mime?: string;
  /** set when this message answers an earlier one */
  replyTo?: { id?: string; author: string; excerpt: string };
  /** artifact messages: a file the agent saved to its deliverables dir */
  artifact?: { name: string; mime: string; size: number };
  /** sent while the lane was busy; drains into the next turn */
  queued?: boolean;
  /** When this message was last edited. Absent means never. */
  editedAt?: number;
  /** Taken back. The row stays so replies pointing at it still make
   * sense and the transcript keeps its shape, but the words are gone
   * and no engine sees it again. */
  deleted?: boolean;
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
  id: ThreadId;
  title: string;
  busy?: boolean;
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
  /** Per-engine conversation cursors, one set per lane so parallel
   * lanes never share a session. */
  resumeCursors: Record<string, unknown>;
  createdAt: number;
}

/** A bot runs at most this many lanes: enough to feel parallel, few
 * enough that each still gets real attention and real compute. */
export const MAX_TASKS = 3;

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
  /** Ids of user-registered MCP servers this agent may use. */
  mcpServers?: string[];
  /** How this agent sounds. Unset means it has no voice yet. */
  voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string } | null;
  /** Read replies aloud as they settle, even outside a call. Off by
   * default: speech is billed per character. */
  speakReplies?: boolean;
  /** Components this agent may not answer with. By exclusion rather than
   * by grant: withholding one from one agent should not touch anybody
   * else, and a list of everything permitted goes stale as the gallery
   * grows. See server/components.ts. */
  withoutComponents?: string[];
  pinned?: boolean;
  hidden?: boolean;
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
  /** Derived: true while ANY task runs. Task-level busy is the gate;
   * this stays for sidebar and composer affordances. */
  busy?: boolean;
  tasks: TaskRecord[];
  activeTaskId: ThreadId;
  createdAt: number;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
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

const DEFAULT_SETUP: OptionCardData = {
  title: "How should we work together?",
  subtitle: "This shapes how much I check in versus just handle things.",
  options: [
    "Check with me before acting",
    "Act on the small stuff, ask on the big",
    "Keep me posted, I trust you",
  ],
};

export class Store {
  bots: BotRecord[] = [];
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      this.bots = JSON.parse(readFileSync(BOTS_FILE, "utf8"));
    } catch {
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
    writeFileSync(BOTS_FILE, JSON.stringify(this.bots, null, 2));
  }

  messagesFor(threadId: string): Message[] {
    let list = this.messages.get(threadId);
    if (!list) {
      try {
        list = JSON.parse(readFileSync(messagesFile(threadId), "utf8"));
      } catch {
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
    writeFileSync(messagesFile(threadId), JSON.stringify(list, null, 2));
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
    writeFileSync(messagesFile(threadId), JSON.stringify(list, null, 2));
    return list[idx];
  }

  bot(id: string) {
    return this.bots.find((b) => b.id === id) ?? null;
  }

  /** Any lane's thread resolves to its bot, not just the active one. */
  botByThread(threadId: string) {
    return this.bots.find((b) => b.tasks.some((t) => t.id === threadId)) ?? null;
  }

  /** Creates an agent, seeded with its role's own greeting and setup
   * question, a new agent is never anonymous or generically onboarded. */
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
    this.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: profile.setup ?? DEFAULT_SETUP,
    });
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
  archiveBot(id: string, now: number): BotRecord | null {
    const bot = this.bot(id);
    if (!bot || bot.archivedAt) return null;
    bot.archivedAt = now;
    bot.hidden = true;
    this.saveBots();
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

  createTask(botId: string, title: string): TaskRecord | null {
    const bot = this.bot(botId);
    if (!bot || bot.tasks.length >= MAX_TASKS) return null;
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

  /** Closing a lane deletes its transcript; the last lane never closes. */
  deleteTask(botId: string, taskId: string): "ok" | "busy" | "last" | "missing" {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!bot || !task) return "missing";
    if (task.busy) return "busy";
    if (bot.tasks.length <= 1) return "last";
    bot.tasks = bot.tasks.filter((t) => t.id !== taskId);
    this.messages.delete(task.id);
    try {
      unlinkSync(messagesFile(task.id));
    } catch {}
    if (bot.activeTaskId === task.id) {
      this.setActiveTask(botId, bot.tasks[0].id);
    } else {
      this.saveBots();
    }
    return "ok";
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
  addTaskUsage(threadId: string, input: number, output: number) {
    const found = this.taskByThread(threadId);
    if (!found) return;
    const safe = (n: number) => Math.max(0, Math.trunc(Number.isFinite(n) ? n : 0));
    const usage = found.task.usage ?? { input: 0, output: 0, turns: 0 };
    usage.input += safe(input);
    usage.output += safe(output);
    usage.turns += 1;
    found.task.usage = usage;
    // The last turn's input is how full this lane was, which is what the
    // ring shows. A running total is a different question.
    found.task.lastInput = safe(input);
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

  markTaskDispatched(botId: string, taskId: string, instanceId: string): void {
    const bot = this.bot(botId);
    const task = bot?.tasks.find((t) => t.id === taskId);
    if (!task || task.lastInstanceId === instanceId) return;
    task.lastInstanceId = instanceId;
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
