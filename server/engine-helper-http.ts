import type { IncomingMessage, ServerResponse } from "node:http";
import { EngineHelperBroker, HelperError } from "./engine-helper.ts";
import { EnginePauseError } from "./engine-pauses.ts";

const base = "/api/engine-helper-runs";
const loopback = (host: string | undefined) => !!host && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(host);
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const piece of req) {
    const data = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    bytes += data.length; if (bytes > 2_000_000) throw new HelperError("invalid"); parts.push(data);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts))); }
  catch { throw new HelperError("invalid"); }
}
/** Must run before broad bearer/owner routing. Returns true for this namespace
 * even on denied requests, so a helper token can never fall through as owner.
 * The configured origin comes from the native listener, never request headers. */
export function engineHelperHttp(broker: EngineHelperBroker, nativeOrigin: string) {
  const origin = new URL(nativeOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Engine helper requires an exact local origin.");
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawPath = req.url?.split("?")[0] ?? "";
    if (rawPath !== base && !rawPath.startsWith(`${base}/`)) return false;
    try {
      if (!loopback(req.socket.remoteAddress) || req.headers.host !== origin.host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin.origin) ||
          req.rawHeaders.filter((_, i) => i % 2 === 0).filter(h => h.toLowerCase() === "authorization").length !== 1) throw new HelperError("forbidden");
      const auth = req.headers.authorization?.match(/^EngineHelper ([A-Za-z0-9_-]{43})$/);
      if (!auth) throw new HelperError("forbidden");
      const token = auth[1], url = new URL(req.url!, origin);
      if (url.origin !== origin.origin || /%/.test(rawPath)) throw new HelperError("forbidden");
      if (rawPath === base && req.method === "POST" && !url.search) {
        const input = await body(req);
        try { json(res, 200, await broker.start(token, input)); }
        catch (error) {
          if ((error instanceof HelperError && error.code === "pending") ||
              (error instanceof EnginePauseError && ["paused", "activating", "storage", "closed"].includes(error.code))) {
            const request = input as Record<string, unknown>;
            // start validated the submitted shape before reaching admission.
            json(res, 200, { version: 1, operationId: request.operationId, phase: request.phase, state: "pending", reason: error.code });
          } else throw error;
        }
        return true;
      }
      const match = rawPath.match(/^\/api\/engine-helper-runs\/([0-9a-f-]{36})(\/events)?$/i);
      if (!match) throw new HelperError("invalid");
      const id = match[1];
      if (!match[2] && req.method === "DELETE" && !url.search) { json(res, 200, await broker.cancel(token, id)); return true; }
      if (match[2] && req.method === "GET") {
        if ([...url.searchParams.keys()].some(k => k !== "after") || url.searchParams.getAll("after").length > 1) throw new HelperError("cursor");
        const after = url.searchParams.get("after") ?? "0";
        if (!/^(0|[1-9][0-9]*)$/.test(after)) throw new HelperError("cursor");
        let cursor = Number(after), flushed = false, draining = false;
        let subscription: ReturnType<EngineHelperBroker["attach"]> | undefined;
        const flush = () => {
          if (!subscription || res.destroyed || res.writableEnded || draining) return;
          const events = broker.events(token, id, cursor);
          for (const event of events) {
            cursor = event.seq;
            // Bounded broker retention plus native response backpressure.
            if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) {
              // A normal 16KiB chunk may exceed the stream high-water mark.
              // Pause delivery while Node drains it; do not treat this as a
              // disconnect or silently drop the queued chunk.
              draining = true;
              res.once("drain", () => { draining = false; flush(); });
              return;
            }
          }
          const all = broker.events(token, id);
          if (all.some(e => e.type === "terminal")) { flushed = true; res.end(); subscription.detach(); }
        };
        subscription = broker.attach(token, id, cursor, flush);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.flushHeaders();
        res.on("close", () => { if (!flushed) subscription?.detach(); });
        flush(); return true;
      }
      throw new HelperError("invalid");
    } catch (error) {
      const code = error instanceof HelperError ? error.code : error instanceof EnginePauseError ? error.code : "pending";
      if (!res.headersSent) json(res, code === "forbidden" ? 403 : code === "conflict" ? 409 : code === "storage" ? 503 : 400, { error: `Engine helper ${code}.`, reason: code });
      else res.destroy();
      return true;
    }
  };
}
