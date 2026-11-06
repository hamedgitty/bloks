// A custom host whose model list cannot be had says why (GitHub 486).
// Anthropic's /v1/models answers 400 without its version header; Bloks
// read that as "no list published", offered an empty picker, and called
// the host ready. Now the status and the provider's own words are kept,
// shown on the endpoint with Retry, and a host with nothing to pick is
// not ready. Every model here is a loopback fixture, every key made up.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { catalogFailure, openAiCompatDriver, providerSaid } from "../server/drivers/openai-compat.ts";
import { CUSTOM_SPEC, PROVIDER_SPECS } from "../server/providers.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

type ModelsReply = { status: number; body: string; type?: string };

/** A model server on loopback whose /models answers what the test says
 * at the moment it is asked, and which counts how often it was. */
async function fixture(t: TestContext, initial: ModelsReply) {
  const state = { reply: initial, asked: 0 };
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      state.asked++;
      res.statusCode = state.reply.status;
      res.setHeader("content-type", state.reply.type ?? "application/json");
      return res.end(state.reply.body);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, state };
}

const ANTHROPIC_400: ModelsReply = {
  status: 400,
  body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "anthropic-version: header is required" } }),
};
const LISTED: ModelsReply = { status: 200, body: JSON.stringify({ data: [{ id: "claude-fixture-1" }, { id: "claude-fixture-2" }] }) };

async function host(t: TestContext, url: string, key = "local-fixture") {
  const driver = openAiCompatDriver(CUSTOM_SPEC);
  const instance = await driver.create({
    instanceId: "custom_fixture",
    displayName: "Fixture Host",
    enabled: true,
    config: driver.decodeConfig({ url }),
    environment: { CUSTOM_API_KEY: key },
  });
  t.after(() => instance.dispose());
  return instance;
}

test("the provider's own words are read from the body it sent", () => {
  assert.equal(providerSaid(ANTHROPIC_400.body), "anthropic-version: header is required");
  // OpenAI's shape, which most gateways copy
  assert.equal(providerSaid(JSON.stringify({ error: { message: "Invalid model", type: "invalid_request_error" } })), "Invalid model");
  assert.equal(providerSaid(JSON.stringify({ error: "not allowed" })), "not allowed");
  assert.equal(providerSaid(JSON.stringify({ message: "Forbidden" })), "Forbidden");
  // FastAPI, as a vLLM or a LiteLLM proxy answers
  assert.equal(providerSaid(JSON.stringify({ detail: "Not Found" })), "Not Found");
  assert.equal(providerSaid(JSON.stringify({ detail: [{ loc: ["header"], msg: "field required" }] })), "field required");
  assert.equal(providerSaid(JSON.stringify({ errors: [{ message: "bad header" }] })), "bad header");
  // a page of HTML is nobody's words; plain text is
  assert.equal(providerSaid("<!doctype html><html><body>502</body></html>"), "");
  assert.equal(providerSaid("upstream connect error\r\nor disconnect"), "upstream connect error or disconnect");
  assert.equal(providerSaid(""), "");
  assert.equal(providerSaid(JSON.stringify({ ok: false })), "");
  // one short line, whatever arrived
  const long = providerSaid(JSON.stringify({ error: { message: "x".repeat(500) } }));
  assert.ok(long.length <= 200 && long.endsWith("…"), long);
});

test("a refused list reads as its status, then the provider's words", () => {
  assert.equal(catalogFailure(400, ANTHROPIC_400.body), "HTTP 400. anthropic-version: header is required.");
  assert.equal(catalogFailure(404, ""), "HTTP 404.");
  assert.equal(catalogFailure(500, JSON.stringify({ error: { message: "Try again later." } })), "HTTP 500. Try again later.");
});

test("a host that refuses its model list is not ready, says why, and Retry looks again", async (t) => {
  const f = await fixture(t, ANTHROPIC_400);
  const instance = await host(t, f.url);

  const refused = await instance.snapshot();
  assert.equal(refused.state, "unavailable", "a host with nothing to pick was called ready");
  assert.equal(refused.catalogError, "HTTP 400. anthropic-version: header is required.");
  assert.equal(refused.reason, "Couldn't load models: HTTP 400. anthropic-version: header is required.");
  assert.equal(instance.models.options.length, 0);

  // looked at again only after a while, not on every glance at the picker
  const asked = f.state.asked;
  await instance.snapshot();
  await instance.snapshot();
  assert.equal(f.state.asked, asked, "a refused list was asked for again straight away");

  // the header is added (or the host fixed): Retry does not wait
  f.state.reply = LISTED;
  await instance.refreshCatalog!();
  assert.equal(f.state.asked, asked + 1);
  const ready = await instance.snapshot();
  assert.equal(ready.state, "available");
  assert.equal(ready.catalogError, undefined);
  assert.deepEqual(instance.models.options.map((o) => o.id), ["claude-fixture-1", "claude-fixture-2"]);

  // a list from before keeps it working while the reason rides along
  f.state.reply = { status: 503, body: JSON.stringify({ error: { message: "Overloaded" } }) };
  await instance.refreshCatalog!();
  const later = await instance.snapshot();
  assert.equal(later.state, "available");
  assert.equal(later.catalogError, "HTTP 503. Overloaded.");
  assert.equal(instance.models.options.length, 2);
});

