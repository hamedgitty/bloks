// Talking to a real browser, over its own debugging protocol.
//
// Bloks already drives a computer by screenshot and coordinate, which is
// the right tool for a native app and the wrong one for the web. A page
// will tell you what is on it if you ask properly: what the controls
// are, what they are called, and where they sit. Asking is cheaper than
// a screenshot, survives a layout that shifts under you, and does not
// need a model to read pixels to find a button.
//
// This is the transport half. No dependency: Chrome speaks JSON over a
// WebSocket, and Node has had one since 22.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Where a browser somebody started by hand is looked for, when there is
 * no profile of ours to start one in. Ours never listen here: each picks
 * a free port of its own (launch). */
export const DEFAULT_PORT = 9222;

export interface Target {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
}

const endpoint = (port: number) => `http://127.0.0.1:${port}`;

/** Pages worth attaching to, newest-looking first. Extensions, service
 * workers and the devtools UI itself are not pages a person means. */
export async function listTargets(port = DEFAULT_PORT): Promise<Target[]> {
  const response = await fetch(`${endpoint(port)}/json/list`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Chrome answered HTTP ${response.status}`);
  const all = (await response.json()) as Target[];
  return all.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      !target.url.startsWith("devtools://") &&
      !target.url.startsWith("chrome-extension://"),
  );
}

export async function isListening(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint(port)}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Chrome, wherever this machine keeps it. */
export function chromePath(): string | null {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** The browser-wide socket a debugging port answers for, or null. */
async function browserSocket(port: number): Promise<string | null> {
  try {
    const response = await fetch(`${endpoint(port)}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const version = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    return typeof version.webSocketDebuggerUrl === "string" ? version.webSocketDebuggerUrl : null;
  } catch {
    return null;
  }
}

/**
 * The debugging port of the browser running on `profileDir`, or null when
 * none is. Chrome writes the port it took into DevToolsActivePort in the
 * profile, with its own socket's path on the next line. The port counts
 * only while it still answers with that path: the file outlives a browser
 * that crashed, and by then the port may be anything else's.
 */
export async function profilePort(profileDir: string): Promise<number | null> {
  let lines: string[];
  try {
    lines = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").split("\n");
  } catch {
    return null;
  }
  const port = Number(lines[0]);
  const path = lines[1]?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path?.startsWith("/devtools/browser/")) return null;
  const socket = await browserSocket(port);
  return socket?.endsWith(path) ? port : null;
}

/** One start per profile at a time: two tools asking at once share it. */
const starting = new Map<string, Promise<number>>();

/**
 * Start a browser for the agent, in its own profile directory, unless one
 * is already running there, and say which port it listens on.
 *
 * Deliberately not the person's own Chrome: an agent and a human
 * fighting over one window is miserable, and a profile of its own is
 * also where imported cookies go, so the agent can be signed in
 * everywhere without touching the real browser's session.
 *
 * Each profile is a browser on a port of its own, which Chrome picks. A
 * port shared by every profile meant whichever started first answered
 * for all of them: a second agent, or a shared room that must never be
 * signed in as the owner, drove the first agent's signed-in browser.
 */
export function launch(profileDir: string, binary = chromePath()): Promise<number> {
  const already = starting.get(profileDir);
  if (already) return already;
  const start = startBrowser(profileDir, binary).finally(() => starting.delete(profileDir));
  starting.set(profileDir, start);
  return start;
}

async function startBrowser(profileDir: string, binary: string | null): Promise<number> {
  const running = await profilePort(profileDir);
  if (running) return running;
  if (!binary) throw new Error("no Chrome, Chromium, Brave or Edge found on this machine");
  // left by a browser that is gone, it could only mislead the wait below
  rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  const child = spawn(
    binary,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // The agent's window should not restore the last session or nag
      // about being the default; it is a tool, not somebody's browser.
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await profilePort(profileDir);
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the browser did not open its debugging port");
}

/**
 * Closes the browser running on `profileDir`, if one is, whoever started
 * it: the protocol's own Browser.close, so it shuts down as if quit and
 * keeps its sign-ins. True when there was one to close.
 */
export async function closeBrowser(profileDir: string): Promise<boolean> {
  const port = await profilePort(profileDir);
  const socket = port ? await browserSocket(port) : null;
  if (!socket) return false;
  const browser = new Session(socket);
  try {
    await browser.open(3_000);
    // the browser may be gone before it answers, which is the point
    await browser.send("Browser.close", {}, 3_000).catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    browser.close();
  }
}

/** One page, and the calls we make to it. */
export class Session {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  /** Whether the socket to the page is still up. A tab that closed
   * leaves a session object behind that can no longer do anything. */
  get attached(): boolean {
    return this.socket !== null;
  }

  async open(timeoutMs = 10_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      // like every call on it, attaching is bounded: a debugging port that
      // accepts the connection and never finishes the upgrade would
      // otherwise hold the tool, and the turn, forever
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* never opened */
        }
        reject(new Error("could not attach to the page in time"));
      }, timeoutMs);
      const failed = (event: Event | CloseEvent) => {
        clearTimeout(timer);
        reject(new Error(`could not attach to the page (${(event as CloseEvent).code ?? "error"})`));
      };
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.removeEventListener("error", failed);
        resolve();
      });
      socket.addEventListener("error", failed);
      socket.addEventListener("message", (event) => this.receive(String(event.data)));
      socket.addEventListener("close", () => {
        for (const waiter of this.pending.values()) waiter.reject(new Error("the page closed"));
        this.pending.clear();
        this.socket = null;
      });
    });
  }

  private receive(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    // Events are not answers to anything; only replies carry an id.
    if (typeof message.id !== "number") return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "the page refused that"));
    else waiter.resolve(message.result);
  }

  /** One protocol call. Every one is bounded: a page that never answers
   * should fail the tool, not hang the turn. */
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("not attached to a page"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Run an expression in the page and hand back its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "the page threw";
      throw new Error(String(text).split("\n")[0]);
    }
    return result?.result?.value as T;
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
  }
}
