// A place to type, in the folder the agent is working in.
//
// The agent and the person share one directory: the agent writes files
// there, and this is where you look at them, run the tests, check what
// git thinks. Nowhere else in the app can you type a command.
//
// A shell needs a terminal, not a pipe. Without one there is no line
// editing, no colour, no job control, and anything that checks whether it
// is talking to a person turns all of that off. Node cannot allocate a
// pty on its own and the packages that can are native code, which is a
// build toolchain on every platform we ship, so the pty comes from the
// system's own `script`, which exists to do exactly this. Windows has no
// equivalent, so it gets a piped shell and the app says so rather than
// pretending.
//
// A session outlives the panel. Closing the terminal in the app detaches
// from the shell, it does not kill it: a build you started is still
// running when you come back, which is the whole reason a session manager
// exists rather than a spawn per open.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/** What the client sees of a session. */
export interface TerminalInfo {
  botId: string;
  cwd: string;
  shell: string;
  /** False where no pty could be had, in which case full screen programs
   * will not work and the app should say so. */
  pty: boolean;
  provider: string;
  cols: number;
  rows: number;
  startedAt: number;
  /** Set once the shell has exited; the session stays readable. */
  exitedAt?: number;
  exitCode?: number | null;
}

/** Sizes a client may ask for. A terminal narrower than this is not a
 * terminal, and one wider is somebody's mistake. */
export const MIN_COLS = 20;
export const MAX_COLS = 500;
export const MIN_ROWS = 5;
export const MAX_ROWS = 200;

/** How much output is kept for a client that comes back. Enough to fill a
 * tall window several times over, small enough that a runaway `yes` does
 * not become a memory leak. */
export const SCROLLBACK_BYTES = 128 * 1024;

/** One shell at a time per agent, and a ceiling on the lot. */
export const MAX_SESSIONS = 12;

/** A session with nobody attached is closed after this. Long enough to
 * survive a lunch break, short enough that shells do not accumulate. */
export const IDLE_MS = 8 * 60 * 60 * 1000;

/** Input is a keystroke, not a payload. */
export const MAX_INPUT_BYTES = 8 * 1024;

export function clampCols(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(MIN_COLS, Math.min(MAX_COLS, n)) : 80;
}

export function clampRows(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(MIN_ROWS, Math.min(MAX_ROWS, n)) : 24;
}

/**
 * The shell to open. The person's own login shell wherever the system
 * says what it is, because a terminal that is not the shell you use is a
 * worse terminal.
 */
export function shellFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return env.COMSPEC || "powershell.exe";
  const chosen = env.SHELL;
  // A login shell recorded as something that cannot run leaves a person
  // with no terminal at all, so anything odd falls back to a real one.
  if (chosen && chosen.startsWith("/") && !chosen.includes("false") && !chosen.includes("nologin")) {
    return chosen;
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * How to get a pty out of the system.
 *
 * Node cannot allocate one, and every package that can is native code, so
 * the pty has to be borrowed from a program that already knows how. Three
 * of them can, and which are present differs by platform, so this is an
 * ordered list rather than one answer.
 *
 * `script` is the obvious candidate and is only useful on Linux: the BSD
 * one macOS ships reads the terminal settings off its own stdin and gives
 * up when that is a pipe, which is exactly the situation it is in when a
 * server spawns it. That is not a thing to work around, it is a thing to
 * find out once and then not use.
 *
 * Nothing here interpolates the shell's path. It arrives in the
 * environment as BLOKS_SHELL and is expanded by /bin/sh at the far end,
 * because two of these three take a script in a language of their own and
 * a login shell recorded as something with a bracket in it would
 * otherwise be code rather than a path.
 */
export interface PtyProvider {
  name: "script" | "expect" | "python";
  file: string;
  args: (cols: number, rows: number) => string[];
}

/** What runs inside the pty, whichever program opened it. */
function innerCommand(cols: number, rows: number): string {
  return `stty rows ${rows} cols ${cols} 2>/dev/null; exec "$BLOKS_SHELL" -i`;
}

const SCRIPT: PtyProvider = {
  name: "script",
  file: "script",
  // util-linux: script -qfc <command> <file>
  args: (cols, rows) => ["-qfc", innerCommand(cols, rows), "/dev/null"],
};

const EXPECT: PtyProvider = {
  name: "expect",
  file: "expect",
  // Tcl. The command runs inside braces, which is the one form Tcl does
  // no substitution in, so nothing in it can become code.
  args: (cols, rows) => [
    "-c",
    `set stty_init "rows ${rows} cols ${cols}"; spawn -noecho /bin/sh -c {${innerCommand(cols, rows)}}; interact`,
  ],
};

const PYTHON: PtyProvider = {
  name: "python",
  file: "python3",
  args: (cols, rows) => [
    "-c",
    `import pty; pty.spawn(["/bin/sh", "-c", ${JSON.stringify(innerCommand(cols, rows))}])`,
  ],
};

/** Ordered by how likely each is to be there, per platform. */
export function ptyProviders(platform: NodeJS.Platform): PtyProvider[] {
  if (platform === "win32") return [];
  if (platform === "linux") return [SCRIPT, EXPECT, PYTHON];
  // macOS and the BSDs: script is out, and expect ships with the system
  return [EXPECT, PYTHON, SCRIPT];
}

/**
 * The first provider whose program is actually installed, or nothing.
 * `lookup` is passed in so this can be reasoned about without a PATH.
 */
export function chooseProvider(
  platform: NodeJS.Platform,
  lookup: (file: string) => boolean,
): PtyProvider | null {
  for (const provider of ptyProviders(platform)) {
    if (lookup(provider.file)) return provider;
  }
  return null;
}

/** Is this program on PATH and runnable. */
export function onPath(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (file.includes("/")) return canRun(file);
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && canRun(join(dir, file))) return true;
  }
  return false;
}

