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
import { existsSync } from "node:fs";

/** Where Chrome listens when we start it, and where we look first. */
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

/**
 * Start a browser for the agent, in its own profile directory.
 *
 * Deliberately not the person's own Chrome: an agent and a human
 * fighting over one window is miserable, and a profile of its own is
 * also where imported cookies go, so the agent can be signed in
 * everywhere without touching the real browser's session.
 */
export async function launch(profileDir: string, port = DEFAULT_PORT): Promise<void> {
  if (await isListening(port)) return;
  const binary = chromePath();
  if (!binary) throw new Error("no Chrome, Chromium, Brave or Edge found on this machine");
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
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
    if (await isListening(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the browser did not open its debugging port");
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

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const failed = (event: Event | CloseEvent) =>
        reject(new Error(`could not attach to the page (${(event as CloseEvent).code ?? "error"})`));
      socket.addEventListener("open", () => {
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
