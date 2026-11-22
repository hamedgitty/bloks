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
//
// An agent can have several, the way a terminal app has tabs: a dev
// server in one, the tests in another, git in a third.
//
// Some of them are the agent's own. An agent's ordinary commands run in
// its turn, not here; but a command that keeps running (a dev server, a
// watcher, tests the person wants to watch) it can start in a tab of its
// own (`bloks terminal run`), which the app labels as the agent's and the
// person can watch and type in. The agent reads back only its own tabs'
// output and stops only its own tabs; the person's tabs are never its to
// read or type in. Each is an ordinary shell with the command typed into
// it, so when the command ends the shell stays, as it would for anyone. Each is its own
// shell with its own id, and they are kept in the order they were opened,
// which is the order the tabs are drawn in. The first one is also what
// the older single-shell routes mean by "the agent's terminal", so a
// client that only knows about one keeps working against the first tab.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { basename, join } from "node:path";

/** What the client sees of a session. */
export interface TerminalInfo {
  /** Which of the agent's shells this is. */
  id: string;
  botId: string;
  /** What its tab says: "Terminal 2" until somebody renames it. */
  title: string;
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
  /** A tab an agent started: who, from which conversation, running what. */
  agent?: AgentTab;
}

/** What makes a tab an agent's own. */
export interface AgentTab {
  name: string;
  /** The conversation that started it. */
  taskId: string;
  command: string;
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

/** Tabs for one agent. Eight is more shells than anybody watches at once,
 * and few enough that a runaway loop pressing + cannot fill the machine
 * with them. */
export const MAX_PER_AGENT = 8;

/** Of those, the most an agent may start itself, so the person always has
 * room for their own. */
export const MAX_AGENT_TABS = 4;

/** A command an agent may type into a tab of its own: one line, as long
 * as a person would type. */
export const MAX_COMMAND = 2000;

/** How much an agent may read back at once, in lines. */
export const READ_LINES = { fallback: 80, max: 400 } as const;

/** And a ceiling on the lot, across every agent. */
export const MAX_SESSIONS = 32;

/** A tab's name is a label, not a paragraph. */
export const MAX_TITLE = 40;

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
 * The name a new tab gets: "Terminal" and the lowest number nobody is
 * using. Closing Terminal 2 of three and opening another gives a new
 * Terminal 2 rather than a Terminal 4, the way a person counting the tabs
 * would number it.
 */
export function terminalTitle(taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const title = `Terminal ${n}`;
    if (!used.has(title)) return title;
  }
}

/**
 * A name somebody typed, made fit to be a tab's: one line, no control
 * characters, not too long. Nothing left means no name, and the caller
 * keeps the one it had rather than drawing an empty tab.
 */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return [...text].slice(0, MAX_TITLE).join("").trim();
}

/** An id a tab can be named by in a path, and nothing else can be. */
export function sessionId(): string {
  return randomBytes(4).toString("hex");
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
 * The pty's size lives in the kernel, and the program that opened the pty
 * (expect, python, script) does not pass a new one on. What can change it
 * is anything allowed to open the terminal device, which this account is,
 * since its shell is on it: `stty -f /dev/ttys005 rows 40 cols 120` from
 * outside sets the size and tells whatever is in the foreground, a full
 * screen program included, the way a terminal app's resize does.
 *
 * Where the device cannot be found, a resize is a line typed into the
 * shell instead, which means it is echoed, and typed into whatever is
 * running if something is: it goes in with a leading space so shells
 * configured to ignore those keep it out of history, and it is not sent
 * for a change nobody would notice.
 */
export function resizeLine(cols: number, rows: number): string {
  return ` stty rows ${rows} cols ${cols} 2>/dev/null\n`;
}

/** The device a `ps -o tty=` answer names, or null for no terminal. */
export function ttyDevice(answer: string): string | null {
  const name = answer.trim();
  if (!name || name.startsWith("?") || !/^[\w/]+$/.test(name) || name.includes("..")) return null;
  return `/dev/${name}`;
}

/** stty's arguments for setting another terminal's size: BSD and macOS
 * name the device with -f, GNU with -F. */
export function sttyArgs(platform: NodeJS.Platform, device: string, cols: number, rows: number): string[] {
  return [platform === "linux" ? "-F" : "-f", device, "rows", String(rows), "cols", String(cols)];
}

/** The system's own stty, by full path for the reason ps is (see PS). */
const STTY = ["/bin/stty", "/usr/bin/stty"];

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 3_000 }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
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

