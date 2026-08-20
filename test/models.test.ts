// Narrowing a provider's raw model list into something a picker can hold.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chooseModels } from "../server/drivers/openai-compat.ts";
import type { ProviderSpec } from "../server/providers.ts";

const spec = (over: Partial<ProviderSpec> = {}): ProviderSpec => ({
  kind: "test",
  name: "Test",
  url: "https://example.invalid/v1",
  auth: "key",
  keyHint: "",
  docsUrl: "",
  models: { default: "b-1", options: [{ id: "b-1", label: "B 1" }] },
  ...over,
});

test("embeddings and other non-chat models are dropped", () => {
  const out = chooseModels(spec(), [
    "chat-large",
    "text-embedding-3-small",
    "whisper-1",
    "tts-1",
    "llama-guard-4",
    "omni-moderation-latest",
  ]);
  assert.deepEqual(out?.options.map((o) => o.id), ["chat-large"]);
});

test("preferred families come first, in the order the spec lists them", () => {
  const out = chooseModels(spec({ prefer: [/^google\//, /^anthropic\//, /^x-ai\//] }), [
    "x-ai/grok-4",
    "anthropic/claude-sonnet",
    "google/gemini-flash",
    "someone-else/model",
  ]);
  assert.deepEqual(out?.options.map((o) => o.id), [
    "google/gemini-flash",
    "anthropic/claude-sonnet",
    "x-ai/grok-4",
  ]);
});

test("the list is capped, because a gateway can serve hundreds", () => {
  const many = Array.from({ length: 400 }, (_, i) => `vendor/model-${i}`);
  const out = chooseModels(spec({ prefer: [/^vendor\//], limit: 12 }), many);
  assert.equal(out?.options.length, 12);
});

test("the configured default survives a refresh when the provider still serves it", () => {
  // otherwise an agent would silently move to a different model
  const out = chooseModels(spec(), ["a-1", "b-1", "c-1"]);
  assert.equal(out?.default, "b-1");
});

test("a default the provider dropped falls back to the first option", () => {
  const out = chooseModels(spec(), ["a-1", "c-1"]);
  assert.equal(out?.default, "a-1");
  assert.ok(out?.options.some((o) => o.id === "a-1"));
});

test("an unusable list returns null so the fallback catalog stays", () => {
  assert.equal(chooseModels(spec(), []), null);
  assert.equal(chooseModels(spec(), ["", ""]), null);
  assert.equal(chooseModels(spec(), ["text-embedding-ada"]), null);
});

test("duplicates collapse", () => {
  const out = chooseModels(spec(), ["a-1", "a-1", "a-1"]);
  assert.equal(out?.options.length, 1);
});

test("ids become readable labels", () => {
  const out = chooseModels(spec({ prefer: [/llama/] }), ["meta-llama/llama-4-maverick"]);
  assert.equal(out?.options[0].label, "Llama 4 Maverick");
});
