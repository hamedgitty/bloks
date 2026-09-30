// Finding the CLIs when nobody set up the environment.
//
// Launched from a terminal, this server inherits a login shell's PATH and
// every engine is findable. Launched from Finder, it inherits launchd's
// minimal one (/usr/bin:/bin:/usr/sbin:/sbin), and `spawn("claude")`
// fails with ENOENT even though the CLI is right there. To the person
// looking at the app, that reads as "Bloks cannot see anything I have
// installed", which is the worst possible first impression.
//
// Two layers close it. The desktop shell asks the user's login shell for
// its real PATH before this process starts (electron/main.mjs), which is
// the correct fix when it works. This file is the backstop for when it
// does not: the places node CLIs actually get installed on a Mac, checked
// on disk and appended so lookup can find them.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Where a `npm i -g`, brew, volta, pnpm or plain installer puts a CLI.
 * Order matters only for ties, so the common ones come first. */
function candidateDirs(): string[] {
  const home = homedir();

  if (process.platform === "win32") {
    // npm's global prefix and the installers' usual homes. AppData paths
    // resolve from env because roaming profiles move them.
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(appData, "npm"),
      join(local, "Programs"),
      join(home, ".grok", "bin"),
      join(home, ".local", "bin"),
      // `npm i -g --prefix ~/.local`, the command the engine hints give,
      // writes its launchers into the prefix itself on Windows, not bin/
      join(home, ".local"),
    ];
  }

  const dirs = [
    "/opt/homebrew/bin", // Apple Silicon brew
    "/usr/local/bin", // Intel brew, and half the installers ever written
    join(home, ".local", "bin"),
    join(home, ".local", "share", "pnpm"),
    join(home, ".grok", "bin"), // the xAI installer’s private prefix
    join(home, ".npm-global", "bin"),
    join(home, "Library", "pnpm"),
    join(home, ".volta", "bin"),
    join(home, "bin"),
  ];

  // nvm keeps one bin directory per installed node; take the newest,
  // which is where a recent `npm i -g` will have landed.
  const nvmVersions = join(home, ".nvm", "versions", "node");
  try {
    const newest = readdirSync(nvmVersions).sort().at(-1);
    if (newest) dirs.push(join(nvmVersions, newest, "bin"));
  } catch {
    /* no nvm */
  }

  const prefix = process.env.npm_config_prefix || process.env.PREFIX;
  if (prefix) dirs.push(join(prefix, "bin"));

  return dirs;
}

/** The file spawn would actually run for `cli`, or null.
 *
 * On Windows the lookup is not "a file with this name". Node (libuv)
 * only tries the name plus .com and .exe, so the extensionless sh shim
 * npm writes next to `pi-acp.cmd` is never runnable, and a .cmd/.bat
 * cannot be spawned without a shell at all (EINVAL since the
 * CVE-2024-27980 fix). So on Windows this walks PATHEXT and reports the
 * first real launcher; launchSpec() below then decides how to run it. */
export function resolveOnPath(cli: string): string | null {
  const win = process.platform === "win32";
  const exts = win
    ? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const runnable = (file: string) =>
    existsSync(file) && (!win || /\.(com|exe|bat|cmd)$/i.test(file));
  if (isAbsolute(cli) || /[\\/]/.test(cli)) {
    for (const ext of exts) if (runnable(cli + ext)) return cli + ext;
    return null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, cli + ext);
      if (runnable(file)) return file;
    }
  }
  return null;
}

/** True when spawn(cli) would find something, given PATH as widenPath left it. */
export function onPath(cli: string): boolean {
  return resolveOnPath(cli) !== null;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Set for the cmd.exe route, whose command line is built by hand. */
  windowsVerbatimArguments?: boolean;
  /** True when a shell sits between us and the agent, so a kill has to
   * take the whole tree. */
  viaShell: boolean;
}

/** cmd.exe quoting for one argument. The agents' argv is a few flags
 * and model ids; anything carrying a metacharacter is refused rather
 * than escaped, because cmd's escaping rules are a trap. */
function cmdArg(arg: string): string {
  if (/^[\w.:=@\/+-]+$/.test(arg)) return arg;
  if (/["%^&|<>()!\r\n]/.test(arg)) throw new Error(`refusing to pass ${JSON.stringify(arg)} through cmd.exe`);
  return `"${arg}"`;
}

/** How to spawn `cli args` so it works on every platform: unchanged on
 * macOS and Linux, and on Windows through cmd.exe when PATH resolves the
 * name to an npm .cmd/.bat launcher. */
export function launchSpec(cli: string, args: string[]): LaunchSpec {
  if (process.platform !== "win32") return { command: cli, args, viaShell: false };
  const file = resolveOnPath(cli);
  if (!file || !/\.(bat|cmd)$/i.test(file)) return { command: file ?? cli, args, viaShell: false };
  const line = [`"${file}"`, ...args.map(cmdArg)].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
    viaShell: true,
  };
}

/** Stop a child and, on Windows, everything it started: killing the
 * cmd.exe wrapper alone would orphan the agent behind it. */
export function killTree(pid: number | undefined, fallback: () => void) {
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", fallback);
      return;
    } catch {
      /* fall through */
    }
  }
  fallback();
}

/**
 * Append any real install directory that PATH is missing.
 *
 * Append rather than prepend on purpose: when the environment already
 * resolves a CLI, that resolution should win. This only adds places to
 * look after everything the user's setup said.
 */
export function widenPath() {
  const current = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const have = new Set(current);

  const missing = candidateDirs().filter((dir) => !have.has(dir) && existsSync(dir));
  if (missing.length) {
    process.env.PATH = [...current, ...missing].join(delimiter);
  }
}
