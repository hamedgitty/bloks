// Pure state: the types every part of the app shares, and the reducer
// that folds actions into them.
//
// This is deliberately a plain .ts module with no React in it. The
// reducer is the piece with real logic (message routing between rooms
// and agents, card patching, arrivals of agents nobody has seen yet), so
// it should be testable without mounting anything. store.tsx owns the
// transports and wires this up.
import type { BlokColor, BlokExpression, BlokShape } from "@/lib/mascot";
import type { LaneContext } from "@/lib/contextCard";
import type { CodexSpeed, CodexSpeedStatus } from "@/lib/codexSpeed";
import type { Effort } from "@/lib/effort";
import type { RoomAnswers, RoomRoute } from "@/lib/roomRoute";
import type { Workplace, WorkplaceStatus } from "@/lib/workplace";
import { resolveSettingsPage } from "../lib/settingsPages.ts";

export type { BlokColor, BlokShape } from "@/lib/mascot";

/** The full pages the main rail opens besides Chat, Automations and Settings. */
export type RailPage = "overview" | "memory" | "plugins" | "usage";

/** Who speaks a voice (server/speech.ts VOICE_PROVIDERS). */
export type VoiceProvider = "elevenlabs" | "openai" | "fish" | "xai" | "chatterbox" | "system";

/** What a link into Usage asked for: one agent's numbers, and the limits
 * rather than the top of the page. `at` tells two asks for the same
 * thing apart, so the page goes there again each time. */
export interface UsageFocus {
  botId: string | null;
  section: "limits" | null;
  at: number;
}
/** One routine or watcher, for a link into Automations. */
export type AutomationsFocus = { kind: "routine" | "watcher"; id: string };
/** The pages of Customize, the rail's Plugins place (Customize.tsx). */
export type CustomizeTab = "plugins" | "skills" | "catalog";
/** One thing on Settings' Plugins page with a page of its own. */
export type PluginFocus = { kind: "app" | "mcp" | "skill" | "cli"; id: string };
/** What the Memory place has open (MemoryPlace.tsx): an agent by its id,
 * the notes about the person, or the shared memory every agent reads. */
export type MemoryTarget = string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  /** In a shared room, the collaborator who answered, when it was not you. */
  answeredBy?: string;
  /** Asked by a turn that was cut off when Bloks stopped; it can no
   * longer be answered. */
  cutOff?: boolean;
  /** Why it closed before anyone answered, in the server's words. */
  closed?: string;
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
  /** Present when an agent proposed an app watcher (server/app-watch.ts).
   * Answered through the watcher's own routes, never as a reply. */
  appWatch?: AppWatchPlan;
  /** Present when an agent pointed the person at a place in the app
   * (`bloks open`, server/where.ts). Pressing it only navigates. */
  open?: OpenPlacePlan;
  /** Present when an agent proposed changing a setting
   * (server/settings-proposals.ts). Answered through its own route. */
  settingsProposal?: SettingsProposalPlan;
}

/** A place an agent's card opens, as server/where.ts writes it. */
export interface OpenPlacePlan {
  kind: "settings" | "panel";
  page: string;
  /** The row to scroll to, by its English label. */
  row?: string;
  name: string;
  /** The way there in words, for a window that cannot open it. */
  path: string;
  /** The agent whose own settings it opens. */
  botId?: string;
  workspace?: boolean;
}

/** A setting an agent proposed changing (server/settings-proposals.ts). */
export interface SettingsProposalPlan {
  id: string;
  laneId: string;
  setting: string;
  nameKey: string;
  name: string;
  path: string;
  page: string;
  current: { key?: string; text: string };
  proposed: { key?: string; text: string };
  value: string;
  why?: string;
  botId: string;
  agentName: string;
  told?: boolean;
  outcome?: "changed" | "kept" | "failed";
  error?: string;
}

/** An app watcher an agent proposed, as its card shows it. */
export interface AppWatchPlan {
  watcherId: string;
  toolkit: string;
  appName: string;
  trigger: string;
  eventName: string;
  config: Record<string, string | number | boolean>;
  filter: string[];
  botId: string;
  agentName: string;
  conversation: string;
  instruction: string;
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
  status?: "sent" | "queued" | "failed" | "uncertain";
}

/** One note recall added to the turn a message started (server/store.ts). */
export interface RecalledNote {
  kind: "conversation" | "room" | "memory";
  threadId?: string;
  messageId?: string;
  /** A memory file, by name, for a note from one. */
  memory?: string;
  /** A conversation's title, a room's name, or a memory file's name. */
  where: string;
  at: number;
  who?: string;
  text: string;
}

