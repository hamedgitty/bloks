// Headers a custom host wants beyond its key (GitHub 486): Anthropic's
// version, a gateway's org id, a proxy's own token. Sent on the model
// list and the chat alike, and kept like a key: stored beside the keys,
// left out of backups and inspections, and never returned by any route.
// Every model here is a loopback fixture, every value made up at runtime.
// before anything loads server/config.ts, so nothing lands in ~/.bloks
import "./helpers/own-data.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { carrySecrets, stripSecrets } from "../server/backup.ts";
import { customInstanceId, instanceConfigs } from "../server/config.ts";
import { openAiCompatDriver } from "../server/drivers/openai-compat.ts";
import { CUSTOM_SPEC, MAX_CUSTOM_HEADERS, customHeaderProblem, sendableHeaders } from "../server/providers.ts";
import { inspectionRedactor } from "../server/settings-redaction.ts";
import type { RuntimeEvent } from "../server/contracts.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** A value nobody would write, made here so no literal looks like a key. */
const sentinel = (what: string) => ["hdr", what, Math.random().toString(36).slice(2), "value"].join("-");

/** An Anthropic-like host: its model list answers only with the version
 * header, and every request's headers are kept for the test to read. */
async function fixture(t: TestContext) {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((req, res) => {
    let input = "";
    req.on("data", (c) => (input += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) {
        if (!req.headers["anthropic-version"]) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "anthropic-version: header is required" } }));
        }
        return res.end(JSON.stringify({ data: [{ id: "claude-fixture" }] }));
      }
      res.setHeader("content-type", "text/event-stream");
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, seen };
}

test("a header the request already owns, or one with a line break, is refused by name", () => {
  for (const name of ["Authorization", "authorization", "AUTHORIZATION", "Content-Type", "content-length", "Host", "Connection", "Transfer-Encoding"]) {
    assert.ok(customHeaderProblem(name, "x"), name);
  }
  assert.match(customHeaderProblem("Authorization", "Bearer x")!, /endpoint's key/);
  assert.match(customHeaderProblem("Content-Type", "text/plain")!, /Bloks sets Content-Type itself/);
  assert.match(customHeaderProblem("x-org\r\nevil", "1")!, /line break/);
  assert.match(customHeaderProblem("x-org", "1\r\nX-Evil: yes")!, /line break/);
  assert.match(customHeaderProblem("x-org", "a\nb")!, /line break/);
  assert.match(customHeaderProblem("x-org", "a\u0000b")!, /control characters/);
  assert.match(customHeaderProblem("x org", "1")!, /is not a header name/);
  assert.match(customHeaderProblem("x-org:", "1")!, /is not a header name/);
  assert.match(customHeaderProblem("", "1")!, /needs a name/);
  assert.match(customHeaderProblem("x-org", "")!, /needs a value/);
  assert.match(customHeaderProblem("x".repeat(65), "1")!, /too long/);
  assert.match(customHeaderProblem("x-org", "v".repeat(4097))!, /too long/);
  // what the issue needed, and a gateway's own
  assert.equal(customHeaderProblem("anthropic-version", "2023-06-01"), null);
  assert.equal(customHeaderProblem("OpenAI-Organization", "org-fixture"), null);
  assert.equal(customHeaderProblem("x-api-key", "with\ttab"), null);
});

test("only headers that can be sent are read out of a saved record", () => {
  const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`x-h${i}`, `v${i}`]));
  assert.equal(Object.keys(sendableHeaders(many)).length, MAX_CUSTOM_HEADERS);
  assert.deepEqual(
    sendableHeaders({ "anthropic-version": "2023-06-01", Authorization: "Bearer stolen", "x-bad": "a\nb", "x-num": 7, "Anthropic-Version": "twice" }),
    { "anthropic-version": "2023-06-01" },
  );
  for (const raw of [null, undefined, "x", ["a"], 3]) assert.deepEqual(sendableHeaders(raw), {});
});

test("a host's headers ride in its engine's config, and only that host's", () => {
  const value = sentinel("cfg");
  const map = instanceConfigs({
    custom: [
      { id: "with", name: "With", url: "https://with.example.test/v1", keys: [{ id: "k", key: sentinel("k1") }], headers: { "x-org": value } },
      { id: "without", name: "Without", url: "https://without.example.test/v1", keys: [{ id: "k", key: sentinel("k2") }] },
    ],
  });
  assert.deepEqual(map[customInstanceId("with")].config, { url: "https://with.example.test/v1", headers: { "x-org": value } });
  assert.deepEqual(map[customInstanceId("without")].config, { url: "https://without.example.test/v1" });
});

test("the headers go on the model list and the chat, and never stand in for the key", async (t) => {
  const f = await fixture(t);
  const driver = openAiCompatDriver(CUSTOM_SPEC);
  const token = sentinel("proxy");
  const instance = await driver.create({
    instanceId: "custom_fixture",
    displayName: "Fixture Host",
    enabled: true,
    // as a file edited by hand might have it: a stray Authorization is
    // dropped on the way in, never sent in place of the key
    config: driver.decodeConfig({ url: f.url, headers: { "anthropic-version": "2023-06-01", "x-proxy-token": token, Authorization: "Bearer stolen" } }),
    environment: { CUSTOM_API_KEY: "local-fixture" },
  });
  t.after(() => instance.dispose());
  const snapshot = await instance.snapshot();
  assert.equal(snapshot.state, "available", JSON.stringify(snapshot));
  assert.deepEqual(instance.models.options.map((o) => o.id), ["claude-fixture"]);

  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "lane", text: "Hi", model: "claude-fixture" });
  await waitFor(() => events.find((e) => e.type === "turn.completed"));

  const models = f.seen.find((r) => r.url.endsWith("/models"))!;
  const chat = f.seen.find((r) => r.url.endsWith("/chat/completions"))!;
  for (const request of [models, chat]) {
    assert.equal(request.headers["anthropic-version"], "2023-06-01", request.url);
    assert.equal(request.headers["x-proxy-token"], token, request.url);
    assert.equal(request.headers.authorization, "Bearer local-fixture", request.url);
  }
  assert.equal(chat.headers["content-type"], "application/json");
});

