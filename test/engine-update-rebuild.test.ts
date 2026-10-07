// An engine updated from the app reads its new models (GitHub 199).
//
// The engines read their model lists when they are built, so an update
// has to rebuild the engine it updated. It used to do that only when no
// agent anywhere was busy, and otherwise never: the window said the new
// models would appear once the work finished, and they appeared after a
// restart. What matters: an engine with a turn running is rebuilt once
// that turn ends, never in the middle of it, and a turn on some other
// engine neither holds the rebuild back nor dies of it.
//
// Pi stands in for any engine whose models come from its CLI. Its CLI is
// a script that serves whatever catalog a file holds, and the "update"
// is a login shell that rewrites the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const catalog = (id: string) => JSON.stringify({ availableModels: [{ modelId: id, name: id }], currentModelId: id });

/** A pi-acp that serves `$HOME/pi-models.json`, and holds every prompt
 * until `$HOME/pi-release` exists. */
const FAKE_PI = [
  `#!${process.execPath}`,
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const home = process.env.HOME;",
  'const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'const reply = (id, result) => say({ jsonrpc: "2.0", id, result });',
  'const models = () => JSON.parse(fs.readFileSync(path.join(home, "pi-models.json"), "utf8"));',
  'require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
  "  let msg; try { msg = JSON.parse(line); } catch { return; }",
  "  if (msg.id === undefined || !msg.method) return;",
  '  if (msg.method === "initialize") reply(msg.id, { protocolVersion: 1, agentCapabilities: {} });',
  '  else if (msg.method === "session/new" || msg.method === "session/load") reply(msg.id, { sessionId: "s1", models: models() });',
  '  else if (msg.method === "session/prompt") {',
  "    const wait = setInterval(() => {",
  '      if (!fs.existsSync(path.join(home, "pi-release"))) return;',
  "      clearInterval(wait);",
  '      say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Pi is done." } } } });',
  '      reply(msg.id, { stopReason: "end_turn" });',
  "    }, 50);",
  "  } else reply(msg.id, {});",
  "});",
].join("\n");

const piModels = async (h: Harness): Promise<string[]> => {
  const { instances } = await h.json("/api/instances");
  return (instances.find((i: any) => i.instanceId === "pi")?.models.options ?? []).map((o: any) => o.id);
};

test("an engine updated mid-turn is rebuilt once its turn ends, and other engines carry on", { skip: process.platform === "win32" }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-update-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "pi-acp"), FAKE_PI + "\n", { mode: 0o755 });
  writeFileSync(join(home, "pi-models.json"), catalog("vendor/old"));
  // what the update runs through: the new release serves a new model
  const shell = join(home, "fake-shell");
  writeFileSync(shell, `#!/bin/sh\necho '${catalog("vendor/new")}' > "$HOME/pi-models.json"\n`, { mode: 0o755 });

  const fake = await fakeProvider(t);
  const h = await startHarness({ HOME: home, SHELL: shell });
  t.after(() => h.stop());
  assert.ok(await waitFor(async () => (await piModels(h)).includes("vendor/old")), "pi never served its catalog");

  const { bot: pi } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Pia" }) });
  await h.fetch(`/api/bots/${pi.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "pi", model: "vendor/old" } }) });
  await h.fetch(`/api/bots/${pi.id}/messages`, { method: "POST", body: JSON.stringify({ text: "TAKE-A-MINUTE" }) });
  assert.ok(
    await waitFor(async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === pi.id)?.busy),
    "the pi turn never started",
  );
  await new Promise((r) => setTimeout(r, 500));

  const updated = await h.json("/api/engines/pi/update", { method: "POST" });
  assert.equal(updated.ok, true, updated.log);
  assert.equal(updated.reloaded, false, "rebuilt under a running turn");
  // the turn is still running on the engine it started on
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await h.json("/api/bots")).bots.find((b: any) => b.id === pi.id)?.busy, true);
  assert.deepEqual(await piModels(h), ["vendor/old"]);

  // the turn ends, and the new models follow without a restart
  writeFileSync(join(home, "pi-release"), "");
  assert.ok(await idle(h, pi), "the pi turn never ended");
  assert.ok(await waitFor(async () => (await piModels(h)).includes("vendor/new")), "the new models never appeared");
  const messages = await messagesOf(h, pi);
  assert.equal(messages.filter((m) => m.kind === "notice" && /cut off/.test(m.text ?? "")).length, 0, "the rebuild cut the turn off");

  // Updated again while a turn runs on another engine: that turn does not
  // hold this engine's rebuild back, and the rebuild does not touch it.
  rmSync(join(home, "pi-release"));
  writeFileSync(shell, `#!/bin/sh\necho '${catalog("vendor/newer")}' > "$HOME/pi-models.json"\n`, { mode: 0o755 });
  const other = await agentOn(h, fake.port, "Ivy");
  await h.fetch(`/api/bots/${other.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG-JOB" }) });
  await waitFor(() => fake.state.calls.length >= 1);
  const again = await h.json("/api/engines/pi/update", { method: "POST" });
  assert.equal(again.reloaded, true, "a turn on another engine held the rebuild back");
  assert.ok(await waitFor(async () => (await piModels(h)).includes("vendor/newer")));
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await idle(h, other));
  const said = await messagesOf(h, other);
  assert.ok(said.some((m) => m.role === "bot" && m.text === "Done."), "the other engine's turn was lost");
  assert.equal(said.filter((m) => m.kind === "notice").length, 0);
  assert.equal(existsSync(join(home, "pi-release")), false);
});
