// An agent's Email lane, past the happy path in agent-mail.test.ts: who
// is emailed when a turn for a mail goes wrong.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const MAIL_ID = "fedcba9876543210fedc";

/** Bloks Cloud as the relay line sees it: asks go down the stream, and
 * every email Bloks sends is kept. */
function stubRelay() {
  let send: ((frame: unknown) => void) | null = null;
  const results = new Map<string, number>();
  const sent: Array<Record<string, any>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "space-test" });
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      res.writeHead(200, { "content-type": "application/json" });
      if (path === "/space/agent/result") results.set(String(parsed.id), Number(parsed.status));
      if (path === "/space/agent/hook" && parsed.platform === "email") return res.end(JSON.stringify({ id: MAIL_ID, domain: "agents.bloks.dev" }));
      if (path === "/space/agent/email") sent.push(parsed);
      res.end("{}");
    });
  });
  return { server, ask: (id: string, payload: string) => send?.({ kind: "ask", id, payload }), results, sent, connected: () => send !== null };
}

/** An engine that answers every turn at once with the same words. */
async function engine(t: TestContext) {
  const state = { calls: [] as string[] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      state.calls.push(body);
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Here is my answer." } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { state, port: (server.address() as { port: number }).port };
}

async function mailbox(t: TestContext, env: Record<string, string> = {}) {
  const model = await engine(t);
  const h = await startHarness(env);
  const relay = stubRelay();
  t.after(async () => {
    relay.server.closeAllConnections();
    relay.server.close();
    await h.stop();
  });
  await h.fetch("/api/providers/grok/connect", {
    method: "POST",
    body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${model.port}` }),
  });
  await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  await h.fetch("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${(relay.server.address() as any).port}`, agentToken: "agent-token", enabled: true }),
  });
  for (let i = 0; i < 100 && !relay.connected(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(relay.connected(), "the relay line never opened");
  await h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  let asks = 0;
  return {
    h,
    relay,
    model,
    async agent(name: string) {
      const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
      await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
      return bot as { id: string; threadId: string };
    },
    async deliver(to: string, from: string, text: string) {
      const id = `ask-${++asks}`;
      const mail = { to: `${to}.${MAIL_ID}@agents.bloks.dev`, from, fromName: "", subject: "A question", text, messageId: `<${id}@example.com>` };
      relay.ask(id, `hook:${JSON.stringify({ platform: "email", body: JSON.stringify(mail), signature: null })}`);
      for (let i = 0; i < 100 && !relay.results.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      return relay.results.get(id);
    },
    async lane(botId: string) {
      const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
      return bot?.tasks.find((task: any) => task.title === "Email") as { id: string; state: string } | undefined;
    },
    idle: (botId: string) =>
      waitFor(async () => {
        const bot = (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === botId);
        return bot && !bot.busy ? bot : null;
      }),
  };
}

test("a mail whose turn fails getting ready leaves no sender to email the lane's next answer to", async (t) => {
  // a runtime that is not there, so a turn on the Local VM fails before
  // it reaches any engine
  const box = await mailbox(t, { BLOKS_VM_RUNTIME: "/nonexistent/bloks-test-container-runtime" });
  const dee = await box.agent("Dee");
  await box.h.fetch(`/api/bots/${dee.id}`, { method: "PATCH", body: JSON.stringify({ computer: "sandbox" }) });

  assert.equal(await box.deliver("dee", "first@example.com", "Can you check the invoices?"), 202);
  const lane = await waitFor(() => box.lane(dee.id));
  assert.ok(lane, "the mail never reached an Email lane");
  const failed = await waitFor(async () =>
    (await box.h.json(`/api/bots/${dee.id}/messages?thread=${lane.id}&limit=50`)).messages.find((m: any) => m.tool?.ok === false),
  );
  assert.ok(failed, "the turn did not fail the way this test needs");
  assert.ok(await box.idle(dee.id));

  // The person then uses the lane themselves. Its answer is theirs: the
  // sender of the mail that never ran was still wired to the lane, and
  // was emailed it.
  await box.h.fetch(`/api/bots/${dee.id}`, { method: "PATCH", body: JSON.stringify({ computer: "off" }) });
  await box.h.fetch(`/api/bots/${dee.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Draft a note to myself", taskId: lane.id }) });
  assert.ok(await waitFor(() => box.model.state.calls.length >= 1), "the person's own turn never ran");
  assert.ok(await box.idle(dee.id));
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(box.relay.sent.map((mail) => mail.to), [], "somebody was emailed an answer that was not to them");
});
