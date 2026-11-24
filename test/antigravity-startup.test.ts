// The move of agents saved on a legacy print-mode Antigravity id, as a
// start does it (server/index.ts): the agents in bots.json and the engine
// new agents start on, with a model of its own whose id only looks
// suffixed left as saved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("a start moves agents and the new-agent default off legacy Antigravity ids, and keeps gpt-oss-120b-medium", { timeout: 120_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agy-startup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = join(home, "agy.mjs");
  writeFileSync(cli, `#!${process.execPath}
if (process.argv[2] === "--version") { console.log("1.5.16"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const data = join(home, ".bloks");
  mkdirSync(data, { recursive: true });
  const configFile = join(data, "config.json");
  const botsFile = join(data, "bots.json");
  writeFileSync(configFile, JSON.stringify({ instances: { agy: { driver: "antigravity", config: { cli } } } }));

  let h = await startHarness({ HOME: home });
  const hire = async (name: string) => (await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) })).bot.id as string;
  const legacyId = await hire("Gemma");
  const ownId = await hire("Oscar");
  await h.stop();

  // as an earlier version left them
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  for (const bot of bots) {
    if (bot.id === legacyId) Object.assign(bot, { modelSelection: { instanceId: "agy", model: "gemini-3.1-pro-high" }, effort: "low" });
    if (bot.id === ownId) bot.modelSelection = { instanceId: "agy", model: "gpt-oss-120b-medium" };
  }
  writeFileSync(botsFile, JSON.stringify(bots, null, 2));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.agentDefaults = { modelSelection: { instanceId: "agy", model: "claude-opus-4-6-thinking" }, approvals: "edits" };
  writeFileSync(configFile, JSON.stringify(config, null, 2));

  h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const saved = (id: string) => JSON.parse(readFileSync(botsFile, "utf8")).find((b: any) => b.id === id);
  assert.deepEqual(saved(legacyId).modelSelection, { instanceId: "agy", model: "gemini-3.1-pro" });
  assert.equal(saved(legacyId).effort, "high");
  assert.deepEqual(saved(ownId).modelSelection, { instanceId: "agy", model: "gpt-oss-120b-medium" });
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).agentDefaults, {
    modelSelection: { instanceId: "agy", model: "claude-opus-4-6" },
    effort: "high",
    approvals: "edits",
  });
  const born = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Nova" }) });
  assert.deepEqual(born.bot.modelSelection, { instanceId: "agy", model: "claude-opus-4-6" });
  assert.equal(born.bot.effort, "high");
});
