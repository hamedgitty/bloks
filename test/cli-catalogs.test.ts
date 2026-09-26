import assert from "node:assert/strict";
import { test } from "node:test";

import { ACP_SPECS } from "../server/drivers/acp.ts";
import { antigravityLabel, catalogFromAgyModels } from "../server/drivers/antigravity.ts";
import { catalogFromModelList, codexLabel } from "../server/drivers/codex.ts";
import { contextLimitFor } from "../server/context.ts";

test("Codex's own model list becomes the picker, hidden models left out", () => {
  const catalog = catalogFromModelList([
    {
      data: [
        { id: "gpt-6-sol", model: "gpt-6-sol", displayName: "GPT-6-Sol", hidden: false, isDefault: true },
        { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false },
        { id: "internal", model: "internal", displayName: "Internal", hidden: true },
      ],
      nextCursor: "2",
    },
    { data: [{ id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5" }, { id: "gpt-6-sol", model: "gpt-6-sol" }] },
  ]);
  assert.deepEqual(catalog, {
    default: "gpt-6-sol",
    options: [
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
  });
});

test("an empty or unreadable Codex list keeps the built-in one", () => {
  assert.equal(catalogFromModelList([]), null);
  assert.equal(catalogFromModelList([{ data: [] }, null, { nope: true }]), null);
  // without a default flagged, the first model leads
  assert.equal(catalogFromModelList([{ data: [{ model: "gpt-6-astra" }] }])?.default, "gpt-6-astra");
});

test("Codex names read the way the picker spells them", () => {
  assert.equal(codexLabel("GPT-5.6-Terra", "gpt-5.6-terra"), "GPT-5.6 Terra");
  assert.equal(codexLabel(undefined, "gpt-6-luna"), "GPT-6 Luna");
  assert.equal(codexLabel("GPT-5.5", "gpt-5.5"), "GPT-5.5");
});

test("agy models output becomes a catalog, whatever the layout", () => {
  const plain = catalogFromAgyModels(
    ["Fetching available models...", "gemini-3.8-flash-high", "google/gemini-3.1-pro-low", "  - claude-opus-4-6-thinking", "gpt-oss-120b-medium", ""].join("\n"),
  );
  assert.deepEqual(
    plain?.options.map((o) => o.id),
    ["gemini-3.8-flash-high", "gemini-3.1-pro-low", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"],
  );
  // the built-in default survives when the account still has it
  const withDefault = catalogFromAgyModels("gemini-3.8-flash-low\ngemini-3.1-pro-high\n");
  assert.equal(withDefault?.default, "gemini-3.1-pro-high");

  const table = catalogFromAgyModels("NAME                      ID\nGemini 3.8 Flash (High)   gemini-3.8-flash-high\n");
  assert.deepEqual(table?.options.map((o) => o.id), ["gemini-3.8-flash-high"]);
});

test("a signed-out agy leaves the list alone", () => {
  assert.equal(
    catalogFromAgyModels("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n"),
    null,
  );
});

test("Antigravity ids the list has never seen still get a readable name", () => {
  assert.equal(antigravityLabel("gemini-3.1-pro-high"), "Gemini 3.1 Pro (High)");
  assert.equal(antigravityLabel("gemini-3.9-flash-medium"), "Gemini 3.9 Flash (Medium)");
  assert.equal(antigravityLabel("gpt-oss-240b-low"), "GPT-OSS 240b (Low)");
});

test("the ACP engines with a catalog of their own are asked for it", () => {
  for (const kind of ["opencode", "grokCli", "geminiCli", "pi"]) {
    assert.equal(ACP_SPECS.find((s) => s.kind === kind)?.probeModels, true, kind);
  }
});

test("the new models have their real windows", () => {
  assert.equal(contextLimitFor("claude-opus-5-5"), 1_000_000);
  assert.equal(contextLimitFor("gpt-6-luna"), 272_000);
  assert.equal(contextLimitFor("gpt-6-sol"), 272_000);
});