/**
 * Whether something is running in a shell, as opposed to the shell
 * sitting at its prompt.
 *
 * Closing a tab ends its shell, and ending a shell mid-build is the one
 * thing about closing a tab worth asking about first. A terminal knows
 * the answer the way every terminal app knows it: the pty has a
 * foreground process group, and while you are at the prompt that group is
 * the shell's own. Run something and the shell hands the terminal to that
 * job's group, so a foreground group that is not the shell's is a job.
 * Background jobs and a prompt's own helpers (the git status some prompts
 * keep running) never take the terminal, so they never count, which is
 * what you want: they do not make closing a tab any less safe than it
 * looks.
 *
 * Read with ps rather than anything native, for the reason the pty comes
 * from `script` and friends. Without a pty there is no foreground group
 * to read, so any child of the shell counts instead.
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  command: string;
}

/** `ps -A -o pid=,ppid=,pgid=,tpgid=,comm=`, one row per process. The
 * command is last because it is the only column that can have spaces. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      command: match[5].trim(),
    });
  }
  return rows;
}

export interface Foreground {
  running: boolean;
  /** The program's own name, for a question that can say what it is. */
  command?: string;
}

/**
 * What is in the foreground of the shell that `root` started. With a pty,
 * `root` is the program that opened it and the shell is its child; without
 * one, `root` is the shell.
 */
export function foregroundJob(rows: readonly ProcessRow[], root: number, pty: boolean): Foreground {
  const shell = pty ? rows.find((r) => r.ppid === root) : rows.find((r) => r.pid === root);
  if (!shell) return { running: false };
  const name = (row: ProcessRow | undefined) => (row ? basename(row.command.split(" ")[0] || row.command) : undefined);
  if (pty && shell.tpgid > 0) {
    if (shell.tpgid === shell.pgid) return { running: false };
    const leader = rows.find((r) => r.pid === shell.tpgid) ?? rows.find((r) => r.pgid === shell.tpgid);
    return { running: true, command: name(leader) };
  }
  const child = rows.find((r) => r.ppid === shell.pid);
  return child ? { running: true, command: name(child) } : { running: false };
}

/** The system's ps, by its full path: the server can run with a PATH
 * that names nothing, and ps is in one of these two everywhere it exists. */
const PS = ["/bin/ps", "/usr/bin/ps"];

function readProcesses(): Promise<ProcessRow[] | null> {
  const file = PS.find(canRun);
  if (!file) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(file, ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,comm="], { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : parsePs(String(stdout)));
    });
  });
}

type Listener = (chunk: Buffer) => void;
type Ending = () => void;

export interface SessionInput {
  botId: string;
  cwd: string;
  cols: number;
  rows: number;
  now: number;
  /** Kept when a shell is restarted in its tab; made up otherwise. */
  id?: string;
  title?: string;
  /** Told once, when the shell ends on its own or is ended. */
  onExit?: () => void;
  /** An agent's own tab, and the command typed into it once the shell is
   * ready. */
  agent?: AgentTab;
  /** False for an agent's tab restarted by the person: same label, a
   * fresh shell, nothing typed. */
  typeCommand?: boolean;
}

/** One live shell, and everyone watching it. */
export class TerminalSession {
  readonly id: string;
  readonly botId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly pty: boolean;
  /** Which program opened the pty, for the app to report honestly. */
  readonly provider: string;
  readonly startedAt: number;
  title: string;
  cols: number;
  rows: number;
  exitedAt?: number;
  exitCode?: number | null;
  readonly agent?: AgentTab;
  /** When the last client detached, or when it opened if nobody has
   * attached yet. Zero while somebody is watching. */
  idleSince: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private pid: number | undefined;
  private scrollback = new Scrollback();
  private listeners = new Set<Listener>();
  private endings = new Set<Ending>();
  private onExit?: () => void;

