// Taking an agent somewhere else, and letting one arrive.
//
// An exported agent is one JSON document: who it is, what it knows how to
// do, the skills it carries and what it has learned. Not its
// conversations, and not anything that only means something on the
// machine it left. A file that names a folder, a connector grant or an
// engine instance from another Mac would either be a lie here or a way in,
// so those are dropped at the door rather than translated.
//
// Everything in here is pure: data in, data out, no filesystem. The IO
// lives in server/index.ts, which is what makes the rules below testable
// and what keeps a hostile file from reaching disk before it is judged.
import type { BlokColor, BlokExpression, BlokShape } from "./store.ts";

export const AGENT_FILE_KIND = "bloks.agent";
export const AGENT_FILE_VERSION = 1;

/** The name a file gets when it is written out. */
export const AGENT_FILE_EXTENSION = ".bloks-agent.json";

/**
 * Caps. A file arrives from somewhere else, so every one of these is
 * enforced on the way in as well as on the way out: an export we wrote is
 * not a different class of citizen from one a stranger sent.
 */
export const LIMITS = {
  /** The whole document, as bytes of JSON. */
  file: 8 * 1024 * 1024,
  name: 80,
  title: 160,
  description: 4_000,
  /** One free-text capability line. */
  capability: 400,
  capabilities: 12,
  memory: 256 * 1024,
  topics: 50,
  topicBytes: 256 * 1024,
  skills: 40,
  skillBytes: 16_000,
  avatar: 2 * 1024 * 1024,
} as const;

const COLORS = new Set<BlokColor>([
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
]);

const SHAPES = new Set<BlokShape>([
  "star",
  "burst",
  "diamond",
  "bit",
  "triangle",
  "cloud",
  "drop",
  "invader",
]);

const EXPRESSIONS = new Set<BlokExpression>([
  "deadpan",
  "friendly",
  "focused",
  "thinking",
  "excited",
  "sleepy",
  "surprised",
  "skeptical",
  "worried",
  "mischievous",
]);

/** The same shape workspace.ts allows, repeated so a topic name from a
 * file is judged by this module rather than by whoever calls it. */
const TOPIC_NAME = /^[\w][\w .-]{0,120}\.md$/;

const AVATAR_MIME = /^image\/(jpeg|png|webp)$/;

export interface PortableAgent {
  name: string;
  title: string;
  description: string;
  color?: BlokColor;
  shape?: BlokShape;
  /** Free-text capabilities, folded into the persona. */
  capabilities?: string[];
  seniority?: number;
  effort?: "low" | "medium" | "high";
  mascotExpression?: BlokExpression | null;
  /** A wish, not a binding: the engine may not exist on the machine this
   * lands on, in which case the workspace default is used instead. */
  model?: { instanceId: string; model: string };
  /** Carried because how an agent sounds is part of who it is. Needs a
   * key at the other end, which the preview says out loud. */
  voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string };
}

export interface PortableSkill {
  id: string;
  name: string;
  description: string;
  body: string;
}

export interface PortableTopic {
  name: string;
  text: string;
}

export interface AgentFile {
  kind: typeof AGENT_FILE_KIND;
  version: number;
  exportedAt: number;
  /** Which build wrote it. Advisory: never used to decide anything. */
  app?: string;
  agent: PortableAgent;
  memory?: { text: string; topics: PortableTopic[] };
  skills?: PortableSkill[];
  avatar?: { mime: string; data: string };
}

// ── writing one ────────────────────────────────────────────────────────

export interface PackInput {
  bot: {
    name?: string;
    title?: string;
    description?: string;
    color?: BlokColor;
    shape?: BlokShape;
    skills?: string[];
    seniority?: number;
    effort?: "low" | "medium" | "high";
    mascotExpression?: BlokExpression | null;
    modelSelection?: { instanceId: string; model: string };
    voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string } | null;
  };
  memory?: string;
  topics?: PortableTopic[];
  skills?: PortableSkill[];
  avatar?: { mime: string; data: string } | null;
  exportedAt: number;
  app?: string;
}

function trim(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Bytes, not characters: every cap here is about what lands on disk. */
function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cut a string to a byte budget without leaving half a character
 * behind. A sliced multi-byte sequence decodes as U+FFFD, so the
 * replacement characters at the tail come off with it. */
function clampBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  return Buffer.from(text, "utf8")
    .subarray(0, max)
    .toString("utf8")
    .replace(/�+$/, "");
}

