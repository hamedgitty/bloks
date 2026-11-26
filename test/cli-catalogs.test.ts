import assert from "node:assert/strict";
import { test } from "node:test";

import { ACP_SPECS } from "../server/drivers/acp.ts";
import { catalogFromModelList, codexLabel } from "../server/drivers/codex.ts";
import { contextLimitFor } from "../server/context.ts";

test("Codex's own model list becomes the picker, hidden models left out", (t) => {
  t.mock.method(Date, "now", () => 1_000);
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
    checkedAt: 1_000,
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

test("the ACP engines with a catalog of their own are asked for it", () => {
  for (const kind of ["opencode", "grokCli", "geminiCli", "pi", "antigravity"]) {
    assert.equal(ACP_SPECS.find((s) => s.kind === kind)?.probeModels, true, kind);
  }
});

test("the new models have their real windows", () => {
  assert.equal(contextLimitFor("claude-opus-5-5"), 1_000_000);
  assert.equal(contextLimitFor("gpt-6-luna"), 272_000);
  assert.equal(contextLimitFor("gpt-6-sol"), 272_000);
});