test("every way a list fails has words of its own", async (t) => {
  const cases: Array<[ModelsReply, string]> = [
    [{ status: 404, body: "" }, "HTTP 404."],
    [{ status: 200, body: "<html>proxy login</html>", type: "text/html" }, "The model list was not JSON."],
    [{ status: 200, body: JSON.stringify({ data: [{ id: "text-embedding-fixture" }] }) }, "It listed no chat models."],
  ];
  for (const [reply, said] of cases) {
    const f = await fixture(t, reply);
    const snapshot = await (await host(t, f.url)).snapshot();
    assert.equal(snapshot.state, "unavailable", said);
    assert.equal(snapshot.catalogError, said);
  }
  // nobody there at all
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const port = (closed.address() as any).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const gone = await (await host(t, `http://127.0.0.1:${port}/v1`)).snapshot();
  assert.equal(gone.state, "unavailable");
  assert.equal(gone.catalogError, "Could not reach it (ECONNREFUSED).");
});

test("a key the provider echoes back never reaches the reason", async (t) => {
  const key = ["fixture", "echoed", "key", "0123456789"].join("-");
  const f = await fixture(t, { status: 400, body: JSON.stringify({ error: { message: `Unknown key ${key} for this route` } }) });
  const snapshot = await (await host(t, f.url, key)).snapshot();
  assert.equal(snapshot.catalogError, "HTTP 400. Unknown key [redacted] for this route.");
  assert.ok(!JSON.stringify(snapshot).includes(key));
});

test("a rejected key still reads as rejected, with the provider's words beside it", async (t) => {
  const f = await fixture(t, { status: 401, body: JSON.stringify({ error: { message: "invalid x-api-key" } }) });
  const snapshot = await (await host(t, f.url)).snapshot();
  assert.equal(snapshot.state, "unavailable");
  assert.match(snapshot.reason ?? "", /that key was rejected/);
  assert.equal(snapshot.catalogError, "HTTP 401. invalid x-api-key.");
});

test("a catalog engine with a list of its own stays ready when the live list fails", async (t) => {
  const f = await fixture(t, { status: 404, body: "" });
  const groq = PROVIDER_SPECS.find((spec) => spec.kind === "groq")!;
  const driver = openAiCompatDriver(groq);
  const instance = await driver.create({
    instanceId: "groq",
    displayName: "Groq",
    enabled: true,
    config: driver.decodeConfig({ url: f.url, apiKeyEnv: "FIXTURE_KEY" }),
    environment: { FIXTURE_KEY: "local-fixture" },
  });
  t.after(() => instance.dispose());
  const snapshot = await instance.snapshot();
  assert.equal(snapshot.state, "available");
  assert.ok(instance.models.options.length > 0);
});

test("Retry is a route of its own, and answers with the engines as they now stand", async (t) => {
  const f = await fixture(t, ANTHROPIC_400);
  const home = mkdtempSync(join(tmpdir(), "bloks-custom-catalog-"));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { endpoints } = await h.json("/api/custom-endpoints", {
    method: "POST",
    body: JSON.stringify({ name: "Anthropic", url: f.url, key: "sk-fixture-catalog" }),
  });
  const endpoint = endpoints[0];
  const described = async () => (await h.json("/api/instances")).instances.find((i: any) => i.instanceId === endpoint.instanceId);
  const refused = await waitFor(async () => {
    const instance = await described();
    return instance?.snapshot.catalogError ? instance : null;
  });
  assert.equal(refused.snapshot.state, "unavailable");
  assert.equal(refused.snapshot.reason, "Couldn't load models: HTTP 400. anthropic-version: header is required.");

  f.state.reply = LISTED;
  const retried = await h.json(`/api/custom-endpoints/${endpoint.id}/models`, { method: "POST" });
  assert.deepEqual(retried.endpoints.map((e: any) => e.id), [endpoint.id]);
  const after = retried.instances.find((i: any) => i.instanceId === endpoint.instanceId);
  assert.equal(after.snapshot.state, "available");
  assert.equal(after.snapshot.catalogError, undefined);
  assert.deepEqual(after.models.options.map((o: any) => o.id), ["claude-fixture-1", "claude-fixture-2"]);

  assert.equal((await h.fetch("/api/custom-endpoints/nosuchhost/models", { method: "POST" })).status, 404);
  assert.ok(!JSON.stringify(retried).includes("sk-fixture-catalog"), "the key came back out");
});
