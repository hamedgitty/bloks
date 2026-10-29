// A request's prompt is a reading; a turn's summed usage is accounting.
// All completions below are served by an isolated loopback fixture.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAiCompatDriver } from "../server/drivers/openai-compat.ts";
import { PROVIDER_SPECS } from "../server/providers.ts";
import type { RuntimeEvent } from "../server/contracts.ts";
import { laneFill, type Reading } from "../server/context.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const spec = PROVIDER_SPECS.find(s => s.kind === "grok")!;

async function fixture(t: TestContext, answer: (body: any, round: number) => any) {
  const bodies: any[] = [];
  const held: Array<() => void> = [];
  const server = createServer((req, res) => {
    let input = "";
    req.on("data", c => input += c);
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const body = JSON.parse(input);
      bodies.push(body);
      const response = answer(body, bodies.length - 1);
      if (response === null) {
        held.push(() => {
          res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
          res.end(body.stream ? 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n' : JSON.stringify(reply()));
        });
        return;
      }
      // a provider refusing the request, as a busy one does
      if (typeof response?.status === "number") {
        res.statusCode = response.status;
        return res.end(JSON.stringify({ error: { message: "busy" } }));
      }
      res.setHeader("content-type", typeof response === "string" ? "text/event-stream" : "application/json");
      res.end(typeof response === "string" ? response : JSON.stringify(response));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { held.forEach(f => f()); server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, bodies, held };
}

const reply = (input?: unknown, text = "Done", tool = false) => ({
  choices: [{ message: { role: "assistant", content: text, ...(tool ? { tool_calls: [
    { id: "tool-one", function: { name: "unavailable_fixture_tool", arguments: "{}" } },
  ] } : {}) } }],
  ...(input === undefined ? {} : { usage: { prompt_tokens: input, completion_tokens: 7 } }),
});

async function drive(t: TestContext, answer: (body: any, round: number) => any, tools = true) {
  const f = await fixture(t, answer);
  const driver = openAiCompatDriver({ ...spec, tools: tools ? true : undefined });
  const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
    config: { url: f.url, apiKeyEnv: "FIXTURE_KEY" }, environment: { FIXTURE_KEY: "local-fixture" } });
  t.after(() => instance.dispose());
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  await instance.adapter.sendTurn({ threadId: "fixture-lane", text: "Next", model: "grok-4" });
  assert.ok(await waitFor(() => events.find(e => e.type === "turn.completed")), "the fixture turn never completed");
  return { ...f, events };
}

test("OpenAI-compatible tool rounds report their own prompts and keep the accounting sum", async t => {
  const f = await drive(t, (_body, round) => reply(round === 0 ? 150_000 : 60_000, "Done", round === 0));
  assert.deepEqual(f.events.filter(e => e.type === "context.reading").map(e => [e.used, e.window]), [[150_000, null], [60_000, null]]);
  const accounting = f.events.filter(e => e.type === "thread.token-usage.updated");
  assert.equal(accounting.length, 1);
  assert.deepEqual([accounting[0].input, accounting[0].output], [210_000, 14]);
  assert.equal(accounting[0].context, undefined, "the total cannot overwrite the last request's reading");
  assert.equal(f.bodies.length, 2);
});

test("an API-backed turn includes uncommitted additions and confirms only after a response", async t => {
  const f = await fixture(t, () => null);
  const driver = openAiCompatDriver({ ...spec, tools: true });
  const instance = await driver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
    config: { url: f.url, apiKeyEnv: "FIXTURE_KEY" }, environment: { FIXTURE_KEY: "local-fixture" } });
  t.after(() => instance.dispose());
  const outcomes: string[] = [], events: RuntimeEvent[] = [];
  let unavailable = 0;
  instance.adapter.onEvent(event => events.push(event));
  await instance.adapter.sendTurn({
    threadId: "fixture-lane", text: "FIRST", model: "grok-4",
    preparation: {
      freeze: () => ({
        hasInputs: true, skillNames: [],
        commit: () => ({ text: "READY_A", skillNames: [], images: [], settle: status => outcomes.push(status) }),
      }),
      ready: () => assert.fail("this adapter has no mid-turn steering"),
      unavailable: () => { unavailable++; },
    },
  });
  assert.ok(await waitFor(() => f.bodies.length === 1));
  assert.match(JSON.stringify(f.bodies[0].messages), /FIRST.*READY_A/);
  assert.deepEqual(outcomes, []);
  f.held.splice(0).forEach(done => done());
  assert.ok(await waitFor(() => events.find(e => e.type === "turn.completed")));
  assert.deepEqual(outcomes, ["accepted"]);
  assert.equal(unavailable, 1);
  assert.equal(f.bodies.length, 1);
});

