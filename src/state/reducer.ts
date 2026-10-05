// Pure state: the types every part of the app shares, and the reducer
// that folds actions into them.
//
// This is deliberately a plain .ts module with no React in it. The
// reducer is the piece with real logic (message routing between rooms
// and agents, card patching, arrivals of agents nobody has seen yet), so
// it should be testable without mounting anything. store.tsx owns the
// transports and wires this up.
import type { BlokColor, BlokExpression, BlokShape } from "@/lib/mascot";

export type { BlokColor, BlokShape } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  /** In a shared room, the collaborator who answered, when it was not you. */
  answeredBy?: string;
  dismissed?: boolean;
  /** Set when the agent is genuinely blocked on this card. Its absence
   * means a setup question, which is safe to ignore. */
  requestId?: string;
  /** The tool an approval card is about, so the answer can be
   * remembered as a rule about that tool. */
  tool?: string;
  /** Set when a workflow run is parked on this card. Answering it
   * resumes that run rather than saying anything to an agent. */
  runId?: string;
  /** Present when a lead has proposed hiring a team. Approving it creates
   * the agents and the room they work in. */
  team?: TeamPlan;
}

/** A team a lead wants to hire, pending the user's approval. */
export interface TeamPlan {
  room: string;
  brief: string;
  members: Array<{ name: string; title: string; description: string; skills: string[] }>;
}

/** A message between two agents (see server/store.ts, AgentNote). */
export interface AgentNote {
  dir: "in" | "out" | "reply";
  peerId: string;
  peerName: string;
  status?: "sent" | "queued" | "failed";
}

export interface Message {
  /** Between two agents rather than with the person. */
  agent?: AgentNote;
  /** Said in this agent's own chat in a turn another agent's message
   * started: shown in full, with a link to the exchange. Not sent to it. */
  afterAgent?: { peerId: string; peerName: string };
  /** The user's selection on a decision component. */
  decisionChoice?: number;
  /** Sent while the lane was busy; drains into the next turn. */
  queued?: boolean;
  /** When it was queued, and when it stopped waiting and went to the
   * agent. Together they are how long it waited. */
  queuedAt?: number;
  deliveredAt?: number;
  /** Queued, but still waiting when Bloks restarted and too old to send
   * on its own (server/index.ts, recoverQueued). */
  unsent?: boolean;
  /** Emoji to whoever pressed it: "user", or an agent's id. */
  reactions?: Record<string, string[]>;
  /** When this message was last edited. Absent means never. */
  editedAt?: number;
  /** Taken back: the row stays, the words are gone. */
  deleted?: boolean;
  /** Came in some other way than you typing it here. */
  via?: "slack" | "discord" | "whatsapp" | "watcher" | "email" | "webhook";
  /** Rewound: taken back with everything after it (see the rewind route). */
  rewound?: number;
  /** secret messages: a value asked for via a secure field */
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
    resumeKey?: string;
    resumed?: boolean;
    error?: string;
  };
  id: string;
  role: "bot" | "user";
  /** Which agent spoke, in a room with more than one. */
  from?: string;
  /** Which person wrote a message in a shared room. Absent: you. */
  author?: string;
  /** A room event (someone joined or left), not a warning. */
  event?: boolean;
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
  /** changes messages: what one turn did to the files in its folder. */
  changes?: {
    checkpointId: string;
    files: Array<{
      path: string;
      status: "added" | "modified" | "deleted";
      big?: boolean;
      added?: number;
      removed?: number;
      /** Changed while another agent was working in the folder, and not
       * one this turn said it edited: shown apart, left out of Undo. */
      shared?: boolean;
    }>;
    total: number;
    /** How many of the files are shared, and the agents who were working
     * there at the same time. */
    shared?: { total: number; alongside: string[] };
    reverted?: { at: number; restored: number; skipped: number };
    /** A rehearsal: changes made on a copy, waiting for a decision. */
    rehearsal?: { state: "pending" | "applied" | "discarded" };
  };
  text?: string;
  card?: OptionCardData;
  /** component messages: an answer that is not a paragraph. */
  component?: Record<string, unknown>;
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
  at: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

/** One lane of an agent's parallel work, as the strip renders it. */
export interface TaskSummary {
  id: string;
  title: string;
  state: "working" | "needs-you" | "idle";
  /** Something landed here that nobody has opened yet. */
  unread?: boolean;
  /** When anything last happened in this lane. */
  lastAt?: number;
  createdAt: number;
  /** Lifetime tokens spent in this lane. */
  usage?: { input: number; output: number; turns: number };
  /** How full this lane's conversation is, and whether its earlier part
   * has been summarised. See server/context.ts. */
  context?: { used: number; limit: number; fraction: number; summarised: boolean };
}

