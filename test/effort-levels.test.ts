// Reasoning effort: which levels each engine takes, what a turn is sent
// when the saved level is not one of them, and the desktop's copy of
// those answers (src/lib/effort.ts), held here to the server's.
import assert from "node:assert/strict";
import { test } from "node:test";

import * as server from "../server/effort.ts";
import * as desktop from "../src/lib/effort.ts";
import { ACP_SPECS } from "../server/drivers/acp.ts";
import { catalogFromModelList } from "../server/drivers/codex.ts";

const ALL = ["low", "medium", "high", "xhigh", "max"] as const;

/** An engine as the server holds it, and as /api/instances describes it. */
function engine(efforts: readonly server.Effort[] | undefined, options: Array<{ id: string; efforts?: server.Effort[] }> = [{ id: "m" }]) {
  const models = { default: options[0].id, options: options.map((o) => ({ label: o.id, ...o })) };
  return {
    held: { displayName: "Engine", driverKind: "x", adapter: { capabilities: efforts ? { efforts } : {} }, models },
    described: { instanceId: "x", displayName: "Engine", efforts: [...(efforts ?? [])], models },
  };
}

test("a saved level the engine has is sent as it is", () => {
  for (const level of ALL) assert.equal(server.clampEffort(level, ALL), level);
});

test("a level the engine lacks is sent as the nearest it has, the lower of two", () => {
  const grok = ["low", "medium", "high"] as const;
  assert.equal(server.clampEffort("max", grok), "high");
  assert.equal(server.clampEffort("xhigh", grok), "high");
  assert.equal(server.clampEffort("low", ["medium", "high"]), "medium");
  // high sits between medium and max, equally far from both
  assert.equal(server.clampEffort("high", ["medium", "max"]), "medium");
  assert.equal(server.clampEffort("max", ["low"]), "low");
});

test("nothing is sent with no level chosen, an unknown one, or an engine with no dial", () => {
  assert.equal(server.clampEffort(undefined, ALL), undefined);
  assert.equal(server.clampEffort(null, ALL), undefined);
  assert.equal(server.clampEffort("ultra", ALL), undefined);
  assert.equal(server.clampEffort("max", []), undefined);
  assert.equal(server.clampEffort("max", undefined), undefined);
});

test("each engine says the levels it passes on", () => {
  const spec = (kind: string) => ACP_SPECS.find((s) => s.kind === kind);
  // Grok CLI is given what it always was; the other ACP agents are given none
  assert.deepEqual(spec("grokCli")?.efforts, ["low", "medium", "high"]);
  for (const kind of ["opencode", "geminiCli", "pi"]) assert.equal(spec(kind)?.efforts, undefined, kind);
  // and only the levels turnArgs is given reach Grok's command line
  const args = spec("grokCli")!.turnArgs!({ fullAuto: false, effort: "high" });
  assert.equal(args[args.indexOf("--reasoning-effort") + 1], "high");
});

test("Codex's list narrows each model to the levels it names, in order", () => {
  const catalog = catalogFromModelList([
    {
      data: [
        { model: "gpt-wide", isDefault: true, supportedReasoningEfforts: [
          { reasoningEffort: "max", description: "" },
          { reasoningEffort: "low", description: "" },
          { reasoningEffort: "xhigh", description: "" },
          { reasoningEffort: "ultra", description: "" },
        ] },
        { model: "gpt-narrow", supportedReasoningEfforts: ["low", "medium", "high", "minimal"] },
        { model: "gpt-silent" },
      ],
    },
  ])!;
  assert.deepEqual(catalog.options.map((o) => o.efforts), [["low", "xhigh", "max"], ["low", "medium", "high"], undefined]);

  const codex = { displayName: "Codex", adapter: { capabilities: { efforts: ALL } }, models: catalog };
  assert.deepEqual(server.effortLevels(codex, "gpt-narrow"), ["low", "medium", "high"]);
  // a model the list did not describe has every level the engine takes
  assert.deepEqual(server.effortLevels(codex, "gpt-silent"), [...ALL]);
  // and an empty model is the engine's default one
  assert.deepEqual(server.effortLevels(codex, ""), ["low", "xhigh", "max"]);
});

