import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { waitFor } from "./helpers/chat-interactions.ts";
import { startHarness } from "./helpers/server.ts";

/**
 * Two agents on a stand-in provider, each on its own model name so a call
 * says whose turn it is. A turn ends when the test finishes its call, with
 * whatever the agent should say; `reply` answers every later call at once.
 */
async function roomHarness() {
  const calls: Array<{ who: string; last: string; finish: (text?: string) => void; done: boolean }> = [];
  const replies: Record<string, ((last: string) => string) | undefined> = {};
  let closing = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) {
        return res.end(JSON.stringify({ data: [{ id: "alice-model" }, { id: "bob-model" }] }));
      }
      const parsed = JSON.parse(body);
      const who = parsed.model === "alice-model" ? "Alice" : "Bob";
      const users = (parsed.messages as any[]).filter((m) => m.role === "user");
      const content = users.at(-1)?.content;
      const last = typeof content === "string" ? content : JSON.stringify(content);
      const call = {
        who, last, done: false,
        finish: (text = "Done.") => {
          if (call.done) return;
          call.done = true;
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
        },
      };
      calls.push(call);
      const reply = replies[who];
      if (closing) call.finish();
      else if (reply) call.finish(reply(last));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const h = await startHarness();
  const post = (path: string, body: unknown) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  await post("/api/providers/grok/connect", { key: "test-key", url: `http://127.0.0.1:${port}` });
  const agent = async (name: string, model: string) => {
    const { bot } = await post("/api/bots", { name });
    await h.json(`/api/bots/${bot.id}`, {
      method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model } }),
    });
    return bot;
  };
  const alice = await agent("Alice", "alice-model");
  const bob = await agent("Bob", "bob-model");
  const { blok } = await post("/api/bloks", { name: "Tag test", memberIds: [alice.id, bob.id] });
  const busy = async (id: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === id).busy as boolean;
  return {
    h, calls, replies, alice, bob, blok, busy,
    say: (text: string) => post(`/api/bloks/${blok.id}/messages`, { text }),
    direct: (id: string, text: string) => post(`/api/bots/${id}/messages`, { text }),
    heard: (who: string, words: string) => calls.filter((c) => c.who === who && c.last.includes(words)),
    /** The first call in which an agent was given these words, once there is one. */
    hears: (who: string, words: string) => waitFor(() => calls.find((c) => c.who === who && c.last.includes(words))),
    async settled() {
      // nobody busy, and the room's rounds (which poll every 250 ms) done
      await waitFor(async () => !(await busy(alice.id)) && !(await busy(bob.id)));
      await new Promise((r) => setTimeout(r, 1_000));
      await waitFor(async () => !(await busy(alice.id)) && !(await busy(bob.id)));
    },
    async stop() {
      closing = true;
      calls.forEach((call) => call.finish());
      await h.stop();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    },
  };
}

test("an idle agent named in a room hears it at once", async (t) => {
  const r = await roomHarness();
  t.after(() => r.stop());
  await r.say("@Bob are you there?");
  const call = await r.hears("Bob", "are you there?");
  assert.equal(r.heard("Alice", "are you there?").length, 0, "only the agent named should wake");
  call.finish();
  await r.settled();
  assert.equal(r.heard("Bob", "are you there?").length, 1, "one turn for one line");
});

test("an agent named in a room while it is mid-turn hears it when that turn ends", async (t) => {
  const r = await roomHarness();
  t.after(() => r.stop());
  await r.direct(r.bob.id, "a long task of your own");
  const own = await r.hears("Bob", "a long task");
  assert.equal(await r.busy(r.bob.id), true);

  await r.say("@Bob please look at the room");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(r.heard("Bob", "please look at the room").length, 0, "it must not interrupt the turn it is in");

  own.finish();
  const late = await r.hears("Bob", "please look at the room");
  late.finish("Looked.");
  await r.settled();
  assert.equal(r.heard("Bob", "please look at the room").length, 1, "delivered once");
  const { bloks } = await r.h.json("/api/bloks");
  const said = bloks.find((b: any) => b.id === r.blok.id).messages.filter((m: any) => m.from === r.bob.id && m.kind === "text");
  assert.ok(said.some((m: any) => m.text === "Looked."), "the late answer lands in the room");
});

test("a second line for the same busy agent in the same room joins the first in one turn", async (t) => {
  const r = await roomHarness();
  t.after(() => r.stop());
  await r.direct(r.bob.id, "a long task of your own");
  const own = await r.hears("Bob", "a long task");
  await r.say("@Bob first line");
  await r.say("@Bob second line");
  await new Promise((resolve) => setTimeout(resolve, 500));
  own.finish();
  const late = await r.hears("Bob", "second line");
  assert.ok(late.last.includes("first line"), "both lines in one turn");
  late.finish();
  await r.settled();
  assert.equal(r.calls.filter((c) => c.who === "Bob").length, 2, "its own turn, then one for the room");
});

// Two agents that always name each other. One human line allows the first
// turn plus MAX_AGENT_HOPS (3) handoffs.
const pingPong = (r: Awaited<ReturnType<typeof roomHarness>>) => {
  r.replies.Alice = () => "@Bob over to you";
  r.replies.Bob = () => "@Alice over to you";
};

test("the hop limit still ends a chain of agents naming each other", async (t) => {
  const r = await roomHarness();
  t.after(() => r.stop());
  pingPong(r);
  await r.say("@Alice start");
  await waitFor(() => r.calls.length >= 4, 10_000);
  await r.settled();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(r.calls.length, 4, `chain ran ${r.calls.length} turns`);
});

test("the hop limit still ends the chain when a handoff waited for a busy agent", async (t) => {
  const r = await roomHarness();
  t.after(() => r.stop());
  await r.direct(r.bob.id, "a long task of your own");
  const own = await r.hears("Bob", "a long task");
  pingPong(r);
  await r.say("@Alice start");
  // Alice answers and names Bob, who is busy: the handoff waits
  await waitFor(() => r.heard("Alice", "start").length);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(r.calls.filter((c) => c.who === "Bob").length, 1, "Bob is still on his own task");
  own.finish();
  await waitFor(() => r.calls.length >= 5, 10_000);
  await r.settled();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  // his own task, then the same four room turns as without the wait
  assert.equal(r.calls.length, 5, `chain ran ${r.calls.length - 1} room turns`);
});
