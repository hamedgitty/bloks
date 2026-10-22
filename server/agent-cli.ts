// A command line an agent can drive as itself.
//
// Everything an agent can do today it does by talking: it says something
// and a person acts on it. That is fine for answers and wrong for work.
// An agent that has decided it needs a colleague, or that this should run
// every Monday, should be able to do that rather than describe it.
//
// So a turn gets a credential of its own, and a command line that carries
// it. Two things about that credential matter more than anything else
// here:
//
//   It is the agent, not the person. It says who is calling, and what an
//   agent may do is a smaller set than what the person at the keyboard
//   may do. Not because agents are untrusted, but because a prompt is an
//   input: whatever ends up in an agent's context can try to steer it,
//   and the blast radius of that should not include the workspace's keys.
//
//   It lasts one turn. Minted when the turn starts, gone when it ends, so
//   a token that leaks into a file, a log or a transcript is spent by the
//   time anybody reads it.
//
// The scope rules are here, as data and a pure function over it, because
// "what may an agent do" is the question worth being able to read in one
// place and test exhaustively.
import { randomBytes } from "node:crypto";

/** A turn's credential. */
export interface AgentToken {
  token: string;
  botId: string;
  /** The lane it was minted for, so the record can say which. */
  taskId: string;
  expiresAt: number;
  /** Changes made so far on this credential. */
  spent: number;
  /** This credential can only reply to its turn's Telegram sender. */
  reply?: { sender: import("./telegram-people.ts").TelegramReplySender; turn: number; attempted?: Set<string> };
  /** Only the final direct submission, retained through normal renewal. */
  report?: ReservedReport;
  /** This credential can only message one person on somebody's behalf
   * (POST /api/agent/message-person): a turn an admin started in a team
   * conversation or a room, which gets none of the owner's standing. */
  messenger?: true;
}

export interface ReportResponse { status: number; body: Record<string, unknown> }
export interface ReservedReport {
  identity: string;
  /** A write may have taken effect. It cannot be safely refunded. */
  dispatched: boolean;
  accepted: boolean;
  response: ReportResponse;
}

export const REPORT_PENDING: ReportResponse = {
  status: 202,
  body: { ok: false, pending: true, note: "This direct message is still pending. Retry the same words and destination to check it; do not send a replacement." },
};
export const REPORT_UNCERTAIN: ReportResponse = {
  status: 202,
  body: { ok: false, uncertain: true, note: "This direct message may have been accepted. Retry only the same submission to check its receipt; do not send it again elsewhere." },
};

/** How long a credential lasts without its turn vouching for it. A turn
 * that is still running renews it (see `alive` below): long turns are
 * ordinary work now, an hour of comparing quotes in a browser, and an
 * agent that lost its credential partway could not deliver what it
 * found. The hour is the backstop for a turn that never ended cleanly. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Whether the turn a credential belongs to is still running. */
export type TurnAlive = (taskId: string) => boolean;

/**
 * How many things one turn may do.
 *
 * Reading is free; anything that changes the workspace is counted. The
 * number is not about abuse, it is about loops: an agent that messages
 * another agent starts a turn, and that agent can message back. Without a
 * ceiling the two of them can spend an afternoon and a lot of somebody's
 * money agreeing with each other. Twelve is more than any real piece of
 * work needs and far less than a loop.
 *
 * Past the twelve one more is kept back, for one direct message to
 * another agent and nothing else (claimReport below). A turn handed work
 * by another agent owes it an answer, and an agent that spent its twelve
 * on the work itself would otherwise finish having done it and been
 * unable to say so. The thirteenth cannot feed a loop the twelve could
 * not: it is one message, and the message still counts along the chain.
 *
 * It starts again with every turn, so it bounds one turn and not the
 * back and forth. That is counted across turns as well: a turn another
 * agent's message started is one further along a chain than the
 * sender's, and past MAX_AGENT_CHAIN (server/index.ts) the next message
 * waits for the person.
 */
export const TURN_BUDGET = 12;

/**
 * What an agent may ask for.
 *
 * Read as: method, a path pattern, and whether `:id` in the path has to
 * be the agent itself. Anything not listed is refused, which is the only
 * way a list like this stays honest as routes are added.
 */
