// Where an agent works: this computer, a Docker container, or another
// machine over SSH.
//
// An agent's engine has always been a process on this computer, so its
// commands and file edits touched this computer too. Some people want
// the opposite of that for some agents: a throwaway container that can
// break nothing here, or a build server or a GPU box that has what the
// work needs. Moving the whole workspace (bloks-server) is the answer to
// a different question; this moves one agent's hands.
//
// The engines Bloks drives already talk over stdio, JSON lines in and
// out, so the protocol does not care where the process is. The engine is
// started on the other side with `docker exec -i` or `ssh -T`, and its
// stdin and stdout are carried back unchanged. What does care is
// everything around the protocol: the files a driver writes for the
// engine to read (its persona, its MCP config), the helpers it spawns
// (the approval bridge), the environment its credential rides in, and
// the features that read this computer's folders afterwards (undo,
// rehearsals, file cards). Each of those is handled on purpose:
//
//   Files      travel ahead of the engine on its own stdin, as a short
//              shell preamble the bootstrap below evaluates and then
//              replaces itself with the engine. Nothing lands in argv,
//              which every process on both machines can read.
//   Helpers    stay on this computer. The engine is pointed at them over
//              HTTP, through the gate (server/workplace-gate.ts), which
//              answers only a turn's own token.
//   Bloks      is reached through the same gate: an SSH reverse tunnel,
//              Docker's host address, or with the network off a line of
//              Bloks' own over docker exec (bin/bloks-line.mjs).
//   Undo       works where the files are on this computer (a mounted
//              folder) and is off, and said to be off, everywhere else.
//
// Everything in this file is pure: the shape of a place, the checks a
// saved one passes, and the exact command lines. Running them is in
// server/workplace-run.ts, so the lines can be tested as data.
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";

import { CLI_DRIVERS } from "./agent-cli.ts";
import { ACP_SPECS } from "./drivers/acp.ts";

// ── the shape of a place ───────────────────────────────────────────────

/** A container Bloks makes from an image and looks after: starts it,
 * reuses it, stops it when idle, and can remove it. */
export interface DockerImagePlace {
  kind: "docker";
  source: "image";
  image: string;
  /** The container's name, which is also how the person finds it. */
  name: string;
  /** The agent's folder on this computer mounted in, or copied in once
   * when the container is made. */
  folder: "mount" | "copy";
  /** Where that folder is inside the container. */
  path: string;
  cpus?: number | null;
  memoryGb?: number | null;
  /** Off is no network at all: only Bloks and the engine's own service,
   * carried over docker exec (see LINE_HOSTS). */
  network: boolean;
  /** Stop it after this long without a turn; 0 is never. */
  idleMinutes: number;
  /** Remove it instead of stopping it, so each stretch of work starts in
   * a fresh one. */
  autoRemove: boolean;
  /** The engine's command there, when it is not the one this computer
   * uses. */
  command?: string | null;
}

/** A container the person runs. Bloks only ever execs into it: it never
 * makes, stops or removes one it did not make. */
export interface DockerContainerPlace {
  kind: "docker";
  source: "container";
  name: string;
  path: string;
  command?: string | null;
}

export interface SshPlace {
  kind: "ssh";
  /** A Host from ~/.ssh/config, or user@host. */
  host: string;
  port?: number | null;
  /** The working folder there. `~/` is that side's home. */
  path: string;
  command?: string | null;
}

export type Workplace = DockerImagePlace | DockerContainerPlace | SshPlace;

/** What Bloks learned about a place the last time it looked, kept with
 * the agent under the place's key so a changed place starts unknown. */
export interface WorkplaceSeen {
  key: string;
  home?: string;
  node?: boolean;
  at: number;
  /** Sign-ins the owner chose to copy there, and when. Never done on
   * Bloks' own initiative; see signInCopyPlan. */
  copied?: Array<{ engine: string; files: string[]; at: number }>;
}

// ── limits ─────────────────────────────────────────────────────────────

export const MAX_PATH_CHARS = 1_024;
const MAX_COMMAND_CHARS = 512;
const MAX_IMAGE_CHARS = 255;

/** The default image: Debian with Node, which the agent's command line
 * and the network-off line both need, and npm to install an engine. */
export const DEFAULT_IMAGE = "node:22-bookworm";
export const DEFAULT_CONTAINER_PATH = "/work";
export const DEFAULT_IDLE_MINUTES = 15;

// ── reading a place a client sent ──────────────────────────────────────

const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^\[[0-9A-Fa-f:.]+\]$/;

/** A host as ssh is handed it, or null. Never anything that begins with
 * a dash, which ssh would read as an option (`-oProxyCommand=` runs a
 * command on this computer). */
export function readSshHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim();
  if (!host || host.length > 255 || host.startsWith("-")) return null;
  const at = host.lastIndexOf("@");
  if (at === -1) return ALIAS.test(host) || IPV6.test(host) ? host : null;
  const user = host.slice(0, at);
  const name = host.slice(at + 1);
  if (!USER.test(user)) return null;
  return HOSTNAME.test(name) || IPV6.test(name) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) ? host : null;
}

