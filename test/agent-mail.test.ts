// Email your agent: mail through Bloks Cloud becomes a turn, and the
// agent's answer goes back as the reply.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const MAIL_ID = "0123456789abcdef0123";

function stubRelay() {
  let send: ((frame: unknown) => void) | null = null;
  const results = new Map<string, number>();
  const sent: Array<Record<string, unknown>> = [];
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

describe("agent mail", () => {
  let h: Harness;
  let relay: ReturnType<typeof stubRelay>;
  let closeEngine = () => {};
  before(async () => {
    h = await startHarness();
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Filed it under March. Total is $1,240." } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    closeEngine = () => engine.close();
    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
    relay = stubRelay();
    await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
    await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    const set = await h.fetch("/api/relay", {
      method: "PUT",
      body: JSON.stringify({ url: `http://127.0.0.1:${(relay.server.address() as any).port}`, agentToken: "agent-token", enabled: true }),
    });
    assert.equal(set.status, 200);
    for (let i = 0; i < 100 && !relay.connected(); i++) await new Promise((r) => setTimeout(r, 50));
  });
  after(async () => {
    relay?.server.close();
    closeEngine();
    await h.stop();
  });

  const deliver = async (id: string, mail: Record<string, unknown>) => {
    relay.ask(id, `hook:${JSON.stringify({ platform: "email", body: JSON.stringify(mail), signature: null })}`);
    for (let i = 0; i < 100 && !relay.results.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return relay.results.get(id);
  };

  test("turning it on gives every agent an address", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Bookkeeper Bea" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
    const on = await h.json("/api/chat/email", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    assert.equal(on.enabled, true);
    const mine = on.addresses.find((a: any) => a.botId === bot.id);
    assert.equal(mine.address, `bookkeeper-bea.${MAIL_ID}@agents.bloks.dev`);
  });

  test("a mail becomes a turn, and the answer is emailed back", async () => {
    const status = await deliver("m-1", {
      to: `bookkeeper-bea.${MAIL_ID}@agents.bloks.dev`,
      from: "hamed@example.com",
      fromName: "Hamed",
      subject: "March invoices",
      text: "Please file these and tell me the total.",
      messageId: "<x1@example.com>",
    });
    assert.equal(status, 202);
    for (let i = 0; i < 200 && !relay.sent.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(relay.sent.length, 1, "the reply was not sent");
    assert.deepEqual(relay.sent[0], {
      to: "hamed@example.com",
      replyTo: `bookkeeper-bea.${MAIL_ID}@agents.bloks.dev`,
      fromName: "Bookkeeper Bea",
      subject: "Re: March invoices",
      text: "Filed it under March. Total is $1,240.",
      inReplyTo: "<x1@example.com>",
    });
    const { bots } = await h.json("/api/bots");
    const bea = bots.find((b: any) => b.name === "Bookkeeper Bea");
    // nobody is listed yet, so this is anyone's mail, in a lane of its own
    assert.ok(bea.tasks.some((t: any) => t.title === "Unlisted email"), "it has a lane for unlisted mail");
    // the same message again is not a second turn
    assert.equal(await deliver("m-2", { to: `bookkeeper-bea.${MAIL_ID}@agents.bloks.dev`, from: "hamed@example.com", text: "again", messageId: "<x1@example.com>" }), 202);
  });

  test("unknown agents and senders who are not allowed are turned away", async () => {
    assert.equal(await deliver("m-3", { to: `nobody.${MAIL_ID}@agents.bloks.dev`, from: "a@b.co", text: "hi" }), 404);
    await h.fetch("/api/chat/email", { method: "PATCH", body: JSON.stringify({ allowFrom: ["@example.com"] }) });
    assert.equal(await deliver("m-4", { to: `bookkeeper-bea.${MAIL_ID}@agents.bloks.dev`, from: "stranger@elsewhere.org", text: "hi" }), 403);
  });
});
