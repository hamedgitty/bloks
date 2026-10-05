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
  // one from each preferred family, not two from the first
  assert.deepEqual(got.slice(0, 2), ["google/gemini-flash", "anthropic/claude"]);
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

// GitHub issue 151: an OpenRouter sign-in offered Gemini and the free
// models and nothing else, because Google alone serves enough tool-taking
// models to fill the whole shortlist before the next lab got a look in.
test("one family with dozens of models cannot crowd out the others", () => {
  const google = Array.from({ length: 40 }, (_, i) => `google/gemini-variant-${String(i).padStart(2, "0")}`);
  const ids = [...google, "anthropic/claude-opus", "anthropic/claude-sonnet", "openai/gpt-big", "x-ai/grok", "deepseek/v4"];
  const prefer = [/^google\//, /^anthropic\//, /^x-ai\//, /^openai\//, /^deepseek\//];
  const out = chooseModels(spec({ prefer, limit: 10 }), ids)!;
  const got = out.options.map((o) => o.id);
  assert.equal(got.length, 10);
  for (const lab of ["google/", "anthropic/", "x-ai/", "openai/", "deepseek/"]) {
    assert.ok(got.some((id) => id.startsWith(lab)), `${lab} is missing from ${got.join(", ")}`);
  }
  // still read lab by lab, in the order the spec prefers them
  const order = got.map((id) => prefer.findIndex((re) => re.test(id)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("within a family, the catalog's own picks go first, then the newest", () => {
  const ids = ["google/gemini-1-old", "google/gemini-2-mid", "google/gemini-3-new", "google/gemini-named"];
  const created = new Map([
    ["google/gemini-1-old", 1_700_000_000],
    ["google/gemini-2-mid", 1_750_000_000],
    ["google/gemini-3-new", 1_790_000_000],
    ["google/gemini-named", 1_600_000_000],
  ]);
  const named = spec({
    prefer: [/^google\//],
    limit: 2,
    models: { default: "google/gemini-named", options: [{ id: "google/gemini-named", label: "Named" }] },
  });
  const out = chooseModels(named, ids, undefined, created)!;
  assert.deepEqual(out.options.map((o) => o.id), ["google/gemini-named", "google/gemini-3-new"]);
  assert.equal(out.default, "google/gemini-named");
});

test("a gateway's routing variant of a listed model is not offered twice", () => {
  const out = chooseModels(spec({ prefer: [/^google\//] }), [
    "google/gemini-flash",
    "google/gemini-flash:batch",
    "google/gemini-flash:nitro",
    "google/only-batch:batch",
  ])!;
  assert.deepEqual(out.options.map((o) => o.id).sort(), ["google/gemini-flash", "google/only-batch:batch"]);
  // a tag that is part of the name, the way Ollama writes sizes, is kept
  const local = chooseModels(spec(), ["qwen3:8b", "qwen3:14b"])!;
  assert.equal(local.options.length, 2);
});