export function packAgent(input: PackInput): AgentFile {
  const bot = input.bot;
  const agent: PortableAgent = {
    name: trim(bot.name, LIMITS.name) || "Agent",
    title: trim(bot.title, LIMITS.title),
    description: trim(bot.description, LIMITS.description),
  };
  if (bot.color && COLORS.has(bot.color)) agent.color = bot.color;
  if (bot.shape && SHAPES.has(bot.shape)) agent.shape = bot.shape;
  const capabilities = (bot.skills ?? [])
    .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    .slice(0, LIMITS.capabilities)
    .map((s) => s.trim().slice(0, LIMITS.capability));
  if (capabilities.length) agent.capabilities = capabilities;
  if (typeof bot.seniority === "number" && Number.isFinite(bot.seniority)) {
    agent.seniority = Math.max(1, Math.min(5, Math.round(bot.seniority)));
  }
  if (bot.effort === "low" || bot.effort === "medium" || bot.effort === "high") {
    agent.effort = bot.effort;
  }
  if (bot.mascotExpression && EXPRESSIONS.has(bot.mascotExpression)) {
    agent.mascotExpression = bot.mascotExpression;
  }
  if (bot.modelSelection?.instanceId && bot.modelSelection.model) {
    agent.model = {
      instanceId: String(bot.modelSelection.instanceId).slice(0, 120),
      model: String(bot.modelSelection.model).slice(0, 200),
    };
  }
  if (bot.voice?.id && (bot.voice.provider === "elevenlabs" || bot.voice.provider === "openai")) {
    agent.voice = {
      provider: bot.voice.provider,
      id: String(bot.voice.id).slice(0, 120),
      ...(bot.voice.name ? { name: String(bot.voice.name).slice(0, 80) } : {}),
    };
  }

  const file: AgentFile = {
    kind: AGENT_FILE_KIND,
    version: AGENT_FILE_VERSION,
    exportedAt: input.exportedAt,
    agent,
  };
  if (input.app) file.app = input.app.slice(0, 40);

  const memoryText = clampBytes(typeof input.memory === "string" ? input.memory : "", LIMITS.memory);
  const topics = (input.topics ?? [])
    .filter((t) => TOPIC_NAME.test(t?.name ?? ""))
    .slice(0, LIMITS.topics)
    .map((t) => ({ name: t.name, text: clampBytes(String(t.text ?? ""), LIMITS.topicBytes) }));
  if (memoryText.trim() || topics.length) {
    file.memory = { text: memoryText, topics };
  }

  const skills = (input.skills ?? [])
    .filter((s) => s && typeof s.body === "string" && s.body.trim())
    .slice(0, LIMITS.skills)
    .map((s) => ({
      id: slug(s.id || s.name),
      name: trim(s.name, LIMITS.name) || slug(s.id || s.name),
      description: trim(s.description, 200),
      body: clampBytes(s.body.trim(), LIMITS.skillBytes),
    }));
  if (skills.length) file.skills = skills;

  if (input.avatar?.data && AVATAR_MIME.test(input.avatar.mime ?? "")) {
    // base64 grows by four thirds, so the cap is on the decoded size
    if (Buffer.from(input.avatar.data, "base64").length <= LIMITS.avatar) {
      file.avatar = { mime: input.avatar.mime, data: input.avatar.data };
    }
  }

  return file;
}

/** The same slug rule skills.ts uses, repeated so this module can be
 * reasoned about on its own: lowercase, dashed, no dots or separators,
 * which is what makes an id from a file unable to leave its directory. */
