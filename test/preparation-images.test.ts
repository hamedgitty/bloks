// The real server and a local ACP stand-in. No provider or device is used.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";

for (const restart of [false, true]) test(`image-capable preparation preserves deferred rows${restart ? " across restart" : ""}`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-preparation-images-"));
  const cli = join(root, "fake-pi-acp"), log = join(root, "prompts.jsonl");
  mkdirSync(join(root, ".bloks"), { recursive: true });
  writeFileSync(join(root, ".bloks", "config.json"), JSON.stringify({ instances: { pi: { driver: "pi", config: { cli } } } }));
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
const root = ${JSON.stringify(root)}, log = ${JSON.stringify(log)};
process.stdin.on("end", () => process.exit(0));
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined || !m.method) return;
  const reply = (result) => out({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
  if (m.method === "session/new" || m.method === "session/load") {
    if (!fs.existsSync(root + "/session-gate")) {
      fs.writeFileSync(root + "/session-held", "1");
      while (!fs.existsSync(root + "/session-gate")) await pause(20);
    }
    return reply({ sessionId: "fixture-session", models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }] } });
  }
  if (m.method === "session/prompt") {
    fs.appendFileSync(log, JSON.stringify(m.params.prompt) + "\\n");
    if (fs.readFileSync(log, "utf8").trim().split("\\n").length === 1) {
      while (!fs.existsSync(root + "/prompt-gate")) await pause(20);
    }
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fixture-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "DONE" } } } });
    return reply({ stopReason: "end_turn" });
  }
  return reply({});
});
`, { mode: 0o755 });
  let h = await startHarness({ HOME: root });
  t.after(async () => {
    writeFileSync(join(root, "session-gate"), "1");
    writeFileSync(join(root, "prompt-gate"), "1");
    await h.stop();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Fixture" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: root, modelSelection: { instanceId: "pi", model: "auto" } }) });
  const paths: string[] = [];
  for (let i = 0; i < 18; i++) {
    const response = await h.fetch("/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i]) });
    assert.equal(response.status, 200);
    paths.push((await response.json()).path);
  }
  const tags = (xs: string[]) => xs.map((path) => `<attached-image path="${path}" />`).join("\n");
  const say = (text: string) => h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
  const first = say(`FIRST\n${tags(paths.slice(0, restart ? 8 : 7))}`);
  assert.ok(await waitFor(() => existsSync(join(root, "session-held")), 30_000));
  if (!restart) assert.equal((await say(`FITS_ONE\n${tags(paths.slice(7, 8))}`)).status, 202);
  assert.equal((await say(`NINE_PATHS\n${tags(paths.slice(8, 17))}`)).status, 202);
  assert.equal((await say(`ONE_AFTER\n${tags(paths.slice(17))}`)).status, 202);
  assert.equal((await say("AFTER_ONE")).status, 202);
  writeFileSync(join(root, "session-gate"), "1");
  assert.equal((await first).status, 202);
  const prompts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  assert.ok(await waitFor(() => prompts().length === 1, 30_000));
  const one = prompts()[0];
  assert.equal(one.filter((p: any) => p.type === "image").length, 8);
  if (!restart) assert.match(JSON.stringify(one), /FITS_ONE/);
  assert.doesNotMatch(JSON.stringify(one), /NINE_PATHS|ONE_AFTER|AFTER_ONE/);
  if (restart) {
    const rows = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
    assert.ok(["pending", "next"].includes(rows.messages.find((m: any) => m.text?.startsWith("NINE_PATHS")).preparation.state));
    assert.ok(["pending", "next"].includes(rows.messages.find((m: any) => m.text?.startsWith("ONE_AFTER")).preparation.state));
    await h.crash();
    h = await startHarness({ HOME: root });
  }
  writeFileSync(join(root, "prompt-gate"), "1");
  assert.ok(await waitFor(() => prompts().length === 3, 30_000));
  assert.ok(await idle(h, bot));
  const two = prompts()[1];
  assert.equal(two.filter((p: any) => p.type === "image").length, 8);
  const bytesFor = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n]).toString("base64");
  assert.deepEqual(two.filter((p: any) => p.type === "image").map((p: any) => p.data), Array.from({ length: 8 }, (_, i) => bytesFor(i + 8)));
  const text = two.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  assert.match(text, /NINE_PATHS/);
  assert.doesNotMatch(text, /ONE_AFTER|AFTER_ONE/);
  for (const path of paths.slice(8, 17)) assert.ok(text.includes(path));
  const three = prompts()[2];
  assert.equal(three.filter((p: any) => p.type === "image").length, 1);
  assert.equal(three.find((p: any) => p.type === "image").data, bytesFor(17));
  const last = three.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  assert.ok(last.indexOf("ONE_AFTER") < last.indexOf("AFTER_ONE"));
  assert.ok(last.includes(paths[17]));
  assert.equal(prompts().length, 3);

  if (restart) return;

  // A later attempt sends eight image bytes before its first receipt. Its
  // dismissed row cannot be replayed or release capacity in that attempt.
  rmSync(join(root, "session-gate"));
  rmSync(join(root, "prompt-gate"));
  rmSync(join(root, "session-held"));
  writeFileSync(log, "");
  const nextFirst = say(`FIRST_AGAIN\n${tags(paths.slice(0, 7))}`);
  assert.ok(await waitFor(() => existsSync(join(root, "session-held")), 30_000));
  assert.equal((await say(`DISMISSED_IMAGE\n${tags(paths.slice(7, 8))}`)).status, 202);
  writeFileSync(join(root, "session-gate"), "1");
  assert.equal((await nextFirst).status, 202);
  assert.ok(await waitFor(() => prompts().length === 1, 30_000));
  assert.equal(prompts()[0].filter((p: any) => p.type === "image").length, 8);
  const rows = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=500`);
  const submitted = rows.messages.find((m: any) => m.text?.startsWith("DISMISSED_IMAGE"));
  assert.equal(submitted.preparation.state, "dispatching");
  assert.equal((await h.fetch(`/api/threads/${bot.threadId}/messages/${submitted.id}/dismiss-preparation`, { method: "POST" })).status, 200);
  assert.equal((await say(`AFTER_DISMISS\n${tags(paths.slice(8, 9))}`)).status, 202);
  assert.equal(prompts().length, 1);
  writeFileSync(join(root, "prompt-gate"), "1");
  assert.ok(await waitFor(() => prompts().length === 2, 30_000));
  assert.ok(await idle(h, bot));
  assert.equal(prompts()[1].filter((p: any) => p.type === "image").length, 1);
  assert.match(JSON.stringify(prompts()[1]), /AFTER_DISMISS/);
  assert.doesNotMatch(JSON.stringify(prompts()[1]), /DISMISSED_IMAGE/);
});