export interface Rule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /**
   * `:me` matches only the calling agent's own id. `:room` matches a room
   * this agent is actually in. `:id` matches any.
   */
  path: string;
  why: string;
}

export const RULES: Rule[] = [
  // The one route that exists for the command line itself. It is on the
  // list like everything else, because the guard runs before any route
  // does and a route nobody listed is a route nobody reaches.
  { method: "GET", path: "/api/agent/whoami", why: "find out who this credential says you are" },
  // A message into one person's private conversation with this agent, on
  // the owner's or an admin's word (server/access.ts decides whether it
  // may, and the answer says so either way).
  { method: "POST", path: "/api/agent/message-person", why: "message one person in this workspace privately, when the owner or an admin asked you to in a team conversation or a room" },
  // Settings as their owners hold them, for `bloks settings`: reading only,
  // credentials as configured or not, and a device's settings as it last
  // said them (docs/ARCHITECTURE.md, Settings inspection).
  { method: "GET", path: "/api/agent/settings", why: "inspect safe settings observations and their owner controls without changing them" },
  // The goal the person set for the conversation this turn runs in, if
  // any. Reading only: a goal starts turns unattended and can run a
  // command on the person's computer, so setting one is theirs alone,
  // and no rule here reaches the routes that do.
  { method: "GET", path: "/api/agent/goal", why: "read the goal the person set for this conversation, if there is one" },
  // Where the person is, as their own iPhone last said, with how long ago
  // and how exactly (server/location.ts). Reading only, and only in the
  // owner's own conversations: the route refuses the rest. The report
  // itself, and forgetting it, are the person's (NEVER below).
  { method: "GET", path: "/api/agent/location", why: "read where the person's iPhone last placed them, how long ago and how exactly, or ask it for a fresh reading" },

  // Who is here, so an agent can address someone by name rather than
  // guessing. Names, roles and skills only: the roster route already
  // returns nothing secret.
  { method: "GET", path: "/api/bots", why: "see who else is in the workspace" },
  { method: "GET", path: "/api/bloks", why: "see which rooms exist" },
  // How the sidebar is arranged, so an agent filing or pinning a teammate
  // can see where things stand first. The order of the headings is read
  // here and only the person moves it.
  { method: "GET", path: "/api/sidebar", why: "see how the sidebar is arranged: its sections in order, and what is pinned where" },

  // Saying something to somebody. This is the one that turns a chat
  // between one agent and one person into a workspace.
  { method: "POST", path: "/api/bots/:id/messages", why: "say something to another agent" },
  { method: "POST", path: "/api/bots/:id/take-back", why: "take back its own messages still waiting for another agent" },
  { method: "POST", path: "/api/bloks/:room/messages", why: "say something in a room it is in" },
  { method: "GET", path: "/api/bloks/:room/messages", why: "read what was said in a room it is in" },

  // Getting a colleague, and somewhere to work with them.
  { method: "POST", path: "/api/bots", why: "hire a teammate" },
  { method: "POST", path: "/api/bloks", why: "open a room" },
  { method: "PATCH", path: "/api/bloks/:room", why: "change a room it is in" },

  // Work that repeats, and work nobody has been named for.
  { method: "GET", path: "/api/routines", why: "see what is scheduled" },
  { method: "POST", path: "/api/routines", why: "file a routine: at a time of day, or a check-in every so often that may answer QUIET" },
  { method: "PATCH", path: "/api/routines/:id", why: "change a routine" },
  { method: "DELETE", path: "/api/routines/:id", why: "drop a routine" },
  { method: "GET", path: "/api/watchers", why: "see its own watchers" },
  { method: "POST", path: "/api/watchers", why: "watch a folder, a web page or a feed, run a cheap check, or wait for the person to arrive at or leave a place, and act when it finds something" },
  { method: "PATCH", path: "/api/watchers/:id", why: "change one of its own watchers without replacing it" },
  { method: "DELETE", path: "/api/watchers/:id", why: "stop one of its own watchers" },
  // Standing intents (server/intents.ts): an agent proposes, the person
  // approves. Nothing on this list approves, pauses or changes one; the
  // route files an agent's as a proposal whatever the body says.
  { method: "GET", path: "/api/intents", why: "see the standing intents it proposed, and whether the person approved each" },
  { method: "POST", path: "/api/intents", why: "propose a standing intent: whenever some words come up in a conversation, post a note, bring an agent in or message one, once the person approves it" },
  { method: "DELETE", path: "/api/intents/:id", why: "withdraw a standing intent it proposed that is still waiting for approval" },
  // Pausing an engine for itself, and only for itself: the route refuses
  // another agent, longer than a day, and stopping what is running.
  { method: "GET", path: "/api/engine-pauses", why: "see the engine pauses that apply to it, and until when" },
  { method: "POST", path: "/api/engine-pauses", why: "pause an engine or a model for itself, up to a day, so its own work waits until then" },
  { method: "DELETE", path: "/api/engine-pauses/:id", why: "call off a pause it made on itself" },
  // The incident desk (server/incidents.ts): something failed and this
  // agent leads, so it reads the incident and takes one of three ways out.
  // The routes refuse an incident that is not this agent's to lead, and
  // one that is with the person now; the list itself is the person's.
  { method: "GET", path: "/api/incidents/:id", why: "read an incident Bloks handed you because you lead" },
  { method: "POST", path: "/api/incidents/:id/retry", why: "try a failed thing you lead once more, once" },
  { method: "POST", path: "/api/incidents/:id/hand", why: "hand a failed thing you lead to a teammate, with what to do" },
  { method: "POST", path: "/api/incidents/:id/tell", why: "tell the person what a failed thing you lead needs from them, in a card they will see" },
  { method: "GET", path: "/api/jobs", why: "read the job board" },
  { method: "POST", path: "/api/jobs", why: "post work to the board" },

  // Its own notes, and nobody else's.
  { method: "GET", path: "/api/bots/:me/memory", why: "read its own memory" },
  { method: "GET", path: "/api/bots/:me/recall", why: "look something up in its own past conversations" },
  { method: "GET", path: "/api/bots/:me/recall/:id", why: "read in full a message its recall found" },
  // Stopping is an authority: the route allows it only for an agent the
  // caller hired, or one it outranks in a room they share.
  { method: "POST", path: "/api/bots/:id/interrupt", why: "stop the current turn of an agent it hired or leads in a room" },
  { method: "POST", path: "/api/bots/:id/archive", why: "archive an agent it hired, once that agent has nothing left to do" },
  { method: "POST", path: "/api/bots/:me/notes", why: "suggest a short note about the person, for them to keep or not" },
  // The same secure field the request_secret tool plants, for an engine
  // that has no such tool. Asking is not a permission: the person still
  // types the value, and the agent never sees it in the chat.
  { method: "POST", path: "/api/bots/:me/secrets", why: "ask the person for an API key or other secret, or for its own Telegram bot's token, through a secure field in the chat" },
  { method: "PUT", path: "/api/bots/:me/memory", why: "write its own memory" },
  { method: "GET", path: "/api/bots/:me/memory/topics/:id", why: "read one of its own memory topic files" },
  { method: "PUT", path: "/api/bots/:me/memory/topics/:id", why: "write one of its own memory topic files" },
  { method: "DELETE", path: "/api/bots/:me/memory/topics/:id", why: "forget one of its own memory topic files" },
  // What the person keeps for every agent, read only: the write is theirs
  // alone, and is not on this list.
  { method: "GET", path: "/api/memory/shared", why: "read the shared memory the person keeps for every agent" },
  { method: "GET", path: "/api/bots/:me/artifacts", why: "list what it has produced" },
  // One file into the conversation, as a card the person opens in the
  // app on any device. The command reads the file, as the agent, and
  // sends its bytes; the route never reads a path it is given.
  { method: "POST", path: "/api/bots/:me/artifacts", why: "share one file into the conversation as a card the person can open, and get a link to it" },

  // Skills it can consult, and its own settings.
  { method: "GET", path: "/api/skills", why: "see the skill library" },
  { method: "GET", path: "/api/skills/:id", why: "read one of its skills in full" },

  // Answering with something other than a paragraph.
  { method: "POST", path: "/api/bots/:me/show", why: "answer with a chart, a table or another component" },
  { method: "PATCH", path: "/api/bots/:me", why: "change its own settings" },
  // A section, a pin and a place among the pins are where a row sits in
  // the sidebar: they change nothing another agent can do or see, and the
  // person can move them back. The route itself refuses anything else on
  // an agent that is not the caller.
  { method: "PATCH", path: "/api/bots/:id", why: "file a teammate into a sidebar section, pin it or place it among the pins (nothing else of its)" },
  { method: "PATCH", path: "/api/bots/:me/tasks/:id", why: "rename one of its own conversations" },
  { method: "DELETE", path: "/api/bots/:me/tasks/:id", why: "close one of its own conversations, once its turn there ends" },
  { method: "POST", path: "/api/bots/:me/tasks/:id/fresh", why: "start a fresh engine session in the conversation it is in, keeping the transcript" },
];

