// What the agent settings dialog offers and sends (src/lib/agentSettings.ts):
// only what changed, an engine with its model, an effort the new model
// cannot take dropped back to the engine's own, and the choices a member
// may not make shown off rather than hidden.
import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalAllowed, changesOf, computerAllowed, draftOf, effortsFor, settingsPath, type AgentSettingsView } from "../src/lib/agentSettings.ts";

const view = (over: Partial<AgentSettingsView> = {}): AgentSettingsView => ({
  agent: { id: "a1", name: "Homework", title: "", description: "", color: "red", shape: null, solo: true, mine: true },
  settings: { modelSelection: { instanceId: "claude", model: "sonnet" }, effort: "high", approvals: "ask", browser: false, computer: null },
  engines: [
    { id: "claude", name: "Claude", default: "sonnet", allowed: true, models: [{ id: "sonnet", label: "Sonnet", efforts: ["low", "medium", "high"] }, { id: "haiku", label: "Haiku", efforts: [] }] },
    { id: "codex", name: "Codex", default: "gpt", allowed: false, models: [{ id: "gpt", label: "GPT", efforts: ["low", "high"] }] },
  ],
  computers: [{ id: "sandbox", label: "Local VM" }, { id: "off", label: "Off" }],
  held: { approvals: "edits", computer: true },
  owner: { name: "Hamed" },
  ...over,
});

test("nothing changed sends nothing; each change is sent alone", () => {
  const v = view();
  assert.deepEqual(changesOf(v, draftOf(v)), {});
  assert.deepEqual(changesOf(v, { ...draftOf(v), name: "  Tutor " }), { name: "Tutor" });
  assert.deepEqual(changesOf(v, { ...draftOf(v), browser: true, computer: "off" }), { browser: true, computer: "off" });
  assert.deepEqual(changesOf(v, { ...draftOf(v), approvals: "edits" }), { approvals: "edits" });
});

test("a model changed carries its engine; an effort it cannot take goes back to the engine's own", () => {
  const v = view();
  assert.deepEqual(changesOf(v, { ...draftOf(v), model: "haiku" }), { modelSelection: { instanceId: "claude", model: "haiku" }, effort: null });
  assert.deepEqual(effortsFor(v, { engine: "claude", model: "sonnet" }), ["low", "medium", "high"]);
  // a level the new one takes stays as it was, and is not sent
  const kept = view({ engines: [{ ...view().engines[0], models: [...view().engines[0].models, { id: "opus", label: "Opus", efforts: ["high"] }] }] });
  assert.deepEqual(changesOf(kept, { ...draftOf(kept), model: "opus" }), { modelSelection: { instanceId: "claude", model: "opus" } });
});

test("a member sees what is held, off, and may always keep or narrow", () => {
  const v = view();
  assert.ok(approvalAllowed(v, "ask"));
  assert.ok(approvalAllowed(v, "edits"));
  assert.ok(!approvalAllowed(v, "auto"));
  assert.ok(!approvalAllowed(v, "full"));
  // what an admin gave it may stay
  assert.ok(approvalAllowed(view({ settings: { ...v.settings, approvals: "full" } }), "full"));
  assert.ok(computerAllowed(v, null));
  assert.ok(computerAllowed(v, "off"));
  assert.ok(!computerAllowed(v, "sandbox"));
  assert.ok(computerAllowed(view({ settings: { ...v.settings, computer: "sandbox" } }), "sandbox"));
  // nothing is held from the owner or an admin
  const free = view({ held: {} });
  for (const level of ["ask", "edits", "auto", "full"] as const) assert.ok(approvalAllowed(free, level));
  assert.ok(computerAllowed(free, "sandbox"));
});

test("the owner's way in and a member's", () => {
  assert.equal(settingsPath("owner", "a1"), "/api/workspace/agents/a1/settings");
  assert.equal(settingsPath("member", "a1"), "/api/member/agents/a1/settings");
});