/** A path on the other side: absolute, or under that side's home. */
function readRemotePath(raw: unknown, allowHome: boolean): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/\/+$/, "") || (raw.trim().startsWith("/") ? "/" : "");
  if (!path || path.length > MAX_PATH_CHARS || /[\0\r\n]/.test(path)) return null;
  if (path.startsWith("/")) return path;
  if (allowHome && (path === "~" || path.startsWith("~/"))) return path;
  return null;
}

function readCommand(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const command = raw.trim();
  if (!command) return null;
  // One program, by name or path. It is quoted as a single word on the
  // other side, so a space would only ever name a file with a space in.
  if (command.length > MAX_COMMAND_CHARS || /[\0\r\n\s]/.test(command) || command.startsWith("-")) return undefined;
  return command;
}

const numberIn = (raw: unknown, min: number, max: number): number | null | undefined => {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
};

export type ReadPlace = { ok: true; place: Workplace | null } | { ok: false; error: string };

/** A place as the settings card sends it, checked whole. Null is this
 * computer. A field that is wrong is refused with what to fix rather
 * than quietly corrected, because a command line built from a guess
 * runs somewhere the person did not mean. */
export function readWorkplace(raw: unknown): ReadPlace {
  if (raw === null || raw === undefined) return { ok: true, place: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "a place is this computer, Docker or SSH" };
  const body = raw as Record<string, unknown>;
  const command = readCommand(body.command);
  if (command === undefined) return { ok: false, error: "the engine command is one program, by name or path, with no spaces" };

  if (body.kind === "ssh") {
    const host = readSshHost(body.host);
    if (!host) return { ok: false, error: "the host is a name from your SSH config or user@host" };
    const port = numberIn(body.port, 1, 65_535);
    if (port === undefined || (port !== null && !Number.isInteger(port))) return { ok: false, error: "the port is a number from 1 to 65535" };
    const path = readRemotePath(body.path ?? "~", true);
    if (!path) return { ok: false, error: "the folder there is a full path, or one under ~/" };
    return { ok: true, place: { kind: "ssh", host, port, path, command } };
  }

  if (body.kind !== "docker") return { ok: false, error: "a place is this computer, Docker or SSH" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!CONTAINER.test(name)) return { ok: false, error: "a container name is letters, digits, dots, dashes and underscores" };
  const path = readRemotePath(body.path ?? DEFAULT_CONTAINER_PATH, false);
  if (!path) return { ok: false, error: "the folder in the container is a full path, like /work" };

  if (body.source === "container") return { ok: true, place: { kind: "docker", source: "container", name, path, command } };
  if (body.source !== "image") return { ok: false, error: "Docker is an image Bloks runs, or a container you run" };

  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image || image.length > MAX_IMAGE_CHARS || !IMAGE.test(image)) return { ok: false, error: "the image is a name like node:22 or ghcr.io/you/tools" };
  const folder = body.folder === "copy" ? "copy" : body.folder === "mount" || body.folder === undefined ? "mount" : null;
  if (!folder) return { ok: false, error: "the working folder is mounted or copied" };
  if (path === "/") return { ok: false, error: "the folder in the container cannot be its root" };
  const cpus = numberIn(body.cpus, 0.1, 256);
  if (cpus === undefined) return { ok: false, error: "CPUs is a number from 0.1 to 256" };
  const memoryGb = numberIn(body.memoryGb, 0.25, 2_048);
  if (memoryGb === undefined) return { ok: false, error: "memory is a number of GB from 0.25" };
  const idle = numberIn(body.idleMinutes ?? DEFAULT_IDLE_MINUTES, 0, 7 * 24 * 60);
  if (idle === undefined || idle === null || !Number.isInteger(idle)) return { ok: false, error: "the idle stop is a whole number of minutes" };
  return {
    ok: true,
    place: {
      kind: "docker",
      source: "image",
      image,
      name,
      folder,
      path,
      cpus,
      memoryGb,
      network: body.network !== false,
      idleMinutes: idle,
      autoRemove: body.autoRemove === true,
      command,
    },
  };
}

/** Docker cannot bind-mount a folder whose path has these in it: `-v`
 * splits on the colon and `--mount` on the comma. Said rather than
 * mangled. */
export function mountRefusal(localFolder: string): string | null {
  if (/[:,]/.test(localFolder)) return `Docker cannot mount ${localFolder}: its path has a colon or a comma in it. Copy the folder in instead, or move it.`;
  return null;
}

// ── naming ─────────────────────────────────────────────────────────────

/** Which place this is, for what is kept about it. Two settings that
 * would land the agent in the same container or on the same host and
 * folder have the same key; anything that moves it changes the key. */
export function placeKey(place: Workplace): string {
  if (place.kind === "ssh") return `ssh:${place.host}:${place.port ?? 22}`;
  return `docker:${place.source}:${place.name}`;
}

/** The session's own place: the key and the folder, which together are
 * where an engine's session file lives. A lane on another one starts a
 * new session (see moveTaskPlace in server/store.ts). */
export function laneWhere(place: Workplace): string {
  return `${placeKey(place)}:${place.path}`;
}

/** How a place is named in a sentence: "container bloks-scout",
 * "build-box". */
export function placeLabel(place: Workplace): string {
  if (place.kind === "ssh") return place.host.includes("@") ? place.host.slice(place.host.lastIndexOf("@") + 1) : place.host;
  return `container ${place.name}`;
}

