// Talking to an MCP server ourselves.
//
// Until now the app registered MCP servers and handed them to whichever
// engine was running the turn: the engine connected, called the tools and
// we never saw either side of it. That is right for tool calls during a
// turn, and useless for anything the app wants to show a person, because
// a server's own interface is not something an engine can hand back.
//
// So this is a small client of our own. It speaks the two transports the
// registry allows, it does the handshake, and it exposes the four calls a
// UI needs: what tools are there, what resources are there, read one, run
// one. Nothing else. The protocol is larger than this and the rest of it
// belongs to the engines.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { attachRpc, type RpcLink } from "./harness/jsonrpc-stdio.ts";

/** What the registry stores for one server. */
export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** One part of a resource, however the server chose to send it. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** The client's half of the handshake. Advertising nothing is honest:
 * this connection reads and calls, it does not sample or elicit. */
const CLIENT_INFO = { name: "bloks", version: "1" };
const PROTOCOL = "2025-06-18";

/** A server that will not answer within this is not going to. */
export const CALL_TIMEOUT_MS = 20_000;
/** A connection nobody has used for this long is closed. */
export const IDLE_MS = 5 * 60 * 1000;
/** Anything a server sends back is capped before it reaches a client. */
export const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;

export interface McpConnection {
  request(method: string, params?: unknown): Promise<any>;
  close(): void;
}

// ── stdio ──────────────────────────────────────────────────────────────

function connectStdio(config: McpServerConfig): McpConnection {
  if (!config.command) throw new Error("that server has no command to run");
  const child = spawn(config.command, config.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  let link: RpcLink | null = attachRpc({
    stdin: child.stdin,
    stdout: child.stdout,
    // A server may ask us things (sampling, roots). We are not that kind
    // of client, and a request left unanswered wedges the server, so
    // everything gets a refusal rather than silence.
    onRequest: (message) => {
      if (message?.id !== undefined) {
        link?.replyError(message.id, -32601, "this client does not serve requests");
      }
    },
    onNotify: () => {},
  });
  // stderr is the server's own log, and reading it keeps the pipe from
  // filling up and stalling a server that is chatty about its startup
  child.stderr.resume();

  const close = () => {
    link?.failPending(new Error("the connection closed"));
    link = null;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  // A command that does not exist raises error and never exits, so
  // without this every call against a mistyped server waits forever.
  child.on("error", (e) => {
    link?.failPending(new Error(`that server would not start: ${e.message}`));
    link = null;
  });
  child.on("exit", () => {
    link?.failPending(new Error("the server exited"));
    link = null;
  });

  return {
    request: (method, params) => {
      if (!link) return Promise.reject(new Error("the server is not running"));
      return link.request(method, params);
    },
    close,
  };
}

// ── http ───────────────────────────────────────────────────────────────

/**
 * One JSON-RPC frame out of an answer that may be a JSON body or an event
 * stream, because a streamable HTTP server is allowed to reply either way
 * and which one you get is not something a caller should have to care
 * about.
 */
export function unwrapFrame(body: string): any {
  const text = body.trim();
  const envelope = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .find((line) => line.startsWith("{"));
  if (!envelope) throw new Error("that server returned nothing we could read");
  const message = JSON.parse(envelope);
  if (message.error) throw new Error(message.error.message || "that server returned an error");
  return message.result ?? null;
}

function connectHttp(config: McpServerConfig): McpConnection {
  if (!config.url) throw new Error("that server has no address");
  const url = config.url;
  let id = 0;
  let session: string | null = null;
  let closed = false;

  return {
    async request(method, params) {
      if (closed) throw new Error("the connection closed");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session } : {}),
          ...(config.headers ?? {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // the session id arrives on the initialize response and every later
      // call has to carry it back
      session = response.headers.get("mcp-session-id") ?? session;
      if (!response.ok) throw new Error(`that server answered HTTP ${response.status}`);
      return unwrapFrame(await response.text());
    },
    close() {
      closed = true;
    },
  };
}

// ── the client ─────────────────────────────────────────────────────────

interface Held {
  connection: McpConnection;
  ready: Promise<void>;
  usedAt: number;
}

/**
 * Connections, one per server, opened on demand and dropped when nobody
 * has used them for a while. A stdio server is a process, so leaving one
 * running per registered server for the life of the app would be a lot of
 * processes for a panel somebody opens twice a week.
 */
export class McpClient {
  private held = new Map<string, Held>();

  private open(config: McpServerConfig): Held {
    const connection =
      config.transport === "http" ? connectHttp(config) : connectStdio(config);
    const ready = (async () => {
      await McpClient.timed(
        connection.request("initialize", {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        }),
        "the handshake",
      );
      // the spec's handshake: the server is not to be called until it has
      // been told the client is ready
      await connection.request("notifications/initialized").catch(() => {});
    })();
    const held: Held = { connection, ready, usedAt: Date.now() };
    this.held.set(config.id, held);
    return held;
  }

  private async use(config: McpServerConfig): Promise<McpConnection> {
    let held = this.held.get(config.id);
    if (!held) held = this.open(config);
    held.usedAt = Date.now();
    try {
      await held.ready;
    } catch (e) {
      this.close(config.id);
      throw e;
    }
    return held.connection;
  }

  /**
   * Every call is timed.
   *
   * The transports fail in different ways and one of them, a process that
   * starts and then says nothing, does not fail at all. A server is
   * somebody else's program: it does not get to hold a request open for
   * as long as it likes, whatever the reason.
   */
  private static timed<T>(work: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`that server did not answer ${what} in time`)),
        CALL_TIMEOUT_MS,
      );
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async tools(config: McpServerConfig): Promise<McpTool[]> {
    const connection = await this.use(config);
    const result = await McpClient.timed(connection.request("tools/list", {}), "what tools it has");
    const list = Array.isArray(result?.tools) ? result.tools : [];
    return list.filter((t: any) => typeof t?.name === "string").slice(0, 200);
  }

  async resources(config: McpServerConfig): Promise<McpResource[]> {
    const connection = await this.use(config);
    // A server with nothing to show says so by not implementing this, and
    // that is a fact about the server rather than a failure to report.
    const result = await McpClient.timed(connection.request("resources/list", {}), "what it publishes").catch(
      () => null,
    );
    const list = Array.isArray(result?.resources) ? result.resources : [];
    return list.filter((r: any) => typeof r?.uri === "string").slice(0, 200);
  }

  async read(config: McpServerConfig, uri: string): Promise<McpResourceContents[]> {
    const connection = await this.use(config);
    const result = await McpClient.timed(connection.request("resources/read", { uri }), "that app");
    const parts = Array.isArray(result?.contents) ? result.contents : [];
    return parts.filter((p: any) => typeof p?.uri === "string");
  }

  async call(config: McpServerConfig, name: string, args: unknown): Promise<any> {
    const connection = await this.use(config);
    return await McpClient.timed(
      connection.request("tools/call", { name, arguments: args ?? {} }),
      "that tool",
    );
  }

  close(id: string) {
    const held = this.held.get(id);
    if (!held) return;
    this.held.delete(id);
    try {
      held.connection.close();
    } catch {
      /* already gone */
    }
  }

  closeAll() {
    for (const id of [...this.held.keys()]) this.close(id);
  }

  sweep(now: number) {
    for (const [id, held] of this.held) {
      if (now - held.usedAt > IDLE_MS) this.close(id);
    }
  }
}
