// A tool call that has stopped making progress, and a stop that stops.
//
// deadline.ts bounds only the handshake, on purpose: a turn can be quiet
// for a long time while a build runs. But one kind of quiet is not work.
// An agent ran `ls` on a Dropbox folder, macOS sat waiting on a
// permission nobody could see, and the call never returned (GitHub 146,
// 147). The engine said nothing more, the conversation showed "working"
// for two hours, every new message queued behind it, and Stop sent one
// SIGTERM to a process that was not listening.
//
// So, two rules. A tool call that is open, with nobody being asked
// anything and no word from the engine for the person's limit, ends the
// turn and says which call it was. And a stop escalates: SIGTERM, then
// SIGKILL, then, if the process still has not let go (a grandchild
// holding its output open, or a wait the kernel will not interrupt), the
// turn ends anyway. Time spent waiting on an approval card is the
// person's, never the engine's, so it does not count.
//
// What is not bounded is still not bounded: the model thinking, writing a
// long file, or a tool that keeps reporting. Only a call gone silent.

/** How long a stop waits before it stops asking, and again before it
 * stops waiting. */
export const STOP_GRACE_MS = 3_000;

/** The default limit for a silent tool call. Claude Code's own Bash cap
 * is ten minutes, so a command that is merely slow ends on its own first. */
export const DEFAULT_STALL_MINUTES = 15;

/** The limits Settings offers, in minutes; 0 is never. */
export const STALL_CHOICES = [5, 15, 30, 60, 0] as const;

export interface OpenCall {
  name: string;
  input: unknown;
  since: number;
}

export function isStalled(state: { open: number; asking: number; lastSign: number; now: number; limitMs: number }): boolean {
  if (state.limitMs <= 0 || state.open === 0 || state.asking > 0) return false;
  return state.now - state.lastSign >= state.limitMs;
}

/** The part of a call's input that says what it was doing. */
export function callDetail(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "notebook_path", "url", "pattern", "query"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 160);
  }
  return null;
}

/** macOS file provider folders: the cloud apps' own (Dropbox, Google
 * Drive, OneDrive, Box) and iCloud Drive. Reading one can wait on a
 * download or on the person's consent. */
const CLOUD_FOLDER = /\/Library\/(CloudStorage|Mobile Documents)\//;

function mentionsCloudFolder(input: unknown): boolean {
  try {
    return CLOUD_FOLDER.test(JSON.stringify(input) ?? "");
  } catch {
    return false;
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m >= 1) return `${m} minute${m === 1 ? "" : "s"}`;
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
}

/** What the person reads when a silent call ends a turn. */
export function describeStall(call: OpenCall, quietMs: number, bundleId = "dev.bloks.app"): string {
  const detail = callDetail(call.input);
  let text =
    `${call.name}${detail ? ` (${detail})` : ""} made no progress for ${minutes(quietMs)}, so Bloks stopped this turn. ` +
    "Whatever it was waiting on never answered. The limit is in Settings, General, under Working with agents.";
  if (mentionsCloudFolder(call.input)) {
    text +=
      " That path is in a cloud folder, where macOS can hold a read until the file downloads or until you allow Bloks to read the cloud app's files." +
      ` If no prompt appeared, make the file available offline, or run \`tccutil reset FileProviderDomain ${bundleId}\` in Terminal so macOS asks again.`;
  }
  return text;
}

/** What the agent is told at the start of its next turn, so it does not
 * walk straight back into the same wait. */
export function stallPreface(said: string): string {
  return `(Bloks stopped your last turn: ${said} Do not run that step again the same way. Tell the person what happened, or find another route.)`;
}