/** Where it is, as a whole phrase: "in container bloks-scout",
 * "on build-box over SSH". */
export function placePhrase(place: Workplace): string {
  return place.kind === "ssh" ? `on ${placeLabel(place)} over SSH` : `in ${placeLabel(place)}`;
}

/** A first container name for an agent: bloks- and its name, made safe,
 * and numbered past any another agent already has. */
export function containerNameFor(agentName: string, taken: Iterable<string> = []): string {
  const stem = agentName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
  const used = new Set(taken);
  let name = `bloks-${stem}`;
  for (let n = 2; used.has(name); n++) name = `bloks-${stem}-${n}`;
  return name;
}

/** An engine that runs a program, by the program's own name, for a
 * sentence about installing or signing in to it there. */
export function programName(driverKind: string, fallback: string): string {
  if (driverKind === "claudeAgent") return "Claude Code";
  if (driverKind === "codex") return "Codex";
  if (driverKind === "antigravity") return "Antigravity";
  return ACP_SPECS.find((s) => s.kind === driverKind)?.name ?? fallback;
}

/** The command an engine runs by when nothing says otherwise, as each
 * driver's own default (decodeConfig). */
export function defaultCli(driverKind: string): string {
  if (driverKind === "claudeAgent") return "claude";
  if (driverKind === "codex") return "codex";
  if (driverKind === "antigravity") return "agy";
  return ACP_SPECS.find((s) => s.kind === driverKind)?.command ?? driverKind;
}

/** The engine's command on the other side: the person's own, or the name
 * this computer runs it by, without the folder this computer keeps it in
 * (a path here means nothing there) or the Windows suffix. */
export function remoteCommand(place: Workplace, localCli: string): string {
  if (place.command) return place.command;
  return basename(localCli.replace(/\\/g, "/")).replace(/\.(cmd|exe|bat)$/i, "") || localCli;
}

// ── which engines can work elsewhere ───────────────────────────────────

export type Support = { ok: true } | { ok: false; why: string };

/** Whether this engine runs a program of its own that can be started on
 * the other side: the ones the agent's credential is minted for
 * (CLI_DRIVERS), and every agent that speaks ACP, Gemini CLI among them,
 * which gets no credential but is a program all the same. Named, not
 * inferred, so a driver added later works only here until somebody has
 * decided it can work elsewhere. */
export function runsThere(driverKind: string): boolean {
  return CLI_DRIVERS.has(driverKind) || ACP_SPECS.some((spec) => spec.kind === driverKind);
}

/** Whether this engine can run on the other side, and if not, why. The
 * engines that run a process of their own speak stdio, which is what
 * crosses; the rest have no process to move. */
export function placeSupport(driverKind: string, engineName = "This engine"): Support {
  if (runsThere(driverKind)) return { ok: true };
  if (driverKind === "boxAgent") return { ok: false, why: `${engineName} already works on its own cloud computer, so there is nothing here to move.` };
  return {
    ok: false,
    why: `${engineName} answers over the internet from Bloks itself and runs no program of its own, so there is nothing to move. Choose an engine that runs a program, like Claude Code or Codex, to work in a container or over SSH.`,
  };
}

/** The hosts each engine's own service answers on, which is all a
 * container with its network off may reach besides Bloks. An engine whose
 * hosts depend on how the person set it up has none here, and cannot
 * work with the network off: there is no way to say what to let through. */
export const LINE_HOSTS: Record<string, readonly string[] | null> = {
  claudeAgent: ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai", "statsig.anthropic.com"],
  codex: ["api.openai.com", "chatgpt.com", "auth.openai.com"],
  geminiCli: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
  antigravity: ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com", "oauth2.googleapis.com", "www.googleapis.com"],
  grokCli: ["api.x.ai", "grok.com", "accounts.x.ai", "auth.x.ai"],
  opencode: null,
  pi: null,
};

/** Whether this engine can work with the container's network off. */
export function networkOffSupport(driverKind: string, engineName = "This engine"): Support {
  const hosts = LINE_HOSTS[driverKind];
  if (hosts) return { ok: true };
  return { ok: false, why: `${engineName} talks to whichever providers it is set up with, so Bloks cannot tell which to let through with the network off.` };
}

// ── what a turn's environment may carry over ───────────────────────────

/** Engine credentials and workspace keys. Never shipped, wherever they
 * came from: the engine signs in on its own side, and a workspace key
 * (Composio's, the box token) is used by Bloks' own helpers, which stay
 * here and are reached through the gate. */
const NEVER_SHIPPED = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "WINDSURF_API_KEY",
  "BLOKS_COMPOSIO_KEY",
  "BLOKS_COMPOSIO_URL",
  "BLOKS_BOX_TOKEN",
  "BLOKS_BOX_ID",
  "ELECTRON_RUN_AS_NODE",
]);

/** The driver's own switches for its engine, which mean the same thing
 * there as here. Anything else the driver's environment holds is this
 * computer's (PATH, HOME, every variable the person's shell exports),
 * and stays here. */
