// Where settings and data live.
//
// Everything is under ~/.bloks: one config file, the agents, every
// transcript, and the logs. That is the whole storage story, and it is
// deliberate. BLOKS_DATA_DIR moves the whole of it somewhere else: the
// desktop app runs one server per workspace, each on a folder of its own,
// and only Personal keeps ~/.bloks. A person can read it, back it up, move it to another Mac, or
// delete it and be genuinely rid of the app.
//
// Credentials may also arrive from the environment, which is what a
// container or a CI run wants and what lets someone try the app without
// writing a key to disk at all.
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readSaved, isRecord, writeFileAtomic } from "./atomic-write.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { usableSecrets } from "./env-names.ts";
import { CUSTOM_SPEC, PROVIDER_SPECS, specFor } from "./providers.ts";
import { CREDITS_KIND, CREDITS_SPEC, creditsCompatUrl, creditsEnvToken } from "./credits.ts";

/** One connected engine: the credential, plus an override for people
 * pointing at a proxy or a self-hosted endpoint. */
export interface ProviderConfig {
  key?: string;
  url?: string;
}

/** One credential on a user-added OpenAI-compatible host. Several can
 * share a URL; the active one is what the live instance sends. */
export interface CustomKey {
  id: string;
  /** Optional name so two keys on one host can be told apart. */
  label?: string;
  key: string;
}

/** A third-party host that speaks OpenAI's /v1 shape. Secrets stay in
 * this file with the rest of the keys. */
export interface CustomEndpoint {
  id: string;
  name: string;
  url: string;
  keys: CustomKey[];
  /** Which key the instance uses. Missing means the first key. */
  activeKeyId?: string;
  /** The person's word that the model behind this host can call tools,
   * which turns the API tool loop on for it. Missing is chat only: no
   * one but them knows what is loaded there. */
  tools?: boolean;
  /** The person says the model behind this URL sees pictures, so a turn's
   * attached images are sent to it as pictures. Nobody can tell from the
   * outside (a llama.cpp server sees only with a vision projector loaded),
   * so it is theirs to say, and off until they do. */
  vision?: boolean;
}

