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

export interface Message {
  /** Sent while the lane was busy; drains into the next turn. */
  queued?: boolean;
  /** Emoji to whoever pressed it: "user", or an agent's id. */
  reactions?: Record<string, string[]>;
  /** When this message was last edited. Absent means never. */
  editedAt?: number;
  /** Taken back: the row stays, the words are gone. */
  deleted?: boolean;
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
  kind: "text" | "options" | "activity" | "screen" | "notice" | "artifact" | "connector" | "secret" | "component";
  text?: string;
  card?: OptionCardData;
  /** component messages: an answer that is not a paragraph. */
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
  busy?: boolean;
  /** Somebody has taken this agent's computer. Null when nobody has;
   * absent only from a harness too old to say. */
  held?: { since: number; why: string; turnedAway: number } | null;
  /** Retired. The row leaves the list and the agent stops working, but
   * everything about it is kept and it can be brought back. */
  archivedAt?: number | null;
  tasks?: TaskSummary[];
  activeTaskId?: string;
  modelSelection: ModelSelection;
  /** Where this agent may act. Left unset it decides for itself: its own
   * box when it has one, otherwise this Mac. */
  computer?: "cloud" | "sandbox" | "local" | "off" | null;
  /** The folder new turns run in; unset means the agent's workspace. */
  cwd?: string | null;
  /** Whether this agent may reach the shared connectors. Unset = yes. */
  composio?: boolean;
  /** Ids of user-registered MCP servers this agent may use. */
  mcpServers?: string[];
  /** How this agent sounds; unset means no voice yet. */
  voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string } | null;
  /** Read replies aloud as they settle. */
  speakReplies?: boolean;
  /** The public half of this agent's key, hex. What its signatures in
   * the record are checked against. */
  fingerprint?: string;
  /** Components this agent may not answer with. */
  withoutComponents?: string[];
  pinned?: boolean;
  /** The sidebar heading this agent files under; unset means the plain
   * Agents list. Shares one namespace with rooms. */
  section?: string | null;
  /** How much this agent may do without asking: ask (default), edits
   * (file changes wave through), auto (everything does). Deny rules
   * outrank every mode. */
  approvals?: "ask" | "edits" | "auto";
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
  speech?: { elevenlabs: boolean; openai: boolean; openaiSource?: "env" | "codex"; openaiAvailable?: "env" | "codex" };
  /** Shared context for every agent, not a secret, so it round-trips. */
  profile?: { about: string };
  /** How lanes are kept inside the model's window. */
  compaction?: { micro: boolean };
  /** Whether finished sessions are read back for something worth keeping. */
  skills?: { propose: boolean };
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
  models: { default: string; options: Array<{ id: string; label: string }> };
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
  createdAt: number;
  messages: Message[];
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
  providers: ProviderRow[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  newAgentOpen: boolean;
  /** the new-agent screen is the last step of setup, not a normal visit */
  newAgentFirstRun: boolean;
  skillsOpen: boolean;
  routinesOpen: boolean;
  newRoomOpen: boolean;
  projectsOpen: boolean;
  /** The one place that says what is running and what wants you. */
  activityOpen: boolean;
  /** The project the app is looking through, or null for everything.
   * A lens: nothing is hidden from anywhere else, and leaving puts the
   * whole workspace back. */
  projectId: string | null;
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** the most recent picture of each agent's screen */
  screens: Record<string, { png: string; mime: string }>;
  /** agents whose box is still being stood up, so the panel can say so */
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
}