const SWITCHES = /^(?:CLAUDE_CODE_[A-Z0-9_]+|ENABLE_CLAUDEAI_MCP_SERVERS|NPM_CONFIG_LOGLEVEL|MAX_THINKING_TOKENS)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What goes to the other side's environment: the turn's own (its token,
 * the CLI's address there, the secrets the owner saved for agents), and
 * the driver's switches where it set one. Never an engine credential or
 * a workspace key, and never this computer's own environment.
 */
export function shippedEnv(
  turnEnv: Record<string, string>,
  driverEnv: Record<string, string | undefined> | undefined,
  base: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(turnEnv)) {
    if (ENV_NAME.test(name) && typeof value === "string" && !NEVER_SHIPPED.has(name)) out[name] = value;
  }
  for (const [name, value] of Object.entries(driverEnv ?? {})) {
    if (typeof value !== "string" || !SWITCHES.test(name) || NEVER_SHIPPED.has(name)) continue;
    if (name in turnEnv) continue;
    if (base[name] !== value) out[name] = value;
  }
  return out;
}

// ── shell words ────────────────────────────────────────────────────────

/** One word for a POSIX shell, whatever it holds. */
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A path for the other side's shell, with `~` as its home. */
export function remoteWord(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

/** Folders an installer usually leaves an engine in, which a shell that
 * ssh or docker exec starts does not always have on its PATH. Read on the
 * other side, so `$HOME` is that side's. */
const WIDEN_PATH =
  'P=; for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && P="$d"; done; ' +
  'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:/usr/local/bin${P:+:$P}:$PATH"; export PATH';

/**
 * The program that runs first on the other side, as one line (a remote
 * login shell may be csh, which will not take a quoted newline).
 *
 * It reads a preamble from its own stdin up to a line that is this run's
 * sentinel, evaluates it, and then becomes the engine, which inherits
 * the same stdin from exactly the byte after. POSIX `read` takes a pipe a
 * byte at a time, so nothing of the engine's input is swallowed. The
 * sentinel is random per run: a line in a persona or a memory note that
 * happened to match it would otherwise end the preamble early.
 *
 * `$1` is the sentinel; the engine and its arguments follow.
 */
export const BOOTSTRAP =
  'umask 077; g=$1; shift; nl=$(printf "\\nx"); nl=${nl%x}; b=; ' +
  'while IFS= read -r l; do [ "$l" = "$g" ] && break; b="$b$l$nl"; done; ' +
  'eval "$b"; exec "$@"';

/** A fresh run: its id, and the sentinel its preamble ends on. */
export function newRun(): { id: string; sentinel: string } {
  return { id: randomBytes(9).toString("base64url"), sentinel: `__bloks_go_${randomBytes(12).toString("hex")}__` };
}

/** Where a run keeps its files on the other side. */
export const runDir = (home: string, runId: string) => `${home.replace(/\/+$/, "")}/.bloks/run/${runId}`;

/** Where a lane's deliverables wait to be brought back after its turn. */
export const outboxDir = (home: string, laneId: string) => `${home.replace(/\/+$/, "")}/.bloks/outbox/${laneId}`;

export interface Preamble {
  /** This process's own mark in its environment (BLOKS_RUN), which the
   * reaper checks before it ends a pid. */
  tag: string;
  run: string;
  sentinel: string;
  files: Array<{ path: string; content: string }>;
  env: Record<string, string>;
  /** Folders to have there before the engine starts. */
  folders: string[];
  cwd: string;
}

/**
 * The shell the bootstrap evaluates, sentinel included. Generated here,
 * never from anything a person or an agent wrote except as quoted data:
 * every value goes through shQuote, every name is checked.
 */
export function preambleText(p: Preamble): string {
  const lines: string[] = [];
  lines.push(`R=${shQuote(p.run)}; mkdir -p "$R" || { echo "Bloks: could not make $R" >&2; exit 96; }`);
  lines.push(`echo $$ > "$R/${pidFile(p.tag)}"`);
  for (const file of p.files) {
    lines.push(`printf '%s' ${shQuote(file.content)} > ${shQuote(file.path)} || exit 96`);
  }
  for (const [name, value] of Object.entries(p.env)) {
    if (!ENV_NAME.test(name)) continue;
    lines.push(`export ${name}=${shQuote(value)}`);
  }
  lines.push(`export BLOKS_RUN=${shQuote(p.tag)}`);
  // the nesting markers would tell the engine it is inside another session
  lines.push("unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT");
  lines.push(WIDEN_PATH);
  for (const folder of p.folders) lines.push(`mkdir -p ${remoteWord(folder)} 2>/dev/null`);
  const cwd = remoteWord(p.cwd);
  lines.push(
    `cd ${cwd} 2>/dev/null || { mkdir -p ${cwd} 2>/dev/null && cd ${cwd}; } || { echo ${shQuote(`Bloks: there is no folder ${p.cwd} here, and it could not be made.`)} >&2; exit 97; }`,
  );
  lines.push(p.sentinel);
  return lines.join("\n") + "\n";
}

/** The argv after `sh -c` on the other side: the bootstrap, a name for
 * $0, the sentinel, then the engine. */
export function bootstrapArgv(sentinel: string, command: string, args: readonly string[]): string[] {
  return ["sh", "-c", BOOTSTRAP, "bloks", sentinel, command, ...args];
}

/**
 * What ends a run on the other side once its connection here has gone:
 * the engine by the pid its bootstrap wrote, its process group with it
 * where it leads one (an SSH session does), and the run's folder. Where
 * /proc can say whose a pid is, it must still be this run's, so a pid
 * the system has since handed to something else is left alone.
 */
export function reaperScript(run: string, tag: string, removeRun: boolean): string {
  const mine = `tr '\\000' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx ${shQuote(`BLOKS_RUN=${tag}`)}`;
  return [
    `R=${shQuote(run)}`,
    `p=$(cat "$R/${pidFile(tag)}" 2>/dev/null)`,
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && { [ ! -d /proc/$p ] || ${mine}; }; then ` +
      `kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 1; ` +
      `kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null; fi`,
    removeRun ? `rm -rf "$R"` : "true",
  ].join("; ");
}

/** The file a process's pid is kept in, inside its run's folder. */
const pidFile = (tag: string) => `pid-${tag.replace(/[^A-Za-z0-9_-]/g, "")}`;

// ── docker command lines ───────────────────────────────────────────────

/** The labels on a container Bloks made, which is the only kind it will
 * ever stop or remove. */
export const AGENT_LABEL = "dev.bloks.agent";
export const SPEC_LABEL = "dev.bloks.spec";

/** The idle process a made container keeps running between turns. A
 * container with nothing running is a container Docker considers done. */
const IDLE = "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done";

/** Everything a made container is made from, so a changed setting can
 * be noticed on the container itself and it made again. */
export function containerSpec(place: DockerImagePlace, localFolder: string): string {
  const spec = {
    image: place.image,
    folder: place.folder,
    path: place.path,
    cpus: place.cpus ?? null,
    memoryGb: place.memoryGb ?? null,
    network: place.network,
    from: place.folder === "mount" ? localFolder : null,
  };
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 16);
}

/** `docker run`, for a container made from an image. */
export function dockerRunArgs(place: DockerImagePlace, botId: string, localFolder: string): string[] {
  const args = [
    "run",
    "--detach",
    "--name", place.name,
    "--label", `${AGENT_LABEL}=${botId}`,
    "--label", `${SPEC_LABEL}=${containerSpec(place, localFolder)}`,
    "--workdir", place.path,
  ];
  // With the network on, Bloks is at the host's own address; Docker on
  // Linux needs to be told that name, Docker Desktop already knows it.
  // Off is no network at all, and Bloks comes over docker exec instead.
  if (place.network) args.push("--add-host", "host.docker.internal:host-gateway");
  else args.push("--network", "none");
  if (place.cpus) args.push("--cpus", String(place.cpus));
  if (place.memoryGb) args.push("--memory", `${Math.round(place.memoryGb * 1024)}m`);
  if (place.folder === "mount") args.push("--volume", `${localFolder}:${place.path}`);
  args.push("--entrypoint", "sh", place.image, "-c", IDLE);
  return args;
}

/** `docker exec -i`, for the engine or anything else that runs there. */
export function dockerExecArgs(container: string, argv: readonly string[]): string[] {
  return ["exec", "-i", container, ...argv];
}

// ── ssh command lines ──────────────────────────────────────────────────

/** Options every ssh Bloks runs carries. Keys only, never a password
 * prompt there is nobody to answer; a host key it does not know is a
 * refusal, not a question; and a link that has gone quiet is noticed
 * within a minute rather than held open forever. */
const SSH_OPTIONS = [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];

/** `ssh`, with an optional reverse tunnel from the other side's loopback
 * to Bloks' gate here. The remote command is a single string, which the
 * other side's shell splits, so every word in it is quoted. */
export function sshArgs(place: SshPlace, argv: readonly string[], tunnel?: { remotePort: number; gateHost: string; gatePort: number }): string[] {
  const args = [...SSH_OPTIONS];
  if (place.port) args.push("-p", String(place.port));
  if (tunnel) {
    args.push("-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${tunnel.remotePort}:${tunnel.gateHost}:${tunnel.gatePort}`);
  }
  args.push("--", place.host, argv.map(shQuote).join(" "));
  return args;
}