export interface Message {
  codexText?: import("../../shared/codex-text.js").CodexText;
  /** A person actually accepted into this running Codex turn, not queued. */
  joinedTurnId?: string;
  /** Between two agents rather than with the person. */
  agent?: AgentNote;
  /** A record of taking back waiting words, not a send to the peer. */
  takeBack?: { peerId: string; peerName: string; messages: Array<{ id: string; laneId: string; text: string }> };
  /** Said in this agent's own chat in a turn another agent's message
   * started: shown in full, with a link to the exchange. Not sent to it. */
  afterAgent?: { peerId: string; peerName: string };
  telegramPerson?: { personId: string; name: string; requester: string; group?: { title: string } };
  /** Said on Telegram by someone the owner gave full access to this agent:
   * a turn with the agent's own tools, answered in their own chat. */
  telegramDelegate?: { personId: string; name: string; requester: string; group?: { title: string } };
  telegramGroup?: { name: string; group: { title: string } };
  telegramSent?: { personId: string; name: string; state: "sending" | "sent" | "uncertain" | "failed" };
  /** The user's selection on a decision component. */
  decisionChoice?: number;
  /** Sent while the lane was busy; drains into the next turn. It waits
   * above the composer, not in the conversation, and joins the end of
   * it when it goes (a patch marked `moved`). */
  queued?: boolean;
  /** When it was queued, and when it stopped waiting and went to the
   * agent. Together they are how long it waited. */
  queuedAt?: number;
  /** The server says this message waits for a restart, or for an engine
   * pause to end, rather than for a turn. */
  waitsFor?: "restart" | "pause";
  /** When that pause ends. */
  waitsUntil?: number;
  deliveredAt?: number;
  /** Went into the turn already running rather than starting one, so a
   * finished turn's work folds around it (src/lib/turnFold.ts). */
  midTurn?: boolean;
  /** Sent while a turn ran: whether it went in, stopped the turn, or
   * waited, and the quiet line that says so (server/delivery.ts). */
  delivery?: { route: "steered" | "stopped" | "queued"; why: string; line: string };
  /** In a room set to Auto: who a message naming nobody went to and why,
   * or that the lead took it (server/room-route.ts). */
  route?: RoomRoute;
  /** Queued, but still waiting when Bloks restarted and too old to send
   * on its own (server/index.ts, recoverQueued). */
  unsent?: boolean;
  /** A turn cut off too long ago to pick up on its own, which Continue
   * picks up (server/index.ts, recoverCutOff). */
  carryOn?: { laneId: string; done?: boolean };
  /** Emoji to whoever pressed it: "user", or an agent's id. */
  reactions?: Record<string, string[]>;
  /** When this message was last edited. Absent means never. */
  editedAt?: number;
  /** Said in that engine before Bloks, and brought over with the session. */
  imported?: "claude" | "codex";
  /** What recall found elsewhere and added to the turn this started. */
  recalled?: RecalledNote[];
  /** Taken back: the row stays, the words are gone. */
  deleted?: boolean;
  /** Came in some other way than you typing it here. "goal" is Bloks
   * starting the next turn toward the conversation's goal; "incident" is
   * the incident desk handing a lead something that failed. */
  via?: "slack" | "discord" | "whatsapp" | "signal" | "watcher" | "email" | "webhook" | "routine" | "goal" | "intent" | "incident" | "service";
  /** Posted or sent by a standing intent (server/intents.ts). */
  intent?: { id: string; name: string };
  /** The incident desk (server/incidents.ts): the note on a lead's quiet
   * turn, the person's card for an incident, or the one card that stands
   * for many while the desk is quiet. */
  incident?: { id: string; kind: "note" | "needs-you" | "summary"; state?: "open" | "resolved"; resolution?: string };
  /** A notice that a routine or a watcher stopped running on its own
   * after failing again and again. */
  failing?: { kind: "routine" | "watcher"; id: string; name: string };
  /** The routine's name and start mode when this message was written,
   * and whether its agent was told it may answer QUIET. */
  routine?: { name?: string; manual: boolean; quiet?: boolean; brief?: boolean };
  /** Part of a quiet check-in: shown folded into one muted line with the
   * rest of its run, and never news (server/store.ts). */
  quiet?: boolean;
  /** A notice about the conversation's goal: set, or where it ended up. */
  goal?: "set" | "done" | "blocked" | "out" | "paused";
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
    /** A Telegram bot token for this agent's own bot, saved to its
     * Telegram settings rather than kept as a key. */
    telegram?: { bot: string; username?: string };
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
  /** Where the engine compacted its session: a line, not a warning. */
  compaction?: { before: number | null; after: number | null; idle?: boolean };
  /** A completed fresh-session reset: persistent transcript information,
   * not a warning, reply, or new attention. */
  sessionReset?: boolean;
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
  tool?: { name: string; command?: string; ok?: boolean; stopped?: boolean };
  /** activity messages: the turn had made this same call (same tool, same
   * arguments) this many times, 5, 10 or 20, shown as a chip on its run. */
  repeated?: number;
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
  /** The Codex speed of the turn running here, absent once it ends. */
  codexDispatch?: CodexSpeedStatus;
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
  context?: LaneContext;
  /** Where mail from senders the person has not listed is answered. The
   * person's own words go to the first conversation instead (typedLane). */
  guestMail?: boolean;
  /** A team agent's one shared conversation (server/access.ts). */
  team?: boolean;
  /** The room this lane's turn is speaking in, while it runs. */
  room?: string;
  /** What this lane keeps working toward, turn after turn (server/goals.ts). */
  goal?: LaneGoal;
  /** A lane that never takes a goal: a shared room's, a rehearsal, or
   * the one that answers mail from people not listed. */
  noGoals?: boolean;
  /** Brought over from a session before Bloks (server/session-import.ts):
   * the engine it was had in, when, and whether it carries that session on. */
  imported?: { engine: "claude" | "codex"; at: number; resumes: boolean };
}

