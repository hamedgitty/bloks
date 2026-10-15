// A loopback-only relay and paired synthetic phone, for actual wake previews.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { deviceKey, open, peek } from "../../server/relay-crypto.ts";
import { waitFor } from "./turns.ts";
import type { Harness } from "./server.ts";

export async function chainRelay(t: TestContext, h: Harness) {
  await h.json("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", { method: "POST", body: JSON.stringify({ code: started.code, device: "Example phone" }) });
  const digest = createHash("sha256").update(claimed.token).digest("hex");
  const key = deviceKey(digest, "mac-to-phone");
  const previews: any[] = [];
  let connected = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/space/agent/stream")) {
      connected = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "example-space" })}\n\n`);
      return;
    }
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const pushed = JSON.parse(body || "{}");
      const sealed = pushed.wake?.sealed?.[claimed.device.id];
      if (sealed) previews.push(open(key, peek(sealed)!));
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await h.json("/api/relay", { method: "PUT", body: JSON.stringify({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, agentToken: "example-agent-token", enabled: true }) });
  assert.ok(await waitFor(() => connected ? true : null), "the isolated server did not connect to its relay");
  return previews;
}