/**
 * Nothing here is reachable with an agent's token, whatever the rules
 * above say. Kept as its own list rather than trusting the allow list to
 * be complete: a rule added carelessly should still not open one of
 * these, and a test can assert every one of them stays shut.
 */
export const NEVER = [
  "/api/config",
  // how much every agent may do without asking is the person's alone
  "/api/approvals",
  "/api/providers",
  "/api/custom-endpoints",
  "/api/instances",
  // installing software and opening Terminal are the person's to start
  "/api/engines",
  "/api/pair",
  "/api/mcp-servers",
  // reading the person's other tools out of their home folder
  "/api/setup-import",
  // and their past conversations with those tools
  "/api/session-import",
  "/api/ledger",
  "/api/relay",
  "/api/calls",
  "/api/terminal",
  "/api/usage",
  "/api/profile",
  // a backup is the whole workspace, and a restore replaces it
  "/api/backups",
  // a map of what reaches the person's keys and screen, and its fixes
  "/api/security",
  // the secrets saved for agents, by name, and forgetting one: the
  // person's to keep or drop, never a turn's
  "/api/secrets",
  // where the person is, as their phone says it: an agent reads it through
  // /api/agent/location and never says it, changes it or forgets it
  "/api/location",
];

const PATH_PART = /^[\w.-]+$/;

