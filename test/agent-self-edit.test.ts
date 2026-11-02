// An agent changing itself may narrow its reach, never widen it
// (server/agent-self-edit.ts). The rule on its own here; the route that
// applies it is held in api.test.ts, through a real turn's credential.
import assert from "node:assert/strict";
import { test } from "node:test";

import { selfEditRefusal } from "../server/agent-self-edit.ts";

const current = {
  computer: "sandbox",
  cwd: "/work/agent",
  modelSelection: { instanceId: "claude" },
  backupSelection: null,
  mcpServers: ["notes", "files"],
  composio: false,
  engineHooks: true,
};

test("what an agent may do to itself: keep what it has, or give some of it up", () => {
  for (const body of [
    { name: "Renamed", color: "#ff0000" },
    { computer: "off" },
    { computer: "sandbox" },
    { cwd: "/work/agent" },
    { modelSelection: { instanceId: "claude", model: "claude-haiku-5" } },
    { backupSelection: { instanceId: "claude", model: "claude-haiku-5" } },
    { backupSelection: null },
    { mcpServers: ["notes"] },
    { mcpServers: [] },
    { composio: false },
    { engineHooks: true },
  ]) {
    assert.equal(selfEditRefusal(body, current), null, JSON.stringify(body));
  }
});

test("what it may not: another computer, folder, engine, server, app or hook", () => {
  for (const [body, said] of [
    [{ computer: "local" }, /computer off/],
    [{ computer: null }, /computer off/],
    [{ cwd: "/" }, /working folder/],
    [{ cwd: null }, /working folder/],
    [{ modelSelection: { instanceId: "codex-full-auto", model: "gpt-6" } }, /another engine/],
    [{ modelSelection: null }, /another engine/],
    [{ backupSelection: { instanceId: "codex-full-auto", model: "gpt-6" } }, /fall back/],
    [{ mcpServers: ["notes", "shell"] }, /MCP servers/],
    [{ mcpServers: "notes" }, /MCP servers/],
    [{ composio: true }, /person's apps/],
    [{ engineHooks: false }, /hooks/],
  ] as const) {
    assert.match(selfEditRefusal(body as Record<string, unknown>, current) ?? "", said, JSON.stringify(body));
  }
});

test("an agent already connected to apps may keep them", () => {
  assert.equal(selfEditRefusal({ composio: true }, { ...current, composio: true }), null);
});