test("a header value is a secret to backups and inspections", () => {
  const value = sentinel("backup");
  const config: Record<string, any> = {
    custom: [{ id: "ep1", name: "Mine", url: "http://example.test", keys: [{ id: "k1", key: sentinel("key") }], headers: { "x-org": value } }],
  };
  const where = stripSecrets(config);
  assert.ok(where.includes("custom[ep1].headers"), where.join(", "));
  assert.equal(config.custom[0].headers, undefined);
  assert.equal(config.custom[0].name, "Mine", "only the secrets go");
  // and come back to this computer's restore, where it had them
  carrySecrets({ custom: [{ id: "ep1", headers: { "x-org": value } }] }, config);
  assert.equal(config.custom[0].headers["x-org"], value);

  const redact = inspectionRedactor({ custom: [{ headers: { "x-org": value } }] }, { instances: { one: { config: { headers: { "x-org": value } } } } });
  assert.equal(redact(`said ${value} here`), "said [redacted] here");
});

test("headers are saved by name, never sent back, and no route returns a value", async (t) => {
  const f = await fixture(t);
  const home = mkdtempSync(join(tmpdir(), "bloks-custom-headers-"));
  const config = () => JSON.parse(readFileSync(join(home, ".bloks", "config.json"), "utf8"));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const value = sentinel("route");
  const kept = sentinel("kept");
  const answers: string[] = [];
  const keep = async (res: Response) => {
    const text = await res.text();
    answers.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const created = await keep(await h.fetch("/api/custom-endpoints", {
    method: "POST",
    body: JSON.stringify({ name: "Anthropic", url: f.url, key: "sk-fixture-headers", headers: [{ name: "x-team", value: kept }] }),
  }));
  assert.equal(created.status, 201);
  const endpoint = created.body.endpoints[0];
  assert.deepEqual(endpoint.headers, ["x-team"]);
  const put = (headers: unknown) => h.fetch(`/api/custom-endpoints/${endpoint.id}/headers`, { method: "PUT", body: JSON.stringify({ headers }) });

  // refused, by name, and nothing saved
  for (const [rows, said] of [
    [[{ name: "Authorization", value: "Bearer x" }], /endpoint's key/],
    [[{ name: "content-type", value: "text/plain" }], /Content-Type/],
    [[{ name: "Host", value: "elsewhere" }], /Host/],
    [[{ name: "x-a", value: "one\r\nX-Evil: yes" }], /line break/],
    [[{ name: "x-a\nb", value: "1" }], /line break/],
    [[{ name: "x-a", value: "1" }, { name: "X-A", value: "2" }], /twice/],
    [[{ name: "x-new" }], /needs a value/],
    [Array.from({ length: 11 }, (_, i) => ({ name: `x-${i}`, value: "1" })), /at most 10/],
    ["x-a: 1", /list/],
  ] as const) {
    const refused = await keep(await put(rows));
    assert.equal(refused.status, 400, JSON.stringify(rows));
    assert.match(refused.body.error, said);
  }
  assert.deepEqual(config().custom[0].headers, { "x-team": kept }, "a refused list changed what was saved");
  assert.equal((await put([])).status, 200);
  assert.equal(config().custom[0].headers, undefined, "no headers is the field gone");
  assert.equal((await keep(await put([{ name: "x-team", value: kept }]))).status, 200);

  // a row with no value keeps the saved one; a name left out is gone
  const saved = await keep(await put([{ name: "x-team" }, { name: "anthropic-version", value: "2023-06-01" }, { name: "x-proxy-token", value }]));
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.endpoints[0].headers, ["x-team", "anthropic-version", "x-proxy-token"]);
  assert.deepEqual(config().custom[0].headers, { "x-team": kept, "anthropic-version": "2023-06-01", "x-proxy-token": value });
  assert.equal((await h.fetch("/api/custom-endpoints/nosuchhost/headers", { method: "PUT", body: JSON.stringify({ headers: [] }) })).status, 404);

  // the host that needed the header now lists its models, and was sent it
  const described = async () => (await h.json("/api/instances")).instances.find((i: any) => i.instanceId === endpoint.instanceId);
  const ready = await waitFor(async () => {
    const instance = await described();
    return instance?.models.options.length ? instance : null;
  });
  assert.equal(ready.snapshot.state, "available");
  assert.ok(f.seen.some((r) => r.url.endsWith("/models") && r.headers["x-proxy-token"] === value));

  // every place a value could come back out
  for (const path of [
    "/api/custom-endpoints",
    "/api/instances",
    "/api/providers",
    "/api/config",
    "/api/bots",
    "/api/agent/settings?category=workspace.engines",
  ]) {
    const res = await h.fetch(path);
    assert.equal(res.status, 200, path);
    answers.push(`${path} ${res.status} ${await res.text()}`);
  }
  answers.push(h.logs());
  for (const answer of answers) {
    assert.ok(!answer.includes(value), `a header value came back: ${answer.slice(0, 300)}`);
    assert.ok(!answer.includes(kept), `a kept header value came back: ${answer.slice(0, 300)}`);
  }
  // and the inspection says there are headers without saying which
  const inspected = answers.find((a) => a.startsWith("/api/agent/settings"))!;
  assert.match(inspected, /"headers"/);
});
