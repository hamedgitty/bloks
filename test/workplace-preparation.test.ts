// Real server, fake container and fake ACP engine. No Docker daemon,
// provider or remote host is used.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakePlaces } from "./helpers/fake-places.ts";
import { startHarness } from "./helpers/server.ts";
import { idle, messagesOf, waitFor } from "./helpers/turns.ts";

for (const afterCommit of [false, true]) test(`an unsupported remote engine queues a file ${afterCommit ? "after" : "before"} commitment without stopping`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-remote-acp-"));
  const fake = fakePlaces(root, join(root, "unused.json"));
  const cli = join(fake.there, "pi-acp");
  const log = join(root, "prompts.jsonl");
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const root = ${JSON.stringify(root)}, remote = process.env.HOME === ${JSON.stringify(fake.home)};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (remote && m.method === "session/cancel") { fs.writeFileSync(root + "/cancelled", "1"); return; }
  if (m.id === undefined || !m.method) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {} });
  if (m.method === "session/new" || m.method === "session/load") {
    if (remote && !fs.existsSync(root + "/session-gate")) {
      fs.writeFileSync(root + "/session-held", "1");
      while (!fs.existsSync(root + "/session-gate")) await pause(20);
    }
    return reply({ sessionId: "fake-session", models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }] } });
  }
  if (m.method === "session/prompt") {
    const text = m.params.prompt.filter((p) => p.type === "text").map((p) => p.text).join("");
    const path = text.split('<attached-file path="')[1]?.split('"')[0];
    const content = path && fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null;
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text, path, content }) + "\\n");
    const count = fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
    if (count === 1) while (!fs.existsSync(root + "/prompt-gate")) await pause(20);
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } } } });
    return reply({ stopReason: "end_turn" });
  }
  return reply({});
});
`, { mode: 0o755 });
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks", "config.json"), JSON.stringify({ instances: { pi: { driver: "pi", config: { cli } } } }));
  const file = join(root, "file.txt");
  writeFileSync(file, "remote ACP attachment");
  const h = await startHarness({ HOME: root, ...fake.env });
  t.after(async () => {
    writeFileSync(join(root, "session-gate"), "1");
    writeFileSync(join(root, "prompt-gate"), "1");
    await h.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: root, modelSelection: { instanceId: "pi", model: "auto" } }) });
  const place = await h.fetch(`/api/bots/${bot.id}/workplace`, { method: "PUT", body: JSON.stringify({ workplace: {
    kind: "docker", source: "image", image: "node:22-bookworm", name: "fake-acp", folder: "mount", path: root, command: cli, network: true,
  } }) });
  assert.equal(place.status, 200, await place.clone().text());
  const first = h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_REMOTE_ACP" }) });
  assert.ok(await waitFor(() => existsSync(join(root, "session-held")), 30_000), "the fake remote session did not pause");
  const addFile = () => h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `ACP_FILE <attached-file path="${file}" />` }) });
  if (!afterCommit) assert.equal((await addFile()).delivery?.route, "pending");
  writeFileSync(join(root, "session-gate"), "1");
  assert.equal((await first).status, 202);
  const prompts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  assert.ok(await waitFor(() => prompts().length === 1, 30_000), "the first prompt did not reach the fake engine");
  assert.doesNotMatch(prompts()[0].text, /ACP_FILE/);
  if (afterCommit) assert.equal((await addFile()).delivery?.route, "queued");
  assert.ok(await waitFor(async () => (await messagesOf(h, bot)).some((m) => m.text?.startsWith("ACP_FILE") && m.preparation?.state === "next"), 10_000), "the waiting file did not get next-turn status");
  const later = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "AFTER_ACP_FILE" }) });
  assert.equal(later.delivery?.route, "queued");
  assert.ok((await messagesOf(h, bot)).some((m) => m.text === "AFTER_ACP_FILE" && m.preparation?.state === "next"));
  assert.equal(prompts().length, 1, "the first turn was stopped or the file overtook it");
  assert.equal(existsSync(join(root, "cancelled")), false, "the fallback cancelled the original turn");
  writeFileSync(join(root, "prompt-gate"), "1");
  assert.ok(await waitFor(() => prompts().length === 2, 30_000), "the next turn did not start");
  assert.match(prompts()[1].text, /ACP_FILE/);
  assert.ok(prompts()[1].text.indexOf("ACP_FILE") < prompts()[1].text.indexOf("AFTER_ACP_FILE"));
  assert.equal(prompts()[1].content, "remote ACP attachment");
  assert.ok(prompts()[1].path.startsWith(fake.home + "/"));
  assert.ok(await idle(h, bot));
  assert.equal(prompts().length, 2);
});