/**
 * Which rooms this agent is in.
 *
 * Passed in rather than read here, so the rules stay a pure function over
 * a request and the store stays the caller's business.
 */
export type InRoom = (roomId: string) => boolean;

/** Nobody, which is what an unanswerable question should mean here. */
const NO_ROOMS: InRoom = () => false;

/** Does a request path match a rule's pattern, for this agent. */
export function matches(pattern: string, path: string, botId: string, inRoom: InRoom = NO_ROOMS): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === ":me") {
      if (got[i] !== botId) return false;
      continue;
    }
    if (want[i] === ":room") {
      if (!PATH_PART.test(got[i] ?? "") || !inRoom(got[i])) return false;
      continue;
    }
    if (want[i] === ":id") {
      if (!PATH_PART.test(got[i] ?? "")) return false;
      continue;
    }
    if (want[i] !== got[i]) return false;
  }
  return true;
}

/** The same shape, ignoring membership: used only to tell "you are not in
 * that room" apart from "that is not a thing an agent can do". */
function shapeMatches(pattern: string, path: string, botId: string): boolean {
  return matches(pattern.replace(/:room/g, ":id"), path, botId);
}

export interface Decision {
  ok: boolean;
  /** Why it was refused, in words an agent can act on. */
  reason?: string;
}

/**
 * May this agent make this request.
 *
 * The refusals say what would have been allowed instead, because the
 * caller is a model and "not allowed" with no direction is how a turn
 * turns into six more attempts at the same thing.
 */
export function allows(botId: string, method: string, path: string, inRoom: InRoom = NO_ROOMS): Decision {
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  for (const prefix of NEVER) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return { ok: false, reason: `${prefix} is not something an agent can reach` };
    }
  }
  const verb = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.method === verb && matches(rule.path, clean, botId, inRoom)) return { ok: true };
  }
  // The right shape, the right verb, the wrong room. Said separately
  // because it is the one refusal here that is about who the agent is
  // rather than about what agents may do, and an agent told "that is not
  // allowed" would reasonably try a different route instead of asking to
  // be added.
  const roomRule = RULES.find(
    (rule) => rule.path.includes(":room") && rule.method === verb && shapeMatches(rule.path, clean, botId),
  );
  if (roomRule) {
    return { ok: false, reason: "an agent can only speak in and change the rooms it is in" };
  }
  // a path an agent may touch, but not this way
  const otherVerb = RULES.find((rule) => shapeMatches(rule.path, clean, botId));
  if (otherVerb) {
    const verbs = RULES.filter((rule) => shapeMatches(rule.path, clean, botId)).map((r) => r.method);
    return { ok: false, reason: `${clean} allows ${verbs.join(", ")} for an agent, not ${verb}` };
  }
  // its own things, being asked for on somebody else's behalf
  if (/^\/api\/bots\/[\w-]+\/(memory(\/topics\/[^/]+)?|artifacts)$/.test(clean)) {
    return { ok: false, reason: "an agent can only read and write its own memory and files" };
  }
  return { ok: false, reason: `${verb} ${clean} is not on the list of things an agent can do` };
}