export interface Bot {
  id: string;
  /** The active task's thread; messages below belong to it. */
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: BlokColor;
  shape?: BlokShape;
  skills?: string[];
  /** Library skills attached to this agent, by id. */
  skillIds?: string[];
  /** 1 to 5; the most senior member of a room has the final call. */
  seniority?: number;
  /** Reasoning effort for engines that have the dial. */
  effort?: "low" | "medium" | "high";
  mascotExpression?: BlokExpression | null;
  /** Upload time of the user's own photo for this agent; absent means
   * the pixel avatar. Doubles as the cache-buster. */
  avatarAt?: number | null;
  unread: boolean;
  /** Messages older than the first one here, still on the server. Only
   * set when the transcript arrived trimmed, through Bloks Cloud. */
  olderMessages?: number;
  busy?: boolean;
  /** Somebody has taken this agent's computer. Null when nobody has;
   * absent only from a harness too old to say. */
  held?: { since: number; why: string; turnedAway: number } | null;
  /** Retired. The row leaves the list and the agent stops working, but
   * everything about it is kept and it can be brought back. */
  archivedAt?: number | null;
  /** The agent that archived it, when one did rather than you, and the
   * note it left about the finished work. */
  archivedBy?: string;
  archiveNote?: string;
  tasks?: TaskSummary[];
  activeTaskId?: string;
  modelSelection: ModelSelection;
  /** The engine that answers when the agent's own runs out. */
  backupSelection?: ModelSelection | null;
  /** Where this agent may act. Left unset it decides for itself: its own
   * box when it has one, otherwise this Mac. */
  computer?: "cloud" | "sandbox" | "local" | "off" | null;
  /** The folder new turns run in; unset means the agent's workspace. */
  cwd?: string | null;
  /** Whether this agent may reach the shared connectors. Unset = yes. */
  composio?: boolean;
  /** Whether this agent has a browser of its own. Unset = no: a browser
   * starts a real process, so it is asked for rather than assumed. */
  browser?: boolean;
  /** Ids of user-registered MCP servers this agent may use. */
  mcpServers?: string[];
  /** How this agent sounds; unset means no voice yet. */
  voice?: { provider: "elevenlabs" | "openai" | "system"; id: string; name?: string } | null;
  /** Read replies aloud as they settle. */
  speakReplies?: boolean;
  /** False: Claude Code runs this agent's turns without hooks. */
  engineHooks?: boolean;
  /** The public half of this agent's key, hex. What its signatures in
   * the record are checked against. */
  fingerprint?: string;
  /** Components this agent may not answer with. */
  withoutComponents?: string[];
  /** Held in place in the sidebar rather than sorted by activity. */
  pinned?: boolean;
  /** Its place among the pins of its section, lowest first; null is a
   * pin with no place yet, after the rest. See src/lib/sections.ts. */
  pinOrder?: number | null;
  /** When it last had something to do with the person (server/store.ts
   * says what counts). The unpinned rows sort by it. */
  activeWithYouAt?: number;
  createdAt?: number;
  /** The sidebar heading this agent files under; unset means the plain
   * Agents list. Shares one namespace with rooms. */
  section?: string | null;
  /** How much this agent may do without asking: ask (default), edits
   * (file changes wave through), auto (everything does). Deny rules
   * outrank every mode. */
  approvals?: "ask" | "edits" | "auto" | "full";
  hidden?: boolean;
  messages: Message[];
}

/** What the server admits about stored credentials: whether each one
 * exists, and never the value. */
export interface ConfigStatus {
  xai?: { configured: boolean   /** Whether this workspace has been through the welcome. */
  setupDone?: boolean;
};
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  speech?: {
    elevenlabs: boolean;
    openai: boolean;
    /** The Mac's own voices: no key, no account. */
    system?: boolean;
    openaiSource?: "env" | "codex";
    openaiAvailable?: "env" | "codex";
  };
  /** Shared context for every agent, not a secret, so it round-trips. */
  profile?: { about: string };
  /** How lanes are kept inside the model's window. */
  compaction?: { micro: boolean };
  /** Whether finished sessions are read back for something worth keeping. */
  skills?: { propose: boolean };
  /** How long a silent tool call may hold a turn, in minutes; 0 is never. */
  turns?: { stallMinutes: number };
  /** Where a new agent starts, applied before its first turn. Absent on
   * a server that does not know about it, and then Settings says nothing. */
  agentDefaults?: AgentDefaults;
}

export interface AgentDefaults {
  cwd?: string;
  /** Ask when unset. An agent hiring another passes on no more than its own. */
  approvals?: "edits" | "auto" | "full";
  modelSelection?: ModelSelection;
  effort?: "low" | "medium" | "high";
}

type Lane = { id: string; unread?: boolean; lastAt?: number; createdAt: number; state?: string };
type LanedBot = { activeTaskId?: string; threadId: string; unread?: boolean; tasks?: Lane[] };

/** The conversation that pinged you: one stopped on you first, then the
 * most recent unread lane, when it is not the one already open. Opening an
 * agent goes there, because the dot on the agent was about it. */
