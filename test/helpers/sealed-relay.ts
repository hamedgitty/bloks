// A stand-in for Bloks Cloud that does what it does and nothing more:
// carries sealed asks from a device to the workspace and its sealed
// answers back, and the workspace's sealed frames out to every device's
// stream. With the app's own remote proxy (electron/remote.mjs) in front,
// a request takes the path the Mac app takes to a workspace on a server
// elsewhere, and the server sees it exactly as it would then.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export async function sealedRelay() {
  const pending = new Map<string, ServerResponse>();
  let upstream: ServerResponse | null = null;
  const devices = new Set<ServerResponse>();
  let connected!: () => void;
  const connection = new Promise<void>((resolve) => (connected = resolve));
  const server = createServer(async (req, res) => {
    const path = req.url?.split("?")[0];
    if (path === "/space/agent/stream") {
      upstream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","spaceId":"fixture-space"}\n\n');
      connected();
      return;
    }
    if (path === "/space/client/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"kind":"hello","online":true}\n\n');
      devices.add(res);
      req.on("close", () => devices.delete(res));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (path === "/space/client/ask") {
      if (!upstream) return void res.writeHead(503).end("{}");
      const id = randomUUID();
      pending.set(id, res);
      upstream.write(`data: ${JSON.stringify({ kind: "ask", id, payload: body.payload })}\n\n`);
      return;
    }
    if (path === "/space/agent/result") {
      const answer = pending.get(body.id);
      pending.delete(body.id);
      answer?.writeHead(200, { "content-type": "application/json" });
      answer?.end(JSON.stringify({ payload: body.payload }));
    }
    if (path === "/space/agent/events") {
      for (const payload of body.frames ?? []) {
        for (const device of devices) device.write(`data: ${JSON.stringify({ kind: "frame", payload })}\n\n`);
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    /** Once the workspace has dialled in. */
    connection,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
