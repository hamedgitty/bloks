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

// OpenRouter's free models, which the paid shortlist used to crowd out.
test("free models get their own slots after the paid shortlist", () => {
  const ids = [
    "google/gemini-pro", "google/gemini-flash", "anthropic/claude",
    "deepseek/deepseek-chat:free", "meta-llama/llama-3.3-70b:free", "google/gemma-3:free",
  ];
  const out = chooseModels(spec({ prefer: [/^google\//, /^anthropic\//], limit: 2, freeSlots: 2 }), ids)!;
  const got = out.options.map((o) => o.id);
  assert.deepEqual(got.slice(0, 2), ["google/gemini-flash", "google/gemini-pro"]);
  // preferred family first among the free ones, then alphabetical
  assert.deepEqual(got.slice(2), ["google/gemma-3:free", "deepseek/deepseek-chat:free"]);
});

test("a free model is labelled as free", () => {
  const out = chooseModels(spec({ freeSlots: 5 }), ["deepseek/deepseek-chat-v3:free"])!;
  assert.match(out.options.find((o) => o.id.endsWith(":free"))!.label, /\(free\)$/);
});

test("when the provider says which models take tools, free ones without tools are left out", () => {
  const ids = ["a/paid", "x/with-tools:free", "y/no-tools:free"];
  const out = chooseModels(spec({ freeSlots: 5 }), ids, new Set(["a/paid", "x/with-tools:free"]))!;
  const got = out.options.map((o) => o.id);
  assert.ok(got.includes("x/with-tools:free"));
  assert.ok(!got.includes("y/no-tools:free"));
});

test("a provider without free slots offers no extra free models", () => {
  const out = chooseModels(spec({ limit: 1 }), ["a/one", "b/two:free"])!;
  assert.equal(out.options.length, 1);
});