export function pingedLane(bot: LanedBot): string | null {
  const open = bot.activeTaskId ?? bot.threadId;
  // A lane stopped on a question or an approval comes first, read or not:
  // going only to unread lanes meant an approval in a lane already looked
  // at could not be found from the agent at all.
  const stopped = (bot.tasks ?? []).find((t) => t.state === "needs-you" && t.id !== open);
  if (stopped) return stopped.id;
  const waiting = (bot.tasks ?? [])
    .filter((t) => t.unread && t.id !== open)
    .sort((a, b) => (b.lastAt ?? b.createdAt) - (a.lastAt ?? a.createdAt));
  return waiting[0]?.id ?? null;
}

/** The same agent with its open lane read. Its own flag follows as "any
 * lane still unread", which is what the server says too. */
export function readOpenLane<T extends LanedBot>(bot: T): T {
  const open = bot.activeTaskId ?? bot.threadId;
  if (!bot.tasks) return { ...bot, unread: false };
  const tasks = bot.tasks.map((t) => (t.id === open ? { ...t, unread: false } : t));
  return { ...bot, tasks, unread: tasks.some((t) => t.unread) };
}

/** Whether the lane on screen is the unread one. An agent flagged unread
 * with no lane to show for it (a turn in a room marks the agent, not a
 * lane) counts as the open one, or that flag could never be cleared. */
export function openLaneUnread(bot: LanedBot): boolean {
  const open = bot.activeTaskId ?? bot.threadId;
  const lane = bot.tasks?.find((t) => t.id === open);
  if (bot.unread && !bot.tasks?.some((t) => t.unread)) return true;
  return lane ? Boolean(lane.unread) : Boolean(bot.unread);
}

/** Whether the conversation on screen is the one working. An agent's
 * conversations run on their own, so "busy" anywhere is not "busy here":
 * reading it agent-wide put "working..." and typing dots on an idle
 * conversation while another one ran. A harness too old to report lanes
 * falls back to the agent's flag. */
export function openLaneWorking(bot: LanedBot & { busy?: boolean }): boolean {
  const open = bot.activeTaskId ?? bot.threadId;
  const lane = bot.tasks?.find((t) => t.id === open);
  return lane?.state ? lane.state === "working" : Boolean(bot.busy);
}

/** A `config` frame is the whole status plus the stream's own fields.
 * Picking fields out of it by name drops whatever was added later, and
 * the card reading a dropped field vanishes until the next reload. */
export function configFromFrame(frame: Record<string, unknown>): ConfigStatus {
  const { kind: _kind, _seq, ...status } = frame;
  return status as unknown as ConfigStatus;
}

/** One engine, as the model picker sees it. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: {
    default: string;
    options: Array<{ id: string; label: string }>;
    /** Where the list came from, when it is not the engine reporting it live. */
    note?: string;
    /** The engine takes any model id, so one typed in can be used. */
    acceptsAnyId?: boolean;
  };
}

/** The role a new agent is created with, sent with POST /api/bots so the
 * agent is named, skilled and greeted correctly on its first frame. */
export interface NewAgentProfile {
  name?: string;
  title?: string;
  description?: string;
  color?: BlokColor;
  shape?: BlokShape;
  skills?: string[];
  skillIds?: string[];
  greeting?: string;
  setup?: { title: string; subtitle: string; options: string[] };
}

/** A room where several agents work together. */
export interface Blok {
  id: string;
  name: string;
  memberIds: string[];
  /** Unaddressed messages wake only the most senior member. */
  leadOnly?: boolean;
  /** The room's shared desk, and the pin that fixes it at first use. */
  cwd?: string;
  pinnedCwd?: string | null;
  /** The sidebar heading this room files under; unset means the plain
   * Rooms list. Shares one namespace with agents. */
  section?: string | null;
  /** Held in place in the sidebar; rooms start that way. */
  pinned?: boolean;
  /** Its place among the pins of its section, as an agent's is. */
  pinOrder?: number | null;
  /** When it last had something to do with the person. */
  activeWithYouAt?: number;
  createdAt: number;
  /** Present while the room is shared with other people. */
  sharing?: RoomSharing;
  /** Archived rooms are kept on the server and never listed here. */
  archived?: boolean;
  messages: Message[];
  /** Messages older than the first one here, still on the server. Only
   * set when the transcript arrived trimmed, through Bloks Cloud. */
  olderMessages?: number;
}

/** How a shared room behaves, owner's choice. See server/bloks.ts. */
export interface RoomSharing {
  since: number;
  history: "join" | "all";
  collaboratorsInvite: boolean;
  activityDetail: boolean;
  tools: "conversation" | "desk";
  memoryFor?: string[];
  ownerTools?: { connectors?: boolean; mcp?: string[]; browser?: boolean; computer?: boolean };
  collaboratorsApprove?: boolean;
  spendCap?: number;
}

/** Someone in a shared room who is not you. */
export interface RoomPerson {
  id: string;
  name: string;
  role: "collaborator" | "viewer";
  joinedAt: number;
}