function canRun(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * What to spawn: the pty provider if there is one, otherwise the shell on
 * its own. Without a pty there is no line editing and no full screen
 * program, which the app has to be able to say, hence the flag.
 */
export function spawnPlan(
  platform: NodeJS.Platform,
  shell: string,
  cols: number,
  rows: number,
  lookup: (file: string) => boolean = onPath,
): { file: string; args: string[]; pty: boolean; provider: string } {
  const provider = chooseProvider(platform, lookup);
  if (!provider) return { file: shell, args: [], pty: false, provider: "none" };
  return { file: provider.file, args: provider.args(cols, rows), pty: true, provider: provider.name };
}

/**
 * A resize after the fact.
 *
 * The pty's size lives in the kernel and the only thing on the far side
 * that can change it is something running inside. So a resize is a line
 * typed into the shell, which means it is echoed: it goes in with a
 * leading space so shells configured to ignore those keep it out of
 * history, and it is not sent for a change nobody would notice.
 */
export function resizeLine(cols: number, rows: number): string {
  return ` stty rows ${rows} cols ${cols} 2>/dev/null\n`;
}

export function worthResizing(
  from: { cols: number; rows: number },
  to: { cols: number; rows: number },
): boolean {
  return Math.abs(from.cols - to.cols) >= 2 || Math.abs(from.rows - to.rows) >= 2;
}

/**
 * Recent output, as bytes rather than lines.
 *
 * Kept as bytes because the stream is escape sequences, not text: a
 * boundary in the wrong place would cut one in half. A client that comes
 * back is sent the tail of this, which is why the panel looks the way it
 * did rather than empty.
 */
export class Scrollback {
  private chunks: Buffer[] = [];
  private size = 0;
  private limit: number;

  constructor(limit: number = SCROLLBACK_BYTES) {
    this.limit = limit;
  }

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    // one chunk larger than the whole budget: keep its tail
    if (this.size > this.limit && this.chunks.length === 1) {
      const only = this.chunks[0];
      this.chunks[0] = only.subarray(only.length - this.limit);
      this.size = this.limit;
    }
  }

  get bytes(): number {
    return this.size;
  }

  read(): Buffer {
    return Buffer.concat(this.chunks);
  }

  clear() {
    this.chunks = [];
    this.size = 0;
  }
}

type Listener = (chunk: Buffer) => void;
type Ending = () => void;

/** One live shell, and everyone watching it. */
export class TerminalSession {
  readonly botId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly pty: boolean;
  /** Which program opened the pty, for the app to report honestly. */
  readonly provider: string;
  readonly startedAt: number;
  cols: number;
  rows: number;
  exitedAt?: number;
  exitCode?: number | null;
  /** When the last client detached. Zero while somebody is watching. */
  idleSince = 0;

  private child: ChildProcessWithoutNullStreams | null = null;
  private scrollback = new Scrollback();
  private listeners = new Set<Listener>();
  private endings = new Set<Ending>();

