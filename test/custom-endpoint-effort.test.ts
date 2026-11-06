// A custom host whose owner says its model takes a reasoning effort
// gets the effort picker, and a turn there is sent the agent's level as
// `reasoning_effort` (low, medium or high, the three every server that
// takes the field agrees on). Off, nothing is sent and there is no dial.
// A host that refuses the field ends the turn saying which switch to
// turn off. Every model here is a loopback fixture, every key made up.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { customInstanceId, instanceConfigs } from "../server/config.ts";
import { COMPAT_EFFORTS, openAiCompatDriver, refusedEffort } from "../server/drivers/openai-compat.ts";
import { effortLevels, effortRefusal } from "../server/effort.ts";
import { CUSTOM_SPEC, PROVIDER_SPECS } from "../server/providers.ts";
import { envModelEndpoint } from "../server/self-host.ts";
import type { RuntimeEvent } from "../server/contracts.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

type Reply = { status?: number; json?: unknown; sse?: string };

async function fixture(t: TestContext, answer: (body: any) => Reply) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let input = "";
    req.on("data", (c) => (input += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "o-fixture" }] }));
      const body = JSON.parse(input || "{}");
      bodies.push(body);
      const reply = answer(body);
      res.statusCode = reply.status ?? 200;
      if (reply.sse) res.setHeader("content-type", "text/event-stream");
      res.end(reply.sse ?? JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, bodies };
}

const streamed = (text: string): Reply => ({ sse: `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n` });
const said = (text: string): Reply => ({ json: { choices: [{ message: { role: "assistant", content: text } }] } });

async function host(t: TestContext, url: string, saved: Record<string, unknown> = {}) {
  const driver = openAiCompatDriver(CUSTOM_SPEC);
  const instance = await driver.create({
    instanceId: "custom_fixture",
    displayName: "Fixture Host",
    enabled: true,
    config: driver.decodeConfig({ url, ...saved }),
    environment: { CUSTOM_API_KEY: "local-fixture" },
  });
  t.after(() => instance.dispose());
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  return { instance, events };
}

async function turn(instance: Awaited<ReturnType<typeof host>>["instance"], events: RuntimeEvent[], effort?: any) {
  events.length = 0;
  await instance.adapter.sendTurn({ threadId: "lane", text: "Think about it", model: "o-fixture", ...(effort ? { effort } : {}) });
  return waitFor(() => events.find((e) => e.type === "turn.completed"));
}

test("only a literal yes gives a host the dial, and then low, medium and high", async (t) => {
  const f = await fixture(t, () => streamed("ok"));
  for (const saved of [{}, { effort: false }, { effort: "yes" }, { effort: 1 }]) {
    const { instance } = await host(t, f.url, saved);
    assert.equal(instance.adapter.capabilities.efforts, undefined, JSON.stringify(saved));
    assert.deepEqual(effortLevels(instance), [], JSON.stringify(saved));
  }
  const { instance } = await host(t, f.url, { effort: true });
  assert.deepEqual(instance.adapter.capabilities.efforts, ["low", "medium", "high"]);
  assert.deepEqual(COMPAT_EFFORTS, ["low", "medium", "high"]);
  // what the pickers and the agent CLI are told when a level is chosen
  assert.equal(effortRefusal("high", instance, "o-fixture"), null);
  assert.match(effortRefusal("max", instance, "o-fixture") ?? "", /takes effort low, medium or high, not max/);
});

test("a turn is sent its level, the nearest of the three, and nothing with the switch off", async (t) => {
  const f = await fixture(t, (body) => (body.stream ? streamed("thought") : said("A title")));
  const on = await host(t, f.url, { effort: true });
  for (const [asked, sent] of [["high", "high"], ["low", "low"], ["medium", "medium"], ["max", "high"], ["xhigh", "high"], ["off", "low"]] as const) {
    assert.equal((await turn(on.instance, on.events, asked))?.ok, true, asked);
    assert.equal(f.bodies.at(-1).reasoning_effort, sent, asked);
  }
  // the engine's own setting: nothing said
  await turn(on.instance, on.events);
  assert.equal("reasoning_effort" in f.bodies.at(-1), false);
  // switched off, a saved level is never sent
  const off = await host(t, f.url);
  await turn(off.instance, off.events, "high");
  assert.equal("reasoning_effort" in f.bodies.at(-1), false);
  // and a title or a summary is Bloks's own, sent no effort either way
  f.bodies.length = 0;
  await on.instance.generateText!("Name this");
  assert.equal("reasoning_effort" in f.bodies[0], false);
});

test("the tool loop sends it on every round", async (t) => {
  const f = await fixture(t, () => said("Done thinking."));
  const { instance, events } = await host(t, f.url, { effort: true, tools: true });
  assert.equal((await turn(instance, events, "medium"))?.ok, true);
  assert.equal(f.bodies[0].stream, false);
  assert.ok(Array.isArray(f.bodies[0].tools));
  assert.equal(f.bodies[0].reasoning_effort, "medium");
});