/** One row of GET /api/providers: an engine and how you sign in to it. */
export interface ProviderRow {
  kind: string;
  name: string;
  /** oauth = browser sign-in, key = paste one, cli = another tool holds
   * the login, none = runs locally and asks for nothing. */
  auth: "oauth" | "key" | "cli" | "none";
  keyHint: string;
  /** For CLI engines: what to do once it is installed but not signed in. */
  signInHint?: string;
  keyPrefix?: string;
  docsUrl: string;
  connected: boolean;
  /** Installed, but with no login we can see. Not the same as missing. */
  needsSignIn?: boolean;
  /** Whether this engine can run tools and touch files, or only chat. */
  agentic: boolean;
}

/** A reusable instruction set from the library (server/skills.ts). */
export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  source: "builtin" | "user";
}

export interface AppState {
  bots: Bot[];
  bloks: Blok[];
  instances: InstanceInfo[];
  /** Engines with a newer release than the one installed, by driver kind.
   * Why a new model can be missing from the list. */
  engineUpdates: Record<string, { installed: string; latest: string }>;
  providers: ProviderRow[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  /** Which Settings page is showing, so a link can open the right one. */
  settingsPage: string;
  newAgentOpen: boolean;
  /** the new-agent screen is the last step of setup, not a normal visit */
  newAgentFirstRun: boolean;
  skillsOpen: boolean;
  /** The Memory panel, and which agent it opens on (null: the first). */
  memoryOpen: boolean;
  memoryBotId: string | null;
  /** The Rehearsals panel, and a counter bumped when any rehearsal moves. */
  rehearsalsOpen: boolean;
  /** The morning brief panel (BriefPanel). */
  briefOpen: boolean;
  /** The agent taking meeting notes, while its panel is open. */
  meetingFor: string | null;
  rehearsalsTick: number;
  /** Bumped when the server says a kind of thing changed (notes about
   * you, briefs, watchers, meetings), so whatever shows it re-reads. */
  ticks: Record<string, number>;
  /** A gallery team a bloks:// link asked to open, until the dialog takes it. */
  teamLink: string | null;
  routinesOpen: boolean;
  newRoomOpen: boolean;
  projectsOpen: boolean;
  /** The one place that says what is running and what wants you. */
  activityOpen: boolean;
  /** The sheet of every keyboard shortcut (⌘/). */
  shortcutsOpen: boolean;
  /** The project the app is looking through, or null for everything.
   * A lens: nothing is hidden from anywhere else, and leaving puts the
   * whole workspace back. */
  projectId: string | null;
  /** The order the sidebar's section headings were dragged into, kept
   * with the workspace so every device has the same one. */
  sectionOrder: string[];
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** Threads whose turn has ended and no new one begun. A delta for one
   * of them is late (pushes through the relay can arrive out of order)
   * and would reopen a finished reply beside its own message. */
  settledTurns: Record<string, true>;
  /** the most recent picture of each agent's screen */
  screens: Record<string, { png: string; mime: string; source?: "browser" }>;
  /** People in each shared room, by room id. */
  roomPeople: Record<string, RoomPerson[]>;
  /** Join requests waiting on you, by room id: how many. */
  joinRequests: Record<string, number>;
  /** The last person seen typing in each shared room. */
  roomTyping: Record<string, { name: string; at: number }>;
  /** agents whose box is still being stood up, so the panel can say so */
  provisioning: Record<string, boolean>;
  /** The agent list has arrived at least once. Until then an empty list
   * means "not loaded yet", not "you have no agents". */
  hydrated: boolean;
  connected: boolean;
  error: string | null;
}

export type Action =
  | { type: "hydrate"; bots: Bot[] }
  /** A page of earlier messages for a transcript that arrived trimmed.
   * `threadId` guards against a lane that changed while it was loading. */
  | { type: "earlierLoaded"; id: string; threadId: string; messages: Message[]; olderMessages: number }
  | { type: "hydrateBloks"; bloks: Blok[] }
  | { type: "blokPatched"; blok: Omit<Blok, "messages"> }
  | { type: "roomPeople"; roomId: string; people: RoomPerson[] }
  | { type: "joinRequest"; roomId: string; pending?: number }
  | { type: "roomTyping"; roomId: string; name: string; at: number }
  | { type: "blokDeleted"; blokId: string }
  | { type: "createRoom"; name: string; memberIds: string[] }
  | { type: "deleteRoom"; blokId: string }
  | { type: "patchRoom"; blokId: string; patch: { archived?: boolean; name?: string; section?: string | null } }
  /** Where an agent or a room sits in the sidebar: its section, whether
   * it is pinned, and its place among the pins (1 the top) when one was
   * chosen. The store works out what that does to the neighbours. */
  | { type: "placeRow"; kind: "agent" | "room"; id: string; section: string | null; pinned: boolean; position?: number }
  /** What a placement changed, row by row, shown before the server says. */
  | {
      type: "placed";
      rows: Array<{
        kind: "agent" | "room";
        id: string;
        patch: { section?: string | null; pinned?: boolean; pinOrder?: number | null };
      }>;
    }
  /** The section order the workspace keeps, as the server has it. */
  | { type: "sectionOrder"; order: string[] }
  /** The person dragged a heading: the new order, to show and to keep. */
  | { type: "moveSections"; order: string[] }
  | { type: "sendToRoom"; blokId: string; text: string; replyTo?: Message["replyTo"] }
  | { type: "toggleNewRoom"; open?: boolean }
  | { type: "openTeamLink"; slug: string | null }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "engineUpdates"; updates: Record<string, { installed: string; latest: string }> }
  | { type: "providers"; providers: ProviderRow[] }
  | { type: "connectProvider"; kind: string; key?: string; url?: string }
  | { type: "disconnectProvider"; kind: string }
  | { type: "configStatus"; config: ConfigStatus }
  /** `lane` opens that conversation; without it, the one that pinged. */
  | { type: "select"; id: string; lane?: string }
  | { type: "send"; botId: string; text: string; replyTo?: Message["replyTo"] }
  | { type: "answerCard"; botId: string; messageId: string; answer: string; roomId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; roomId?: string }
  | { type: "hireTeam"; botId: string; messageId: string }
  | { type: "newBot"; profile?: NewAgentProfile }
  | { type: "toggleNewAgent"; open?: boolean; firstRun?: boolean }
  | { type: "toggleSkills"; open?: boolean }
  | { type: "toggleRoutines"; open?: boolean }
  | { type: "toggleActivity"; open?: boolean }
  | { type: "toggleShortcuts"; open?: boolean }
  | { type: "newTask"; botId: string }
  | { type: "selectTask"; botId: string; taskId: string }
  | { type: "closeTask"; botId: string; taskId: string }
  | { type: "clearTask"; botId: string; taskId: string }
  | { type: "renameTask"; botId: string; taskId: string; title: string }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string; forget?: boolean }
  | { type: "restoreBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markLaneUnread"; botId: string; taskId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string; onlyIfSettled?: boolean }
  | { type: "turnStarted"; threadId: string }
  | { type: "turnSettled"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string; source?: "browser" }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  /** `page` opens Settings on that page (see SETTINGS_PAGES). */
  | { type: "toggleAppSettings"; open?: boolean; page?: string }
  | { type: "toggleProjects"; open?: boolean }
  | { type: "toggleMemory"; open?: boolean; botId?: string | null }
  | { type: "toggleRehearsals"; open?: boolean }
  | { type: "rehearsalsChanged" }
  | { type: "tick"; key: string }
  | { type: "toggleBrief"; open?: boolean }
  | { type: "openMeeting"; botId: string | null }
  | { type: "openProject"; id: string | null }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          | "name"
          | "title"
          | "description"
          | "notifications"
          | "computer"
          | "color"
          | "shape"
          | "skills"
          | "skillIds"
          | "seniority"
          | "effort"
          | "mascotExpression"
          | "pinned"
          | "hidden"
          | "section"
          | "approvals"
          | "composio"
          | "mcpServers"
          | "backupSelection"
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