test("choosing a level the engine lacks is refused, and says what it has", () => {
  const grok = { displayName: "Grok CLI", adapter: { capabilities: { efforts: ["low", "medium", "high"] as const } }, models: { default: "g", options: [] } };
  assert.equal(server.effortRefusal("high", grok, "g"), null);
  assert.equal(server.effortRefusal("max", grok, "g"), "Grok CLI takes effort low, medium or high, not max");
  const narrow = engine(ALL, [{ id: "gpt-narrow", efforts: ["low", "medium"] }, { id: "gpt-none", efforts: [] }]).held;
  assert.equal(server.effortRefusal("xhigh", narrow, "gpt-narrow"), "Engine takes effort low or medium on gpt-narrow, not xhigh");
  assert.equal(server.effortRefusal("low", narrow, "gpt-none"), "Engine takes no reasoning effort on gpt-none");
  assert.equal(server.effortRefusal("ultra", grok, "g"), "effort is low, medium, high, xhigh or max");
  // an engine with no dial does nothing with any level, and keeps it for
  // one that has one; one that is not here is not judged either
  assert.equal(server.effortRefusal("max", engine(undefined).held, "m"), null);
  assert.equal(server.effortRefusal("max", engine([]).held, "m"), null);
  assert.equal(server.effortRefusal("ultra", engine(undefined).held, "m"), "effort is low, medium, high, xhigh or max");
  assert.equal(server.effortRefusal("max", null), null);
});

test("the desktop's levels and clamp are the server's", () => {
  const values = [undefined, null, "", "ultra", ...ALL];
  const shapes = [[], ["low", "medium", "high"], ["medium", "max"], [...ALL]] as server.Effort[][];
  for (const levels of shapes) {
    for (const wanted of values) assert.equal(desktop.clampEffort(wanted, levels), server.clampEffort(wanted, levels), `${wanted} on ${levels}`);
  }
  for (const efforts of [undefined, ...shapes]) {
    const { held, described } = engine(efforts, [{ id: "a" }, { id: "b", efforts: ["low", "high", "max"] }]);
    for (const model of ["", "a", "b", "other"]) {
      assert.deepEqual(desktop.effortLevels(described, model), server.effortLevels(held, model), `${efforts} ${model}`);
    }
  }
  assert.deepEqual(desktop.EFFORTS, server.EFFORTS);
  assert.deepEqual(desktop.EFFORT_LABELS, server.EFFORT_LABELS);
});

test("the labels are plain words", () => {
  assert.deepEqual(Object.values(server.EFFORT_LABELS), ["Low", "Medium", "High", "Extra high", "Max"]);
  assert.deepEqual(desktop.effortOptions(["low", "xhigh"]), [
    { value: undefined, label: "Use engine setting" },
    { value: "low", label: "Low" },
    { value: "xhigh", label: "Extra high" },
  ]);
});

test("a picker shows the level a saved one runs at, and says so", () => {
  const grok = { instanceId: "grok", displayName: "Grok CLI", efforts: ["low", "medium", "high"] as server.Effort[], models: { default: "g", options: [] } };
  const quiet = { instanceId: "quiet", displayName: "OpenCode", efforts: [], models: { default: "q", options: [] } };
  const moved = desktop.effortChoice([grok], { instanceId: "grok", model: "g" }, "max");
  assert.equal(moved.value, "high");
  assert.deepEqual(moved.options.map((o) => o.label), ["Use engine setting", "Low", "Medium", "High"]);
  assert.equal(moved.note, "Saved as Max. Grok CLI has no Max, so it runs at High.");
  assert.equal(desktop.effortChoice([grok], { instanceId: "grok", model: "g" }, "medium").note, null);
  // an engine with no dial offers nothing, and keeps what was saved
  const none = desktop.effortChoice([quiet], { instanceId: "quiet", model: "q" }, "max");
  assert.deepEqual(none.levels, []);
  assert.equal(none.value, undefined);
  assert.equal(none.note, "OpenCode has no reasoning effort setting. Max is kept for an engine that has one.");
  // the model is named when it, not its engine, lacks the level
  const codex = {
    instanceId: "codex", displayName: "Codex", efforts: [...ALL] as server.Effort[],
    models: { default: "luna", options: [{ id: "luna", label: "GPT-5.6 Luna", efforts: ["low", "medium", "high", "xhigh"] as server.Effort[] }] },
  };
  const narrowed = desktop.effortChoice([codex], { instanceId: "codex", model: "" }, "max");
  assert.equal(narrowed.value, "xhigh");
  assert.equal(narrowed.note, "Saved as Max. GPT-5.6 Luna has no Max, so it runs at Extra high.");
  // an engine not in the list yet is not narrowed
  assert.deepEqual(desktop.effortChoice([], { instanceId: "gone", model: "" }, "max").levels, [...ALL]);
  // a server from before the levels were per engine took the first three everywhere
  assert.deepEqual(desktop.effortLevels({ models: { default: "m", options: [] } }), ["low", "medium", "high"]);
});
