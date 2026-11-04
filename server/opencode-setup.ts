// OpenCode's own setup for one workspace (GitHub 484).
//
// OpenCode keeps everything in the XDG folders: its settings, plugins and
// instructions in ~/.config/opencode, its sign-ins and session database
// in ~/.local/share/opencode, its state and cache beside them. A turn
// here inherits all of it: the plugins and MCP servers the person set up
// for their own use, the instructions they wrote for themselves, and a
// session list shared with their own terminal. With the workspace setting
// on (`opencode.isolated` in config.json), turns on this computer point
// OpenCode at folders of the workspace's own instead, in <data
// folder>/opencode, with the variables the engine reads: OPENCODE_CONFIG_DIR
// (OpenCode 2), XDG_CONFIG_HOME (1.x), and the XDG data, state and cache
// homes (both).
//
// What is in those folders is the engine's. Bloks writes one file of its
// own there, the service file that tells OpenCode 2 to run its own server
// rather than reach for the person's background one, whose sign-ins and
// sessions are theirs.
//
// The providers already connected are brought over once, when the folder
// is first set up, so switching it on is not a new sign-in: OpenCode 2's
// own `auth export`, piped into `auth import` on this side (through
// stdin, never argv, never a file, never logged), or for 1.x a copy of
// its auth.json, 0600 in a 0700 folder inside the 0700 data folder, which
// is no wider than where it came from. Never again after that: what the
// person connects in their own OpenCode later stays theirs, and Connect a
// provider under the setting signs in here. The folder stays on this
// computer; backups and moves leave it out (server/backup.ts).
//
// Only turns on this computer use it. A turn in a workplace (a container,
// another machine over SSH) runs the OpenCode there, with its setup there;
// these paths are this computer's. And the commands an agent runs inherit
// the same variables, so a tool that keeps its settings under ~/.config
// (gh, for one) does not find them in such a turn. The README says so.
import { execFile, spawn } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { killTree, launchSpec } from "./path.ts";

export interface OpencodePaths {
  /** <data folder>/opencode, private. */
  root: string;
  /** OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME. */
  configDir: string;
  /** XDG_DATA_HOME; OpenCode's own folder is `opencodeDataDir` in it. */
  dataDir: string;
  stateDir: string;
  cacheDir: string;
  /** Where OpenCode keeps its sign-ins and session database. */
  opencodeDataDir: string;
}

export function isolatedOpencodePaths(dataDir: string = DATA_DIR): OpencodePaths {
  const root = join(dataDir, "opencode");
  return {
    root,
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    stateDir: join(root, "state"),
    cacheDir: join(root, "cache"),
    opencodeDataDir: join(root, "data", "opencode"),
  };
}

/** The file that says "no background server" for each release channel's
 * OpenCode 2: service.json for the published ones, service-local.json for
 * a build of its own. */
const SERVICE_FILES = ["service.json", "service-local.json"];

/**
 * Makes the folders, private, and the service file if it is not there,
 * and returns the variables that point OpenCode at them. Brings nothing
 * over: that is seedOpencodeSignIns, once.
 */