/** A lane's goal as the server ships it (goalSummary in server/goals.ts). */
export interface LaneGoal {
  text: string;
  check?: string;
  budget: number;
  /** Turns Bloks has started toward it, the first included. */
  turns: number;
  status: "active" | "paused" | "done" | "blocked" | "out";
  startedAt: number;
  lastReason?: string;
  /** Between two turns, while Bloks checks whether it is done. */
  judging?: boolean;
}

export interface Bot {
  id: string;
  /** The active task's thread; messages below belong to it. */
  threadId: string;
  /** Who shares a team agent's conversation (server/access.ts); absent
   * is everyone in the workspace. */
  access?: { mode: "everyone" | "only" | "except"; people: string[]; admins?: boolean };
  /** A solo agent: its maker's alone. */
  solo?: { by: string };
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: BlokColor;
  shape?: BlokShape;
  skills?: string[];
  /** Library skills attached to this agent, by id. */
  skillIds?: string[];
  /** 1 to 5; the most senior member of a room has the final call, unless
   * the room crowned someone else (Blok.leadId). */
  seniority?: number;
  /** Reasoning effort for engines that have the dial. Absent or null is
   * the engine's own; a level the engine lacks runs at the nearest it
   * has (src/lib/effort.ts). */
  effort?: Effort | null;
  /** This agent's own Codex speed; absent or null follows the workspace. */
  codexSpeed?: CodexSpeed | null;
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
  /** Where its engine runs: unset is this computer; otherwise a Docker
   * container or another machine over SSH (src/lib/workplace.ts). */
  workplace?: Workplace | null;
  /** That place now, as the header says it. Null on this computer. */
  workplaceStatus?: WorkplaceStatus | null;
  /** Whether this agent may reach the shared connectors. Unset = yes. */
  composio?: boolean;
  /** Whether this agent has a browser of its own. Unset = no: a browser
   * starts a real process, so it is asked for rather than assumed. */
  browser?: boolean;
  /** Ids of user-registered MCP servers this agent may use. */
  mcpServers?: string[];
  /** How this agent sounds; unset means no voice yet. */
  voice?: { provider: VoiceProvider; id: string; name?: string } | null;
  /** Read replies aloud as they settle. */
  speakReplies?: boolean;
  /** False: Claude Code runs this agent's turns without hooks. */
  engineHooks?: boolean;
  /** False: no notes from its other conversations before your turns. */
  recallBeforeTurn?: boolean;
  /** Words sent mid-turn: read them, always go in now, or always wait.
   * Unset follows the workspace's choice. */
  delivery?: "auto" | "interrupt" | "queue" | null;
  /** Whether its turns wait for the background work they start, or stop
   * it with the reply. Unset follows the workspace's choice. */
  backgroundWork?: "finish" | "stop" | null;
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
  /** The workspace Codex speed; absent from a server older than it. */
  codex?: { speed: CodexSpeed };
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
    fish?: boolean;
    xai?: boolean;
    /** Which key xAI speaks with: one saved for speech, or Grok's. */
    xaiSource?: "speech" | "grok";
    /** A Chatterbox server of the person's own, and where it is. */
    chatterbox?: boolean;
    chatterboxUrl?: string;
  };
  /** Shared context for every agent, not a secret, so it round-trips;
   * `name` is what the owner is called, empty until they say. */
  profile?: { about: string; name?: string };
  /** How lanes are kept inside the model's window. */
  /** `beforeTurn` is the size a native session is compacted at before a
   * turn, in tokens; 0 is never. */
  compaction?: { micro: boolean; idle?: boolean; beforeTurn?: number };
  /** Whether finished sessions are read back for something worth keeping,
   * and `learn`, how eagerly: off, suggest or suggest more. */
  skills?: { propose: boolean; learn?: "off" | "suggest" | "more" };
  /** Whether agents are reminded of their other conversations before
   * your turn. On unless turned off. */
  recall?: { beforeTurn: boolean };
  /** Each agent's memory tidied once a night; on unless turned off. */
  memory?: { tidy: boolean };
  /** Agents' turn limit, 1 to 50, and the turns in a row the person
   * allows across separate tasks, or null for none (server/agent-chain.ts). */
  agents?: { turnLimit: number; taskBudget?: number | null };
  /** The incident desk (server/incidents.ts): on unless turned off, and
   * who leads incidents: "auto", "person" or an agent's id. */
  incidents?: { enabled: boolean; lead: string };
  /** What happens to words sent mid-turn, for agents that have not
   * chosen (server/delivery.ts). */
  delivery?: { mode: "auto" | "interrupt" | "queue"; askModel?: boolean };
  /** The engine a room set to Auto asks; null is the room's own. */
  rooms?: { router: string | null };
  /** Count-only cards for overlapping turns with no own files. On by default. */
  changes?: { showShared: boolean };
  /** How long a silent tool call may hold a turn, in minutes; 0 is never.
   * And whether a turn waits for the background work it started, for
   * agents that have not chosen (server/background-work.ts). */
  turns?: { stallMinutes: number; backgroundWork?: "finish" | "stop" };
  /** Where a new agent starts, applied before its first turn. Absent on
   * a server that does not know about it, and then Settings says nothing. */
  agentDefaults?: AgentDefaults;
  /** Bloks AI without what is left, which Settings reads on its own
   * (server/credits.ts). Absent on a server that does not know it. */
  credits?: CreditsSummary;
  /** A hosted workspace (server/hosted.ts): whether this is one, whether
   * its virtual desktop can be shown, and where an agent may act here. */
  hosted?: {
    on: boolean;
    desktop: boolean;
    computers: Array<{ id: "cloud" | "sandbox" | "local" | "off"; label: string }>;
  };
}