  constructor(input: SessionInput) {
    this.id = input.id ?? sessionId();
    this.title = input.title ?? "Terminal 1";
    if (input.agent) this.agent = input.agent;
    this.onExit = input.onExit;
    this.botId = input.botId;
    this.cwd = input.cwd;
    this.cols = clampCols(input.cols);
    this.rows = clampRows(input.rows);
    this.startedAt = input.now;
    // nobody watching from the start: a shell opened for a panel that
    // never attached would otherwise count as watched, and never be swept
    this.idleSince = input.now;
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
    this.pid = this.child.pid;

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
    // An agent's command is typed in once the shell has said something
    // (its prompt), or after a moment if it says nothing: typed before the
    // shell reads its keyboard, a line can be lost to its start-up.
    if (input.agent?.command && input.typeCommand !== false) {
      // Return in a pty, a newline to a shell reading a pipe
      const line = `${input.agent.command}${this.pty ? "\r" : "\n"}`;
      let typed = false;
      const type = () => {
        if (typed) return;
        typed = true;
        clearTimeout(timer);
        this.child?.stdout.off("data", type);
        setTimeout(() => this.write(line), 60);
      };
      const timer = setTimeout(type, 1_500);
      this.child.stdout.on("data", type);
    }
  }

  private settle(code: number | null) {
    if (this.exitedAt) return;
    this.exitedAt = Date.now();
    this.exitCode = code;
    this.child = null;
    // The panel should say the shell has gone rather than sit there
    // looking live, and the only one who knows is this.
    for (const ending of this.endings) ending();
    this.onExit?.();
  }

  get alive(): boolean {
    return Boolean(this.child) && !this.exitedAt;
  }

  get watchers(): number {
    return this.listeners.size;
  }

  info(): TerminalInfo {
    return {
      id: this.id,
      botId: this.botId,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      pty: this.pty,
      provider: this.provider,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      ...(this.exitedAt ? { exitedAt: this.exitedAt, exitCode: this.exitCode ?? null } : {}),
      ...(this.agent ? { agent: { ...this.agent } } : {}),
    };
  }

  /** The last `lines` lines of what it printed, as plain text: what an
   * agent reads back from a tab of its own. */
  tail(lines: number): string {
    return lastLines(plainText(this.scrollback.read().toString("utf8")), lines);
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
    if (!this.pty) return;
    // one at a time and in order, so a drag's last size is the one that
    // sticks rather than whichever stty happened to finish last
    this.resizing = this.resizing.then(async () => {
      if (this.cols !== next.cols || this.rows !== next.rows) return;
      if (!(await this.resizeQuietly(next.cols, next.rows))) this.write(resizeLine(next.cols, next.rows));
    });
  }

  private resizing: Promise<void> = Promise.resolve();
  /** The pty's device, once found; null once known not to be findable. */
  private device: string | null | undefined;

  /** Sets the size from outside the shell, without typing anything into
   * it. False when that cannot be done here. */
  private async resizeQuietly(cols: number, rows: number): Promise<boolean> {
    if (process.platform === "win32" || !this.alive) return false;
    const stty = STTY.find(canRun);
    const ps = PS.find(canRun);
    if (!stty || !ps || !this.pid) return false;
    if (this.device === undefined) {
      // the shell is the pty program's child, and the pty is its terminal
      const processes = await readProcesses();
      const shell = processes?.find((r) => r.ppid === this.pid);
      const answer = shell ? await run(ps, ["-o", "tty=", "-p", String(shell.pid)]) : null;
      this.device = answer === null ? null : ttyDevice(answer);
    }
    if (!this.device) return false;
    return (await run(stty, sttyArgs(process.platform, this.device, cols, rows))) !== null;
  }

  /** Forget what was printed, so a client that comes back after Clear is
   * not shown it all again. */
  clearScrollback() {
    this.scrollback.clear();
  }

