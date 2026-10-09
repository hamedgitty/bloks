// A request's prompt is a reading; a turn's summed usage is accounting.
// All completions below are served by an isolated loopback fixture.
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
        held.push(() => res.end(JSON.stringify(reply())));
        return;
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

test("a replay provider still folds after a long measured turn, without summed usage driving the ring", async t => {
  let turn = 0;
  let summaries = 0;
  const f = await fixture(t, body => {
    if (!body.tools) { summaries++; return reply(undefined, "Earlier messages summarised."); }
    turn++;
    return reply(turn === 5 ? 120_000 : 30_000, "x".repeat(turn === 5 ? 420_000 : 30_000));
  });
  const h = await startHarness();
  t.after(() => h.stop());
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "local-fixture", url: f.url }) })).ok);
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Replay" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  for (let i = 0; i < 5; i++) {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `Request ${i}` }) });
    assert.ok(await waitFor(async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id && !b.busy)), h.logs());
    if (i < 4) assert.equal(summaries, 0, "the fixture must reach the long turn without pre-turn folding");
  }
  const folded = await waitFor(async () => {
    const b = (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    return b.tasks.find((l: any) => l.id === b.threadId && l.context.summarised);
  });
  assert.ok(folded, h.logs());
  assert.equal(summaries, 1);
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