  constructor(input: { botId: string; cwd: string; cols: number; rows: number; now: number }) {
    this.botId = input.botId;
    this.cwd = input.cwd;
    this.cols = clampCols(input.cols);
    this.rows = clampRows(input.rows);
    this.startedAt = input.now;
    this.shell = shellFor(process.platform, process.env);

    const plan = spawnPlan(process.platform, this.shell, this.cols, this.rows);
    this.pty = plan.pty;
    this.provider = plan.provider;
    this.child = spawn(plan.file, plan.args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
        // the shell to open, read at the far end by /bin/sh rather than
        // pasted into somebody else's scripting language
        BLOKS_SHELL: this.shell,
        // so a shell can tell, and so anything that runs from in here is
        // not mistaken for the agent's own turn
        BLOKS_TERMINAL: "1",
      },
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    const take = (chunk: Buffer) => {
      this.scrollback.push(chunk);
      for (const listener of this.listeners) listener(chunk);
    };
    this.child.stdout.on("data", take);
    this.child.stderr.on("data", take);
    this.child.on("error", (e) => {
      take(Buffer.from(`\r\n[the shell would not start: ${e.message}]\r\n`));
      this.settle(null);
    });
    this.child.on("exit", (code) => {
      take(Buffer.from(`\r\n[the shell exited${code === null ? "" : ` with ${code}`}]\r\n`));
      this.settle(code);
    });
  }

  private settle(code: number | null) {
    if (this.exitedAt) return;
    this.exitedAt = Date.now();
    this.exitCode = code;
    this.child = null;
    // The panel should say the shell has gone rather than sit there
    // looking live, and the only one who knows is this.
    for (const ending of this.endings) ending();
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.exitedAt;
  }

  get watchers(): number {
    return this.listeners.size;
  }

  info(): TerminalInfo {
    return {
      botId: this.botId,
      cwd: this.cwd,
      shell: this.shell,
      pty: this.pty,
      provider: this.provider,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      ...(this.exitedAt ? { exitedAt: this.exitedAt, exitCode: this.exitCode ?? null } : {}),
    };
  }

  /** Watch. Returns the tail of what has already happened, plus how to stop. */
  attach(listener: Listener, onEnd?: Ending): { replay: Buffer; detach: () => void } {
    this.listeners.add(listener);
    if (onEnd) this.endings.add(onEnd);
    this.idleSince = 0;
    return {
      replay: this.scrollback.read(),
      detach: () => {
        this.listeners.delete(listener);
        if (onEnd) this.endings.delete(onEnd);
        if (!this.listeners.size) this.idleSince = Date.now();
      },
    };
  }

  write(data: string): boolean {
    if (!this.child?.stdin.writable) return false;
    this.child.stdin.write(data.slice(0, MAX_INPUT_BYTES));
    return true;
  }

  resize(cols: number, rows: number) {
    const next = { cols: clampCols(cols), rows: clampRows(rows) };
    if (!worthResizing(this, next)) return;
    this.cols = next.cols;
    this.rows = next.rows;
    if (this.pty) this.write(resizeLine(next.cols, next.rows));
  }

  close() {
    this.listeners.clear();
    this.endings.clear();
    const child = this.child;
    this.settle(null);
    if (!child) return;
    // ask, then insist: a shell mid-command ignores the first one
    try {
      child.kill("SIGHUP");
    } catch {}
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 2_000).unref?.();
  }
}

/** Every open shell, one per agent. */
export class TerminalStore {
  private sessions = new Map<string, TerminalSession>();

  get(botId: string): TerminalSession | null {
    return this.sessions.get(botId) ?? null;
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /**
   * The session for this agent, opening one if there is none. A shell that
   * has exited is replaced rather than resurrected, so pressing the button
   * again after `exit` does the obvious thing.
   */
  open(input: { botId: string; cwd: string; cols: number; rows: number; now: number }): TerminalSession {
    const existing = this.sessions.get(input.botId);
    if (existing && existing.alive && existing.cwd === input.cwd) return existing;
    if (existing) {
      existing.close();
      this.sessions.delete(input.botId);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      // close the one nobody has looked at for longest
      const [oldest] = [...this.sessions.values()].sort(
        (a, b) => (a.idleSince || Infinity) - (b.idleSince || Infinity),
      );
      if (oldest) this.close(oldest.botId);
    }
    const session = new TerminalSession(input);
    this.sessions.set(input.botId, session);
    return session;
  }

  close(botId: string) {
    const session = this.sessions.get(botId);
    if (!session) return;
    session.close();
    this.sessions.delete(botId);
  }

  closeAll() {
    for (const botId of [...this.sessions.keys()]) this.close(botId);
  }

  /** Shells nobody has watched for a long time, and shells that ended. */
  sweep(now: number) {
    for (const [botId, session] of this.sessions) {
      const gone = session.exitedAt && now - session.exitedAt > 60_000 && !session.watchers;
      const stale = session.idleSince && now - session.idleSince > IDLE_MS;
      if (gone || stale) this.close(botId);
    }
  }
}