/** An agent record from the server, minus the fields the person is still
 * typing into. The echo of a save reports what was sent, which is older
 * than what has been typed since, and adopting it would take those
 * keystrokes back. */
export function withoutEdits<T extends object>(bot: T, editing: ReadonlySet<string>): T {
  if (!editing.size) return bot;
  return Object.fromEntries(Object.entries(bot).filter(([key]) => !editing.has(key))) as T;
}

/** Drop this save's unanswered marks when it is still the latest for that
 * field, and return the fields whose response is stale (a newer save is
 * still in flight). The caller withholds those from the merge so an
 * older HTTP response cannot overwrite newer text. */
export function settleUnanswered(
  unanswered: Map<string, number>,
  saveGens: ReadonlyMap<string, number>,
): Set<string> {
  const stale = new Set<string>();
  for (const [key, gen] of saveGens) {
    if (unanswered.get(key) === gen) unanswered.delete(key);
    else stale.add(key);
  }
  return stale;
}

/** The card a card action is about, in an agent's chat or in a room. */
export function findCard(
  state: AppState,
  ref: { botId: string; messageId: string; roomId?: string },
): OptionCardData | undefined {
  const messages = ref.roomId
    ? state.bloks.find((b) => b.id === ref.roomId)?.messages
    : state.bots.find((b) => b.id === ref.botId)?.messages;
  return messages?.find((m) => m.id === ref.messageId)?.card;
}

const withCard = (messages: Message[], messageId: string, patch: Partial<OptionCardData>) =>
  messages.map((m) => (m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m));