export function slug(input: string): string {
  const out = String(input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return out || "skill";
}

/** What the file is called when it is saved. */
export function fileNameFor(name: string): string {
  return `${slug(name) || "agent"}${AGENT_FILE_EXTENSION}`;
}

// ── reading one ────────────────────────────────────────────────────────

export type ParseResult = { ok: true; file: AgentFile } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Judge a document that came from somewhere else.
 *
 * Nothing is carried across by spreading: every field is read by name and
 * rebuilt, so a file with extra keys in it, whatever they are called,
 * cannot smuggle one into a record. Anything oversized is refused rather
 * than silently trimmed, because a file that does not fit is more likely
 * to be wrong than to be generous.
 */
export function parseAgentFile(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, error: "that is not an agent file" };
  if (value.kind !== AGENT_FILE_KIND) return { ok: false, error: "that is not an agent file" };
  const version = value.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, error: "that agent file has no version" };
  }
  if (version > AGENT_FILE_VERSION) {
    return { ok: false, error: "that agent was exported by a newer version of Bloks" };
  }

  const raw = value.agent;
  if (!isRecord(raw)) return { ok: false, error: "that agent file has no agent in it" };
  const name = trim(raw.name, LIMITS.name);
  if (!name) return { ok: false, error: "that agent has no name" };

  const agent: PortableAgent = {
    name,
    title: trim(raw.title, LIMITS.title),
    description: trim(raw.description, LIMITS.description),
  };
  if (typeof raw.color === "string" && COLORS.has(raw.color as BlokColor)) {
    agent.color = raw.color as BlokColor;
  }
  if (typeof raw.shape === "string" && SHAPES.has(raw.shape as BlokShape)) {
    agent.shape = raw.shape as BlokShape;
  }
  if (Array.isArray(raw.capabilities)) {
    const list = raw.capabilities
      .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
      .slice(0, LIMITS.capabilities)
      .map((s) => s.trim().slice(0, LIMITS.capability));
    if (list.length) agent.capabilities = list;
  }
  if (typeof raw.seniority === "number" && Number.isFinite(raw.seniority)) {
    agent.seniority = Math.max(1, Math.min(5, Math.round(raw.seniority)));
  }
  if (raw.effort === "low" || raw.effort === "medium" || raw.effort === "high") {
    agent.effort = raw.effort;
  }
  if (typeof raw.mascotExpression === "string" && EXPRESSIONS.has(raw.mascotExpression as BlokExpression)) {
    agent.mascotExpression = raw.mascotExpression as BlokExpression;
  }
  if (isRecord(raw.model) && typeof raw.model.instanceId === "string" && typeof raw.model.model === "string") {
    agent.model = {
      instanceId: raw.model.instanceId.slice(0, 120),
      model: raw.model.model.slice(0, 200),
    };
  }
  if (
    isRecord(raw.voice) &&
    (raw.voice.provider === "elevenlabs" || raw.voice.provider === "openai") &&
    typeof raw.voice.id === "string" &&
    raw.voice.id
  ) {
    agent.voice = {
      provider: raw.voice.provider,
      id: raw.voice.id.slice(0, 120),
      ...(typeof raw.voice.name === "string" ? { name: raw.voice.name.slice(0, 80) } : {}),
    };
  }

  const file: AgentFile = {
    kind: AGENT_FILE_KIND,
    version,
    exportedAt: typeof value.exportedAt === "number" ? value.exportedAt : 0,
    agent,
  };
  if (typeof value.app === "string") file.app = value.app.slice(0, 40);

  if (value.memory !== undefined) {
    if (!isRecord(value.memory)) return { ok: false, error: "that agent file's memory is malformed" };
    const text = typeof value.memory.text === "string" ? value.memory.text : "";
    if (bytes(text) > LIMITS.memory) return { ok: false, error: "that agent's memory is too large" };
    const rawTopics = Array.isArray(value.memory.topics) ? value.memory.topics : [];
    if (rawTopics.length > LIMITS.topics) {
      return { ok: false, error: "that agent carries too many memory files" };
    }
    const topics: PortableTopic[] = [];
    for (const entry of rawTopics) {
      // a name is a filename on the way back in, so it is checked here
      // and not merely trusted because we probably wrote it
      if (!isRecord(entry) || typeof entry.name !== "string" || !TOPIC_NAME.test(entry.name)) {
        return { ok: false, error: "that agent file names a memory file we will not write" };
      }
      const body = typeof entry.text === "string" ? entry.text : "";
      if (bytes(body) > LIMITS.topicBytes) {
        return { ok: false, error: `that agent's ${entry.name} is too large` };
      }
      topics.push({ name: entry.name, text: body });
    }
    if (text || topics.length) file.memory = { text, topics };
  }

  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) return { ok: false, error: "that agent file's skills are malformed" };
    if (value.skills.length > LIMITS.skills) {
      return { ok: false, error: "that agent carries too many skills" };
    }
    const skills: PortableSkill[] = [];
    for (const entry of value.skills) {
      if (!isRecord(entry)) return { ok: false, error: "that agent file's skills are malformed" };
      const body = typeof entry.body === "string" ? entry.body.trim() : "";
      if (!body) continue;
      if (bytes(body) > LIMITS.skillBytes) {
        return { ok: false, error: "one of that agent's skills is too large" };
      }
      const id = slug(typeof entry.id === "string" && entry.id ? entry.id : String(entry.name ?? ""));
      skills.push({
        id,
        name: trim(entry.name, LIMITS.name) || id,
        description: trim(entry.description, 200),
        body,
      });
    }
    if (skills.length) file.skills = skills;
  }

  if (value.avatar !== undefined) {
    if (!isRecord(value.avatar)) return { ok: false, error: "that agent file's picture is malformed" };
    const mime = typeof value.avatar.mime === "string" ? value.avatar.mime : "";
    const data = typeof value.avatar.data === "string" ? value.avatar.data : "";
    if (!AVATAR_MIME.test(mime)) return { ok: false, error: "that agent's picture is not an image" };
    const decoded = Buffer.from(data, "base64");
    if (!decoded.length) return { ok: false, error: "that agent's picture is empty" };
    if (decoded.length > LIMITS.avatar) return { ok: false, error: "that agent's picture is too large" };
    file.avatar = { mime, data };
  }

  return { ok: true, file };
}