test("a host that refuses the effort ends the turn and says which switch", async (t) => {
  const refusals: Reply[] = [
    { status: 400, json: { error: { message: "Unrecognized request argument supplied: reasoning_effort", type: "invalid_request_error" } } },
    { status: 400, json: { error: { message: "reasoning_effort is not supported with this model" } } },
    { status: 422, json: { detail: [{ loc: ["body", "reasoning_effort"], msg: "extra fields not permitted" }] } },
  ];
  for (const refusal of refusals) {
    for (const tools of [false, true]) {
      const f = await fixture(t, () => refusal);
      const { instance, events } = await host(t, f.url, { effort: true, tools });
      const done = await turn(instance, events, "high");
      const shown = `${JSON.stringify(refusal)} tools ${tools}`;
      assert.equal(done?.ok, false, shown);
      const error = events.find((e) => e.type === "runtime.error");
      const message = error && "message" in error ? String(error.message) : "";
      assert.match(message, /^Fixture Host refused the reasoning effort Bloks sent/, shown);
      assert.match(message, /turn off "Takes reasoning effort"/, shown);
      assert.equal(f.bodies.length, 1, `asked again without it: ${shown}`);
    }
  }
});

test("only a refusal that names the effort is read as one", () => {
  assert.equal(refusedEffort(400, "reasoning_effort is not supported"), true);
  assert.equal(refusedEffort(422, '{"detail":[{"loc":["body","reasoning_effort"]}]}'), true);
  for (const status of [401, 402, 403, 408, 429, 500, 200]) assert.equal(refusedEffort(status, "reasoning"), false, String(status));
  assert.equal(refusedEffort(400, "model o-fixture not found"), false);
});

test("the switch rides in the host's engine config, from Settings or the environment", () => {
  const map = instanceConfigs({
    custom: [
      { id: "on", name: "On", url: "https://on.example.test/v1", keys: [{ id: "k", key: "k-on" }], effort: true },
      { id: "off", name: "Off", url: "https://off.example.test/v1", keys: [{ id: "k", key: "k-off" }] },
    ],
  });
  assert.deepEqual(map[customInstanceId("on")].config, { url: "https://on.example.test/v1", effort: true });
  assert.deepEqual(map[customInstanceId("off")].config, { url: "https://off.example.test/v1" });
  assert.equal(envModelEndpoint({ BLOKS_MODEL_URL: "http://vllm:8000/v1", BLOKS_MODEL_EFFORT: "1" })?.effort, true);
  assert.equal(envModelEndpoint({ BLOKS_MODEL_URL: "http://vllm:8000/v1", BLOKS_MODEL_EFFORT: "yes" })?.effort, false);
  // a catalog engine has no switch: a stray flag in a hand-edited config
  // is read the same literal way, and nothing else turns it on
  const ollama = PROVIDER_SPECS.find((spec) => spec.kind === "ollama")!;
  assert.equal(openAiCompatDriver(ollama).decodeConfig({}).effort, undefined);
});

test("the switch round-trips through the endpoint API, and an agent's level reaches the host", async (t) => {
  const isTurn = (body: any) => body.messages?.[0]?.role === "system";
  const f = await fixture(t, (body) => (body.stream ? streamed("Thinking hard.") : said("A title")));
  const home = mkdtempSync(join(tmpdir(), "bloks-custom-effort-"));
  const config = () => JSON.parse(readFileSync(join(home, ".bloks", "config.json"), "utf8"));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { endpoints } = await h.json("/api/custom-endpoints", {
    method: "POST",
    body: JSON.stringify({ name: "Reasoner", url: f.url, key: "sk-fixture-effort" }),
  });
  const endpoint = endpoints[0];
  assert.equal(endpoint.effort, false, "a new host sends no effort");
  const engine = async () => (await h.json("/api/instances")).instances.find((i: any) => i.instanceId === endpoint.instanceId);
  assert.deepEqual((await engine()).efforts, []);

  assert.equal((await h.fetch(`/api/custom-endpoints/${endpoint.id}`, { method: "PATCH", body: JSON.stringify({ effort: "yes" }) })).status, 400);
  const on = await h.json(`/api/custom-endpoints/${endpoint.id}`, { method: "PATCH", body: JSON.stringify({ effort: true }) });
  assert.equal(on.endpoints[0].effort, true);
  assert.equal(config().custom[0].effort, true);
  assert.deepEqual((await engine()).efforts, ["low", "medium", "high"]);

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Thinker" }) });
  const picked = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: endpoint.instanceId, model: "o-fixture" }, effort: "high" }),
  });
  assert.equal(picked.status, 200, await picked.text());
  const refused = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ effort: "max" }) });
  assert.equal(refused.status, 400, "a level the host does not take was saved");

  const sent = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Think it through" }) });
  assert.ok(sent.ok, await sent.text());
  const body = await waitFor(() => f.bodies.find(isTurn), 30_000);
  assert.ok(body, h.logs());
  assert.equal(body.reasoning_effort, "high");

  const off = await h.json(`/api/custom-endpoints/${endpoint.id}`, { method: "PATCH", body: JSON.stringify({ effort: false }) });
  assert.equal(off.endpoints[0].effort, false);
  assert.ok(!("effort" in config().custom[0]), "off is the field gone");
});