/** What the server says about Bloks AI on the stream and with the rest
 * of the settings. */
export interface CreditsSummary {
  /** A Cloud licence is active here, or the host came with a token. */
  offered: boolean;
  /** Work nobody asked for this minute may use Bloks AI. Off by default. */
  background: boolean;
  /** The last run the service refused for an empty balance, in its words,
   * until more is added. */
  refused: { at: number; message: string } | null;
  /** Where more is bought, in the browser. */
  checkoutUrl: string;
  /** Whether the licence is a team's, once the server has heard. Absent
   * on a server from before Bloks AI. */
  team?: boolean | null;
}

export interface AgentDefaults {
  cwd?: string;
  /** Ask when unset. An agent hiring another passes on no more than its own. */
  approvals?: "edits" | "auto" | "full";
  modelSelection?: ModelSelection;
  effort?: Effort;
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

/** Whether this agent is taking a turn in this room right now. Its own
 * busy flag is up while any of its lanes works, so a room reading it said
 * a member was thinking there while it worked on something else. Each
 * lane says which room its running turn speaks in; a harness too old to
 * report lanes falls back to the agent's flag. */
export function workingInRoom(bot: { busy?: boolean; tasks?: Array<{ room?: string }> }, roomId: string): boolean {
  return bot.tasks ? bot.tasks.some((t) => t.room === roomId) : Boolean(bot.busy);
}

/** The conversation words typed to this agent are sent to: the one on
 * screen, named, because left unnamed the server puts them in whichever
 * lane it last heard was open, and another device may have opened a
 * different one a moment ago. Undefined in the lane strangers' mail is
 * answered in, which the server keeps the person's own words out of on
 * purpose (activeLaneOf): those go to the first conversation, and the
 * screen follows them there (store.tsx, "send"). */
export function typedLane(bot: { activeTaskId?: string; threadId: string; tasks?: Array<{ id: string; guestMail?: boolean }> }): string | undefined {
  const open = bot.activeTaskId ?? bot.threadId;
  return bot.tasks?.some((t) => t.id === open && t.guestMail) ? undefined : open;
}

/** Whether closing this lane would delete anything. The server dates a
 * lane by its last message, or by its making when it has none, so a later
 * time means something was said. A lane that cannot say (a harness too
 * old to send the time) counts as having messages: asking once too often
 * costs a tap, and not asking costs a conversation. */
export function laneHasMessages(lane: { lastAt?: number; createdAt: number; usage?: { turns: number } } | undefined): boolean {
  if (!lane || lane.lastAt === undefined) return true;
  return lane.lastAt > lane.createdAt || (lane.usage?.turns ?? 0) > 0;
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
  /** Switched on in Settings. Off starts no turns, however installed and
   * signed in the snapshot says it is. Absent from an older server, where
   * it reads as on. */
  enabled?: boolean;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  /** The effort levels the engine takes, least first; empty for one with
   * no dial. Absent from a server from before they were per engine. */
  efforts?: Effort[];
  models: {
    default: string;
    /** codexFast: whether Codex offers Fast for the model, where it said.
     * efforts: the levels the engine listed for the model, where it said. */
    options: Array<{ id: string; label: string; codexFast?: boolean; efforts?: Effort[] }>;
    /** When the engine last reported the list. */
    checkedAt?: number;
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
  /** Unaddressed messages wake only the lead. True for Auto as well,
   * whose fallback is the lead; `answers` says which. */
  leadOnly?: boolean;
  /** Who answers a message naming nobody. Absent on a room from before
   * Auto, which reads leadOnly (answersOf in src/lib/roomRoute.ts). */
  answers?: RoomAnswers;
  /** The member crowned for this room. Null or absent means the most
   * senior leads (src/lib/roomLead.ts). */
  leadId?: string | null;
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

/** A New room dialog filled in before it opens: a room's team, ready to
 * start again in a room of their own (src/lib/roomEdit.ts). `from` names
 * the room it came from, which is left as it is. */
export interface NewRoomPreset {
  name: string;
  memberIds: string[];
  leadId: string | null;
  answers: RoomAnswers;
  cwd?: string;
  from: string;
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
  /** For CLI engines: the name it is looked up by on PATH. */
  command?: string;
  keyPrefix?: string;
  docsUrl: string;
  connected: boolean;
  /** Installed, but with no login we can see. Not the same as missing. */
  needsSignIn?: boolean;
  /** Installed, but a release too old to run here: updating fixes it. */
  outdated?: boolean;
  /** For CLI engines: the CLI started instead of the one on PATH, or
   * null for PATH's. */
  path?: string | null;
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
  /** The version it is at (server/skill-history.ts); 0 for a built-in. */
  revision?: number;
  /** How often it has been used, how often the person corrected it
   * straight after, and when it was last used. */
  uses?: number;
  corrected?: number;
  lastUsed?: number | null;
}

/** The tabs of the Automations page (src/components/AutomationsPanel.tsx). */
export type AutomationsTab = "schedules" | "watchers" | "intents" | "workflows" | "webhooks" | "jobs";

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
  /** Which of the main rail's full pages covers the chat (AppRail): the
   * overview, memory, plugins or usage. Settings and Automations keep their
   * own flags; null with both of those closed is the chat. */
  page: RailPage | null;
  /** Which Customize page shows when Plugins is the place. */
  customize: CustomizeTab;
  /** The app whose details page is open in Customize, by slug. */
  customizeApp: string | null;
  /** What Settings' Plugins page has open (PluginSettings.tsx): an app,
   * a server or a skill, or null for the lists. */
  pluginFocus: PluginFocus | null;
  settingsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  /** Which Settings page is showing, so a link can open the right one. */
  settingsPage: string;
  /** A row a link asked Settings to scroll to and light, once its page is
   * in; `at` makes the same row asked twice a new ask. */
  settingsRow: { page: string; row: string; at: number } | null;
  newAgentOpen: boolean;
  /** the new-agent screen is the last step of setup, not a normal visit */
  newAgentFirstRun: boolean;
  /** What the Memory place has open: an agent's id, "you" or "shared";
   * null until something is picked or a link asks for one, when the
   * place chooses (notes waiting on you, else the agent in view). */
  memoryTarget: MemoryTarget | null;
  /** What the last link into Usage asked for, or null (UsagePage). */
  usageFocus: UsageFocus | null;
  /** The brief a notification asked Overview to open, until the brief
   * panel takes it (BriefPanel). */
  briefFocus: string | null;
  /** The agent taking meeting notes, while its panel is open. */
  meetingFor: string | null;
  /** The conversation whose "Set a goal" dialog is open (GoalDialog). */
  goalFor: { botId: string; taskId: string } | null;
  /** Bumped when any rehearsal moves, so Overview re-reads them. */
  rehearsalsTick: number;
  /** Bumped when the server says a kind of thing changed (notes about
   * you, briefs, watchers, meetings), so whatever shows it re-reads. */
  ticks: Record<string, number>;
  /** A gallery team a bloks:// link asked to open, until the dialog takes it. */
  teamLink: string | null;
  /** A team or skill a bloks://install link asked to review, by its https
   * address, until the catalogue page takes it (CatalogPage.tsx). */
  installLink: string | null;
  routinesOpen: boolean;
  /** The tab Automations opens on, when something linked to one. */
  routinesTab: AutomationsTab | null;
  /** The routine or watcher Automations opens on, when something linked
   * to one (a card about one that stopped for failing). */
  routinesFocus: AutomationsFocus | null;
  newRoomOpen: boolean;
  /** What the New room dialog opens filled in with, when something asked
   * for more than an empty one: a fresh start from a room (src/lib/roomEdit.ts). */
  newRoomPreset: NewRoomPreset | null;
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
  /** The turn last seen starting in each thread, by its id, so the end of
   * an earlier one heard late does not end the one running now. */
  liveTurns: Record<string, string>;
  /** Agents whose open conversation changed with no transcript to show
   * for it, as when a lane is opened on another device: the lane, by
   * agent, whose messages the store is asking for. */
  laneLoads: Record<string, string>;
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
  /** Counts the errors shown. The timer that clears one names it, so an
   * older error's timer cannot take a newer one off the screen early. */
  errorAt: number;
}

export type Action =
  /** The whole agent list. `after` is what the stream said after the
   * list was made (src/state/snapshotOrder.ts), applied over it. */
  | { type: "hydrate"; bots: Bot[]; after?: Action[] }
  /** A page of earlier messages for a transcript that arrived trimmed.
   * `threadId` guards against a lane that changed while it was loading. */
  | { type: "earlierLoaded"; id: string; threadId: string; messages: Message[]; olderMessages: number }
  /** The transcript asked for after an agent's open conversation changed
   * (see laneLoads). Taken only while that lane is still the one open. */
  | { type: "laneLoaded"; id: string; threadId: string; messages: Message[]; olderMessages: number }
  | { type: "hydrateBloks"; bloks: Blok[] }
  | { type: "blokPatched"; blok: Omit<Blok, "messages"> }
  | { type: "roomPeople"; roomId: string; people: RoomPerson[] }
  | { type: "joinRequest"; roomId: string; pending?: number }
  | { type: "roomTyping"; roomId: string; name: string; at: number }
  | { type: "blokDeleted"; blokId: string }
  /** `leadId`, `answers` and `cwd` are the room's own settings, chosen
   * as it is made rather than found in its header afterwards. */
  | { type: "createRoom"; name: string; memberIds: string[]; leadId?: string; answers?: RoomAnswers; cwd?: string }
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
  /** `onFailed`: the send did not go, so the box can have it back. */
  | { type: "sendToRoom"; blokId: string; text: string; replyTo?: Message["replyTo"]; onFailed?: () => void }
  /** `preset` fills the dialog in as it opens; any toggle without one
   * leaves it empty, so a preset never outlives the dialog it was for. */
  | { type: "toggleNewRoom"; open?: boolean; preset?: NewRoomPreset }
  | { type: "openTeamLink"; slug: string | null }
  | { type: "openInstallLink"; url: string | null }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "engineUpdates"; updates: Record<string, { installed: string; latest: string }> }
  | { type: "providers"; providers: ProviderRow[] }
  | { type: "connectProvider"; kind: string; key?: string; url?: string }
  | { type: "disconnectProvider"; kind: string }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "credits"; credits: CreditsSummary }
  /** `lane` opens that conversation; without it, the one that pinged. */
  | { type: "select"; id: string; lane?: string }
  | { type: "send"; botId: string; text: string; replyTo?: Message["replyTo"]; stopFirst?: boolean; delivery?: "now" | "wait"; onFailed?: () => void }
  | { type: "answerCard"; botId: string; messageId: string; answer: string; roomId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; roomId?: string }
  /** An answer that did not go: the card can be answered again. */
  | { type: "cardReopened"; botId: string; messageId: string; roomId?: string }
  | { type: "hireTeam"; botId: string; messageId: string }
  | { type: "newBot"; profile?: NewAgentProfile }
  | { type: "toggleNewAgent"; open?: boolean; firstRun?: boolean }
  /** `tab` opens Automations on that tab, for a link from elsewhere. */
  | { type: "toggleRoutines"; open?: boolean; tab?: AutomationsTab; focus?: AutomationsFocus }
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
  /** `moved`: a queued message that went, so it leaves its place and
   * joins the end of the conversation, as it did on disk. */
  | { type: "messagePatched"; threadId: string; message: Message; moved?: boolean }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string; onlyIfSettled?: boolean }
  | { type: "turnStarted"; threadId: string; turnId?: string }
  | { type: "turnSettled"; threadId: string; turnId?: string }
  /** The event stream came back without the frames it missed (hello
   * with resumed: false), so what it was in the middle of is stale. */
  | { type: "streamRestarted" }
  | { type: "screenFrame"; botId: string; png: string; mime: string; source?: "browser" }
  /** A `computer` frame: an agent's cloud computer is provisioning,
   * waking, ready, failed or asleep. */
  | { type: "computerState"; botId: string; state: string }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  /** `at` on a clear: only the error shown as that one (see errorAt). */
  | { type: "error"; message: string | null; at?: number }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "openPage"; page: RailPage | null }
  /** Overview, at one brief: the one its notification was about. Null
   * only says the panel has it now. */
  | { type: "openBrief"; id: string | null }
  | { type: "openCustomize"; tab: CustomizeTab; app?: string | null }
  | { type: "openPluginSettings"; focus: PluginFocus | null }
  /** The Memory place, on `target` when given (an agent's id, "you" or
   * "shared"), else on whatever it had open; null lets the place choose. */
  | { type: "openMemory"; target?: MemoryTarget | null }
  /** Usage, narrowed to one agent and scrolled to its limits when asked. */
  | { type: "openUsage"; botId?: string | null; section?: "limits" | null }
  | { type: "toggleComputer"; open?: boolean }
  /** `page` opens Settings on that page (see SETTINGS_PAGES). */
  | { type: "toggleAppSettings"; open?: boolean; page?: string; row?: string }
  | { type: "rehearsalsChanged" }
  | { type: "tick"; key: string }
  | { type: "openMeeting"; botId: string | null }
  | { type: "openGoal"; botId: string; taskId: string }
  | { type: "closeGoal" }
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
          | "codexSpeed"
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