  /** Whether a program is running in the foreground, for the question
   * before a tab is closed. A shell that has ended runs nothing, and a
   * system that will not say is taken to be running nothing too: the
   * question is a courtesy, and failing to ask is better than refusing
   * to close. */
  async foreground(): Promise<Foreground> {
    if (!this.alive || !this.pid || process.platform === "win32") return { running: false };
    const rows = await readProcesses();
    return rows ? foregroundJob(rows, this.pid, this.pty) : { running: false };
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

/** A tab more than an agent may have, or than the machine will hold. */
export class TerminalLimitError extends Error {}

/** What changed among one agent's shells, for a client drawing their tabs. */
export type TerminalEvent =
  | { kind: "opened" | "replaced" | "renamed" | "exited"; session: TerminalSession }
  | { kind: "closed"; id: string };

/**
 * Every open shell, grouped by agent, each agent's in the order they were
 * opened. Calls that take no session id mean the agent's first shell,
 * which is what an agent's terminal meant before there could be more than
 * one, except close, which without an id closes them all: that is what
 * archiving an agent and quitting the app both mean.
 */
export class TerminalStore {
  private agents = new Map<string, Map<string, TerminalSession>>();
  private watchers = new Map<string, Set<(event: TerminalEvent) => void>>();

  /** One agent's shells, oldest first. */
  sessions(botId: string): TerminalSession[] {
    return [...(this.agents.get(botId)?.values() ?? [])];
  }

  get(botId: string, id?: string): TerminalSession | null {
    const mine = this.agents.get(botId);
    if (!mine) return null;
    if (id === undefined) return mine.values().next().value ?? null;
    return mine.get(id) ?? null;
  }

  /** One agent's shells as the client sees them, or everybody's. */
  list(botId?: string): TerminalInfo[] {
    return (botId === undefined ? this.all() : this.sessions(botId)).map((s) => s.info());
  }

  /** How many shells are open, across every agent. */
  get size(): number {
    let n = 0;
    for (const mine of this.agents.values()) n += mine.size;
    return n;
  }

  /** Hear about one agent's shells opening, closing and being renamed.
   * Returns the way to stop. */
  watch(botId: string, listener: (event: TerminalEvent) => void): () => void {
    let set = this.watchers.get(botId);
    if (!set) this.watchers.set(botId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.watchers.delete(botId);
    };
  }

  private emit(botId: string, event: TerminalEvent) {
    for (const listener of this.watchers.get(botId) ?? []) {
      try {
        listener(event);
      } catch {
        /* one broken watcher does not cost the others their news */
      }
    }
  }

  /** A new session that tells this store when it ends, so the tabs can
   * say so without anybody having to be attached to it. */
  private spawn(input: SessionInput): TerminalSession {
    const session: TerminalSession = new TerminalSession({
      ...input,
      onExit: () => {
        if (this.agents.get(input.botId)?.get(session.id) === session) this.emit(input.botId, { kind: "exited", session });
      },
    });
    return session;
  }

  /** Room for one more, across every agent: the shell nobody has looked
   * at for longest goes, and a shell somebody is watching never does. */
  private makeRoom() {
    if (this.size < MAX_SESSIONS) return;
    const [oldest] = this.all()
      .filter((s) => s.idleSince > 0)
      .sort((a, b) => a.idleSince - b.idleSince);
    if (!oldest) throw new TerminalLimitError("There are too many terminals open. Close one and try again.");
    this.close(oldest.botId, oldest.id);
  }

  /**
   * The agent's first session, opening one if there is none. A shell that
   * has exited is replaced rather than resurrected, so pressing the button
   * again after `exit` does the obvious thing, and so is one whose folder
   * is not the agent's any more. Replaced in its place, under its name:
   * it is the same tab with a new shell in it.
   */
  open(input: { botId: string; cwd: string; cols: number; rows: number; now: number }): TerminalSession {
    const existing = this.get(input.botId);
    if (existing && existing.alive && existing.cwd === input.cwd) return existing;
    if (existing) return this.restart(input.botId, existing.id, input)!;
    return this.create(input);
  }

  /** A new tab for this agent, named after the lowest free number. */
  create(input: { botId: string; cwd: string; cols: number; rows: number; now: number; title?: string; agent?: AgentTab }): TerminalSession {
    const mine = this.agents.get(input.botId) ?? new Map<string, TerminalSession>();
    if (mine.size >= MAX_PER_AGENT) {
      throw new TerminalLimitError(`${MAX_PER_AGENT} terminals is the most one agent can have open. Close one first.`);
    }
    if (input.agent && [...mine.values()].filter((s) => s.agent).length >= MAX_AGENT_TABS) {
      throw new TerminalLimitError(`${MAX_AGENT_TABS} tabs of your own is the most you can have open. Stop one first (\`bloks terminal stop <tab>\`).`);
    }
    this.makeRoom();
    const title = cleanTitle(input.title) ?? terminalTitle([...mine.values()].map((s) => s.title));
    const session = this.spawn({ ...input, title });
    // the agent's map may have been emptied and dropped by makeRoom
    this.agents.set(input.botId, mine);
    mine.set(session.id, session);
    this.emit(input.botId, { kind: "opened", session });
    return session;
  }

  /** A new shell in an existing tab: same id, same name, same place in
   * the strip, the old shell ended. */
  restart(
    botId: string,
    id: string,
    input: { cwd: string; cols: number; rows: number; now: number },
  ): TerminalSession | null {
    const mine = this.agents.get(botId);
    const old = mine?.get(id);
    if (!mine || !old) return null;
    // an agent's tab stays the agent's, its command not typed again: a
    // restart is the person's, for a fresh shell
    const session = this.spawn({ ...input, botId, id, title: old.title, ...(old.agent ? { agent: old.agent, typeCommand: false } : {}) });
    // Set on a key a Map already has keeps the key's place, so the tab
    // stays where it was. The old shell is ended after it has been
    // replaced, which is also why its ending is not reported as news.
    mine.set(id, session);
    old.close();
    this.emit(botId, { kind: "replaced", session });
    return session;
  }

  rename(botId: string, id: string, raw: unknown): TerminalSession | null {
    const session = this.get(botId, id);
    const title = cleanTitle(raw);
    if (!session || !title) return null;
    session.title = title;
    this.emit(botId, { kind: "renamed", session });
    return session;
  }

  /** Ends one shell, or every shell the agent has when no id is given. */
  close(botId: string, id?: string) {
    const mine = this.agents.get(botId);
    if (!mine) return;
    const ids = id === undefined ? [...mine.keys()] : [id];
    for (const each of ids) {
      const session = mine.get(each);
      if (!session) continue;
      // out of the map first, so its ending is reported as a close
      mine.delete(each);
      session.close();
      this.emit(botId, { kind: "closed", id: each });
    }
    if (!mine.size) this.agents.delete(botId);
  }

  closeAll() {
    for (const botId of [...this.agents.keys()]) this.close(botId);
  }

  /** Shells nobody has watched for a long time, and shells that ended. */
  sweep(now: number) {
    for (const session of this.all()) {
      const gone = session.exitedAt && now - session.exitedAt > 60_000 && !session.watchers;
      const stale = session.idleSince && now - session.idleSince > IDLE_MS;
      if (gone || stale) this.close(session.botId, session.id);
    }
  }

  private all(): TerminalSession[] {
    return [...this.agents.values()].flatMap((m) => [...m.values()]);
  }
}

// ── what an agent reads back ───────────────────────────────────────────

/**
 * A terminal's bytes as the text a person would see: escape sequences
 * (colours, cursor moves, titles) taken out, a carriage return starting
 * its line again the way a progress bar redraws, and a backspace taking
 * back the character before it.
 */
export function plainText(raw: string): string {
  const stripped = raw
    // OSC: ESC ] ... BEL or ESC \
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // CSI: ESC [ params final
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // the other two-character escapes
    .replace(/\u001b[@-Z\\-_]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g, (c) => (c === "\b" ? c : ""));
  return stripped
    .split("\n")
    .map((line) => {
      // what follows the last carriage return wrote over what came before
      const parts = line.replace(/\r+$/, "").split("\r");
      let out = "";
      for (const part of parts) out = part + out.slice(part.length);
      let kept = "";
      for (const ch of out) kept = ch === "\b" ? kept.slice(0, -1) : kept + ch;
      return kept.replace(/\s+$/, "");
    })
    .join("\n");
}

/** The last `n` lines, with trailing blank ones left out. */
export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-Math.max(1, n)).join("\n");
}

/** How many lines an agent asked for, kept within what it may read. */
export function readLines(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(READ_LINES.max, n) : READ_LINES.fallback;
}

/** A command fit to type into a tab: one line, no control characters,
 * not empty, not too long. Null with nothing left. */
export function cleanCommand(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw)) return null;
  const text = raw.trim();
  if (!text || text.length > MAX_COMMAND) return null;
  return text;
}
