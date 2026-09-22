// Finding a model server that is already running.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { probeOllama, shouldAdopt, type LocalModels } from "../server/local-models.ts";
import type { AppConfig } from "../server/config.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const answers = (body: unknown, ok = true) => {
  globalThis.fetch = (async () => ({ ok, json: async () => body }) as unknown as Response) as typeof fetch;
};

describe("probeOllama", () => {
  test("a running Ollama reports what it has pulled", async () => {
    answers({ data: [{ id: "llama3.2" }, { id: "qwen2.5" }] });
    assert.deepEqual(await probeOllama(), { running: true, models: ["llama3.2", "qwen2.5"] });
  });

  test("answering with nothing pulled is not running, because it is not usable", async () => {
    answers({ data: [] });
    assert.deepEqual(await probeOllama(), { running: false, models: [] });
  });

  test("a refused connection is simply not running", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    assert.deepEqual(await probeOllama(), { running: false, models: [] });
  });

  test("an error status is not running", async () => {
    answers({ data: [{ id: "x" }] }, false);
    assert.equal((await probeOllama()).running, false);
  });

  test("junk in the list is dropped rather than shown", async () => {
    answers({ data: [{ id: "good" }, { id: 7 }, {}] });
    assert.deepEqual((await probeOllama()).models, ["good"]);
  });
});

describe("shouldAdopt", () => {
  const found: LocalModels = { running: true, models: ["llama3.2"] };

  test("connects it when nothing is configured", () => {
    assert.equal(shouldAdopt({} as AppConfig, found), true);
  });

  test("never over an existing entry, including one somebody emptied", () => {
    assert.equal(shouldAdopt({ providers: { ollama: {} } } as AppConfig, found), false);
    assert.equal(
      shouldAdopt({ providers: { ollama: { url: "http://10.0.0.2:11434/v1" } } } as AppConfig, found),
      false,
    );
  });

  test("nothing running means nothing to connect", () => {
    assert.equal(shouldAdopt({} as AppConfig, { running: false, models: [] }), false);
  });
});