/** What ssh says when it could not get there at all, as what to do. */
export function sshProblem(stderr: string, place: SshPlace): string {
  const where = placeLabel(place);
  const said = stderr.trim();
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(said)) {
    return `This computer does not know ${where}'s host key yet, or it has changed. Connect once with ssh ${place.host} in Terminal to check and accept it.`;
  }
  if (/Permission denied|Too many authentication failures/i.test(said)) {
    return `${where} refused the sign-in. Bloks signs in with SSH keys only: add your key there (ssh-copy-id ${place.host}) or load it into ssh-agent.`;
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(said)) {
    return `Bloks could not find ${where}. Check the name, or the Host entry in ~/.ssh/config.`;
  }
  if (/Connection refused/i.test(said)) return `${where} refused the connection on port ${place.port ?? 22}.`;
  if (/timed out|Operation timed out|No route to host|Network is unreachable/i.test(said)) {
    return `${where} did not answer on port ${place.port ?? 22}.`;
  }
  if (/remote port forwarding failed/i.test(said)) {
    return `${where} would not open the tunnel back to Bloks. Its sshd may have AllowTcpForwarding off, or the port was taken; try again.`;
  }
  const line = said.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 240);
  return line ? `Could not reach ${where} over SSH: ${line}` : `Could not reach ${where} over SSH.`;
}

/** Host names from an ssh config's Host lines: patterns and negations
 * left out, since a name to pick has to be one ssh can connect to. */