export type Action =
  | { type: "hydrate"; bots: Bot[] }
  | { type: "hydrateBloks"; bloks: Blok[] }
  | { type: "blokPatched"; blok: Omit<Blok, "messages"> }
  | { type: "blokDeleted"; blokId: string }
  | { type: "createRoom"; name: string; memberIds: string[] }
  | { type: "deleteRoom"; blokId: string }
  | { type: "patchRoom"; blokId: string; patch: { archived?: boolean; name?: string; section?: string | null } }
  | { type: "sendToRoom"; blokId: string; text: string; replyTo?: Message["replyTo"] }
  | { type: "toggleNewRoom"; open?: boolean }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "providers"; providers: ProviderRow[] }
  | { type: "connectProvider"; kind: string; key?: string; url?: string }
  | { type: "disconnectProvider"; kind: string }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string; replyTo?: Message["replyTo"] }
  | { type: "answerCard"; botId: string; messageId: string; answer: string; roomId?: string }
  | { type: "dismissCard"; botId: string; messageId: string; roomId?: string }
  | { type: "hireTeam"; botId: string; messageId: string }
  | { type: "newBot"; profile?: NewAgentProfile }
  | { type: "toggleNewAgent"; open?: boolean; firstRun?: boolean }
  | { type: "toggleSkills"; open?: boolean }
  | { type: "toggleRoutines"; open?: boolean }
  | { type: "toggleActivity"; open?: boolean }
  | { type: "newTask"; botId: string }
  | { type: "selectTask"; botId: string; taskId: string }
  | { type: "closeTask"; botId: string; taskId: string }
  | { type: "botAdded"; bot: Bot }
  | { type: "deleteBot"; botId: string; forget?: boolean }
  | { type: "restoreBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  | { type: "toggleProjects"; open?: boolean }
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
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
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
      return { ...state, bots: action.bots, selectedId };
    }
    case "hydrateBloks": {
      const wanted = state.selectedId || readSelected();
      const selectedId = action.bloks.some((b) => b.id === wanted) ? wanted : state.selectedId;
      return { ...state, bloks: action.bloks, selectedId };
    }
    case "blokPatched": {
      const existing = state.bloks.find((b) => b.id === action.blok.id);
      return {
        ...state,
        bloks: existing
          ? state.bloks.map((b) => (b.id === action.blok.id ? { ...b, ...action.blok } : b))
          : [{ ...action.blok, messages: [] }, ...state.bloks],
      };
    }
    case "blokDeleted": {
      const bloks = state.bloks.filter((b) => b.id !== action.blokId);
      const selectedId =
        state.selectedId === action.blokId ? (state.bots[0]?.id ?? "") : state.selectedId;
      return { ...state, bloks, selectedId };
    }
    case "toggleNewRoom":
      return { ...state, newRoomOpen: action.open ?? !state.newRoomOpen };
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
    case "instances":
      return { ...state, instances: action.instances };
    case "providers":
      return { ...state, providers: action.providers };
    case "configStatus":
      return { ...state, config: action.config };
    case "select":
      writeSelected(action.id);
      return updateBot({ ...state, selectedId: action.id }, action.id, (b) => ({ ...b, unread: false }));
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
        bots: [action.bot, ...state.bots],
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
      return { ...state, routinesOpen: action.open ?? !state.routinesOpen };
    case "toggleActivity":
      return { ...state, activityOpen: action.open ?? !state.activityOpen };
    case "newTask":
    case "selectTask":
    case "closeTask":
      return state;
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
    case "markUnread":
      return updateBot(state, action.botId, (b) => ({ ...b, unread: true }));
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
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: (state.streaming[action.threadId] ?? "") + action.delta,
        },
      };
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      return { ...state, streaming: rest };
    }
    case "screenFrame":
      return {
        ...state,
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
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
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
      };
    }
    case "updateBot":
      return updateBot(state, action.botId, (b) => ({ ...b, ...action.patch }));
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
  providers: [],
  config: null,
  selectedId: readSelected(),
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  newAgentOpen: false,
  newAgentFirstRun: false,
  skillsOpen: false,
  routinesOpen: false,
  newRoomOpen: false,
  projectsOpen: false,
  activityOpen: false,
  projectId: (() => {
    try {
      return localStorage.getItem("bloks-project");
    } catch {
      return null;
    }
  })(),
  streaming: {},
  screens: {},
  provisioning: {},
  connected: false,
  error: null,
};