export interface AppConfig {
  codex?: { speed?: import("./codex-speed.ts").CodexSpeed };
  /** The port to listen on when BLOKS_PORT does not say. Chosen by hand,
   * for a machine where the usual one is taken; the desktop app reads it
   * too, since an app opened from Finder never sees BLOKS_PORT. */
  port?: number;
  /** Model providers, keyed by the catalog's driver kind. */
  providers?: Record<string, ProviderConfig>;
  /** Pre-catalog xAI slot. Still read, still written through to
   * providers.grok, so an old config file keeps working. */
  xai?: { key?: string; url?: string };
  /** Two different Composio credentials, and they are not
   * interchangeable. The consumer key is the one that matters: it opens
   * connections and gives agents their tools. The project key is optional
   * and only makes the plugin grid prettier. */
  composio?: { key?: string; apiKey?: string; url?: string };
  /** Voice vendors. Any key lights up voices and calls. */
  speech?: {
    elevenlabsKey?: string;
    openaiKey?: string;
    fishKey?: string;
    /** xAI's speech API. Unset, the Grok engine's key is used: it is the
     * same account, already given to Bloks (server/speech.ts xaiKey). */
    xaiKey?: string;
    /** A Chatterbox server on this computer or the local network. Not a
     * secret, and no key: it is the person's own machine. */
    chatterboxUrl?: string;
    /** The user's explicit yes to using a key discovered in the
     * environment or Codex's auth file for voice billing. */
    useDiscoveredOpenAI?: boolean;
  };
  /** `sleepAfter`: minutes without work before Bloks puts an agent's
   * cloud computer to sleep (billing stops, the disk stays). 0 never. */
  box?: { token?: string; sleepAfter?: number };
  /** Keyboard shortcuts the desktop shell registers with the system.
   * Off until somebody sets one: a global hotkey that arrives
   * uninvited will collide with whatever they already use. */
  shortcuts?: { quickAsk?: string | null };
  /** User-added OpenAI-compatible hosts. Same file as the other keys
   * because this is already the secrets file. */
  custom?: CustomEndpoint[];
  /** Carrying shared rooms into Slack and Discord channels
   * (server/chat-bridge.ts). Tokens are credentials, so they live here. */
  chat?: {
    slack?: { botToken?: string; appToken?: string; enabled?: boolean };
    discord?: { token?: string; enabled?: boolean };
    /** Meta's Cloud API. The app secret checks every webhook; the verify
     * token is what Meta echoes when the webhook is first set up. */
    whatsapp?: {
      token?: string;
      phoneNumberId?: string;
      appSecret?: string;
      verifyToken?: string;
      /** The business number, as Meta reports it, for spotting mentions. */
      number?: string;
      /** Where Meta should call, from Bloks Cloud. */
      webhookUrl?: string;
      enabled?: boolean;
    };
    /** Mail to <agent>.<id>@agents.bloks.dev, through Bloks Cloud. `id` is
     * this computer's part of every address; `allowFrom` limits who can
     * write (addresses, or @domain), empty meaning anyone who has one. */
    email?: { enabled?: boolean; id?: string; domain?: string; allowFrom?: string[] };
    /** A Signal group, through one of the accounts linked in signal-cli
     * (server/signal.ts). No credential: signal-cli keeps the keys. */
    signal?: { account?: string; aci?: string; enabled?: boolean };
  };
  /** Reaching agents from Signal, one linked account per agent, through
   * signal-cli on this computer. Nothing here is a credential: the
   * account's keys stay in signal-cli's own data folder. */
  signal?: import("./signal-people.ts").SignalSettings;
  /** Home Assistant (server/home-assistant.ts). The token is a credential
   * and lives here; it never reaches a client or a turn. */
  home?: import("./home-assistant.ts").HomeSettings;
  /** Reaching agents from a phone over Telegram. The token is a
   * credential, so it lives here with the rest of them. */
  telegram?: import("./telegram-bots.ts").TelegramConfig;
  /** User-registered MCP servers, attachable per agent. Headers and
   * commands live here because this file is already the secrets file.
   * `env` is a stdio server's own environment; a name with an empty value
   * is one the person has yet to fill in, and is not passed on. */
  mcpServers?: Array<{
    id: string;
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  }>;
  /** Values agents asked for via secret cards, injected into engine
   * environments under their env-var names. Never echoed to clients. */
  secrets?: Record<string, string>;
  /** Services agents reach through Bloks without holding the credential
   * (server/connections.ts). The token is a secret like the ones above,
   * kept here for the same reason, and unlike them it never enters a turn.
   * Replaced whole by saveConnections, never merged. */
  connections?: import("./connections.ts").ConnectionRecord[];
  /** Tools on this computer agents use from their shell, and whether each
   * plugin is on (server/cli-plugins.ts). No credential lives here: gh
   * keeps its own sign-in. */
  cliPlugins?: { github?: { enabled?: boolean } };
  /** When the one-time welcome was completed. Lives here, beside the
   * agents it describes, because a browser's localStorage is the wrong
   * place to remember whether a WORKSPACE has been set up: clear it, or
   * open the app on a different port, and a returning user is asked to
   * onboard again while a genuinely new one is skipped past it. */
  setupDoneAt?: number;
  /** When the routines, watchers and webhooks that named no conversation
   * were given the one they already ran in, once, on the upgrade that
   * made an agent's first conversation the default (GitHub 237). Here
   * for the same reason as setupDoneAt: it describes this workspace. */
  oneConversationAt?: number;
  /** Shared context every agent receives, not a secret, echoed back to
   * the app so the settings field can prefill. */
  /** `name` is how members of a shared room see the owner. */
  profile?: { about?: string; name?: string };
  /** The morning brief (server/brief.ts): on unless turned off, at 08:00
   * unless another time is chosen. `notify` off keeps it to the page;
   * `allClear` notifies on a quiet morning too. `layout` is how the
   * person arranged its sections (briefSettings reads it with defaults). */
  brief?: {
    enabled?: boolean;
    time?: string;
    notify?: boolean;
    allClear?: boolean;
    layout?: { order: string[]; pinned: string[]; hidden: string[] };
  };
  /** The daily backup (server/backup.ts): on unless turned off. It never
   * holds saved keys, since nobody is there to give it a passphrase. */
  backups?: { auto?: boolean };
  /** How a lane is kept inside the model's window. Off means the fold
   * happens once at a threshold; on means one message is absorbed after
   * each turn instead. See the note in server/context.ts for what that
   * trades: absorbing every turn rewrites history every turn, which
   * breaks the provider's prompt cache prefix every turn. `idle` asks a
   * quiet Claude Code conversation to compact before its cache expires;
   * see the note in server/context.ts. `beforeTurn` is the most tokens a
   * native session may carry into a new turn before it is compacted
   * first, 0 for never and unset for the default; `beforeTurnAt` is the
   * share of the window that also counts as too full (GitHub 222, 223). */
  compaction?: { micro?: boolean; idle?: boolean; beforeTurn?: number; beforeTurnAt?: number };
  /** Whether a finished session is read back for something worth keeping.
   * Off unless asked for: it spends the person's own tokens on work they
   * did not request. What it finds is always staged, never installed.
   * `learn` is how eager that is (server/proposals.ts): "off", "suggest"
   * or "more". Unset reads `propose`, which is what it was when it was
   * one switch: on is "suggest". */
  skills?: { propose?: boolean; learn?: "off" | "suggest" | "more" };
  /** Where the catalogue of teams and skills is read from: an index.json
   * over https (server/catalog.ts). Empty or unset is this repository's
   * own; BLOKS_CATALOG_URL, when set, wins over both. */
  catalog?: { url?: string };
  /** How long a tool call may go without a word from the engine before
   * Bloks stops the turn, in minutes; 0 is never. Unset is the default
   * in server/drivers/stall.ts. `backgroundWork` is whether a turn waits
   * for the background work it started or stops it with the reply, for
   * every agent that has not chosen (server/background-work.ts); unset
   * waits. */
  turns?: { stallMinutes?: number; backgroundWork?: "finish" | "stop" };
  /** Whether an agent is reminded, before the person's turn, of what it
   * said elsewhere that matches. Unset is on; each agent can also turn it
   * off for itself (BotRecord.recallBeforeTurn). */
  recall?: { beforeTurn?: boolean };
  /** Whether each agent's memory is tidied once a night, in the small
   * hours (server/memory-tidy.ts). Unset is on; Tidy now works either way. */
  memory?: { tidy?: boolean };
  /** Agent-started turns in a row, 1 to 50, default 12. There is no Off;
   * anything else stored here is read as 12 (agentTurnLimit). taskBudget
   * is the turns in a row the person allows across separate tasks, 2 to
   * 100, or null or absent for none (agentTaskBudget, GitHub 326). */
  agents?: { turnLimit?: number; taskBudget?: number | null };
  /** The incident desk (server/incidents.ts): on unless turned off, and
   * who leads incidents: "auto" (a room's lead, else the workspace's most
   * senior agent), "person" (always the person), or an agent's id. */
  incidents?: { enabled?: boolean; lead?: string };
  /** What happens to words sent while an agent is mid-turn, for every
   * agent that has not chosen for itself (server/delivery.ts). Unset is
   * auto: stops, corrections, answers and urgent words go in now, the
   * rest waits for the turn to end. `askModel` lets Automatic ask the
   * agent's own small model about words its rules cannot read; off
   * unless turned on, since each ask is a call on the person's key. */
  delivery?: { mode?: "auto" | "interrupt" | "queue"; askModel?: boolean };
  /** Rooms set to Auto (server/room-route.ts). `router` is the engine
   * (an instance id) that picks who answers a message naming nobody;
   * unset or null is the room's own engines, small model first, so the
   * words go nowhere they were not already going. */
  rooms?: { router?: string | null };
  /** Show a card for files changed during an overlapping turn even when
   * none are named as its own. On unless turned off; own-file cards stay. */
  changes?: { showShared?: boolean };
  /** What every new agent starts with, whoever hires it. Without this an
   * agent's first chat pins to its own workspace before anybody can
   * point it elsewhere. A missing key keeps the built-in start: its own
   * workspace, ask before acting, the first engine that is available.
   * An agent hiring an agent never passes on more approvals than it has. */
  agentDefaults?: {
    cwd?: string;
    approvals?: "ask" | "edits" | "auto" | "full";
    modelSelection?: { instanceId: string; model: string };
    effort?: import("./effort.ts").Effort;
  };
  /** The outbound line to a relay, so a phone can reach this Mac from
   * outside the house. The token names one space; the relay never holds
   * a key that could read what travels through it. */
  relay?: { url?: string; agentToken?: string; clientToken?: string; enabled?: boolean };
  /** Bloks credits (server/credits.ts). The licence is kept because a
   * credits token is traded for it, again whenever the service refuses
   * the token; the token is what every call sends. Both are secrets
   * (backup.ts SECRET_PATHS). `background` lets work nobody asked for
   * this minute (the nightly memory tidy, skill proposals) spend credits;
   * off unless turned on. */
  credits?: { licence?: string; token?: string; background?: boolean };
  /** Off unless somebody turned it on. Holds the devices allowed to
   * reach this server from the network (see server/pairing.ts); each
   * one is a name and a token digest, never a token. */
  remote?: { enabled?: boolean; devices?: unknown[]; memberDevices?: unknown[] };
  /** A monthly spending limit in US dollars on an engine that runs on
   * the person's own key, by engine instance (server/spend-limits.ts).
   * None set is no limit. */
  spendLimits?: Record<string, number>;
  /** The person's own price for an engine, in US dollars per million
   * input and output tokens, by engine instance (server/model-prices.ts):
   * a host of their own, or a model the providers' list does not know.
   * Ahead of that list when a turn comes back unpriced. */
  spendPrices?: Record<string, { input: number; output: number }>;
  /** The CLI an engine is started from, by driver kind, when it is not
   * the one on PATH: a second install, a build of one's own. Applied to
   * every instance of that driver whose own config does not name one. */
  enginePaths?: Record<string, string>;
  /** The switch on each engine in Settings, by instance id. It wins over
   * an `enabled` written into `instances`, since it is the later word,
   * and it reaches the engines a connected key or a custom host makes,
   * which have no entry there to write it in. None set is as configured. */
  engineSwitches?: Record<string, boolean>;
  instances?: InstanceConfigMap;
}