export function sshConfigHosts(text: string): string[] {
  const hosts = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const name of match[1].split(/\s+/)) {
      if (!name || /[*?!]/.test(name)) continue;
      if (readSshHost(name)) hosts.add(name);
    }
  }
  return [...hosts].slice(0, 200);
}

// ── looking at the other side ──────────────────────────────────────────

export interface ProbeAsk {
  /** The engine's command there. */
  command: string;
  /** Skip `--version`, for an engine whose --version starts a session. */
  noVersion?: boolean;
  folder: string;
  /** Sign-in checks, as this engine is asked about them. */
  signIn: "claude" | "codex" | { files: readonly string[]; env: readonly string[] } | null;
  /** Bloks' gate, as that side reaches it, to see that it does. */
  bloksUrl?: string;
}

/** One shell line that looks at everything a turn there would need and
 * says it as `name=value` lines. Read-only, apart from tidying away run
 * folders a crash left behind. */
export function probeScript(ask: ProbeAsk): string {
  const c = shQuote(ask.command);
  const parts = [
    `printf 'home=%s\\n' "$HOME"`,
    WIDEN_PATH,
    `c=$(command -v ${c} 2>/dev/null); printf 'engine=%s\\n' "$c"`,
    ...(ask.noVersion ? [] : [`[ -n "$c" ] && printf 'version=%s\\n' "$("$c" --version 2>/dev/null | head -n 1)"`]),
    `n=$(command -v node 2>/dev/null); printf 'node=%s\\n' "$n"`,
    `[ -n "$n" ] && printf 'nodeVersion=%s\\n' "$(node --version 2>/dev/null)"`,
    `printf 'tar=%s\\n' "$(command -v tar 2>/dev/null)"`,
    `f=${remoteWord(ask.folder)}; if [ -d "$f" ]; then echo folder=ok; elif [ -e "$f" ]; then echo folder=file; else echo folder=missing; fi`,
  ];
  if (ask.signIn === "claude") {
    parts.push(`[ -n "$c" ] && printf 'auth=%s\\n' "$("$c" auth status 2>/dev/null | tr -d '\\n')"`);
    parts.push(`[ -f "$HOME/.claude/.credentials.json" ] && echo authFile=yes`);
  } else if (ask.signIn === "codex") {
    parts.push(`[ -n "$c" ] && { "$c" login status >/dev/null 2>&1 && echo signedIn=yes || echo signedIn=no; }`);
    parts.push(`[ -f "\${CODEX_HOME:-$HOME/.codex}/auth.json" ] && echo authFile=yes`);
  } else if (ask.signIn) {
    for (const file of ask.signIn.files) parts.push(`[ -f "$HOME"/${shQuote(file)} ] && echo authFile=yes`);
    for (const name of ask.signIn.env) if (ENV_NAME.test(name)) parts.push(`[ -n "\${${name}:-}" ] && echo authEnv=yes`);
  }
  if (ask.bloksUrl) {
    const u = shQuote(`${ask.bloksUrl}/api/gate/ping`);
    parts.push(
      `if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 ${u} >/dev/null 2>&1 && echo bloks=yes || echo bloks=no; ` +
        `elif command -v wget >/dev/null 2>&1; then wget -q -T 5 -O /dev/null ${u} >/dev/null 2>&1 && echo bloks=yes || echo bloks=no; ` +
        `elif [ -n "$n" ]; then node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' ${u} && echo bloks=yes || echo bloks=no; ` +
        `else echo bloks=unknown; fi`,
    );
  }
  parts.push(`find "$HOME/.bloks/run" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null`);
  parts.push("true");
  return parts.join("; ");
}

export interface Probe {
  home: string;
  engine: string;
  version: string;
  node: string;
  nodeVersion: string;
  tar: string;
  folder: "ok" | "file" | "missing" | "";
  auth: string;
  authFile: boolean;
  authEnv: boolean;
  signedIn: "yes" | "no" | "";
  bloks: "yes" | "no" | "unknown" | "";
}

export function readProbe(stdout: string): Probe {
  const seen = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at);
    if (!seen.has(name) || name === "authFile" || name === "authEnv") seen.set(name, line.slice(at + 1).trim());
  }
  const get = (name: string) => seen.get(name) ?? "";
  return {
    home: get("home"),
    engine: get("engine"),
    version: get("version").slice(0, 120),
    node: get("node"),
    nodeVersion: get("nodeVersion").slice(0, 40),
    tar: get("tar"),
    folder: (["ok", "file", "missing"].includes(get("folder")) ? get("folder") : "") as Probe["folder"],
    auth: get("auth").slice(0, 2_000),
    authFile: get("authFile") === "yes",
    authEnv: get("authEnv") === "yes",
    signedIn: (["yes", "no"].includes(get("signedIn")) ? get("signedIn") : "") as Probe["signedIn"],
    bloks: (["yes", "no", "unknown"].includes(get("bloks")) ? get("bloks") : "") as Probe["bloks"],
  };
}

/** The sign-in check this engine has, for probeScript. */
export function signInAsk(driverKind: string): ProbeAsk["signIn"] {
  if (driverKind === "claudeAgent") return "claude";
  if (driverKind === "codex") return "codex";
  const spec = ACP_SPECS.find((s) => s.kind === driverKind);
  if (spec) return { files: spec.authFiles ?? [], env: spec.keyEnv ?? [] };
  return null;
}

