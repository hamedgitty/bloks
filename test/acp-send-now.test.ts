// Send now on an engine that cannot take words mid-turn, end to end
// (GitHub 475).
//
// OpenCode over ACP has no way to add words to a running turn: ACP has
// no such request, and OpenCode refuses a second session/prompt while
// one runs. Send now there is the stop Cmd+Enter makes, as on every
// engine without steering: the turn stops, says it was stopped rather
// than that it failed, and what waited goes together in the next turn.
// It used to say "The turn did not finish (cancelled)", since OpenCode
// answers a cancel with stopReason "cancelled".
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

test("Send now on OpenCode stops the turn as stopped and sends what waited in the next one", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-acp-send-now-"));
  const log = join(home, "prompts.log");
  // OpenCode as far as this goes: a prompt saying LONG runs until it is
  // cancelled, then answers "cancelled"; anything else is answered.
  const cli = join(home, "fake-opencode.cjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("1.19.5"); process.exit(0); }
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let running = null;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "session/cancel") {
    running?.();
    running = null;
    return;
  }
  if (msg.id === undefined || !msg.method) return;
  const reply = (result) => say({ jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (msg.method === "session/new") return reply({ sessionId: "s1" });
  if (msg.method !== "session/prompt") return reply({});
  const text = msg.params.prompt.map((p) => p.text ?? "").join("");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(text) + "\\n");
  if (running) return say({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error", data: { details: "Session already has an active ACP prompt" } } });
  if (text.includes("LONG")) {
    say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it" } } } });
    running = () => reply({ stopReason: "cancelled" });
    return;
  }
  say({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } } } });
  reply({ stopReason: "end_turn" });
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { "opencode-fake": { driver: "opencode", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const prompts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string) : []);

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Otto" }) });
  const set = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "opencode-fake", model: "auto" } }),
  });
  assert.equal(set.status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LONG: tidy the notes" }) });
  assert.ok(await waitFor(() => prompts().length === 1), "the first turn never reached the agent");

  const held = await h.json(`/api/bots/${bot.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "and keep the headings", delivery: "wait" }),
  });
  assert.equal(held.queued, true, `the words did not wait: ${JSON.stringify(held)}`);

  const now = await h.json(`/api/bots/${bot.id}/queued/now`, { method: "POST", body: "{}" });
  assert.equal(now.outcome, "stopped");

  assert.ok(await waitFor(() => prompts().length === 2), "what waited never went in a turn of its own");
  assert.match(prompts()[1], /and keep the headings/);
  assert.ok(await idle(h, bot), "the second turn never finished");

  const said = await messagesOf(h, bot);
  const waited = said.find((m: any) => m.text === "and keep the headings");
  assert.equal(waited?.queued, false);
  assert.equal(waited?.delivery?.line, "Stopped Otto to send this now");
  const notices = said.filter((m: any) => m.kind === "notice" || m.kind === "error").map((m: any) => String(m.text));
  assert.ok(!notices.some((text) => /did not finish|cancelled|Internal error|-32603/i.test(text)), `the stop read as a failure: ${JSON.stringify(notices)}`);
});
