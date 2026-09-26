// Backup engines: which failures mean "out", when it is usable again,
// and the whole round trip through a real server.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";

import { Cooldowns, describeRest, outReason, resetAt, restUntil } from "../server/failover.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

const MIN = 60_000;

describe("what counts as out", () => {
  test("limits, overload, credit and sign-in, in the words providers use", () => {
    assert.equal(outReason("Claude AI usage limit reached|1790400000"), "limit");
    assert.equal(outReason("You've hit your limit · resets 3pm (Europe/London)"), "limit");
    assert.equal(outReason("Grok HTTP 429: Too Many Requests"), "limit");
    assert.equal(outReason("You exceeded your current quota, please check your plan and billing details."), "limit");
    assert.equal(outReason("RESOURCE_EXHAUSTED: Quota exceeded for quota metric"), "limit");
    assert.equal(outReason("API Error: 529 {\"type\":\"overloaded_error\"}"), "overloaded");
    assert.equal(outReason("Your credit balance is too low to access the Anthropic API."), "credit");
    assert.equal(outReason("Invalid API key · Please run /login"), "signedOut");
    assert.equal(outReason("OAuth token has expired. Please obtain a new token."), "signedOut");
  });

  test("a failure about the work is not the engine running out", () => {
    assert.equal(outReason("npm test failed: 3 failing"), null);
    assert.equal(outReason("The command was refused by a rule"), null);
    assert.equal(outReason("This conversation is longer than the model will take"), null);
    assert.equal(outReason(""), null);
    assert.equal(outReason(null), null);
  });
});

describe("when it is usable again", () => {
  const now = new Date(2026, 8, 26, 10, 0, 0).getTime();

  test("an epoch after a pipe, in seconds or milliseconds", () => {
    assert.equal(resetAt("Claude AI usage limit reached|1790600000", now), 1790600000_000);
    assert.equal(resetAt("limit|1790600000000", now), 1790600000_000);
  });

  test("a wait in hours, minutes and seconds", () => {
    assert.equal(resetAt("Rate limit reached. Please try again in 20m", now), now + 20 * MIN);
    assert.equal(resetAt("try again in 1 hour 5 minutes", now), now + 65 * MIN);
    assert.equal(resetAt("retry after 30 seconds", now), now + 30_000);
  });

  test("a clock time, today or tomorrow", () => {
    assert.equal(resetAt("resets 3pm", now), new Date(2026, 8, 26, 15, 0).getTime());
    assert.equal(resetAt("resets at 9:30am", now), new Date(2026, 8, 27, 9, 30).getTime());
    assert.equal(resetAt("usage limit reached", now), null);
  });

  test("a sensible rest when nothing is said, and never absurdly long", () => {
    assert.equal(restUntil("limit", "rate limit", now), now + 30 * MIN);
    assert.equal(restUntil("overloaded", "overloaded", now), now + 10 * MIN);
    assert.equal(restUntil("limit", "limit|9999999999", now), now + 12 * 60 * MIN);
  });

  test("a rest ends by itself, and says how long it has left", () => {
    const table = new Cooldowns();
    const rest = table.rest("claude", "limit", "try again in 20m", now);
    assert.equal(table.of("claude", now + 5 * MIN)?.reason, "limit");
    assert.equal(describeRest(rest, now), "for about 20 minutes");
    assert.equal(table.of("claude", now + 21 * MIN), undefined);
    assert.deepEqual(table.all(now + 21 * MIN), {});
  });
});

/** A chat engine that always says the same thing, or always refuses. */
function fakeEngine(answer: (asked: string) => { status: number; body: unknown }): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
      }
      const last = (() => {
        try {
          const messages = JSON.parse(body).messages ?? [];
          return String(messages[messages.length - 1]?.content ?? "");
        } catch {
          return "";
        }
      })();
      asked.push(last);
      const reply = answer(last);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as any).port}`, asked })),
  );
}

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe("a turn that runs out moves to the backup", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.stop());

  test("the same message is answered by the backup, and later turns stay there while the main one rests", async (t) => {
    const main = await fakeEngine(() => ({
      status: 429,
      body: { error: { message: "Rate limit reached. Please try again in 20m" } },
    }));
    const spare = await fakeEngine(() => ({
      status: 200,
      body: { choices: [{ message: { role: "assistant", content: "Done, from the spare." } }] },
    }));
    t.after(() => {
      main.server.close();
      spare.server.close();
    });
    await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "xai-test-0000000000", url: main.url }) });
    await h.fetch("/api/providers/kimi/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-0000000000", url: spare.url }) });

    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Relay" }) });
    const patched = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        modelSelection: { instanceId: "grok", model: "m-1" },
        backupSelection: { instanceId: "kimi", model: "m-1" },
      }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual((await patched.json()).bot.backupSelection, { instanceId: "kimi", model: "m-1" });

    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Summarise the week" }) });
    const answered = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.some((m: any) => m.text === "Done, from the spare.") ? me : null;
    });
    assert.ok(answered, "the backup never answered");
    assert.ok(main.asked.some((q) => q.includes("Summarise the week")), "the main engine is tried first");
    assert.ok(spare.asked.some((q) => q.includes("Summarise the week")), "the backup gets the same message");
    const notice = answered.messages.find((m: any) => m.kind === "notice" && /is picking this up/.test(m.text));
    assert.ok(notice, "the chat says the backup took over");
    assert.match(notice.text, /is out of usage for about 20 minutes/);
    // said once, in plain words: the raw error is not shown as well
    assert.ok(!answered.messages.some((m: any) => /HTTP 429/.test(m.text ?? "")), "the raw error stays out of the way");
    // the user's message is in the chat once, not twice
    assert.equal(answered.messages.filter((m: any) => m.role === "user" && m.text === "Summarise the week").length, 1);

    // the next turn goes straight to the backup: the main one is resting
    const triedBefore = main.asked.length;
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "And next week?" }) });
    const second = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.filter((m: any) => m.text === "Done, from the spare.").length === 2 ? me : null;
    });
    assert.ok(second, "the second turn never landed");
    assert.equal(main.asked.length, triedBefore, "a resting engine is not asked again");

    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("without a backup a turn that runs out fails the way it always did", async (t) => {
    const main = await fakeEngine(() => ({ status: 429, body: { error: { message: "Too Many Requests" } } }));
    t.after(() => main.server.close());
    await h.fetch("/api/providers/deepseek/connect", { method: "POST", body: JSON.stringify({ key: "sk-test-1111111111", url: main.url }) });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Solo" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "deepseek", model: "m-1" } }) });
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Hello" }) });
    const settled = await waitFor(async () => {
      const { bots } = await h.json("/api/bots");
      const me = bots.find((b: any) => b.id === bot.id);
      return !me.busy && me.messages.some((m: any) => m.kind === "notice" || m.kind === "activity") ? me : null;
    });
    assert.ok(settled);
    assert.ok(!settled.messages.some((m: any) => /picking this up/.test(m.text ?? "")));
    assert.ok(settled.messages.some((m: any) => /429|Too Many Requests/.test(m.text ?? m.tool?.name ?? "")), "the error is shown");
    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("a backup that is not an engine and a model is refused", async () => {
    const { bots } = await h.json("/api/bots");
    const res = await h.fetch(`/api/bots/${bots[0].id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: 4 } }) });
    assert.equal(res.status, 400);
    const cleared = await h.fetch(`/api/bots/${bots[0].id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: null }) });
    assert.equal(cleared.status, 200);
  });
});
