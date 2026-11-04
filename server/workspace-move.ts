// Moving a whole workspace to another machine: from the person's Mac to a
// hosted workspace, in one file.
//
// A move is a backup with the machine taken out (server/backup.ts writes
// it, and a restore puts it in place), because the backup already knows
// how to carry every agent, lane, room, routine, watcher, intent, memory
// and skill, and how to keep keys out of a file that travels. What a move
// adds is the rest of what belongs to the computer it leaves rather than
// to the workspace: folders on that disk, engine sessions only its CLIs
// can resume, the Undo history of files that are not coming, its relay
// space and paired devices, its port. Those are left out or cleared here,
// and the machine it lands on keeps its own.
//
// Keys never travel in a move, sealed or not. The file says which ones
// were left behind, by name, so the person knows what to enter again.
//
// Everything here is pure: text in, text out.
import { isRecord } from "./atomic-write.ts";

/** Folders and files that only mean something on the machine a move
 * leaves, beyond what a backup already leaves out. */
export function moveLeftOut(rel: string, isDir: boolean): string | null {
  const parts = rel.split("/");
  if (parts.length !== 1) return null;
  const name = parts[0];
  if (isDir) {
    if (name === "checkpoints") return "Undo history of files on the computer it left";
    if (name === "rehearsals") return "rehearsal copies of folders on the computer it left";
    if (name === "vm-home") return "the Local VM's files";
    if (name === "identities") return "agents' signing keys";
    return null;
  }
  const machine: Record<string, string> = {
    // a move's own note: where this copy's work went, which is this
    // copy's to say and never travels with it (server/moved-mark.ts)
    "moved.json": "the note that this copy was moved",
    "turns-in-flight.json": "turns running on the computer it left",
    "engine-sessions.json": "engine sessions on the computer it left",
    "engine-turns.json": "engine sessions on the computer it left",
    "session-import.json": "what was brought over from that computer's other tools",
    "setup-import.json": "what was brought over from that computer's other tools",
    "setup-import-runs.json": "imports from that computer's other tools, kept for undo",
    "pair-links.json": "pairing links for that computer",
    "live-activities.json": "phones paired with that computer",
  };
  return machine[name] ?? null;
}

/** Sections of config.json that describe the computer, not the workspace:
 * its port, its engines' install paths, its relay space and paired
 * devices, its keyboard shortcuts, its cloud box. A move leaves them out,
 * and a machine that takes one in keeps its own. */
export const MACHINE_CONFIG = ["port", "instances", "relay", "remote", "shortcuts", "box"] as const;

/** A key's place in config.json, as a person would name it. */
export function secretLabel(path: string, config: Record<string, unknown>): string {
  const provider = /^providers\.([\w-]+)\.key$/.exec(path);
  if (provider) return `${providerName(provider[1])} key`;
  const custom = /^custom\[([^\]]+)\]\.keys\[([^\]]+)\]\.key$/.exec(path);
  if (custom) {
    const host = Array.isArray(config.custom)
      ? config.custom.find((entry) => isRecord(entry) && String(entry.id) === custom[1])
      : null;
    const name = isRecord(host) && typeof host.name === "string" ? host.name : "a custom host";
    return `Key for ${name}`;
  }
  const mcp = /^mcpServers\[([^\]]+)\]\.headers$/.exec(path);
  if (mcp) {
    const server = Array.isArray(config.mcpServers)
      ? config.mcpServers.find((entry) => isRecord(entry) && String(entry.id) === mcp[1])
      : null;
    return `Headers for the ${isRecord(server) && typeof server.name === "string" ? server.name : "MCP"} server`;
  }
  const telegramBot = /^telegram\.bots\.([\w-]+)\.token$/.exec(path);
  if (telegramBot) return "A Telegram bot token";
  if (/^webhookSecrets\./.test(path)) return "A webhook's signing secret";
  const known: Record<string, string> = {
    "xai.key": "Grok key",
    "composio.key": "Composio key",
    "composio.apiKey": "Composio project key",
    "speech.elevenlabsKey": "ElevenLabs key",
    "speech.openaiKey": "OpenAI speech key",
    "speech.fishKey": "Fish Audio key",
    "speech.xaiKey": "xAI speech key",
    "box.token": "Cloud box key",
    "chat.slack.botToken": "Slack bot token",
    "chat.slack.appToken": "Slack app token",
    "chat.discord.token": "Discord token",
    "chat.whatsapp.token": "WhatsApp token",
    "chat.whatsapp.appSecret": "WhatsApp app secret",
    "chat.whatsapp.verifyToken": "WhatsApp verify token",
    "telegram.token": "Telegram bot token",
    "telegram.pending.token": "Telegram bot token",
    "credits.licence": "Bloks Cloud key, for Bloks AI",
    "credits.token": "Bloks Cloud key, for Bloks AI",
  };
  return known[path] ?? path;
}

