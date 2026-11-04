// Whether a stdio MCP server's command is there to run.
//
// A server is handed to the engine as written, and an engine that cannot
// start one says nothing: the agent works the turn without those tools
// and nobody hears why. So the command is looked for here first, when it
// is saved, when the list is read, and when a turn is handed its
// servers, and one that is plainly not on this computer is said, in
// Settings and in the chat, instead of left to fail in silence.
//
// Looked for, never run: running it would be running whatever it is.
// And the look is bounded. A path on a network volume that has gone
// away, or a folder macOS asks the person about first, must not hold a
// turn up, so a look that takes too long, or fails in any way other than
// "nothing is there", counts as found. Only a clear absence is reported.
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/** About as long as a person would wait on a list of servers. */
export const COMMAND_CHECK_MS = 2_000;
/** How long one answer is kept, so a list read twice, or every turn of
 * a busy agent, does not walk PATH each time. */
const REMEMBER_MS = 15_000;

/** What one file on disk is, as far as running it goes. */
export type Probe = "runnable" | "absent" | "unknown";

export interface CommandCheck {
  /** PATH and PATHEXT as the engine will have them. */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string;
  timeoutMs?: number;
  /** Stands in for the disk in a test. */
  probe?: (file: string, windows: boolean) => Promise<Probe>;
}

/** `~/bin/tool` as the absolute path it means. Nothing spawns through a
 * shell, so nobody else expands it; handing the engine the expanded path
 * means what is checked is what runs. */
export function expandHome(command: string, home = homedir()): string {
  return command === "~" || command.startsWith("~/") || command.startsWith("~\\") ? join(home, command.slice(1)) : command;
}

/** A command as Settings names it: the program, without its arguments,
 * with the home folder as ~ so a path does not spell out the account. */
export function shownCommand(command: string, home = homedir()): string {
  return home && (command === home || command.startsWith(`${home}/`) || command.startsWith(`${home}\\`))
    ? `~${command.slice(home.length)}`
    : command;
}

async function probeDisk(file: string, windows: boolean): Promise<Probe> {
  try {
    if (!(await stat(file)).isFile()) return "absent";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
  // Windows has no execute bit; what makes a file runnable is its
  // extension, which the caller has already chosen by PATHEXT
  if (windows) return "runnable";
  try {
    await access(file, constants.X_OK);
    return "runnable";
  } catch (error) {
    // the file is there (stat said so), so this is the file's own mode
    return (error as NodeJS.ErrnoException).code === "EACCES" ? "absent" : "unknown";
  }
}

/** An environment variable the way the platform reads its name: Windows
 * has `Path` as often as `PATH`. */
function envValue(env: Record<string, string | undefined>, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/** The files `command` could be, in the order a launch would try them. */
function candidates(command: string, env: Record<string, string | undefined>, windows: boolean): string[] | null {
  const exts = windows
    ? (envValue(env, "PATHEXT", windows) || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())
    : [];
  // on Windows a name runs as given only when it already has a runnable
  // extension, and otherwise with each of PATHEXT's in turn
  const forms = (file: string) =>
    windows ? [...(exts.some((ext) => file.toLowerCase().endsWith(ext)) ? [file] : []), ...exts.map((ext) => file + ext)] : [file];
  const paths = windows ? win32 : posix;
  if (paths.isAbsolute(command)) return forms(command);
  // a relative path is resolved against the folder the engine starts in,
  // which differs by turn; that is not a question this can answer
  if (/[\\/]/.test(command)) return null;
  const dirs = (envValue(env, "PATH", windows) ?? "").split(paths.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => forms(paths.join(dir, command)));
}

const remembered = new Map<string, { at: number; missing: boolean }>();

/** Looks at the disk still under way, one per file. A stat on a network
 * volume that has gone away may never come back, and every one stuck
 * holds a thread of the pool that file reads, DNS and zlib share; so a
 * file already being looked at is waited on again, never looked at twice. */
const looking = new Map<string, Promise<Probe>>();

function probeOnce(file: string, windows: boolean): Promise<Probe> {
  const key = `${windows}\0${file}`;
  let pending = looking.get(key);
  if (!pending) {
    pending = probeDisk(file, windows).finally(() => looking.delete(key));
    looking.set(key, pending);
  }
  return pending;
}

/**
 * Whether `command` is plainly not there to run: an absolute or `~/` path
 * with no runnable file, or a bare name found nowhere on PATH. False for
 * anything found, anything that cannot be told, and any look that ran
 * past the bound.
 */
export async function commandMissing(command: string, options: CommandCheck = {}): Promise<boolean> {
  const windows = (options.platform ?? process.platform) === "win32";
  const env = options.env ?? process.env;
  const file = expandHome(command.trim(), options.home);
  if (!file) return false;
  const list = candidates(file, env, windows);
  // a relative path cannot be told; a bare name with no PATH at all is
  // found nowhere
  if (!list) return false;
  if (!list.length) return true;
  const key = `${windows}\0${file}\0${envValue(env, "PATH", windows) ?? ""}\0${envValue(env, "PATHEXT", windows) ?? ""}`;
  const known = options.probe ? undefined : remembered.get(key);
  if (known && Date.now() - known.at < REMEMBER_MS) return known.missing;
  const probe = options.probe ?? probeOnce;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), options.timeoutMs ?? COMMAND_CHECK_MS)));
  // every candidate at once: a PATH of twenty folders is one wait, not twenty
  const looked = Promise.all(list.map((candidate) => probe(candidate, windows).catch((): Probe => "unknown")));
  const answer = await Promise.race([looked, late]).finally(() => clearTimeout(timer));
  // a look past the bound counts as found, and is kept as found too, so a
  // dead volume costs one wait per while, not one per turn
  const missing = answer !== "late" && answer.every((seen) => seen === "absent");
  if (!options.probe) {
    if (remembered.size > 200) remembered.clear();
    remembered.set(key, { at: Date.now(), missing });
  }
  return missing;
}

/** The environment a server's command is looked up in: the engines', with
 * the server's own PATH over it when it sets one. */
export function lookupEnv(server: { env?: Record<string, string> }, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const own = Object.entries(server.env ?? {}).filter(([name, value]) => value && /^(path|pathext)$/i.test(name));
  return own.length ? { ...base, ...Object.fromEntries(own) } : base;
}

/** What the agent is told when servers it was given are left out, every
 * turn they are: its tools are listed by the engine, so without this it
 * would only find them gone. */
export function serversMissingNote(names: readonly string[]): string {
  const quoted = names.map((name) => JSON.stringify(name));
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0];
  const them = names.length > 1 ? "these MCP servers" : "this MCP server";
  return `\n\nThe person gave you ${list}, but ${them} did not start this turn: ${names.length > 1 ? "their commands were" : "its command was"} not found on this computer, so you have none of ${names.length > 1 ? "their" : "its"} tools. Your other tools are not affected. If a task needs ${names.length > 1 ? "them" : "it"}, say so plainly, and that it is fixed in Settings, under Plugins.`;
}

/** What the person sees in the chat, once per conversation. */
export function serversMissingNotice(agent: string, names: readonly string[]): string {
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return names.length > 1
    ? `${list} did not start: their commands were not found. ${agent} works without them until they are fixed in Settings, under Plugins.`
    : `${list} did not start: its command was not found. ${agent} works without it until it is fixed in Settings, under Plugins.`;
}