export function isolatedOpencodeEnv(dataDir: string = DATA_DIR): Record<string, string> {
  const paths = isolatedOpencodePaths(dataDir);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  // a folder made some other way is made private all the same: sign-ins
  // go in it
  try {
    chmodSync(paths.root, 0o700);
  } catch {
    /* not ours to change; the data folder around it is 0700 */
  }
  for (const dir of [paths.configDir, paths.opencodeDataDir, join(paths.stateDir, "opencode"), join(paths.cacheDir, "opencode")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const name of SERVICE_FILES) {
    try {
      // one the person changed with `opencode service set` is kept
      writeFileSync(join(paths.configDir, name), JSON.stringify({ disabled: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      /* already there */
    }
  }
  return variables(paths);
}

function variables(paths: OpencodePaths): Record<string, string> {
  return {
    OPENCODE_CONFIG_DIR: paths.configDir,
    XDG_CONFIG_HOME: paths.configDir,
    XDG_DATA_HOME: paths.dataDir,
    XDG_STATE_HOME: paths.stateDir,
    XDG_CACHE_HOME: paths.cacheDir,
  };
}

/** The command that connects a provider to the workspace's own setup, in
 * Terminal: OpenCode's own login, pointed at its folders. Only words:
 * the caller makes the folders first (isolatedOpencodeEnv), so the login
 * finds the service file and does not start a background server. */
export function isolatedOpencodeSignInCommand(cli = "opencode", dataDir: string = DATA_DIR, platform: NodeJS.Platform = process.platform): string {
  const quote = (value: string) => (platform === "win32" ? `"${value.replace(/"/g, '`"')}"` : `'${value.replace(/'/g, `'\\''`)}'`);
  // always quoted, so a path is only ever a path to the shell; PowerShell
  // runs a quoted path only through its call operator
  const bin = platform === "win32" ? `& ${quote(cli)}` : quote(cli);
  const pairs = Object.entries(variables(isolatedOpencodePaths(dataDir)));
  return platform === "win32"
    ? `${pairs.map(([k, v]) => `$env:${k}=${quote(v)}`).join("; ")}; ${bin} auth login`
    : `${pairs.map(([k, v]) => `${k}=${quote(v)}`).join(" ")} ${bin} auth login`;
}

/** Long enough for OpenCode 2 to start a server of its own for the
 * export or the import; a first turn waits on it, once. */
const SEED_MS = 15_000;

export type Seeded = "imported" | "copied" | "none";

/**
 * Brings the providers connected in the person's own OpenCode over to
 * the workspace's, the first time the folder is set up, and never again.
 * Never throws: a seeding that fails leaves the workspace's OpenCode on
 * its free models until a provider is connected there, which is what the
 * setting's Connect a provider is for. `env` is this computer's own
 * environment, where the person's OpenCode is found.
 */
export async function seedOpencodeSignIns(
  cli: string,
  dataDir: string = DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<Seeded> {
  try {
    const paths = isolatedOpencodePaths(dataDir);
    const own = { ...env, ...isolatedOpencodeEnv(dataDir) };
    // Claimed before anything is tried, so it happens once whatever the
    // outcome: a provider signed out of here later is not brought back.
    try {
      writeFileSync(join(paths.root, ".seeded"), "", { flag: "wx", mode: 0o600 });
    } catch {
      return "none";
    }
    const theirs = join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "opencode");
    if (theirs === paths.opencodeDataDir) return "none";
    // OpenCode 2 keeps sign-ins in its database and hands them over with
    // its own export. One that answered, even with nothing, has said;
    // only one that could not (1.x has no export) falls back to the file.
    if (existsSync(join(theirs, "opencode.db"))) {
      const exported = await exportSignIns(cli, env, home);
      if (exported !== null) return exported && (await importSignIns(cli, own, paths.root, exported)) ? "imported" : "none";
    }
    const from = join(theirs, "auth.json");
    if (!existsSync(from)) return "none";
    const to = join(paths.opencodeDataDir, "auth.json");
    // the kernel copies it, so the key is never in this process; made
    // 0600 before anything else could open it in the 0700 folder
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, 0o600);
    return "copied";
  } catch {
    return "none";
  }
}

/** The person's sign-ins as OpenCode 2 exports them: the JSON text when
 * there are some, "" when there are none, null when it could not say.
 * `--standalone` so it reads them without starting a background server
 * that would outlive Bloks. The text holds secrets: it goes from here to
 * the import's stdin and nowhere else. */
function exportSignIns(cli: string, env: NodeJS.ProcessEnv, home: string): Promise<string | null> {
  return new Promise((resolve) => {
    let launch: ReturnType<typeof launchSpec>;
    try {
      launch = launchSpec(cli, ["auth", "export", "--standalone"]);
    } catch {
      return resolve(null);
    }
    execFile(
      launch.command,
      launch.args,
      { cwd: home, env, timeout: SEED_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: launch.windowsVerbatimArguments },
      // the error says what failed and carries stderr, never the export,
      // and is not kept
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const list: unknown = JSON.parse(stdout);
          resolve(Array.isArray(list) ? (list.length ? stdout : "") : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function importSignIns(cli: string, env: NodeJS.ProcessEnv, cwd: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let launch: ReturnType<typeof launchSpec>;
    try {
      launch = launchSpec(cli, ["auth", "import", "--standalone"]);
    } catch {
      return resolve(false);
    }
    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      killTree(child.pid, () => child.kill("SIGTERM"));
      finish(false);
    }, SEED_MS);
    timer.unref?.();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