function providerName(kind: string): string {
  const names: Record<string, string> = {
    openrouter: "OpenRouter",
    gemini: "Gemini",
    grok: "Grok",
    kimi: "Kimi",
    llama: "Llama",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    groq: "Groq",
    custom: "Custom host",
  };
  return names[kind] ?? kind;
}

/** One key or connection a move left behind, to be entered again where
 * it lands: as a person would name it, the Settings page it is entered
 * on (src/lib/settingsPages.ts), and where it was in config.json, by
 * name and never by value. */
export interface KeyToEnter {
  label: string;
  page: string;
  path: string;
}

/** The Settings page a key is entered on, by where it sits in
 * config.json. */
export function keyPage(path: string): string {
  if (/^(providers\.|xai\.|custom\[)/.test(path)) return "engines";
  if (/^(telegram\.|chat\.)/.test(path)) return "chat";
  if (/^(composio|secrets)\./.test(path) || path === "secrets") return "apps";
  if (/^speech\./.test(path)) return "voices";
  if (/^mcpServers\[/.test(path)) return "plugins";
  if (/^box\./.test(path)) return "computers";
  if (/^credits\./.test(path)) return "plan";
  // not a Settings page: a webhook's own page, under Automations
  if (/^webhookSecrets\./.test(path)) return "automations:webhooks";
  return "engines";
}

/**
 * config.json for a move, given the copy a backup has already taken the
 * keys out of (`stripped`, with where each was) and the original, which
 * is read for names only. The machine's own sections go, and so does the
 * new-agent folder, which is a folder on that disk. Says which keys are
 * to be entered again, by name, each once.
 */
export function configForMove(
  stripped: Record<string, unknown>,
  leftOut: string[],
  original: Record<string, unknown>,
): { config: Record<string, unknown>; toEnter: string[]; keys: KeyToEnter[] } {
  const config = structuredClone(stripped);
  for (const key of MACHINE_CONFIG) delete config[key];
  if (isRecord(config.agentDefaults)) delete config.agentDefaults.cwd;
  const keys = keysLeftBehind(leftOut, original);
  return { config, toEnter: keys.map((key) => key.label), keys };
}

/** What a move left behind, each named once, with the page it is
 * entered on again. The relay's tokens and the paired devices stay with
 * that computer and are nothing to enter: a new space is opened there. */
export function keysLeftBehind(leftOut: string[], original: Record<string, unknown>): KeyToEnter[] {
  const keys: KeyToEnter[] = [];
  const add = (label: string, path: string) => {
    if (!keys.some((key) => key.label === label)) keys.push({ label, page: keyPage(path), path });
  };
  for (const path of leftOut) {
    if (/^(relay|remote)\./.test(path)) continue;
    if (path === "secrets") {
      // each by its own name, so a machine with saved secrets of its own
      // is still asked for the ones it does not have
      const names = isRecord(original.secrets) ? Object.keys(original.secrets) : [];
      for (const name of names) add(`Saved secret ${name}`, `secrets.${name}`);
      continue;
    }
    add(secretLabel(path, original), path);
  }
  return keys;
}

/** A move's keys as a file or an answer said them, each checked, or an
 * empty list. */
export function readKeys(raw: unknown): KeyToEnter[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.path !== "string") return [];
    const path = item.path.slice(0, 200);
    return [{ label: item.label.slice(0, 200), page: keyPage(path), path }];
  });
}

/** The keys still to be entered where a move lands, given the places in
 * that machine's own config.json that hold one already (heldKeyPaths). A
 * workspace moved back into the copy it left keeps that copy's keys, so
 * those are not asked for again. */
export function stillToEnter(keys: KeyToEnter[], held: string[]): KeyToEnter[] {
  const here = new Set(held);
  return keys.filter((key) => !here.has(key.path));
}

/** Where a config.json holds a key, by path and never by value, with each
 * saved secret by its own name, as keysLeftBehind names them. `strip` is
 * backup.ts stripSecrets, passed in so this file stays free of it. */
export function heldKeyPaths(config: Record<string, unknown>, strip: (config: Record<string, unknown>) => string[]): string[] {
  const names = isRecord(config.secrets) ? Object.keys(config.secrets).map((name) => `secrets.${name}`) : [];
  return [...strip(structuredClone(config)).filter((path) => path !== "secrets"), ...names];
}