/** The data folder: BLOKS_DATA_DIR when it names one, else ~/.bloks. A
 * leading ~ is the home folder, the way a person would write it in a
 * shell; a relative path is taken from where the server was started. */
export function dataDirFrom(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const said = env.BLOKS_DATA_DIR?.trim();
  if (!said) return join(home, ".bloks");
  if (said === "~") return home;
  if (said.startsWith("~/")) return join(home, said.slice(2));
  return isAbsolute(said) ? said : resolve(said);
}

export const DATA_DIR = dataDirFrom();
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");
/** User-installed skills, one markdown file each. */
export const SKILLS_DIR = join(DATA_DIR, "skills");
/** Uploaded agent photos, one file per bot id plus a mime sidecar. */
export const AVATARS_DIR = join(DATA_DIR, "avatars");

/** The build that is running. Advisory: it goes on things we hand to
 * people so a file can say where it came from, and nothing anywhere
 * decides anything from it. Empty when the manifest cannot be found,
 * which is a stamp missing, not a failure. */
export const APP_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../..", "../../.."]) {
    try {
      const version = JSON.parse(readFileSync(join(here, up, "package.json"), "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch {
      /* not there; try the next one up */
    }
  }
  return "";
})();


export function ensureDirs() {
  // transcripts, keys and provider logs all live here, keep it private
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR, SKILLS_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(DATA_DIR, 0o700);
    chmodSync(join(DATA_DIR, "config.json"), 0o600);
  } catch {
    /* no config yet, or a non-POSIX filesystem */
  }
}

