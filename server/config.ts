// Where settings and data live.
//
// Everything is under ~/.bloks: one config file, the agents, every
// transcript, and the logs. That is the whole storage story, and it is
// deliberate. A person can read it, back it up, move it to another Mac, or
// delete it and be genuinely rid of the app.
//
// Credentials may also arrive from the environment, which is what a
// container or a CI run wants and what lets someone try the app without
// writing a key to disk at all.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { InstanceConfigMap } from "./contracts.ts";
import { CUSTOM_SPEC, PROVIDER_SPECS, specFor } from "./providers.ts";

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
}

export interface AppConfig {
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
  /** Voice vendors. Either key lights up voices and calls. */
  speech?: {
    elevenlabsKey?: string;
    openaiKey?: string;
    /** The user's explicit yes to using a key discovered in the
     * environment or Codex's auth file for voice billing. */
    useDiscoveredOpenAI?: boolean;
  };
  box?: { token?: string };
  /** Keyboard shortcuts the desktop shell registers with the system.
   * Off until somebody sets one: a global hotkey that arrives
   * uninvited will collide with whatever they already use. */
  shortcuts?: { quickAsk?: string | null };
  /** User-added OpenAI-compatible hosts. Same file as the other keys
   * because this is already the secrets file. */
  custom?: CustomEndpoint[];
  /** Reaching agents from a phone over Telegram. The token is a
   * credential, so it lives here with the rest of them. */
  telegram?: {
    token?: string;
    chatIds?: number[];
    botId?: string;
    pairing?: string | null;
    offset?: number;
    enabled?: boolean;
  };
  /** User-registered MCP servers, attachable per agent. Headers and
   * commands live here because this file is already the secrets file. */
  mcpServers?: Array<{
    id: string;
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
  }>;
  /** Values agents asked for via secret cards, injected into engine
   * environments under their env-var names. Never echoed to clients. */
  secrets?: Record<string, string>;
  /** When the one-time welcome was completed. Lives here, beside the
   * agents it describes, because a browser's localStorage is the wrong
   * place to remember whether a WORKSPACE has been set up: clear it, or
   * open the app on a different port, and a returning user is asked to
   * onboard again while a genuinely new one is skipped past it. */
  setupDoneAt?: number;
  /** Shared context every agent receives, not a secret, echoed back to
   * the app so the settings field can prefill. */
  profile?: { about?: string };
  /** How a lane is kept inside the model's window. Off means the fold
   * happens once at a threshold; on means one message is absorbed after
   * each turn instead. See the note in server/context.ts for what that
   * trades: absorbing every turn rewrites history every turn, which
   * breaks the provider's prompt cache prefix every turn. */
  compaction?: { micro?: boolean };
  /** Whether a finished session is read back for something worth keeping.
   * Off unless asked for: it spends the person's own tokens on work they
   * did not request. What it finds is always staged, never installed. */
  skills?: { propose?: boolean };
  /** The outbound line to a relay, so a phone can reach this Mac from
   * outside the house. The token names one space; the relay never holds
   * a key that could read what travels through it. */
  relay?: { url?: string; agentToken?: string; clientToken?: string; enabled?: boolean };
  /** Off unless somebody turned it on. Holds the devices allowed to
   * reach this server from the network (see server/pairing.ts); each
   * one is a name and a token digest, never a token. */
  remote?: { enabled?: boolean; devices?: unknown[] };
  instances?: InstanceConfigMap;
}

export const DATA_DIR = join(homedir(), ".bloks");
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

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {
    /* first run, env fallbacks below */
  }
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
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  // An allowlist, not a spread: this file holds credentials and a request
  // body is not a config file. A section missing from here is a section
  // that silently will not save, which is what happened the first time
  // compaction was added without it.
  for (const key of [
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
    "telegram",
  ] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  if (Array.isArray((patch as Record<string, unknown>).mcpServers)) {
    disk.mcpServers = (patch as Record<string, unknown>).mcpServers;
  }
  if (Array.isArray((patch as Record<string, unknown>).custom)) {
    disk.custom = (patch as Record<string, unknown>).custom;
  }
  if (typeof (patch as Record<string, unknown>).setupDoneAt === "number") {
    disk.setupDoneAt = (patch as Record<string, unknown>).setupDoneAt;
  }
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  // this file holds API keys in plaintext, never leave it group/world
  // readable (mode on write only applies to a fresh file, so chmod too)
  writeFileSync(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* non-POSIX filesystem, best effort */
  }
}

/** Forgets a provider's credential entirely, rather than blanking it. */
export function disconnectProvider(kind: string): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, any> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return;
  }
  if (disk.providers) delete disk.providers[kind];
  // the legacy slot is the same credential under an older name
  if (kind === "grok") delete disk.xai;
  writeFileSync(p, JSON.stringify(disk, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* non-POSIX filesystem, best effort */
  }
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
  grok_cli: { driver: "grokCli" },
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
  // change rather than a new engine in the picker.
  for (const endpoint of cfg.custom ?? []) {
    const cred = activeCustomKey(endpoint);
    if (!endpoint.url || !cred?.key) continue;
    map[customInstanceId(endpoint.id)] = {
      driver: CUSTOM_SPEC.kind,
      displayName: endpoint.name,
      config: { url: endpoint.url },
      environment: { [envVarFor(CUSTOM_SPEC.kind)]: cred.key },
    };
  }
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...cfg.secrets,
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
