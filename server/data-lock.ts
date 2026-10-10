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
//
// Windows ends a process outright when the desktop app kills it, so no
// exit handler runs there and the lock stays behind; Windows also hands a
// dead process's pid to the next one soon. Taking any live pid at its
// word kept Bloks from starting until the lock was deleted by hand, so
// there the pid's program has to be one that can be Bloks, and it has to
// have started before the lock was written.
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

/** Whether a live pid is plausibly the Bloks server that wrote the lock
 * rather than whatever the system handed that number to after a crash.
 * When the system will not say, a live pid is taken at its word. */
function looksLikeBloks(holder: LockHolder): boolean {
  const { pid } = holder;
  if (process.platform === "win32") {
    const seen = windowsProcess(pid);
    return seen ? fitsHolder(seen, holder) : true;
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 });
    return /bloks|server[\\/]index\./i.test(command);
  } catch {
    return true;
  }
}

export interface WindowsProcess {
  name: string;
  startedAt: number | null;
}

/** What Windows says about a pid: its program's name, and when it
 * started in epoch milliseconds when it will say. PowerShell rather than
 * tasklist, because only it gives the start time. */
function windowsProcess(pid: number): WindowsProcess | null {
  try {
    const script =
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName; ` +
      "try { ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { '' }";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return parseWindowsProcess(out);
  } catch {
    return null;
  }
}

/** The two lines windowsProcess asks PowerShell for. */
export function parseWindowsProcess(out: string): WindowsProcess | null {
  const [name = "", started = ""] = out.split(/\r?\n/).map((line) => line.trim());
  if (!name) return null;
  const at = Number(started);
  return { name, startedAt: started && Number.isFinite(at) && at > 0 ? at : null };
}

/** How far a process's start may seem to trail the lock its server wrote
 * after starting: two clocks read, each with its own rounding. */
const START_SLACK_MS = 2_000;

/** Whether a process fits the server that wrote `holder`: the app itself
 * (Bloks.exe, or Electron in a checkout) or node running bloks-server,
 * started no later than the lock was written. A pid handed on since
 * names another program, or started after. */
export function fitsHolder(seen: WindowsProcess, holder: LockHolder): boolean {
  if (!/bloks|node|electron/i.test(seen.name)) return false;
  if (seen.startedAt === null || !Number.isFinite(holder.startedAt)) return true;
  return seen.startedAt <= holder.startedAt + START_SLACK_MS;
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
    if (holder && holder.pid !== process.pid && alive(holder.pid) && looksLikeBloks(holder)) {
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

/** The live Bloks server holding `dir`, when it is another process.
 * Only reads: for work that must not happen under a running server's
 * feet but has no business taking the folder itself, such as a restore
 * swapping the folder before this server claims it. */
export function holderOf(dir: string): LockHolder | null {
  const holder = read(join(dir, "server.lock"));
  return holder && holder.pid !== process.pid && alive(holder.pid) && looksLikeBloks(holder.pid) ? holder : null;
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