/** Whether the engine is signed in there: yes, no, or not something
 * Bloks can tell for this engine. */
export function signedInThere(driverKind: string, probe: Probe): boolean | null {
  if (!probe.engine) return null;
  if (driverKind === "claudeAgent") {
    try {
      const { loggedIn } = JSON.parse(probe.auth) as { loggedIn?: unknown };
      if (typeof loggedIn === "boolean") return loggedIn;
    } catch {
      /* an older CLI; the file is the fallback, as it is here */
    }
    return probe.authFile;
  }
  if (driverKind === "codex") return probe.signedIn === "yes" || (probe.signedIn === "" && probe.authFile);
  const spec = ACP_SPECS.find((s) => s.kind === driverKind);
  if (spec) {
    if (probe.authFile || probe.authEnv) return true;
    return spec.signInOptional ? true : (spec.authFiles?.length ?? 0) > 0 ? false : null;
  }
  return null;
}

/** Whether a probe's engine can skip `--version` (pi-acp starts a
 * session on it and never returns). */
export function noVersionProbe(driverKind: string): boolean {
  return Boolean(ACP_SPECS.find((s) => s.kind === driverKind)?.probePath);
}

// ── the Test button's answer ───────────────────────────────────────────

export interface Check {
  id: "reach" | "folder" | "engine" | "signedIn" | "node" | "bloks" | "tar";
  /** null is a check that could not be made. */
  ok: boolean | null;
  label: string;
}

export interface TestReport {
  ok: boolean;
  checks: Check[];
  /** What is missing, each as one sentence that says what to do. */
  problems: string[];
  /** How to sign in there, when that is what is missing. */
  signIn?: { command: string };
  /** A sign-in from this computer that could be copied, on consent. */
  canCopySignIn?: boolean;
  home?: string;
  node?: boolean;
}

/** The engine's own sign-in command, for "Sign in there". */
const SIGN_IN_COMMANDS: Record<string, string> = {
  claudeAgent: "claude",
  codex: "codex login",
  geminiCli: "gemini",
  grokCli: "grok login",
  opencode: "opencode auth login",
  devin: "devin auth login",
  pi: "pi",
  antigravity: "agy",
};

/** How to open an interactive shell there with one command running. */
export function interactiveCommand(place: Workplace, command: string): string {
  if (place.kind === "ssh") return `ssh -t${place.port ? ` -p ${place.port}` : ""} ${place.host} ${shQuote(command)}`;
  return `docker exec -it ${place.name} sh -lc ${shQuote(command)}`;
}

/** The sign-in command for this engine on that side, as one line to
 * run in Terminal here, or null when the engine signs in some other way. */
export function signInThereCommand(place: Workplace, driverKind: string, command: string): string | null {
  const own = SIGN_IN_COMMANDS[driverKind];
  if (!own) return null;
  const name = own.split(" ")[0];
  const run = name === command ? own : [command, ...own.split(" ").slice(1)].join(" ");
  return interactiveCommand(place, run);
}

/** How each engine installs, as one line to run on the other side. The
 * same installers the app runs here (server/engine-setup.ts), each as a
 * single command a person can read. */
export function installFor(driverKind: string): string | undefined {
  if (driverKind === "claudeAgent") return "curl -fsSL https://claude.ai/install.sh | bash";
  if (driverKind === "codex") return "npm i -g --prefix ~/.local @openai/codex";
  if (driverKind === "antigravity") return "curl -fsSL https://antigravity.google/cli/install.sh | bash";
  return ACP_SPECS.find((s) => s.kind === driverKind)?.install;
}

/** The install command for this engine, run there. */
export function installThereCommand(place: Workplace, install: string | undefined): string | null {
  if (!install) return null;
  return interactiveCommand(place, install);
}

