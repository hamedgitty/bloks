// One server per data folder.
//
// Every store here reads its file once and writes the whole of it back on
// each change, so two servers on one ~/.bloks each overwrite what the
// other wrote: an edit reverted, a hired agent gone, one message starting
// two engines on one session (GitHub 140). The desktop app found its usual
// port taken by a running bloks-server and quietly started a second
// server on another port, on the same folder.
//
// So the first thing a server does is claim the folder with a lock file
// holding its pid and port. A second server finds the first still alive
// and stops before touching anything, saying which server holds the
// folder and where. A lock left by a server that died is stale and is
// taken over: its pid is gone, or now belongs to something that is not
// Bloks.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface LockHolder {
  pid: number;
  port: number;
  startedAt: number;
}

/** What the server prints when the folder is taken. The desktop app
 * looks for this to explain instead of trying other ports. */
export const IN_USE_MARK = "DATA_FOLDER_IN_USE";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // it exists, it is just not ours to signal
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a live pid is plausibly a Bloks server rather than whatever
 * the system handed that number to after a crash. Without `ps` (Windows)
 * a live pid is taken at its word. */
function looksLikeBloks(pid: number): boolean {
  if (process.platform === "win32") return true;
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 });
    return /bloks|server[\\/]index\./i.test(command);
  } catch {
    return true;
  }
}

function read(file: string): LockHolder | null {
  try {
    const held = JSON.parse(readFileSync(file, "utf8"));
    return typeof held?.pid === "number" ? held : null;
  } catch {
    return null;
  }
}

/**
 * Claim `dir` for this process. Returns the holder when another live Bloks
 * server has it; otherwise the folder is ours, and the lock goes when this
 * process exits.
 */
export function claimDataFolder(dir: string, port: number): { ok: true } | { ok: false; holder: LockHolder } {
  const file = join(dir, "server.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() } satisfies LockHolder));
      closeSync(fd);
      process.once("exit", () => {
        // only our own: a successor may have taken a stale one over
        if (read(file)?.pid === process.pid) {
          try {
            unlinkSync(file);
          } catch {
            /* already gone */
          }
        }
      });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = read(file);
    if (holder && holder.pid !== process.pid && alive(holder.pid) && looksLikeBloks(holder.pid)) {
      return { ok: false, holder };
    }
    // stale, or half written by a server that died writing it
    try {
      unlinkSync(file);
    } catch {
      /* someone else cleared it; try again */
    }
  }
  throw new Error(`could not claim ${dir}: its lock file keeps changing`);
}

/** The words a person reads when a second server is turned away. */
export function inUseMessage(dir: string, holder: LockHolder): string {
  return (
    `[bloks] ${IN_USE_MARK} pid=${holder.pid} port=${holder.port} dir=${dir}\n` +
    `[bloks] Another Bloks server (pid ${holder.pid}, http://127.0.0.1:${holder.port}) is already using ${dir}. ` +
    "Two servers on one data folder overwrite each other's changes, so this one is not starting. " +
    "Use the one that is running, or stop it first."
  );
}