/** The saved bytes last observed by this owner, before environment defaults.
 * This is provenance, not a claim that a hand-edited file is current. Reads
 * never refresh it, and a failed owner load/save leaves it unchanged. */
let savedObservation: { value: AppConfig; observedAt: number; source: "owner-load" | "owner-save" } | null = null;
function observedSaved(value: AppConfig, source: "owner-load" | "owner-save"): void {
  savedObservation = { value: structuredClone(value), observedAt: Date.now(), source };
}
export function savedConfigObservation(): typeof savedObservation {
  return savedObservation ? structuredClone(savedObservation) : null;
}

export function loadConfig(): AppConfig {
  const saved = readSaved<AppConfig>(join(DATA_DIR, "config.json"), {}, isRecord);
  observedSaved(saved, "owner-load");
  return withEnvironment(saved);
}

/** Also used on the result of a save: a successful write must not be
 * followed by another fallible read just to refresh the live settings. */
function withEnvironment(cfg: AppConfig): AppConfig {
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.providers = { ...cfg.providers };
  // A key in the environment connects a provider without a config file,
  // which is what a container or a CI run wants.
  for (const spec of PROVIDER_SPECS) {
    const fromEnv = process.env[envVarFor(spec.kind)];
    if (fromEnv) cfg.providers[spec.kind] = { key: fromEnv, ...cfg.providers[spec.kind] };
  }
  // the old xai slot is just the grok provider by another name
  if (cfg.xai?.key && !cfg.providers.grok?.key) {
    cfg.providers.grok = { key: cfg.xai.key, ...(cfg.xai.url ? { url: cfg.xai.url } : {}) };
  }
  return cfg;
}