/** Cards live in an agent's chat or in a room; roomId picks which. */
function patchCard(
  state: AppState,
  botId: string,
  messageId: string,
  patch: Partial<OptionCardData>,
  roomId?: string,
): AppState {
  if (roomId) {
    return {
      ...state,
      bloks: state.bloks.map((b) =>
        b.id === roomId ? { ...b, messages: withCard(b.messages, messageId, patch) } : b,
      ),
    };
  }
  return updateBot(state, botId, (b) => ({ ...b, messages: withCard(b.messages, messageId, patch) }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const wanted = state.selectedId || readSelected();
      const match = action.bots.find((b) => b.id === wanted);
      const selectedId = match
        ? match.hidden
          ? (action.bots.find((b) => !b.hidden)?.id ?? "")
          : wanted
        : wanted && !action.bots.some((b) => b.id === wanted)
          ? wanted
          : (action.bots.find((b) => !b.hidden)?.id ?? "");
      return { ...state, bots: action.bots, selectedId, hydrated: true };
    }
    case "earlierLoaded": {
      const prepend = <T extends { messages: Message[]; olderMessages?: number }>(t: T): T => {
        const have = new Set(t.messages.map((m) => m.id));
        const fresh = action.messages.filter((m) => !have.has(m.id));
        return { ...t, messages: [...fresh, ...t.messages], olderMessages: action.olderMessages };
      };
      if (state.bloks.some((b) => b.id === action.id)) {
        return { ...state, bloks: state.bloks.map((b) => (b.id === action.id ? prepend(b) : b)) };
      }
      return updateBot(state, action.id, (b) => (b.threadId === action.threadId ? prepend(b) : b));
    }
    case "hydrateBloks": {
      // the server keeps archived rooms; the list only hides them, and a
      // reload must not bring back what patchRoom took away
      const bloks = action.bloks.filter((b) => !b.archived);
      const wanted = state.selectedId || readSelected();
      const selectedId = bloks.some((b) => b.id === wanted) ? wanted : state.selectedId;
      return { ...state, bloks, selectedId };
    }
    case "roomPeople":
      return { ...state, roomPeople: { ...state.roomPeople, [action.roomId]: action.people } };
    case "joinRequest":
      return {
        ...state,
        joinRequests: {
          ...state.joinRequests,
          [action.roomId]: action.pending ?? (state.joinRequests[action.roomId] ?? 0) + 1,
        },
      };
    case "roomTyping":
      return { ...state, roomTyping: { ...state.roomTyping, [action.roomId]: { name: action.name, at: action.at } } };
    case "blokPatched": {
      // the server's echo of an archive, which would otherwise re-add
      // the room patchRoom has just removed
      if (action.blok.archived) {
        return { ...state, bloks: state.bloks.filter((b) => b.id !== action.blok.id) };
      }
      const existing = state.bloks.find((b) => b.id === action.blok.id);
      return {
        ...state,
        bloks: existing
          ? // sharing is set outright: a room that stopped being shared
            // arrives without the key, and a merge would keep the old one
            state.bloks.map((b) =>
              b.id === action.blok.id ? { ...b, ...action.blok, sharing: action.blok.sharing } : b,
            )
          : [{ ...action.blok, messages: [] }, ...state.bloks],
      };
    }
    case "blokDeleted": {
      const bloks = state.bloks.filter((b) => b.id !== action.blokId);
      const selectedId =
        state.selectedId === action.blokId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bloks, selectedId };
    }
    case "openTeamLink":
      return { ...state, teamLink: action.slug, newRoomOpen: action.slug ? true : state.newRoomOpen };
    case "toggleNewRoom":
      return { ...state, newRoomOpen: action.open ?? !state.newRoomOpen };
    case "toggleRehearsals":
      return { ...state, rehearsalsOpen: action.open ?? !state.rehearsalsOpen };
    case "rehearsalsChanged":
      return { ...state, rehearsalsTick: state.rehearsalsTick + 1 };
    case "openMeeting":
      return { ...state, meetingFor: action.botId };
    case "toggleBrief":
      return { ...state, briefOpen: action.open ?? !state.briefOpen };
    case "tick":
      return { ...state, ticks: { ...state.ticks, [action.key]: (state.ticks[action.key] ?? 0) + 1 } };
    case "toggleMemory":
      return {
        ...state,
        memoryOpen: action.open ?? !state.memoryOpen,
        memoryBotId: action.botId === undefined ? state.memoryBotId : action.botId,
      };
    case "toggleProjects":
      return { ...state, projectsOpen: action.open ?? !state.projectsOpen };
    case "openProject": {
      try {
        if (action.id) localStorage.setItem("bloks-project", action.id);
        else localStorage.removeItem("bloks-project");
      } catch {
        /* private mode: the choice holds for this session */
      }
      return { ...state, projectId: action.id };
    }
    case "engineUpdates":
      return { ...state, engineUpdates: action.updates };
    case "instances":
      return { ...state, instances: action.instances };
    case "providers":
      return { ...state, providers: action.providers };
    case "configStatus":
      return { ...state, config: action.config };
    case "select":
      writeSelected(action.id);
      // choosing a conversation in the sidebar means looking at it, so a
      // full page covering the chat steps aside
      return updateBot({ ...state, selectedId: action.id, routinesOpen: false, appSettingsOpen: false }, action.id, (b) =>
        action.lane && b.tasks
          ? (() => {
              const tasks = b.tasks.map((t) => (t.id === action.lane ? { ...t, unread: false } : t));
              return { ...b, tasks, unread: tasks.some((t) => t.unread) };
            })()
          : readOpenLane(b),
      );
    // settle the card locally now; the server's own patch arrives a
    // moment later saying the same thing
    case "answerCard":
      return patchCard(state, action.botId, action.messageId, { answered: action.answer }, action.roomId);
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true }, action.roomId);
    case "hireTeam":
      return patchCard(state, action.botId, action.messageId, { answered: "Hire the team" });
    case "botAdded":
      writeSelected(action.bot.id);
      return {
        ...state,
        // the server announces a new agent to every window, and that can
        // arrive before the reply to the request that made it
        bots: [action.bot, ...state.bots.filter((b) => b.id !== action.bot.id)],
        selectedId: action.bot.id,
        newAgentOpen: false,
        newAgentFirstRun: false,
      };
    case "toggleNewAgent":
      return {
        ...state,
        newAgentOpen: action.open ?? !state.newAgentOpen,
        // only a deliberate first-run open sets the flag; every close clears
        // it, so a later visit never inherits setup's copy
        newAgentFirstRun: (action.open ?? !state.newAgentOpen) ? (action.firstRun ?? false) : false,
      };
    case "toggleSkills":
      return { ...state, skillsOpen: action.open ?? !state.skillsOpen };
    case "toggleRoutines":
      {
        const open = action.open ?? !state.routinesOpen;
        return { ...state, routinesOpen: open, appSettingsOpen: open ? false : state.appSettingsOpen };
      }
    case "toggleActivity":
      return { ...state, activityOpen: action.open ?? !state.activityOpen };
    case "toggleShortcuts":
      return { ...state, shortcutsOpen: action.open ?? !state.shortcutsOpen };
    case "newTask":
    case "selectTask":
    case "closeTask":
    case "clearTask":
      return state;
    case "renameTask":
      // shown at once; the server's answer (one line, 40 characters)
      // replaces it a moment later through botPatched
      return {
        ...state,
        bots: state.bots.map((b) =>
          b.id === action.botId
            ? { ...b, tasks: b.tasks?.map((t) => (t.id === action.taskId ? { ...t, title: action.title } : t)) }
            : b,
        ),
      };
    case "deleteBot": {
      // Archiving keeps the record, so it must keep the transcript in the
      // client too. Dropping the row and waiting for the bot frame to put
      // it back would put it back empty: clientBot carries no messages,
      // and the arrival branch below seeds a new row with none. The row
      // moves to the drawer instead, with everything it had.
      if (!action.forget) {
        const moved = state.bots.map((b) =>
          b.id === action.botId ? { ...b, hidden: true, archivedAt: Date.now() } : b,
        );
        const selectedId =
          state.selectedId === action.botId ? (moved.find((b) => !b.hidden)?.id ?? "") : state.selectedId;
        if (selectedId !== state.selectedId) writeSelected(selectedId);
        return { ...state, bots: moved, selectedId };
      }
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? "") : state.selectedId;
      if (selectedId !== state.selectedId) writeSelected(selectedId);
      return { ...state, bots, selectedId };
    }
    case "restoreBot":
      // Optimistic, and corrected by the bot frame that follows. Waiting
      // for the round trip leaves the row in the drawer for a beat after
      // the press, which reads as the button not working.
      return updateBot(state, action.botId, (b) => ({ ...b, hidden: false, archivedAt: null }));
    case "markLaneUnread":
      return updateBot(state, action.botId, (b) => ({
        ...b,
        unread: true,
        tasks: b.tasks?.map((t) => (t.id === action.taskId ? { ...t, unread: true } : t)),
      }));
    case "botPatched": {
      // A whole record for an agent we have never seen is a new agent, not
      // a patch: an agent a lead just hired shows up this way.
      const known = state.bots.some((b) => b.id === action.bot.id);
      if (!known) {
        const arrival = action.bot as Partial<Bot> & { id: string; threadId?: string };
        if (!arrival.threadId) return state;
        return { ...state, bots: [{ messages: [], ...arrival } as Bot, ...state.bots] };
      }
      return updateBot(state, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        messages: (action.bot as Partial<Bot>).messages ?? b.messages,
      }));
    }
    case "messageAdded": {
      const room = state.bloks.find((b) => b.id === action.threadId);
      if (room) {
        return {
          ...state,
          bloks: state.bloks.map((b) =>
            b.id === room.id && !b.messages.some((m) => m.id === action.message.id)
              ? { ...b, messages: [...b.messages, action.message] }
              : b,
          ),
        };
      }
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const next = updateBot(state, bot.id, (b) =>
        b.messages.some((m) => m.id === action.message.id)
          ? b
          : { ...b, messages: [...b.messages, action.message] },
      );
      // the reply has landed as a real message, so the streaming preview
    // for that thread has done its job
      if (action.message.role === "bot" && action.message.kind === "text") {
        const { [action.threadId]: _, ...rest } = next.streaming;
        return { ...next, streaming: rest };
      }
      return next;
    }
    case "messagePatched": {
      const room = state.bloks.find((b) => b.id === action.threadId);
      if (room) {
        return {
          ...state,
          bloks: state.bloks.map((b) =>
            b.id === room.id
              ? { ...b, messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)) }
              : b,
          ),
        };
      }
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "streamDelta":
      if (state.settledTurns[action.threadId]) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        },
      };
    case "streamClear": {
      if (action.onlyIfSettled && !state.settledTurns[action.threadId]) return state;
      if (!(action.threadId in state.streaming)) return state;
      const { [action.threadId]: _, ...rest } = state.streaming;
      return { ...state, streaming: rest };
    }
    case "turnStarted": {
      if (!state.settledTurns[action.threadId]) return state;
      const { [action.threadId]: _, ...rest } = state.settledTurns;
      return { ...state, settledTurns: rest };
    }
    case "turnSettled":
      return { ...state, settledTurns: { ...state.settledTurns, [action.threadId]: true } };
    case "screenFrame":
      return {
        ...state,
        screens: {
          ...state.screens,
          [action.botId]: { png: action.png, mime: action.mime, ...(action.source ? { source: action.source } : {}) },
        },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return { ...state, provisioning: { ...state.provisioning, [action.botId]: action.on } };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return { ...state, error: action.message };
    // the right-hand slot holds one thing at a time, so opening any of
    // these closes the rest
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        settingsPage: action.page ?? (open && !state.appSettingsOpen ? "general" : state.settingsPage),
        // a full page, like Automations: one of them at a time
        routinesOpen: open ? false : state.routinesOpen,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot":
      return updateBot(state, action.botId, (b) => ({ ...b, ...action.patch }));
    case "placeRow":
      // worked out in the store, which knows every row, and applied as "placed"
      return state;
    case "placed": {
      const patches = (kind: "agent" | "room") =>
        new Map(action.rows.filter((row) => row.kind === kind).map((row) => [row.id, row.patch]));
      const agents = patches("agent");
      const rooms = patches("room");
      return {
        ...state,
        bots: state.bots.map((b) => (agents.has(b.id) ? { ...b, ...agents.get(b.id) } : b)),
        bloks: state.bloks.map((b) => (rooms.has(b.id) ? { ...b, ...rooms.get(b.id) } : b)),
      };
    }
    case "sectionOrder":
    case "moveSections":
      return { ...state, sectionOrder: action.order };
    case "patchRoom": {
      // archived rooms leave the list the moment the choice is made; the
      // server confirms on its own broadcast
      const bloks = action.patch.archived
        ? state.bloks.filter((b) => b.id !== action.blokId)
        : state.bloks.map((b) => (b.id === action.blokId ? { ...b, ...action.patch } : b));
      const selectedId =
        action.patch.archived && state.selectedId === action.blokId
          ? (state.bots.find((b) => !b.hidden)?.id ?? "")
          : state.selectedId;
      return { ...state, bloks, selectedId };
    }
    // handled entirely by the async wrapper
    case "createRoom":
    case "deleteRoom":
    case "sendToRoom":
    case "send":
    case "newBot":
    case "duplicateBot":
    case "interrupt":
    case "connectProvider":
    case "disconnectProvider":
      return state;
  }
}