test("a message explicitly for later waits behind an unsupported turn already committed", async t => {
  const f = await fixture(t, (body, round) => round === 0 ? null : body.stream
    ? 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'
    : reply());
  const h = await startHarness();
  t.after(() => h.stop());
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "local-fixture", url: f.url }) })).ok);
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Fixture" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST" }) });
  assert.ok(await waitFor(() => f.held.length === 1), "the first request did not reach the fixture");
  const followup = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "UNSUPPORTED_FOLLOWUP", delivery: "wait" }) });
  assert.equal(followup.delivery.route, "queued");
  const rows = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
  assert.equal(rows.messages.find((m: any) => m.text === "UNSUPPORTED_FOLLOWUP")?.preparation, undefined);
  assert.equal(f.bodies.length, 1, "the original request was stopped or followed too early");
  f.held.splice(0).forEach(done => done());
  assert.ok(await waitFor(() => f.bodies.length === 2), "the follow-up never got its next turn");
  assert.doesNotMatch(JSON.stringify(f.bodies[0].messages), /UNSUPPORTED_FOLLOWUP/);
  assert.match(JSON.stringify(f.bodies[1].messages), /UNSUPPORTED_FOLLOWUP/);
});

test("send now after an unsupported turn has committed keeps its existing explicit stop behavior", async t => {
  const f = await fixture(t, (body, round) => round === 0 ? null : body.stream
    ? 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'
    : reply());
  const h = await startHarness();
  t.after(() => h.stop());
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "local-fixture", url: f.url }) })).ok);
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Fixture" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST" }) });
  assert.ok(await waitFor(() => f.held.length === 1), "the first request did not reach the fixture");
  const followup = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SEND_NOW", delivery: "now" }) });
  assert.equal(followup.delivery.route, "stopped");
  assert.ok(await waitFor(() => f.bodies.length === 2), "the explicit next turn never started");
  assert.doesNotMatch(JSON.stringify(f.bodies[0].messages), /SEND_NOW/);
  assert.match(JSON.stringify(f.bodies[1].messages), /SEND_NOW/);
});

test("OpenAI-compatible missing, zero and malformed prompt usage produce no request reading", async t => {
  for (const input of [undefined, 0, -1, "60000"]) {
    const f = await drive(t, () => reply(input));
    assert.equal(f.events.filter(e => e.type === "context.reading").length, 0, String(input));
    assert.equal(f.events.find(e => e.type === "turn.completed")?.ok, true);
  }
});

