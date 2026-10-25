// An actual isolated server and token-streaming loopback provider. No model
// or installed workspace is used; the same fixture supports rendered proof.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { TestContext } from "node:test";
import { startHarness } from "./server.ts";
import { idle, messagesOf, waitFor } from "./turns.ts";

export const request = (method: string, body?: unknown) => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const noAnswer = "The agent ended this turn without an answer.";
export async function quietFixture(t: Pick<TestContext, "after">) {
  const h = await startHarness();
  const answers: string[] = [];
  let answer = "QUIET", reading: Promise<void> | undefined;
  const frames: any[] = [], calls: any[] = [];
  const controller = new AbortController();
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "grok-4" }] })); return; }
    const sent = JSON.parse(body); calls.push(sent);
    const text = answers.shift() ?? answer;
    if (!sent.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Per-character frames exercise the real adapter, not a copied stream fold.
    for (const content of text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(async () => {
    controller.abort(); await reading;
    await h.stop(); provider.closeAllConnections(); provider.close();
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const port = (provider.address() as { port: number }).port;
  const response = await h.fetch("/api/events", { signal: controller.signal }); assert.ok(response.ok);
  reading = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
    try { for (;;) {
      const next = await reader.read(); if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true }); let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const data = block.split("\n").find(s => s.startsWith("data: "));
        if (data) frames.push(JSON.parse(data.slice(6)));
      }
    } } catch (e) { if (!controller.signal.aborted) throw e; }
  })();
  assert.ok(await waitFor(() => frames.some(f => f.kind === "hello")));
  const { endpoints } = await h.json("/api/custom-endpoints", request("POST", { name: "Loopback fixture", url: `http://127.0.0.1:${port}`, key: "fixture" }));
  const bot = async (name = "Neutral helper") => {
    const { bot } = await h.json("/api/bots", request("POST", { name }));
    await h.json(`/api/bots/${bot.id}`, request("PATCH", { modelSelection: { instanceId: endpoints[0].instanceId, model: "grok-4" } }));
    return bot as { id: string; threadId: string };
  };
  const send = async (b: { id: string }, text = "Prepare the fixture result") => {
    const r = await h.fetch(`/api/bots/${b.id}/messages`, request("POST", { text })); assert.equal(r.status, 202, await r.text());
    assert.ok(await idle(h, b), h.logs());
    assert.ok(await waitFor(() => frames.some(f => f.kind === "runtime" && f.event?.type === "turn.completed") ? true : null));
  };
  const setAnswer = (text: string) => { answer = text; };
  return { h, bot, send, answers, setAnswer, frames, calls, messages: (b: { id: string; threadId: string }) => messagesOf(h, b) };
}