/** Puts a probe into checks and sentences. */
export function testReport(input: {
  place: Workplace;
  driverKind: string;
  engineName: string;
  command: string;
  probe: Probe;
  install?: string;
  /** Whether this computer holds a sign-in file for the engine. */
  localSignIn: boolean;
  /** How Bloks will be reached, so a failed check names the right way. */
  line: "tunnel" | "host" | "line";
}): TestReport {
  const { place, probe, engineName } = input;
  const where = placeLabel(place);
  const checks: Check[] = [{ id: "reach", ok: true, label: place.kind === "ssh" ? `Reached ${where}` : `${where.replace(/^container/, "Container")} is running` }];
  const problems: string[] = [];
  const report: TestReport = { ok: true, checks, problems, home: probe.home || undefined, node: Boolean(probe.node) };

  if (probe.folder === "ok") checks.push({ id: "folder", ok: true, label: `${place.path} is there` });
  else if (probe.folder === "file") {
    checks.push({ id: "folder", ok: false, label: `${place.path} is a file` });
    problems.push(`${place.path} on ${where} is a file, not a folder. Choose another folder.`);
  } else checks.push({ id: "folder", ok: true, label: `${place.path} is made on the first turn` });

  if (!probe.engine) {
    checks.push({ id: "engine", ok: false, label: `${engineName} is not installed` });
    const install = installThereCommand(place, input.install);
    problems.push(
      `${engineName} is not installed ${placePhrase(place).replace(/ over SSH$/, "")}, or not as ${input.command}.` +
        (install ? ` Install it there: ${install}` : ` Install it there, or set the engine command to where it is.`),
    );
  } else {
    // "2.1.299 (Claude Code)" names the engine twice beside its name
    const version = probe.version.replace(/\s*\([^)]*\)\s*$/, "");
    checks.push({ id: "engine", ok: true, label: version ? `${engineName} ${version}` : `${engineName} is installed` });
    const signed = signedInThere(input.driverKind, probe);
    if (signed === false) {
      checks.push({ id: "signedIn", ok: false, label: "Not signed in there" });
      const command = signInThereCommand(place, input.driverKind, input.command);
      if (command) report.signIn = { command };
      report.canCopySignIn = input.localSignIn;
      problems.push(
        `${engineName} is installed ${placePhrase(place).replace(/ over SSH$/, "")} but not signed in. Sign in there${command ? ` (${command})` : ""}${input.localSignIn ? ", or copy your sign-in from this computer" : ""}.`,
      );
    } else if (signed === true) checks.push({ id: "signedIn", ok: true, label: "Signed in there" });
    else checks.push({ id: "signedIn", ok: null, label: "Sign-in is checked on the first message" });
  }

  if (probe.node) checks.push({ id: "node", ok: true, label: `Node ${probe.nodeVersion || "is installed"}` });
  else {
    checks.push({ id: "node", ok: input.line === "line" ? false : null, label: "No Node there" });
    problems.push(
      input.line === "line"
        ? `Node is not ${placePhrase(place).replace(/ over SSH$/, "")}. With the network off, Bloks reaches the container through a small Node program, so it needs Node. Use an image with Node, like ${DEFAULT_IMAGE}, or turn the network on.`
        : `Node is not ${placePhrase(place).replace(/ over SSH$/, "")}, so the agent's bloks command cannot run there. Replies, approvals and file cards still work.`,
    );
  }

  if (!probe.tar) {
    checks.push({ id: "tar", ok: false, label: "No tar there" });
    problems.push(`tar is not ${placePhrase(place).replace(/ over SSH$/, "")}, so files the agent makes there cannot be brought back as cards.`);
  }

  if (probe.bloks === "yes") checks.push({ id: "bloks", ok: true, label: "Reaches Bloks" });
  else if (probe.bloks === "no") {
    checks.push({ id: "bloks", ok: false, label: "Cannot reach Bloks" });
    problems.push(
      input.line === "tunnel"
        ? `${where} could not reach Bloks through the tunnel. Its sshd may have AllowTcpForwarding off.`
        : `The container could not reach Bloks at host.docker.internal. Docker on this computer may not offer that address; approvals and the bloks command will not work until it does.`,
    );
  } else if (input.line !== "line") checks.push({ id: "bloks", ok: null, label: "Could not check the way back to Bloks (no curl, wget or Node)" });

  report.ok = checks.every((check) => check.ok !== false);
  return report;
}

// ── copying a sign-in, only when asked ─────────────────────────────────

/** The files an engine keeps its sign-in in, under a home. */
export function signInFiles(driverKind: string): string[] {
  if (driverKind === "claudeAgent") return [".claude/.credentials.json"];
  if (driverKind === "codex") return [".codex/auth.json"];
  return [...(ACP_SPECS.find((s) => s.kind === driverKind)?.authFiles ?? [])];
}

export interface CopyPlan {
  engine: string;
  /** From this computer, as ~/..., to that side, in full. */
  files: Array<{ from: string; to: string; bytes: number }>;
  where: string;
  /** What the consent card reads, word for word. */
  says: string;
  fingerprint: string;
}

/** The plan a consent card shows and a copy must match exactly: which
 * files, from where to where, and how big, so nothing is copied that the
 * person was not shown. */
export function copyPlan(input: { place: Workplace; driverKind: string; engineName: string; home: string; found: Array<{ rel: string; bytes: number }> }): CopyPlan {
  const where = placeLabel(input.place);
  const files = input.found.map((file) => ({ from: `~/${file.rel}`, to: `${input.home.replace(/\/+$/, "")}/${file.rel}`, bytes: file.bytes }));
  const says =
    `Bloks will copy ${files.map((f) => f.from).join(" and ")} from this computer to ${files.map((f) => f.to).join(" and ")} ${placePhrase(input.place)}. ` +
    `That is your ${input.engineName} sign-in: anyone who can use ${where} can then use it as you. ` +
    `Nothing else is copied, and nothing is copied again unless you ask. Signing in there yourself keeps this computer's sign-in here.`;
  const fingerprint = createHash("sha256").update(JSON.stringify({ engine: input.driverKind, key: placeKey(input.place), files })).digest("hex").slice(0, 24);
  return { engine: input.driverKind, files, where, says, fingerprint };
}

// ── status ─────────────────────────────────────────────────────────────

export type PlaceState = "idle" | "starting" | "ready" | "working" | "stopped" | "removed" | "dropped" | "reconnecting" | "unreachable";

export interface PlaceStatus {
  kind: Workplace["kind"];
  label: string;
  state: PlaceState;
  /** Why, when the state is a problem. */
  detail?: string;
  at: number;
}
