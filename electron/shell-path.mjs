// The PATH the person's own login shell uses, read once at start.
//
// An app opened from Finder inherits launchd's PATH, which has never
// heard of npm, brew or nvm, so the main process asks the login shell
// (main.mjs, adoptLoginShellPath) before any server is forked. Asked
// with -il, the shell reads .zshrc too, which is where plenty of people
// export PATH, and with it everything that file prints and every exit
// hook it runs. So the answer is printed between two markers and read
// from between them, whatever came around it: a banner, an exit status
// other than 0 from a hook that ran after it, or a shell that printed it
// and then sat in a slow exit until the timeout cut it off. Only when no
// PATH came out at all is there nothing to keep. The pure parts live here
// so they can be tested without a shell.
import { execFile } from "node:child_process";

export const PATH_START = "__BLOKS_PATH_START__";
export const PATH_END = "__BLOKS_PATH_END__";

/** What the shell is asked to run: the PATH between the markers, on a
 * line of its own, so nothing a profile prints can run into it. */
export const PATH_SCRIPT = `printf '\\n%s%s%s\\n' '${PATH_START}' "$PATH" '${PATH_END}'`;

/** How long the first ask may take before the window waits no longer. */
export const FIRST_ASK_MS = 4_000;
/** How long the one ask again, in the background, may take. */
export const SECOND_ASK_MS = 20_000;

/**
 * The PATH out of what the shell printed, or null when there is none:
 * the last pair of markers (a profile that runs the same thing must not
 * win over the real answer), its absolute folders only, each once. Null
 * for anything else: no markers, an empty PATH, a line break inside it,
 * or not one folder that is a folder.
 */
export function readShellPath(output) {
  const text = typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
  const end = text.lastIndexOf(PATH_END);
  if (end === -1) return null;
  const start = text.lastIndexOf(PATH_START, end);
  if (start === -1) return null;
  const said = text.slice(start + PATH_START.length, end);
  if (!said || /[\r\n\0]/.test(said)) return null;
  const dirs = [...new Set(said.split(":").filter((dir) => dir.startsWith("/")))];
  return dirs.length ? dirs.join(":") : null;
}

/** The shell's folders first, then what this process already had that
 * the shell did not say, each once. */
export function mergePath(reported, current) {
  return [...new Set([...(reported ?? "").split(":"), ...(current ?? "").split(":")])].filter(Boolean).join(":");
}

/** Whether a run that ended in an error was cut off by its timeout. */
export function cutOff(error) {
  return Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
}

/**
 * Asks the login shell for its PATH. Resolves with the PATH it printed,
 * or null, and whether it ran out of time; never rejects. `run` stands
 * in for execFile in a test.
 */
export function askLoginShell({ shell, timeoutMs = FIRST_ASK_MS, run = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      run(shell || "/bin/zsh", ["-ilc", PATH_SCRIPT], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        const path = readShellPath(stdout);
        resolve({ path, timedOut: !path && cutOff(error) });
      });
    } catch {
      resolve({ path: null, timedOut: false });
    }
  });
}
