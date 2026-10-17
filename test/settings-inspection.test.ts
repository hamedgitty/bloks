import test from "node:test";
import assert from "node:assert/strict";
import { inspectWorkspaceSettings, WORKSPACE_INSPECTION_BYTES, INSPECTION_TEXT_CHARS } from "../server/settings-inspection.ts";
const defaults = { beforeTurn: 200000, beforeTurnAt: 0.6, stallMinutes: 15 };
const read = (saved: unknown = {}, runtime: unknown = saved, redact = (s: string) => s) =>
  inspectWorkspaceSettings({ saved, runtime, resolved: defaults, redact });
const field = (rows: ReturnType<typeof read>, id: string) => {
  const row = rows.find((r) => r.id === id); assert.ok(row, id); return row;
};

test("workspace answers effective defaults and the actual turn-limit control", () => {
  const rows = read();
  for (const [id, value] of [["agents.turnLimit", 12], ["recall.beforeTurn", true], ["changes.showShared", true],
    ["compaction.micro", false], ["compaction.idle", false], ["skills.propose", false],
    ["compaction.beforeTurn", 200000], ["compaction.beforeTurnAt", 0.6], ["turns.stallMinutes", 15],
    ["shortcuts.quickAsk", null], ["profile.about", ""], ["profile.name", "The owner"]] as const) {
    assert.deepEqual(field(rows, id).effective, { status: "value", value });
    assert.deepEqual(field(rows, id).saved, { status: "absent" });
  }
  assert.equal(field(rows, "agents.turnLimit").control, "Settings > General > Working with agents");
});

test("saved absent, null, false, zero and empty string stay distinguishable", () => {
  for (const value of [null, false, 0, ""]) {
    const rows = read({ agents: { turnLimit: value } });
    assert.deepEqual(field(rows, "agents.turnLimit").saved, { status: "value", value });
    assert.deepEqual(field(rows, "agents.turnLimit").effective, { status: "value", value: 12 });
  }
  assert.deepEqual(field(read({ agents: { turnLimit: 60 } }), "agents.turnLimit").effective, { status: "value", value: 50 });
  const rows = inspectWorkspaceSettings({ saved: { compaction: { beforeTurn: 0 } }, runtime: {},
    resolved: { beforeTurn: 0, beforeTurnAt: 0.4, stallMinutes: 0 }, redact: (s) => s });
  assert.deepEqual(field(rows, "compaction.beforeTurn").effective, { status: "value", value: 0 });
  assert.deepEqual(field(rows, "turns.stallMinutes").effective, { status: "value", value: 0 });
});

test("saved versus already-resolved environment precedence exposes only configured status", () => {
  const secret = "SENTINEL_PRIVATE_VALUE";
  const rows = read({}, { composio: { key: secret, apiKey: secret }, speech: { openaiKey: secret }, box: { token: secret } });
  assert.deepEqual(field(rows, "composio.key").saved, { status: "absent" });
  assert.deepEqual(field(rows, "composio.key").effective, { status: "configured", configured: true });
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.deepEqual(field(read({ composio: { key: "" } }, { composio: { key: "" } }), "composio.key").effective,
    { status: "configured", configured: false });
});

test("registered secrets are redacted and opaque nested maps and unknown ids never escape", () => {
  const secret = "SENTINEL_PRIVATE_VALUE";
  const cfg = { profile: { about: `Use ${secret} carefully` }, composio: { key: secret },
    mcpServers: [{ id: secret, args: [secret], url: `https://example.com/${secret}`, env: { [secret]: secret } }],
    [secret]: { token: secret } };
  const rows = read(cfg, cfg, (s) => s.replaceAll(secret, "[redacted]"));
  assert.deepEqual(field(rows, "profile.about").effective, { status: "value", value: "Use [redacted] carefully" });
  assert.ok(!JSON.stringify(rows).includes(secret));
  assert.ok(!rows.some((r) => /mcp|url|env/.test(r.id)));
});

test("projection does not enumerate inherited or unknown getters", () => {
  let calls = 0;
  const cfg = Object.create({ agents: { turnLimit: 45 } });
  Object.defineProperty(cfg, "provider", { enumerable: true, get() { calls++; throw new Error("PRIVATE ERROR"); } });
  Object.defineProperty(cfg, "profile", { enumerable: true, get() { calls++; throw new Error("PRIVATE ERROR"); } });
  const rows = read(cfg); assert.equal(calls, 0);
  assert.deepEqual(field(rows, "agents.turnLimit").effective, { status: "value", value: 12 });
  assert.ok(!JSON.stringify(rows).includes("PRIVATE"));
});

test("oversized values and projector failures are neutral and whole response remains bounded", () => {
  const cfg = { profile: { about: String.fromCodePoint(0x1F600).repeat(INSPECTION_TEXT_CHARS + 1), name: "SENTINEL_PRIVATE_VALUE" } };
  const rows = read(cfg, cfg, () => { throw new Error("SENTINEL_PRIVATE_VALUE"); });
  assert.deepEqual(field(rows, "profile.about").effective, { status: "omitted", reason: "size_limit" });
  assert.deepEqual(field(rows, "profile.name").effective, { status: "unsupported", reason: "invalid_value" });
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) <= WORKSPACE_INSPECTION_BYTES);
  assert.ok(!JSON.stringify(rows).includes("SENTINEL"));
});