function readSelected(): string {
  try {
    return localStorage.getItem("bloks-selected") ?? "";
  } catch {
    return "";
  }
}

function writeSelected(id: string) {
  try {
    if (id) localStorage.setItem("bloks-selected", id);
    else localStorage.removeItem("bloks-selected");
  } catch {
    /* private mode */
  }
}

export const initialState: AppState = {
  bots: [],
  bloks: [],
  instances: [],
  engineUpdates: {},
  providers: [],
  config: null,
  selectedId: readSelected(),
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  settingsPage: "general",
  newAgentOpen: false,
  newAgentFirstRun: false,
  skillsOpen: false,
  memoryOpen: false,
  memoryBotId: null,
  rehearsalsOpen: false,
  briefOpen: false,
  meetingFor: null,
  rehearsalsTick: 0,
  ticks: {},
  teamLink: null,
  routinesOpen: false,
  newRoomOpen: false,
  projectsOpen: false,
  activityOpen: false,
  shortcutsOpen: false,
  projectId: (() => {
    try {
      return localStorage.getItem("bloks-project");
    } catch {
      return null;
    }
  })(),
  sectionOrder: [],
  streaming: {},
  settledTurns: {},
  screens: {},
  roomPeople: {},
  joinRequests: {},
  roomTyping: {},
  provisioning: {},
  hydrated: false,
  connected: false,
  error: null,
};
