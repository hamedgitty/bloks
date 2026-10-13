// A stop that arrives while a turn is still getting ready (GitHub 272).
//
// A lane reads as working from the moment something is said to it, but
// its engine is started a little later, once everything the turn needs
// is there. A stop in between found no engine turn to interrupt and was
// lost: the turn started anyway and ran to its end, and a Redo of it
// waited twenty seconds for a stop that was never coming.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

describe("a stop while the turn is getting ready", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.stop();
  });

  /** An agent on an engine the test scripts. A request whose last message
   * says HOLD is never answered, the way a long turn is not: only a stop
   * ends it. Every request the engine is sent is kept. */
  async function agentOn(t: TestContext, provider: string, name: string) {
    const heard: string[] = [];
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        const said = ((JSON.parse(body).messages ?? []) as Array<{ content: unknown }>).map((m) => String(m.content ?? ""));
        const last = said[said.length - 1] ?? "";
        heard.push(last);
        if (last.includes("HOLD")) return;
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Done: ${last}` } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    t.after(() => {
      engine.closeAllConnections();
      engine.close();
    });
    await h.fetch(`/api/providers/${provider}/connect`, {
      method: "POST",
      body: JSON.stringify({ key: "sk-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: provider, model: "m-1" } }),
    });
    assert.equal(set.status, 200, await set.clone().text());
    t.after(() => h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" }));
    const me = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    const say = (text: string) => h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    const stop = () => h.fetch(`/api/bots/${bot.id}/interrupt`, { method: "POST", body: "{}" });
    return { bot, heard, me, say, stop };
  }

  test("the turn ends, whether or not its engine had been started", async (t) => {
    const a = await agentOn(t, "deepseek", "Early");
    await a.say("HOLD this one");
    assert.ok(await waitFor(async () => (await a.me()).busy), "the lane never read as working");
    // straight away: on most runs the engine has not been asked yet
    const started = a.heard.length;
    assert.equal((await a.stop()).status, 200);
    const idle = await waitFor(async () => {
      const now = await a.me();
      return now.busy ? null : now;
    }, 5_000);
    assert.ok(idle, "the stop was lost and the turn went on");
    // a stop that came before the engine was asked never asks it, and
    // the conversation says what happened to the words
    if (!started && !a.heard.length) {
      assert.ok(
        idle.messages.some((m: any) => m.kind === "notice" && /Stopped before Early had started on it/.test(m.text ?? "")),
        "nothing in the conversation says the turn was stopped",
      );
    }

    // and the stop is not left behind for the next thing said
    await a.say("the next request");
    const answered = await waitFor(async () => {
      const now = await a.me();
      return !now.busy && now.messages.some((m: any) => m.text === "Done: the next request") ? now : null;
    });
    assert.ok(answered, "the turn after a stopped one did not run");
  });

  test("what was waiting behind the stopped turn goes next", async (t) => {
    const a = await agentOn(t, "groq", "Queued");
    await a.say("HOLD the first");
    assert.ok(await waitFor(async () => (await a.me()).busy));
    // this engine takes no words mid-turn, so the next thing said waits
    const second = await (await a.say("then the second")).json();
    assert.equal(second.queued, true);
    assert.equal((await a.stop()).status, 200);
    const answered = await waitFor(async () => {
      const now = await a.me();
      return !now.busy && now.messages.some((m: any) => m.text === "Done: then the second") ? now : null;
    });
    assert.ok(answered, "the waiting message never got its turn");
    assert.ok(!answered.messages.some((m: any) => m.queued), "something is still marked as waiting");
  });
});