/**
 * A turn starting or ending in one lane, on its tab: the lane reads
 * working or idle, and its agent busy while a lane of it works. The
 * server's next record of the agent says the same, but until it came a
 * finished turn's tab still read working, or a running one idle, and sent
 * the person to the wrong conversation (GitHub 398). A lane waiting on
 * the person is left as it is: waiting outranks working on the server,
 * and whether a card still waits once its turn is over is the server's
 * to say.
 */
function laneTurn(state: AppState, threadId: string, running: boolean): AppState {
  const owner = state.bots.find((b) => (b.tasks ? b.tasks.some((t) => t.id === threadId) : b.threadId === threadId));
  if (!owner) return state;
  return updateBot(state, owner.id, (b) => {
    if (!b.tasks) return { ...b, busy: running };
    const tasks = b.tasks.map((t): TaskSummary => {
      if (t.id !== threadId || t.state === "needs-you") return t;
      if (running) return t.state === "working" ? t : { ...t, state: "working" };
      // the room it spoke in and the speed it ran at are said only while
      // a turn runs
      const { room: _room, codexDispatch: _dispatch, ...ended } = t;
      return { ...ended, state: "idle" };
    });
    // A lane waiting on the person may still have its turn open. A
    // member's private lanes are not listed here at all; the record the
    // server sends after every turn's end says if one of those still runs.
    const busy = running || tasks.some((t) => t.state === "working") || (Boolean(b.busy) && tasks.some((t) => t.state === "needs-you"));
    return { ...b, tasks, busy };
  });
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
      const listed: AppState = { ...state, bots: action.bots, selectedId, hydrated: true, laneLoads: {} };
      if (!action.after?.length) return listed;
      // Those frames were applied as they came, so what streams and which
      // turns run is already theirs; going through them again only puts
      // the agents right. A reply landing a second time would otherwise
      // clear the next turn's words as they stream.
      const caught = action.after.reduce(reducer, listed);
      return { ...caught, streaming: state.streaming, settledTurns: state.settledTurns, liveTurns: state.liveTurns };
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
    // the catalogue page opens with the link's review on top of it
    case "openInstallLink":
      return action.url
        ? {
            ...state,
            installLink: action.url,
            page: "plugins",
            customize: "catalog",
            customizeApp: null,
            routinesOpen: false,
            appSettingsOpen: false,
            settingsOpen: false,
          }
        : { ...state, installLink: null };
    case "toggleNewRoom": {
      const open = action.open ?? !state.newRoomOpen;
      return { ...state, newRoomOpen: open, newRoomPreset: open ? (action.preset ?? null) : null };
    }
    case "rehearsalsChanged":
      return { ...state, rehearsalsTick: state.rehearsalsTick + 1 };
    case "openMeeting":
      return { ...state, meetingFor: action.botId };
    case "openGoal":
      return { ...state, goalFor: { botId: action.botId, taskId: action.taskId } };
    case "closeGoal":
      return { ...state, goalFor: null };
    case "tick":
      return { ...state, ticks: { ...state.ticks, [action.key]: (state.ticks[action.key] ?? 0) + 1 } };
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
    case "credits":
      return state.config ? { ...state, config: { ...state.config, credits: action.credits } } : state;
    case "select":
      writeSelected(action.id);
      // choosing a conversation in the sidebar means looking at it, so a
      // full page covering the chat steps aside, an agent's settings too
      return updateBot({ ...state, selectedId: action.id, routinesOpen: false, appSettingsOpen: false, settingsOpen: false, page: null }, action.id, (b) =>
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
    case "cardReopened":
      return patchCard(state, action.botId, action.messageId, { answered: undefined }, action.roomId);
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
    case "toggleRoutines":
      {
        const open = action.open ?? !state.routinesOpen;
        return {
          ...state,
          routinesOpen: open,
          routinesTab: open ? (action.tab ?? null) : null,
          routinesFocus: open ? (action.focus ?? null) : null,
          appSettingsOpen: open ? false : state.appSettingsOpen,
          page: open ? null : state.page,
          settingsOpen: open ? false : state.settingsOpen,
        };
      }
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
      const incoming = action.bot as Partial<Bot>;
      const shown = state.bots.find((b) => b.id === action.bot.id)!;
      // Another conversation is open now, and what says so brings no
      // transcript: a bot frame never does. Keeping the messages put the
      // last lane's words under the new lane's name, so they go, and the
      // store asks for the new lane's own.
      if (incoming.threadId && incoming.threadId !== shown.threadId && !incoming.messages) {
        return {
          ...updateBot(state, action.bot.id, (b) => ({ ...b, ...action.bot, messages: [], olderMessages: undefined })),
          laneLoads: { ...state.laneLoads, [action.bot.id]: incoming.threadId },
        };
      }
      const next = updateBot(state, action.bot.id, (b) => ({
        ...b,
        ...action.bot,
        messages: incoming.messages ?? b.messages,
      }));
      // a transcript for the open lane is what was being asked for
      if (!incoming.messages || !(action.bot.id in state.laneLoads)) return next;
      const { [action.bot.id]: _, ...laneLoads } = state.laneLoads;
      return { ...next, laneLoads };
    }
    case "laneLoaded": {
      if (state.laneLoads[action.id] !== action.threadId) return state;
      const { [action.id]: _, ...laneLoads } = state.laneLoads;
      return {
        ...updateBot(state, action.id, (b) => {
          // What the stream brought while this loaded is as new as the
          // page or newer, so it wins where both have a message, and the
          // rest of it follows the page.
          const streamed = new Map(b.messages.map((m) => [m.id, m]));
          const paged = new Set(action.messages.map((m) => m.id));
          return {
            ...b,
            messages: [
              ...action.messages.map((m) => streamed.get(m.id) ?? m),
              ...b.messages.filter((m) => !paged.has(m.id)),
            ],
            olderMessages: action.olderMessages,
          };
        }),
        laneLoads,
      };
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
      // the reply has landed as a real message, so the streaming preview
      // for that thread has done its job. That holds for a lane in the
      // background too, whose messages are not kept here: its preview
      // kept growing, and opening the lane while it worked said again
      // what it had already said.
      let landed = state;
      if (action.message.role === "bot" && action.message.kind === "text" && action.threadId in state.streaming) {
        const { [action.threadId]: _, ...rest } = state.streaming;
        landed = { ...state, streaming: rest };
      }
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return landed;
      return updateBot(landed, bot.id, (b) =>
        b.messages.some((m) => m.id === action.message.id)
          ? b
          : { ...b, messages: [...b.messages, action.message] },
      );
    }
    case "messagePatched": {
      const patched = (messages: Message[]) =>
        action.moved
          ? [...messages.filter((m) => m.id !== action.message.id), action.message]
          : messages.map((m) => (m.id === action.message.id ? action.message : m));
      const room = state.bloks.find((b) => b.id === action.threadId);
      if (room) {
        return {
          ...state,
          bloks: state.bloks.map((b) => (b.id === room.id ? { ...b, messages: patched(b.messages) } : b)),
        };
      }
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      return updateBot(state, bot.id, (b) => ({ ...b, messages: patched(b.messages) }));
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
      const { [action.threadId]: _, ...settledTurns } = state.settledTurns;
      // a turn with no id of its own leaves nothing to tell its end from
      // an earlier one's, so whatever ends next ends it
      const { [action.threadId]: _earlier, ...others } = state.liveTurns;
      const liveTurns = action.turnId ? { ...others, [action.threadId]: action.turnId } : others;
      return laneTurn({ ...state, settledTurns, liveTurns }, action.threadId, true);
    }
    case "turnSettled": {
      // An earlier turn's end, heard after a newer one began, ends nothing:
      // the newer one is still running. One with no id (an engine rebuilt
      // under it) ends whatever runs.
      const live = state.liveTurns[action.threadId];
      if (action.turnId && live && live !== action.turnId) return state;
      const { [action.threadId]: _, ...liveTurns } = state.liveTurns;
      return laneTurn({ ...state, settledTurns: { ...state.settledTurns, [action.threadId]: true }, liveTurns }, action.threadId, false);
    }
    case "streamRestarted":
      // Whatever was streaming when the line dropped finished or moved on
      // unseen, and the messages that say so are coming in the reload. A
      // partial kept from before showed under the finished reply, and the
      // next turn's words were added to the end of it. A computer being
      // set up may have finished unseen too. Cleared here rather than in
      // hydrate, which also follows an archive, mid-turn for everyone else.
      return { ...state, streaming: {}, settledTurns: {}, liveTurns: {}, provisioning: {} };
    case "screenFrame":
      return {
        ...state,
        screens: {
          ...state.screens,
          [action.botId]: { png: action.png, mime: action.mime, ...(action.source ? { source: action.source } : {}) },
        },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "computerState":
      // Only setting one up shows in the chat. Every other word ends that,
      // and the server always sends one after it, ready or failed, so a
      // box that never came up cannot leave the line spinning.
      return { ...state, provisioning: { ...state.provisioning, [action.botId]: action.state === "provisioning" } };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      // A clear meant for an error that has since been replaced leaves the
      // newer one up: it is owed its own six seconds.
      if (action.message === null && action.at !== undefined && action.at !== state.errorAt) return state;
      return {
        ...state,
        error: action.message,
        errorAt: action.message === null ? state.errorAt : state.errorAt + 1,
      };
    // An agent's settings are a full page, in the panel where its chat
    // was, so opening them closes every other full page; the computer
    // panel beside the chat goes with the chat
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        page: open ? null : state.page,
      };
    }
    case "openPage":
      // one full page at a time, the rail's own and Settings or Automations;
      // Usage opened plainly is the whole picture, not the last link's
      return action.page
        ? { ...state, page: action.page, usageFocus: null, routinesOpen: false, appSettingsOpen: false, settingsOpen: false }
        : { ...state, page: null };
    case "openBrief":
      return action.id
        ? { ...state, page: "overview", briefFocus: action.id, usageFocus: null, routinesOpen: false, appSettingsOpen: false, settingsOpen: false }
        : { ...state, briefFocus: null };
    case "openCustomize":
      return {
        ...state,
        page: "plugins",
        customize: action.tab,
        customizeApp: action.app ?? null,
        routinesOpen: false,
        appSettingsOpen: false,
        settingsOpen: false,
      };
    case "openPluginSettings":
      return {
        ...state,
        appSettingsOpen: true,
        settingsPage: "plugins",
        pluginFocus: action.focus,
        routinesOpen: false,
        page: null,
        settingsOpen: false,
      };
    case "openMemory": {
      const target = action.target;
      return {
        ...state,
        page: "memory",
        memoryTarget: target === undefined ? state.memoryTarget : target,
        routinesOpen: false,
        appSettingsOpen: false,
        settingsOpen: false,
      };
    }
    case "openUsage":
      return {
        ...state,
        page: "usage",
        usageFocus: { botId: action.botId ?? null, section: action.section ?? null, at: Date.now() },
        routinesOpen: false,
        appSettingsOpen: false,
        settingsOpen: false,
      };
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
        // an id that moved goes where it lives now (src/lib/settingsPages.ts),
        // so a link from anywhere, old or new, lands on a real page
        settingsPage: action.page ? resolveSettingsPage(action.page) : open && !state.appSettingsOpen ? "general" : state.settingsPage,
        // a row only with the page it is on, and only while opening
        settingsRow: open && action.page && action.row ? { page: resolveSettingsPage(action.page), row: action.row, at: Date.now() } : null,
        // a full page, like Automations: one of them at a time
        routinesOpen: open ? false : state.routinesOpen,
        page: open ? null : state.page,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
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
  page: null,
  customize: "plugins",
  customizeApp: null,
  pluginFocus: null,
  computerOpen: false,
  appSettingsOpen: false,
  settingsPage: "general",
  settingsRow: null,
  newAgentOpen: false,
  newAgentFirstRun: false,
  memoryTarget: null,
  usageFocus: null,
  briefFocus: null,
  meetingFor: null,
  goalFor: null,
  rehearsalsTick: 0,
  ticks: {},
  teamLink: null,
  installLink: null,
  routinesOpen: false,
  routinesTab: null,
  routinesFocus: null,
  newRoomOpen: false,
  newRoomPreset: null,
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
  liveTurns: {},
  laneLoads: {},
  screens: {},
  roomPeople: {},
  joinRequests: {},
  roomTyping: {},
  provisioning: {},
  hydrated: false,
  connected: false,
  error: null,
  errorAt: 0,
};