/** Everything an agent may do, as sentences, for the prompt and for the
 * CLI's own help. */
export function capabilities(): string[] {
  return RULES.map((rule) => rule.why);
}

/**
 * The engines a credential is worth minting for.
 *
 * A credential reaches an agent through the environment of the process
 * its turn runs in, so an engine that is an HTTP call rather than a
 * process has nowhere to put it and no shell to spend it from. Naming
 * them rather than excluding the two obvious ones means a driver added
 * later gets nothing until somebody has decided it should.
 */
export const CLI_DRIVERS = new Set(["claudeAgent", "codex", "antigravity", "opencode", "grokCli", "pi"]);

export function runsAProcess(driverKind: string): boolean {
  return CLI_DRIVERS.has(driverKind);
}

// ── the credentials themselves ─────────────────────────────────────────

export class AgentTokens {
  private byToken = new Map<string, AgentToken>();

  /** One turn, one credential. */
  mint(botId: string, taskId: string, now: number): AgentToken {
    const minted: AgentToken = {
      token: `blk_${randomBytes(24).toString("base64url")}`,
      botId,
      taskId,
      expiresAt: now + TOKEN_TTL_MS,
      spent: 0,
    };
    this.byToken.set(minted.token, minted);
    return minted;
  }

  mintReply(botId: string, taskId: string, now: number, sender: import("./telegram-people.ts").TelegramReplySender, turn: number): AgentToken {
    const minted: AgentToken = { token: `blr_${randomBytes(24).toString("base64url")}`, botId, taskId, expiresAt: now + TOKEN_TTL_MS, spent: 0, reply: { sender, turn } };
    this.byToken.set(minted.token, minted);
    return minted;
  }

  /** A credential for one thing: messaging a person on the asker's
   * behalf. For a turn the owner did not start but an admin did, which
   * must not carry the owner's whole workspace in its environment. */
  mintMessenger(botId: string, taskId: string, now: number): AgentToken {
    const minted: AgentToken = { token: `blm_${randomBytes(24).toString("base64url")}`, botId, taskId, expiresAt: now + TOKEN_TTL_MS, spent: 0, messenger: true };
    this.byToken.set(minted.token, minted);
    return minted;
  }

  /** Who is calling, or nobody. A credential past its hour still works
   * while its turn is running, and is renewed for another; once the turn
   * is over it is gone. */
  identify(token: string | null | undefined, now: number, alive?: TurnAlive): AgentToken | null {
    if (!token) return null;
    const found = this.byToken.get(token);
    if (!found) return null;
    if (found.expiresAt <= now && !this.renew(found, now, alive)) {
      this.byToken.delete(token);
      return null;
    }
    return found;
  }

  private renew(held: AgentToken, now: number, alive?: TurnAlive): boolean {
    if (!alive?.(held.taskId)) return false;
    held.expiresAt = now + TOKEN_TTL_MS;
    return true;
  }

  /** The turn ended. Whatever it was given stops working now rather than
   * at the end of the hour. */
  revokeTask(taskId: string) {
    for (const [token, held] of this.byToken) {
      if (held.taskId === taskId) this.byToken.delete(token);
    }
  }

  /**
   * Count one change against a credential's budget. Returns false once
   * the twelve general changes are spent, which the guard turns into a
   * refusal that says so, or into the kept-back direct message when that
   * is what was asked for.
   */
  spend(token: AgentToken): boolean {
    if (this.byToken.get(token.token) !== token || token.spent >= TURN_BUDGET) return false;
    token.spent++;
    return true;
  }