/** Parse the bytes of a dropped file, size gate first. */
export function parseAgentDocument(text: string): ParseResult {
  if (bytes(text) > LIMITS.file) return { ok: false, error: "that agent file is too large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "that file is not an agent file" };
  }
  return parseAgentFile(value);
}

// ── what the preview says ──────────────────────────────────────────────

export interface PreviewContext {
  /** Skill ids already in this workspace's library. */
  skillIds: string[];
  /** Engine instances configured here. */
  instanceIds: string[];
  /** Whether a voice could actually be spoken here. */
  voiceReady?: boolean;
}

export interface AgentPreview {
  name: string;
  title: string;
  description: string;
  color?: BlokColor;
  shape?: BlokShape;
  capabilities: string[];
  seniority?: number;
  /** Library skills, and whether each one is already here. */
  skills: Array<{ id: string; name: string; description: string; alreadyHere: boolean }>;
  memoryBytes: number;
  topics: number;
  hasPhoto: boolean;
  exportedAt: number;
  /** Anything the person should know before they say yes. */
  notes: string[];
}

/**
 * The dialog's whole content, decided here rather than in the component,
 * so what an import promises is something a test can hold.
 */
export function describeAgentFile(file: AgentFile, ctx: PreviewContext): AgentPreview {
  const known = new Set(ctx.skillIds);
  const skills = (file.skills ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    alreadyHere: known.has(s.id),
  }));

  const notes: string[] = [];
  const fresh = skills.filter((s) => !s.alreadyHere).length;
  if (fresh) {
    notes.push(
      fresh === 1
        ? "One skill will be added to your library."
        : `${fresh} skills will be added to your library.`,
    );
  }
  const clashes = skills.filter((s) => s.alreadyHere);
  if (clashes.length) {
    notes.push(
      clashes.length === 1
        ? `You already have a skill called ${clashes[0].name}. Yours is kept.`
        : `You already have ${clashes.length} of these skills. Yours are kept.`,
    );
  }
  if (file.agent.model && !ctx.instanceIds.includes(file.agent.model.instanceId)) {
    notes.push("It was running on an engine you have not set up. Yours will be used instead.");
  }
  if (file.agent.voice && ctx.voiceReady === false) {
    notes.push("It has a voice, which needs a speech key here before it can talk.");
  }
  const memoryBytes = bytes(file.memory?.text ?? "");
  if (memoryBytes || file.memory?.topics.length) {
    notes.push("Its memory comes with it, so it arrives knowing what it knew.");
  }
  notes.push("Its conversations stay behind. This is the agent, not the history.");

  return {
    name: file.agent.name,
    title: file.agent.title,
    description: file.agent.description,
    color: file.agent.color,
    shape: file.agent.shape,
    capabilities: file.agent.capabilities ?? [],
    seniority: file.agent.seniority,
    skills,
    memoryBytes,
    topics: file.memory?.topics.length ?? 0,
    hasPhoto: Boolean(file.avatar),
    exportedAt: file.exportedAt,
    notes,
  };
}

/**
 * The record an import creates, split into what a new agent is made from
 * and what is patched onto it afterwards. Ids, threads, tasks, cursors
 * and every grant an agent holds are deliberately absent: an arriving
 * agent gets this workspace's defaults for all of them, and has to be
 * given anything more by the person who imported it.
 */
export function profileFromFile(file: AgentFile): {
  profile: {
    name: string;
    title: string;
    description: string;
    color?: BlokColor;
    shape?: BlokShape;
    skills?: string[];
    skillIds?: string[];
    seniority?: number;
  };
  patch: {
    effort?: "low" | "medium" | "high";
    mascotExpression?: BlokExpression;
    voice?: { provider: "elevenlabs" | "openai"; id: string; name?: string };
  };
} {
  const a = file.agent;
  return {
    profile: {
      name: a.name,
      title: a.title,
      description: a.description,
      ...(a.color ? { color: a.color } : {}),
      ...(a.shape ? { shape: a.shape } : {}),
      ...(a.capabilities?.length ? { skills: a.capabilities } : {}),
      ...(file.skills?.length ? { skillIds: file.skills.map((s) => s.id) } : {}),
      ...(a.seniority ? { seniority: a.seniority } : {}),
    },
    patch: {
      ...(a.effort ? { effort: a.effort } : {}),
      ...(a.mascotExpression ? { mascotExpression: a.mascotExpression } : {}),
      ...(a.voice ? { voice: a.voice } : {}),
    },
  };
}
