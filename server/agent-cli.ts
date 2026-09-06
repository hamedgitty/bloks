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
}

/** A turn that runs longer than this has bigger problems. */
export const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * How many things one turn may do.
 *
 * Reading is free; anything that changes the workspace is counted. The
 * number is not about abuse, it is about loops: an agent that messages
 * another agent starts a turn, and that agent can message back. Without a
 * ceiling the two of them can spend an afternoon and a lot of somebody's
 * money agreeing with each other. Twelve is more than any real piece of
 * work needs and far less than a loop.
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

  // Who is here, so an agent can address someone by name rather than
  // guessing. Names, roles and skills only: the roster route already
  // returns nothing secret.
  { method: "GET", path: "/api/bots", why: "see who else is in the workspace" },
  { method: "GET", path: "/api/bloks", why: "see which rooms exist" },

  // Saying something to somebody. This is the one that turns a chat
  // between one agent and one person into a workspace.
  { method: "POST", path: "/api/bots/:id/messages", why: "say something to another agent" },
  { method: "POST", path: "/api/bloks/:room/messages", why: "say something in a room it is in" },

  // Getting a colleague, and somewhere to work with them.
  { method: "POST", path: "/api/bots", why: "hire a teammate" },
  { method: "POST", path: "/api/bloks", why: "open a room" },
  { method: "PATCH", path: "/api/bloks/:room", why: "change a room it is in" },

  // Work that repeats, and work nobody has been named for.
  { method: "GET", path: "/api/routines", why: "see what is scheduled" },
  { method: "POST", path: "/api/routines", why: "file a routine" },
  { method: "PATCH", path: "/api/routines/:id", why: "change a routine" },
  { method: "DELETE", path: "/api/routines/:id", why: "drop a routine" },
  { method: "GET", path: "/api/jobs", why: "read the job board" },
  { method: "POST", path: "/api/jobs", why: "post work to the board" },

  // Its own notes, and nobody else's.
  { method: "GET", path: "/api/bots/:me/memory", why: "read its own memory" },
  { method: "PUT", path: "/api/bots/:me/memory", why: "write its own memory" },
  { method: "GET", path: "/api/bots/:me/artifacts", why: "list what it has produced" },

  // Skills it can consult, and its own settings.
  { method: "GET", path: "/api/skills", why: "see the skill library" },
  { method: "GET", path: "/api/skills/:id", why: "read one of its skills in full" },

  // Answering with something other than a paragraph.
  { method: "POST", path: "/api/bots/:me/show", why: "answer with a chart, a table or another component" },
  { method: "PATCH", path: "/api/bots/:me", why: "change its own settings" },
];

/**
 * Nothing here is reachable with an agent's token, whatever the rules
 * above say. Kept as its own list rather than trusting the allow list to
 * be complete: a rule added carelessly should still not open one of
 * these, and a test can assert every one of them stays shut.
 */
export const NEVER = [
  "/api/config",
  "/api/providers",
  "/api/custom-endpoints",
  "/api/instances",
  "/api/pair",
  "/api/mcp-servers",
  "/api/ledger",
  "/api/relay",
  "/api/calls",
  "/api/terminal",
  "/api/usage",
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
  if (/^\/api\/bots\/[\w-]+\/(memory|artifacts)$/.test(clean)) {
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

  /** Who is calling, or nobody. */
  identify(token: string | null | undefined, now: number): AgentToken | null {
    if (!token) return null;
    const found = this.byToken.get(token);
    if (!found) return null;
    if (found.expiresAt <= now) {
      this.byToken.delete(token);
      return null;
    }
    return found;
  }

  /** The turn ended. Whatever it was given stops working now rather than
   * at the end of the hour. */
  revokeTask(taskId: string) {
    for (const [token, held] of this.byToken) {
      if (held.taskId === taskId) this.byToken.delete(token);
    }
  }

  /**
   * Count one change against a credential's budget. Returns false once it
   * is spent, which the guard turns into a refusal that says so.
   */
  spend(token: AgentToken): boolean {
    if (token.spent >= TURN_BUDGET) return false;
    token.spent++;
    return true;
  }

  revokeBot(botId: string) {
    for (const [token, held] of this.byToken) {
      if (held.botId === botId) this.byToken.delete(token);
    }
  }

  sweep(now: number) {
    for (const [token, held] of this.byToken) {
      if (held.expiresAt <= now) this.byToken.delete(token);
    }
  }

  get size(): number {
    return this.byToken.size;
  }
}

/** What the agent is told, once, when it has a credential. Short on
 * purpose: a paragraph of instructions in every prompt is a paragraph
 * competing with the actual request. */
export function cliBriefing(command: string): string {
  return [
    `You can act on this workspace yourself, not only describe what should happen. Run \`${command} help\` to see how.`,
    "Use it when you have decided something needs doing: hiring a teammate, opening a room, filing a routine, posting a job, saying something to another agent.",
    "It answers JSON. Your credential is already in the environment and only lasts this turn.",
  ].join(" ");
}
