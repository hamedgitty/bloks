// JSON-RPC over a child process's stdio.
//
// Two of the agent CLIs we drive speak JSON-RPC across newline-delimited
// stdio: Codex over its app-server protocol, and anything implementing
// ACP. The protocols above the transport are nothing alike, but the
// transport itself is identical, and it has three fiddly parts worth
// writing once:
//
//   framing        stdout arrives in arbitrary chunks, so lines have to be
//                  reassembled rather than assumed.
//   correlation    our requests get numeric ids and resolve out of order.
//   direction      a frame with an id AND a method is the child asking us
//                  something, which is a different thing entirely from a
//                  frame with an id and a result. Conflating them is how a
//                  permission prompt ends up silently ignored.
//
// Not protocol-aware beyond that. It routes; the drivers interpret.
import type { Readable, Writable } from "node:stream";

export interface RpcLink {
  /** Call the child and wait for its reply. */
  request(method: string, params?: unknown): Promise<any>;
  /** Tell the child something, expecting no reply. */
  notify(method: string, params?: unknown): void;
  /** Answer a request the child made of us. */
  reply(id: unknown, result: unknown): void;
  /** Refuse a request the child made of us. */
  replyError(id: unknown, code: number, message: string): void;
  /** Fail every in-flight request. Called when the turn ends, so nothing
   * is left waiting on a process that is about to be killed. */
  failPending(reason: Error): void;
}

export interface RpcOptions {
  stdin: Writable;
  stdout: Readable;
  /** The child is asking us something and wants an answer. */
  onRequest: (message: any) => void;
  /** The child is telling us something. */
  onNotify: (message: any) => void;
  /** Every decoded frame, in either direction, for the native log. */
  onFrame?: (message: any, direction: "in" | "out") => void;
}

export function attachRpc(options: RpcOptions): RpcLink {
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let nextId = 1;

  const write = (frame: unknown) => {
    try {
      options.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // The child died. Whoever owns the turn notices via its close
      // handler; there is nothing useful to do from here.
    }
    options.onFrame?.(frame, "out");
  };

  let buffered = "";
  options.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const cut = buffered.indexOf("\n");
      if (cut === -1) break;
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      if (!line.trim()) continue;

      let frame: any;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // CLIs log to stdout too; not everything is protocol
      }
      options.onFrame?.(frame, "in");

      const hasId = frame.id !== undefined;
      const isReply = hasId && (frame.result !== undefined || frame.error !== undefined);

      if (isReply) {
        const waiting = pending.get(frame.id);
        if (!waiting) continue;
        pending.delete(frame.id);
        if (frame.error) {
          waiting.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)));
        } else {
          waiting.resolve(frame.result);
        }
      } else if (hasId && frame.method) {
        options.onRequest(frame);
      } else if (frame.method) {
        options.onNotify(frame);
      }
    }
  });

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    reply(id, result) {
      write({ jsonrpc: "2.0", id, result });
    },
    replyError(id, code, message) {
      write({ jsonrpc: "2.0", id, error: { code, message } });
    },
    failPending(reason) {
      for (const waiting of pending.values()) waiting.reject(reason);
      pending.clear();
    },
  };
}