test("a plain streaming provider with no usage requests no usage extension and has no reading", async t => {
  const f = await drive(t, () => 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n', false);
  assert.equal(f.bodies[0].stream, true);
  assert.equal(f.bodies[0].stream_options, undefined);
  assert.equal(f.events.filter(e => e.type === "context.reading" || e.type === "thread.token-usage.updated").length, 0);
});

test("a plain streaming provider's reported usage supplies its own prompt", async t => {
  const f = await drive(t, () => 'data: {"choices":[{"delta":{"content":"Done"}}],"usage":{"prompt_tokens":60000,"completion_tokens":7}}\n\ndata: [DONE]\n\n', false);
  const event = f.events.find(e => e.type === "thread.token-usage.updated");
  assert.deepEqual(event && [event.context, event.input, event.output], [60_000, 60_000, 7]);
});

test("unmeasured fills keep numeric zeroes; real windows or known tables alone permit a fill", () => {
  const selection = { instanceId: "fixture", model: "grok-4" };
  const reading: Reading = { ...selection, used: 60_000, window: null, at: 1 };
  for (const seen of [undefined, { ...reading, used: 0 }, { ...reading, used: NaN }, { ...reading, instanceId: "other" }, { ...reading, model: "other" }]) {
    const fill = laneFill(seen, selection);
    assert.deepEqual([fill.used, fill.limit, fill.fraction, fill.measured], [0, 0, 0, false]);
  }
  assert.equal(laneFill(reading, selection).window, "table");
  assert.equal(laneFill(reading, selection).limit, 131_072);
  assert.deepEqual(laneFill({ ...reading, used: 200_000, window: 100_000 }, selection),
    { used: 200_000, limit: 100_000, fraction: 1, measured: true, window: "engine" });
  const unknown = { instanceId: "fixture", model: "unlisted-model" };
  assert.equal(laneFill({ ...reading, ...unknown }, unknown).measured, false, "32k is only a fold margin");
  for (const window of [NaN, Infinity, -1, 0, 100_000.5]) {
    assert.equal(laneFill({ ...reading, ...unknown, window }, unknown).measured, false);
  }
});

/** Four ordinary turns and a fifth whose request reads 120k, which is past
 * the fold for a model with no known window, against a fixture whose
 * summary requests `summary` answers. Answers the fold once it shows on
 * the lane (null if it never does), and what was asked of the fixture. */
async function foldAfterLongTurn(t: TestContext, summary: (n: number) => any) {
  const asked = { turns: 0, summaries: 0 };
  const f = await fixture(t, body => {
    if (!body.tools) return summary(++asked.summaries);
    asked.turns++;
    return reply(asked.turns === 5 ? 120_000 : 30_000, "x".repeat(asked.turns === 5 ? 420_000 : 30_000));
  });
  const h = await startHarness();
  t.after(() => h.stop());
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "local-fixture", url: f.url }) })).ok);
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Replay" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  for (let i = 0; i < 5; i++) {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `Request ${i}` }) });
    // Each its own turn: its request reaches the provider before the wait
    // for the agent to be idle. Read too soon, idle means not started
    // yet, the next message waits beside this one, and the two go as one
    // turn, so on a busy machine the long fifth turn never came and there
    // was nothing to fold.
    assert.ok(await waitFor(() => asked.turns === i + 1), `turn ${i + 1} never reached the provider: ${h.logs()}`);
    assert.ok(await waitFor(async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id && !b.busy)), h.logs());
    if (i < 4) assert.equal(asked.summaries, 0, "the fixture must reach the long turn without pre-turn folding");
  }
  // The fold summarises the long turn after it ends, nobody waiting on
  // it. A summary request that fails is tried again a few times, the
  // last about forty seconds on (FOLD_RETRY_MS), so a fold that does not
  // show by then is not coming.
  const folded = await waitFor(async () => {
    const b = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    return b.tasks.find((l: any) => l.id === b.threadId && l.context.summarised);
  }, 60_000);
  assert.ok(folded, h.logs());
  return { folded, asked };
}

test("a replay provider still folds after a long measured turn, without summed usage driving the ring", async t => {
  const { folded, asked } = await foldAfterLongTurn(t, () => reply(undefined, "Earlier messages summarised."));
  assert.equal(asked.summaries, 1);
  assert.equal(folded.context.used, 120_000);
  assert.equal(folded.context.window, "table");
  assert.equal(folded.context.measured, true);
});

test("legacy input supplies neither bot fill nor Activity fill after a no-usage turn", async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-legacy-reading-"));
  const f = await fixture(t, () => null);
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ compaction: { idle: false, beforeTurn: 0 }, providers: { grok: { key: "local-fixture", url: f.url } } }));
  let h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Legacy" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  await h.stop();
  const file = join(home, ".bloks", "bots.json");
  const bots = JSON.parse(readFileSync(file, "utf8"));
  const lane = bots.find((b: any) => b.id === bot.id).tasks.find((l: any) => l.id === bot.threadId);
  lane.lastInput = 1_500_000;
  lane.context = { summary: "Earlier work", through: 0, at: 1 };
  writeFileSync(file, JSON.stringify(bots));
  h = await startHarness({ HOME: home });
  const current = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
  const context = current.tasks.find((l: any) => l.id === bot.threadId).context;
  assert.deepEqual(context, { used: 0, limit: 0, fraction: 0, measured: false, window: "table", summarised: true });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Next" }) });
  assert.ok(await waitFor(() => f.held.length > 0));
  const activity = await h.json("/api/activity");
  const running = activity.running.find((l: any) => l.threadId === bot.threadId);
  assert.deepEqual(running.context, { used: 0, limit: 0, fraction: 0, measured: false, window: "table" });
  f.held.splice(0).forEach(finish => finish());
  assert.ok(await waitFor(async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id && !b.busy)));
  assert.equal(f.bodies.filter(b => !b.tools).length, 0, "legacy usage did not trigger a summary");
  assert.equal((await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id).tasks[0].context.measured, false);
});

test("a fold whose summary request fails tries again, without waiting for another turn", async t => {
  // the first summary request is refused, the way a busy provider's is
  const { folded, asked } = await foldAfterLongTurn(t, n => n === 1 ? { status: 503 } : reply(undefined, "Earlier messages summarised."));
  assert.equal(asked.summaries, 2, "the fold never asked for its summary again");
  assert.equal(asked.turns, 5, "the fold waited for another turn");
  assert.equal(folded.context.used, 120_000);
});