/** The env var a provider's key can arrive in, e.g. GEMINI_API_KEY. */
export function envVarFor(kind: string): string {
  return `${kind.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** Providers with a credential (or that need none) are the ones that
 * become instances. Everything else stays a row on the connections
 * screen until someone signs in. */
export function connectedProviders(cfg: AppConfig): string[] {
  return PROVIDER_SPECS.filter((spec) => {
    const entry = cfg.providers?.[spec.kind];
    return spec.auth === "none" ? Boolean(entry) : Boolean(entry?.key);
  }).map((spec) => spec.kind);
}

/** Merge changes into the config file, preserving whatever else is in
 * it. Nothing written here is ever sent back to a client: the API answers
 * questions about credentials with yes or no, never with the value. */
export function saveConfig(patch: Partial<AppConfig>, beforeWrite?: () => void): AppConfig {
  const p = join(DATA_DIR, "config.json");
  const disk = readSaved<Record<string, unknown>>(p, {}, isRecord);
  // An allowlist, not a spread: this file holds credentials and a request
  // body is not a config file. A section missing from here is a section
  // that silently will not save, which is what happened the first time
  // compaction was added without it.
  for (const key of [
    "codex",
    "xai",
    "composio",
    "box",
    "profile",
    "providers",
    "remote",
    "speech",
    "secrets",
    "relay",
    "shortcuts",
    "compaction",
    "skills",
    "catalog",
    "turns",
    "recall",
    "memory",
    "agents",
    "incidents",
    "delivery",
    "rooms",
    "changes",
    "telegram",
    "chat",
    "signal",
    "home",
    "brief",
    "backups",
    "credits",
    "spendLimits",
    "spendPrices",
    "cliPlugins",
    "enginePaths",
    "engineSwitches",
  ] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      // The migrated Telegram section is a complete private record. A
      // merge would retain the old workspace token or a removed binding.
      disk[key] = key === "telegram" && (patch.telegram?.version === 1 || patch.telegram?.version === 2)
        ? patch.telegram
        : { ...(disk[key] as object), ...patch[key] };
      // credits forgets by null: a token from an old licence must be gone
      // from the file, not kept beside a newer one; a limit taken off is
      // gone the same way, not kept as a zero that reads like one
      if (key === "credits" || key === "spendLimits" || key === "spendPrices" || key === "enginePaths" || key === "engineSwitches") {
        const merged = disk[key] as Record<string, unknown>;
        for (const name of Object.keys(merged)) if (merged[name] === null || merged[name] === undefined) delete merged[name];
      }
    }
  }
  if (Array.isArray((patch as Record<string, unknown>).mcpServers)) {
    disk.mcpServers = (patch as Record<string, unknown>).mcpServers;
  }
  // Replaced whole rather than merged, so leaving a key out clears it.
  if (patch.agentDefaults && typeof patch.agentDefaults === "object") {
    disk.agentDefaults = patch.agentDefaults;
  }
  if (Array.isArray((patch as Record<string, unknown>).custom)) {
    disk.custom = (patch as Record<string, unknown>).custom;
  }
  if (typeof (patch as Record<string, unknown>).setupDoneAt === "number") {
    disk.setupDoneAt = (patch as Record<string, unknown>).setupDoneAt;
  }
  if (typeof patch.oneConversationAt === "number") disk.oneConversationAt = patch.oneConversationAt;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // this file holds API keys in plaintext, never leave it group/world
  // readable; every save is a new file made 0600, whatever the old one was
  beforeWrite?.();
  const bytes = JSON.stringify(disk, null, 2);
  writeFileAtomic(p, bytes, 0o600);
  observedSaved(JSON.parse(bytes), "owner-save");
  return withEnvironment(disk as AppConfig);
}

/** Forgets one saved secret, by its name. Deleted rather than merged
 * away: saveConfig merges, and a merged `undefined` would leave the name
 * in the live settings, handed to every turn with no value. Null when
 * there was no such secret. */
export function forgetSecret(name: string): AppConfig | null {
  const p = join(DATA_DIR, "config.json");
  const disk = readSaved<Record<string, any> | null>(p, null, isRecord);
  if (!disk || !isRecord(disk.secrets) || !Object.prototype.hasOwnProperty.call(disk.secrets, name)) return null;
  delete disk.secrets[name];
  const bytes = JSON.stringify(disk, null, 2);
  writeFileAtomic(p, bytes, 0o600);
  observedSaved(JSON.parse(bytes), "owner-save");
  return withEnvironment(disk);
}

/** Writes the whole list of connections (server/connections.ts), in
 * place of the one on disk: a connection removed must be gone from the
 * file, token and all, not merged back from what was there. */
export function saveConnections(list: import("./connections.ts").ConnectionRecord[]): AppConfig {
  const p = join(DATA_DIR, "config.json");
  const disk = readSaved<Record<string, any>>(p, {}, isRecord);
  if (list.length) disk.connections = list;
  else delete disk.connections;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify(disk, null, 2);
  writeFileAtomic(p, bytes, 0o600);
  observedSaved(JSON.parse(bytes), "owner-save");
  return withEnvironment(disk);
}

/** Forgets a provider's credential entirely, rather than blanking it. */
export function disconnectProvider(kind: string): AppConfig {
  const p = join(DATA_DIR, "config.json");
  const disk = readSaved<Record<string, any> | null>(p, null, isRecord);
  if (!disk) return withEnvironment({});
  if (disk.providers) delete disk.providers[kind];
  // the legacy slot is the same credential under an older name
  if (kind === "grok") delete disk.xai;
  const bytes = JSON.stringify(disk, null, 2);
  writeFileAtomic(p, bytes, 0o600);
  observedSaved(JSON.parse(bytes), "owner-save");
  return withEnvironment(disk);
}

// Default fleet: the CLI agents and the box, plus an instance for every
// provider that has been connected, whose instance id defaults to the
// driver kind. Config-file keys are injected as per-instance environment
// so drivers see them without needing real process env vars.
const BUILT_IN_CLI_INSTANCES: InstanceConfigMap = {
  claude: { driver: "claudeAgent" },
  codex: { driver: "codex" },
  gemini_cli: { driver: "geminiCli" },
  opencode: { driver: "opencode" },
  devin: { driver: "devin" },
  grok_cli: { driver: "grokCli" },
  cursor: { driver: "cursor" },
  cline: { driver: "cline" },
  antigravity: { driver: "antigravity" },
  pi: { driver: "pi" },
  computer: { driver: "boxAgent" },
};

export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? { ...cfg.instances }
      : Object.fromEntries(
          Object.entries(BUILT_IN_CLI_INSTANCES).map(([id, entry]) => [id, { ...entry }]),
        );
  // A build that adds a CLI has to appear for people who already have
  // an instances map, or the new engine is a catalog row that never
  // probes.
  for (const [id, entry] of Object.entries(BUILT_IN_CLI_INSTANCES)) {
    if (Object.values(map).some((e) => e.driver === entry.driver)) continue;
    map[id] = { ...entry };
  }
  // A connected provider that is not already spelled out in `instances`
  // gets the obvious one: instance id = driver kind.
  for (const kind of connectedProviders(cfg)) {
    if (Object.values(map).some((e) => e.driver === kind)) continue;
    const spec = specFor(kind);
    map[kind] = {
      driver: kind,
      displayName: spec?.name,
      ...(cfg.providers?.[kind]?.url ? { config: { url: cfg.providers[kind].url } } : {}),
    };
  }
  // One instance per custom host. Several keys can sit on that host;
  // only the active one is injected, so rotating a key is a settings
  // change rather than a new engine in the picker. Tools ride in the
  // instance's config, so switching them is a rebuild of that one
  // instance, like any other config change.
  for (const endpoint of cfg.custom ?? []) {
    const cred = activeCustomKey(endpoint);
    if (!endpoint.url || !cred?.key) continue;
    map[customInstanceId(endpoint.id)] = {
      driver: CUSTOM_SPEC.kind,
      displayName: endpoint.name,
      config: { url: endpoint.url, ...(endpoint.tools === true ? { tools: true } : {}), ...(endpoint.vision === true ? { vision: true } : {}) },
      environment: { [envVarFor(CUSTOM_SPEC.kind)]: cred.key },
    };
  }
  // The Bloks engine, while a Cloud licence is active or this host was
  // started with a credits token. Its key is not injected here: the
  // driver asks for the token on each call, since a refused one is
  // renewed while the engine stays loaded.
  if (creditsOffered(cfg) && !map[CREDITS_KIND]) {
    map[CREDITS_KIND] = { driver: CREDITS_SPEC.kind, displayName: CREDITS_SPEC.name, config: { url: creditsCompatUrl() } };
  }
  // A copy, not the entry itself: an entry spelled out in `instances` is
  // the saved config's own object, and the switch is not written there.
  for (const [id, on] of Object.entries(cfg.engineSwitches ?? {})) {
    if (map[id] && typeof on === "boolean") map[id] = { ...map[id], enabled: on };
  }
  for (const entry of Object.values(map)) {
    const path = cfg.enginePaths?.[entry.driver];
    const own = entry.config as Record<string, unknown> | undefined;
    if (typeof path === "string" && path && !(typeof own?.cli === "string" && own.cli)) {
      entry.config = { ...own, cli: path };
    }
    entry.environment = {
      ...usableSecrets(cfg.secrets),
      ...Object.fromEntries(
        Object.entries(cfg.providers ?? {})
          .filter(([, v]) => v?.key)
          .map(([kind, v]) => [envVarFor(kind), v.key!]),
      ),
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...entry.environment,
    };
  }
  return map;
}

export function customInstanceId(endpointId: string): string {
  return `custom_${endpointId}`;
}

export function activeCustomKey(endpoint: CustomEndpoint): CustomKey | undefined {
  if (endpoint.activeKeyId) {
    const named = endpoint.keys.find((k) => k.id === endpoint.activeKeyId && k.key);
    if (named) return named;
  }
  return endpoint.keys.find((k) => k.key);
}

/** Whether Bloks credits are offered here: an active Cloud licence (the
 * relay's space tokens are how this machine knows one was activated), or
 * a credits token this host was started with. */
export function creditsOffered(cfg: AppConfig): boolean {
  return Boolean(creditsEnvToken()) || Boolean(cfg.relay?.enabled && cfg.relay.agentToken);
}