/** What a move counts on both sides, to say that all of it arrived. */
export interface MoveCounts {
  agents: number;
  conversations: number;
  rooms: number;
  routines: number;
  watchers: number;
  workflows: number;
  memoryFiles: number;
}

/** Each count, with its word for one and for more. */
export const COUNTED: ReadonlyArray<readonly [keyof MoveCounts, string, string]> = [
  ["agents", "agent", "agents"],
  ["conversations", "conversation", "conversations"],
  ["rooms", "room", "rooms"],
  ["routines", "routine", "routines"],
  ["watchers", "watcher", "watchers"],
  ["workflows", "workflow", "workflows"],
  ["memoryFiles", "memory file", "memory files"],
];

/** Counts as a file or an answer said them, or null for anything that is
 * not a whole set. */
export function readCounts(raw: unknown): MoveCounts | null {
  if (!isRecord(raw)) return null;
  const out: Partial<MoveCounts> = {};
  for (const [key] of COUNTED) {
    const n = raw[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    out[key] = n;
  }
  return out as MoveCounts;
}

/** What did not arrive as it left, in words ("2 of 3 agents"), or an
 * empty list when all of it did. */
export function countsDiffer(sent: MoveCounts, arrived: MoveCounts): string[] {
  const out: string[] = [];
  for (const [key, one, many] of COUNTED) {
    if (sent[key] !== arrived[key]) out.push(`${arrived[key]} of ${sent[key]} ${sent[key] === 1 ? one : many}`);
  }
  return out;
}

/** bots.json for a move: every agent and lane kept, without the folders
 * of the computer it leaves or the engine sessions only that computer can
 * resume. A lane whose session is gone is told the conversation so far on
 * its next turn, the way a dropped session is (store.dropSession). */
export function botsForMove(text: string): string {
  const bots = JSON.parse(text);
  if (!Array.isArray(bots)) return text;
  for (const bot of bots) {
    if (!isRecord(bot)) continue;
    delete bot.cwd;
    bot.resumeCursors = {};
    // a box or a VM on that computer, or that computer itself, is not
    // here; off stays off, anything else lets the new machine decide
    if (bot.computer !== "off") delete bot.computer;
    const tasks = Array.isArray(bot.tasks) ? bot.tasks : [];
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      delete task.cwd;
      task.resumeCursors = {};
      // served by no engine in particular: the next one is told the story
      task.lastInstanceId = "";
      delete task.reading;
      delete task.pendingCompaction;
      task.busy = false;
      if (isRecord(task.imported)) task.imported.resumes = false;
    }
  }
  return `${JSON.stringify(bots, null, 2)}\n`;
}

/** bloks.json for a move: a room's desk is a folder on that disk, so the
 * room's first turn here chooses one again. */
export function roomsForMove(text: string): string {
  const rooms = JSON.parse(text);
  if (!Array.isArray(rooms)) return text;
  for (const room of rooms) {
    if (!isRecord(room)) continue;
    delete room.cwd;
    delete room.pinnedCwd;
  }
  return `${JSON.stringify(rooms, null, 2)}\n`;
}

/** projects.json for a move: a project keeps its name, people and notes,
 * and loses the folders it covered on that disk, since a project whose
 * folders are missing stops its agents rather than guess. */
export function projectsForMove(text: string): string {
  const projects = JSON.parse(text);
  if (!Array.isArray(projects)) return text;
  for (const project of projects) {
    if (isRecord(project)) project.folders = [];
  }
  return `${JSON.stringify(projects, null, 2)}\n`;
}

/** The files a move rewrites on the way out, by their path in the data
 * folder. config.json is done apart, after its keys are taken out. */
export const MOVE_REWRITES: Record<string, (text: string) => string> = {
  "bots.json": botsForMove,
  "bloks.json": roomsForMove,
  "projects.json": projectsForMove,
};

/** A config.json that arrived in a move, given the one this machine has:
 * this machine's own sections put back over it, whole. */
export function keepThisMachine(current: Record<string, unknown>, restored: Record<string, unknown>): void {
  for (const key of MACHINE_CONFIG) {
    if (current[key] === undefined) delete restored[key];
    else restored[key] = structuredClone(current[key]);
  }
}

/** Whether a workspace is empty enough to take a move in: nothing said by
 * the person, no rooms and no standing work. A first start seeds an agent
 * that greets, which is not anybody's work. */
export function emptyEnoughForMove(counts: { mine: number; rooms: number; routines: number; watchers: number; intents: number; workflows?: number }): boolean {
  return counts.mine === 0 && counts.rooms === 0 && counts.routines === 0 && counts.watchers === 0 && counts.intents === 0 && !counts.workflows;
}