  /** The thirteenth change, the kept-back direct message: only once the
   * twelve are spent, and only once. Called synchronously after delivery
   * guards, before any recipient write. */
  claimReport(token: AgentToken, identity: string, now: number, alive?: TurnAlive): ReservedReport {
    if (this.identify(token.token, now, alive) !== token) {
      throw Object.assign(new Error("this request's credential expired or was revoked"), { status: 401 });
    }
    if (token.spent !== TURN_BUDGET || token.report) {
      throw Object.assign(new Error("this turn's direct reporting slot is already occupied"), { status: 429 });
    }
    return token.report = { identity, dispatched: false, accepted: false, response: REPORT_PENDING };
  }

  revokeBot(botId: string) {
    for (const [token, held] of this.byToken) {
      if (held.botId === botId) this.byToken.delete(token);
    }
  }

  sweep(now: number, alive?: TurnAlive) {
    for (const [token, held] of this.byToken) {
      if (held.expiresAt <= now && !this.renew(held, now, alive)) this.byToken.delete(token);
    }
  }

  get size(): number {
    return this.byToken.size;
  }
}

/**
 * How an agent with a POSIX shell runs the CLI: through BLOKS_CLI, which
 * every turn sets (server/index.ts says why not a path). Spelled so that
 * a shell without it stops with a sentence saying so. `node ""` runs
 * nothing and exits 0, so a shell whose engine had kept the variable from
 * it answered every command with a silence that read as success
 * (GitHub 336).
 */
export const CLI_FROM_ENV = 'node "${BLOKS_CLI:?not set in this shell}"';

/** What the agent is told, once, when it has a credential. Short on
 * purpose: a paragraph of instructions in every prompt is a paragraph
 * competing with the actual request. */
/** The opening of a turn whose session last ran the CLI some other way.
 * `before` is the command it was told then, when that was recorded. */
export function cliMovedNote(command: string, before?: string): string {
  // the same variable, spelled to stop loudly: nothing has moved
  if (before?.includes("BLOKS_CLI")) {
    return `(Run the bloks command as \`${command}\` from now on. When this shell does not have BLOKS_CLI it stops with an error saying so, where \`${before}\` quietly did nothing.)`;
  }
  return before
    ? `(Bloks has moved since your earlier turns. Run its command as \`${command}\` from now on. Earlier commands in this conversation that run \`${before}\` reach the copy that used to be there, so do not reuse them.)`
    : `(Run the bloks command as \`${command}\` from now on. Earlier commands in this conversation that run bloks.mjs from a written-out path may reach an older copy of Bloks that has since moved, so do not reuse them.)`;
}

/**
 * How an agent asks for a key, said in terms of what it actually has
 * (GitHub 172). Claude Code and the API engines with tools have the
 * request_secret tool, the other engines with a credential have `secret`
 * on the command line, and an engine with neither is told nothing, since
 * pointing it at a tool it cannot call only makes it pretend to.
 */
export function secretHint(route: "tool" | "cli" | null, command: string): string | null {
  if (route === "tool") {
    return "When a task needs an API key or other secret from the user, call the request_secret tool and they get a secure field in the chat; never ask for keys in plain conversation.";
  }
  if (route === "cli") {
    return `When a task needs an API key or other secret from the user, run \`${command} secret "<what it is>" --hint "<where to find it>"\` and they get a secure field in the chat; never ask for keys in plain conversation.`;
  }
  return null;
}

/** How a turn that may message people is told to, in terms of what its
 * engine has: a tool, the command line, or nothing at all. */
export function messageHint(route: "tool" | "cli" | null, command: string): string | null {
  if (route === "tool") return "send it with the message_person tool";
  if (route === "cli") return `send it by running \`${command} message-person "<their name>" "<the message>"\``;
  return null;
}

export function cliBriefing(command: string): string {
  return [
    `You can act on this workspace yourself, not only describe what should happen. Run \`${command} help\` to see how.`,
    "Use it when you have decided something needs doing: hiring a teammate, opening a room, filing a routine, posting a job, saying something to another agent.",
    "Its `recall <words>` searches your past conversations when something may have come up before.",
    "It answers JSON. Your credential is already in the environment and only lasts this turn.",
  ].join(" ");
}
