// Metadata callers must ask for no transcript before reading a room's history.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const MCP = fileURLToPath(new URL("../bin/bloks-mcp.mjs", import.meta.url));

test("the actual CLI and MCP discover rooms without carrying transcripts", async (t) => {
  const seen: string[] = [];
  const room = { id: "11111111-1111-4111-8111-111111111111", name: "Plans", memberIds: ["reader"], messages: [] };
  const server = createServer((req, res) => {
    const path = req.url ?? "";
    seen.push(path);
    res.setHeader("content-type", "application/json");
    if (path.startsWith("/api/bloks") && !path.includes("/messages") && path !== "/api/bloks?messages=0") {
      res.writeHead(400);
      return void res.end(JSON.stringify({ error: "room discovery must request messages=0" }));
    }
    const body = path === "/api/bloks?messages=0"
      ? { bloks: [room] }
      : path === "/api/bots?messages=0"
        ? { bots: [{ id: "reader", name: "Reader" }] }
        : { messages: [{ id: "line", kind: "text", role: "user", text: "The full history line" }] };
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const environment = { PATH: process.env.PATH!, BLOKS_URL: `http://127.0.0.1:${(server.address() as any).port}`, BLOKS_TOKEN: "fixture-turn-token" };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await t.test("CLI rooms uses a zero transcript and keeps its output", async () => {
    const child = spawn(process.execPath, [CLI, "rooms"], { env: environment });
    let out = "", error = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (error += chunk));
    const exit = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exit, 0, error || out);
    assert.deepEqual(JSON.parse(out), [{ id: room.id, name: "Plans", members: ["reader"] }]);
  });
  const child = spawn(process.execPath, [MCP], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const pending = new Map<number, (value: any) => void>();
  let next = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const answer = JSON.parse(line);
    pending.get(answer.id)?.(answer);
    pending.delete(answer.id);
  });
  const tool = (name: string, args: Record<string, unknown> = {}) => {
    const id = ++next;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP fixture did not answer")); }, 10_000);
      pending.set(id, (value) => { clearTimeout(timer); resolve(value.result); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return result;
  };
  await t.test("MCP room listing uses only metadata", async () => {
    const result = await tool("list_rooms");
    assert.equal(result.isError ?? false, false, result.content[0].text);
    assert.equal(result.content[0].text, "- Plans: Reader");
  });
  await t.test("MCP room lookup asks for zero before the separate history read", async () => {
    const result = await tool("read_conversation", { room: "Plans", limit: 2 });
    assert.equal(result.isError ?? false, false, result.content[0].text);
    assert.equal(result.content[0].text, "You: The full history line");
    assert.ok(seen.includes(`/api/bloks/${room.id}/messages?limit=2`));
  });
});
