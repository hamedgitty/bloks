// Installing an engine, and signing in to it, from the app.
//
// Setup used to be a command to copy into Terminal. That is where most
// first runs went wrong: `npm i -g` on a stock Mac writes to a folder the
// user does not own and fails with EACCES, a Mac without Node has no npm
// at all, and a CLI that installed fine still answers nothing until it is
// signed in. Each of those read as "Bloks is broken" rather than as one
// step left to do.
//
// So the app runs the install itself, into the user's own ~/.local (no
// admin password, nothing to chmod), through their login shell so it sees
// the same node and PATH their Terminal does. What fails is translated
// into the one thing to do next. Signing in stays in Terminal, because
// every engine's login is its own interactive flow, but the app opens that
// Terminal with the command already running.
import { spawn } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { widenPath } from "./path.ts";
import { shellFor } from "./terminal.ts";

export interface EngineSetup {
  /** What runs, shown to the person before and after, so nothing about
   * it is hidden. A POSIX shell script. */
  install: string;
  /** The command that signs in, run in Terminal. Absent when the engine
   * signs in on first use or with a key in Settings. */
  signIn?: string;
}

// npm into the user's own prefix: ~/.local/bin is already where path.ts
// looks, and nothing under ~/.local needs sudo.
const npmUser = (packages: string) =>
  [
    'command -v npm >/dev/null 2>&1 || { echo "BLOKS_NEEDS_NODE"; exit 3; }',
    `npm install -g --prefix "$HOME/.local" ${packages}`,
  ].join("\n");

export const ENGINE_SETUP: Record<string, EngineSetup> = {
  // the native installer: no Node needed, lands in ~/.local/bin
  claudeAgent: { install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude" },
  codex: { install: npmUser("@openai/codex"), signIn: "codex login" },
  geminiCli: { install: npmUser("@google/gemini-cli"), signIn: "gemini" },
  pi: { install: npmUser("--ignore-scripts @earendil-works/pi-coding-agent pi-acp") },
  antigravity: { install: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
  grokCli: { install: "curl -fsSL https://x.ai/cli/install.sh | bash" },
};

/** Long enough for a slow download, short enough that a hung installer
 * does not hold the button forever. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const LOG_TAIL = 4_000;

export interface InstallResult {
  ok: boolean;
  /** One plain sentence for the person when it did not work. */
  problem?: string;
  /** The end of what the installer printed, for the curious and for bug
   * reports. Never contains anything the person did not already have. */
  log: string;
}

/** What a failed install printed, as the step that would fix it. */
export function explainInstallFailure(log: string, code: number | null): string {
  if (log.includes("BLOKS_NEEDS_NODE") || /npm: command not found|command not found: npm/.test(log)) {
    return "This one installs with npm, which comes with Node.js. Install Node from nodejs.org, then try again.";
  }
  if (/EACCES|permission denied/i.test(log)) {
    return "The installer was not allowed to write where it wanted to. Try again; if it keeps happening, the log below says which folder.";
  }
  if (/Could not resolve host|ENOTFOUND|getaddrinfo|network is unreachable|timed out/i.test(log)) {
    return "The download did not get through. Check the internet connection and try again.";
  }
  if (/curl: \(22\)|404/.test(log)) {
    return "The installer's download address did not answer. Try again later, or install it from the engine's own site.";
  }
  if (code === null) return "The installer took too long and was stopped. Try again.";
  return `The installer stopped with an error (exit ${code}). The log below has the details.`;
}

/** The person's own shell, as a login shell, so the install sees what
 * their Terminal sees: nvm's node, brew's npm, their PATH. The terminal
 * panel already knows how to pick one, and its fallback matters here: a
 * server started without SHELL (a systemd unit, a container) is common on
 * Linux, where /bin/zsh is usually not installed, and spawning a shell
 * that is not there read as every install failing with exit 1. */
function loginShell(): string {
  return shellFor(process.platform, process.env);
}

export function installEngine(kind: string): Promise<InstallResult> {
  const setup = ENGINE_SETUP[kind];
  if (!setup) return Promise.resolve({ ok: false, problem: "Bloks does not know how to install that one.", log: "" });
  return runSetupScript(setup.install);
}

/** Run one install or update script through the login shell, and say how
 * it went in terms of what to do next. */
export function runSetupScript(script: string): Promise<InstallResult> {
  if (process.platform === "win32") {
    return Promise.resolve({
      ok: false,
      problem: "Installing from the app works on macOS and Linux. On Windows, run the command below in a terminal.",
      log: "",
    });
  }
  return new Promise((resolve) => {
    let log = "";
    const child = spawn(loginShell(), ["-lc", script], {
      env: { ...process.env, CI: "1", NONINTERACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-LOG_TAIL * 4);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), INSTALL_TIMEOUT_MS);
    const done = (code: number | null) => {
      clearTimeout(timer);
      // a first install can create ~/.local/bin, which PATH did not have
      widenPath();
      const tail = log.slice(-LOG_TAIL).replace(/BLOKS_NEEDS_NODE\n?/g, "");
      resolve(code === 0 ? { ok: true, log: tail } : { ok: false, problem: explainInstallFailure(log, code), log: tail });
    };
    child.on("error", () => done(1));
    child.on("close", (code, signal) => done(signal ? null : code));
  });
}

/** Open Terminal with an engine's sign-in already running. macOS only:
 * elsewhere the answer is the command, for the person to run. */
export function openSignIn(kind: string): { opened: boolean; command: string | null } {
  const command = ENGINE_SETUP[kind]?.signIn ?? null;
  if (!command || process.platform !== "darwin") return { opened: false, command };
  // A .command file is what Finder hands to Terminal: no Automation
  // permission to ask for, which osascript would need.
  const file = join(tmpdir(), `bloks-signin-${kind}.command`);
  writeFileSync(
    file,
    [
      `#!${loginShell()} -l`,
      "clear",
      `echo "Signing in for Bloks. When it says you are signed in, close this window and go back to Bloks."`,
      "echo",
      command,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  spawn("open", [file], { stdio: "ignore", detached: true }).unref();
  return { opened: true, command };
}
