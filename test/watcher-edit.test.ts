import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { allows } from "../server/agent-cli.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const cli = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const runCli = (args: string[], home: string, url: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  execFile(process.execPath, [cli, ...args], {
    env: { HOME: home, USERPROFILE: home, PATH: "/nonexistent", BLOKS_URL: url, BLOKS_TOKEN: "blk_fixture" },
    timeout: 10_000,
  }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") return reject(error);
    assert.equal(stderr, "");
    try { resolve({ status: error?.code as number ?? 0, body: JSON.parse(stdout) }); }
    catch (parseError) { reject(parseError); }
  });
});

test("the agent route permits watcher PATCH but no collection or nested operation", () => {
  assert.equal(allows("me", "PATCH", "/api/watchers/own-id").ok, true, "watcher PATCH is missing from the agent allow-list");
  assert.equal(allows("me", "PATCH", "/api/watchers").ok, false);
  assert.equal(allows("me", "PATCH", "/api/watchers/own-id/check").ok, false);
  assert.equal(allows("me", "PUT", "/api/watchers/own-id").ok, false);
  assert.equal(allows("me", "POST", "/api/watchers/own-id/check").ok, false);
});

test("CLI edits send one sparse PATCH, keep literal true and empty values, and report interval bounds", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-edit-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: Array<{ method?: string; path?: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push({ method: req.method, path: req.url, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ watcher: { kind: body.kind ?? "page", every: Math.max(5, Math.min(1440, body.every ?? 30)) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cases: Array<{ args: string[]; body: Record<string, unknown> }> = [
    { args: ["--do", "true"], body: { instruction: "true" } },
    { args: ["--name=New", "--mentions=", "--thread", ""], body: { name: "New", mentions: "", thread: "" } },
    ...["folder", "page", "feed", "check"].map((kind) => ({ args: [`--${kind}=true`], body: { kind, target: "true" } })),
    { args: ["--every", "17"], body: { every: 17 } },
  ];
  for (const { args, body } of cases) {
    const before = calls.length;
    const result = await runCli(["edit-watch", "own-id", ...args], home, url);
    assert.equal(result.status, 0, "the edit-watch CLI command did not succeed");
    assert.equal(calls.length, before + 1, "editing made an extra request instead of one PATCH");
    assert.deepEqual(calls.at(-1), { method: "PATCH", path: "/api/watchers/own-id", body }, "editing reset a field that was not supplied");
    assert.equal(result.body.note, undefined);
  }
  const clamped = await runCli(["edit-watch", "own-id", "--every", "2"], home, url);
  assert.equal(clamped.status, 0);
  assert.equal(clamped.body.note, "Checks every 5 minutes (the minimum; you asked for 2).");
});

test("CLI refuses missing, unknown and conflicting edits before making a request", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-edit-usage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cases: Array<[string[], RegExp]> = [
    [[], /watcher id/],
    [["--do", "Act"], /watcher id/],
    [["own-id"], /at least one field/],
    [["own-id", "--do"], /--do needs a value/],
    [["own-id", "--every", "--do", "Act"], /--every needs a value/],
    [["own-id", "--do", "Act", "--botId", "other"], /does not understand --botId/],
    [["own-id", "stray"], /does not understand stray/],
    [["own-id", "--folder", "/a", "--page", "https://fixture.invalid"], /only one of/],
    [["own-id", "--every", "Infinity"], /number of minutes/],
    [["own-id", "--every", "abc"], /number of minutes/],
  ];
  for (const [args, error] of cases) {
    const result = await runCli(["edit-watch", ...args], home, "http://127.0.0.1:1");
    assert.equal(result.status, 1);
    assert.match(result.body.error, error, "invalid CLI input reached the server or was silently ignored");
  }
  const help = await runCli(["help"], home, "http://127.0.0.1:1");
  const command = help.body.commands.find((c: any) => c.name === "edit-watch");
  assert.ok(command, "help does not expose the watcher edit command");
  assert.match(command.use, /<watcher-id>.*--do.*--thread/);
  assert.match(command.about, /id and fire history/);
});

const request = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

test("an actual agent edits saved watchers through the CLI with ownership and approvals intact", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-watcher-edit-"));
  const answers = join(home, "answers.json");
  const engine = join(home, "fake-claude.mjs");
  let h: Harness | undefined;
  t.after(async () => { await h?.stop(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".bloks"));
  const folder = join(home, "watched");
  mkdirSync(folder);
  // This engine receives a real turn credential. It runs the real CLI
  // or a raw request for the status check, never writing the credential.
  writeFileSync(engine, `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let line = "";
process.stdin.on("data", async (chunk) => {
  line += chunk;
  while (line.includes(String.fromCharCode(10))) {
    const at = line.indexOf(String.fromCharCode(10));
    const raw = line.slice(0, at); line = line.slice(at + 1);
    if (!raw.trim()) continue;
    const msg = JSON.parse(raw);
    const text = msg.message?.content;
    if (msg.type !== "user" || typeof text !== "string" || !text.startsWith("CALLS ")) continue;
    const out = [];
    for (const call of JSON.parse(Buffer.from(text.slice(6), "base64").toString())) {
      if (call.cli) {
        const ran = spawnSync(process.execPath, [process.env.BLOKS_CLI, ...call.cli], { env: process.env, encoding: "utf8", timeout: 10000 });
        out.push({ status: ran.status, body: JSON.parse(ran.stdout), stderr: ran.stderr });
      } else {
        const res = await fetch(process.env.BLOKS_URL + call.path, { method: "PATCH", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" }, body: JSON.stringify(call.body) });
        out.push({ status: res.status, body: await res.json() });
      }
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out));
    renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done" }));
  }
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: engine } } } }));
  h = await startHarness({ HOME: home });
  const { bot } = await h.json("/api/bots", request("POST", { name: "Watcher owner" }));
  const { bot: other } = await h.json("/api/bots", request("POST", { name: "Other owner" }));
  await h.fetch(`/api/bots/${bot.id}`, request("PATCH", { approvals: "ask", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }));
  const row = { kind: "folder", target: folder, instruction: "Original instruction", name: "Original", enabled: false, every: 30, mentions: "original", thread: "General" };
  const { watcher: own } = await h.json("/api/watchers", request("POST", { ...row, botId: bot.id }));
  const { watcher: foreign } = await h.json("/api/watchers", request("POST", { ...row, botId: other.id }));
  const { watcher: check } = await h.json("/api/watchers", request("POST", { ...row, botId: bot.id, kind: "check", target: "true" }));
  assert.ok(own && foreign && check, h.logs());
  assert.equal(check.approvedBy, "person");
  await h.stop();
  h = undefined;
  const storePath = join(home, ".bloks", "watchers.json");
  const saved = JSON.parse(readFileSync(storePath, "utf8"));
  const fires = [{ at: 1_700_000_000_000, summary: "Earlier finding" }, { at: 1_700_000_060_000, summary: "Second finding" }];
  for (const watcher of saved) { watcher.fires = fires; watcher.seen = "saved baseline"; }
  writeFileSync(storePath, JSON.stringify(saved));
  h = await startHarness({ HOME: home });
  const server = h;
  const asAgent = async (calls: unknown[]) => {
    rmSync(answers, { force: true });
    const sent = await server.fetch(`/api/bots/${bot.id}/messages`, request("POST", { text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }));
    assert.equal(sent.status, 202, server.logs());
    assert.ok(await waitFor(() => existsSync(answers), 20_000), "the synthetic engine did not run the CLI");
    assert.ok(await waitFor(async () => !(await server.json("/api/bots")).bots.find((b: any) => b.id === bot.id)?.busy, 20_000), "the synthetic turn did not finish");
    return JSON.parse(readFileSync(answers, "utf8"));
  };
  const watchers = async () => (await server.json("/api/watchers")).watchers;

  await t.test("own CLI edit retains id, history and omitted fields in the saved store", async () => {
    const instruction = "x".repeat(1_000);
    const [edited] = await asAgent([{ cli: ["edit-watch", own.id, "--do", instruction, "--name", "Edited", "--every", "17", "--mentions="] }]);
    assert.equal(edited.status, 0, "the actual agent CLI could not edit its watcher");
    assert.equal(edited.body.watcher.id, own.id, "editing replaced the watcher id");
    assert.deepEqual(edited.body.watcher.fires, fires, "editing lost the fire history");
    assert.equal(edited.body.watcher.instruction, instruction);
    assert.equal(edited.body.watcher.target, folder, "an omitted target changed");
    assert.equal(edited.body.watcher.enabled, false, "editing enabled a disabled watcher");
    assert.equal(edited.body.watcher.thread, "General", "an omitted conversation changed");
    assert.equal(edited.body.watcher.mentions, undefined);
    assert.equal(edited.body.watcher.name, "Edited");
    assert.equal(edited.body.watcher.every, 17);
    assert.equal((await watchers()).length, 3, "editing refiled a watcher");
    const persisted = JSON.parse(readFileSync(storePath, "utf8")).find((w: any) => w.id === own.id);
    assert.deepEqual(persisted.fires, fires, "the saved fire history changed");
    assert.equal(persisted.instruction, instruction);
    assert.equal(persisted.seen, "saved baseline");
  });

  await t.test("another owner receives 404, forged ownership is ignored and invalid edits leave no partial save", async () => {
    const before = readFileSync(storePath, "utf8");
    const [cliOther, httpOther, invalid] = await asAgent([
      { cli: ["edit-watch", foreign.id, "--do", "Must not be saved"] },
      { path: `/api/watchers/${foreign.id}`, body: { name: "Must not be saved" } },
      { cli: ["edit-watch", own.id, "--do", "x".repeat(1_001), "--name", "Must not be saved"] },
    ]);
    assert.equal(cliOther.status, 1, "the CLI edited another agent's watcher");
    assert.equal(cliOther.body.error, "no such watcher");
    assert.equal(httpOther.status, 404, "another agent's watcher did not answer 404");
    assert.equal(invalid.status, 1, "an over-limit agent edit was accepted");
    assert.match(invalid.body.error, /1,000/);
    assert.equal(readFileSync(storePath, "utf8"), before, "a refused edit saved part of its body");
    const [forged] = await asAgent([{ path: `/api/watchers/${own.id}`, body: { botId: other.id, id: "replacement", fires: [] } }]);
    assert.equal(forged.status, 200);
    assert.equal(forged.body.watcher.botId, bot.id, "an agent transferred watcher ownership");
    assert.equal(forged.body.watcher.id, own.id, "the client replaced a saved id");
    assert.deepEqual(forged.body.watcher.fires, fires, "the client erased fire history");
  });

  await t.test("a changed command needs approval again and cannot approve itself", async () => {
    const [unchanged, changed, forged] = await asAgent([
      { cli: ["edit-watch", check.id, "--do", "A new instruction"] },
      { cli: ["edit-watch", check.id, "--check", "false"] },
      { path: `/api/watchers/${check.id}`, body: { approved: true, approvedBy: "person" } },
    ]);
    assert.equal(unchanged.status, 0, "an instruction-only CLI edit failed");
    assert.equal(unchanged.body.watcher.approvedBy, "person", "an unchanged command lost its approval");
    assert.equal(changed.status, 0);
    assert.equal(changed.body.watcher.target, "false");
    assert.equal(changed.body.watcher.approvedBy, undefined, "a rewritten command kept the person's approval");
    assert.equal(forged.status, 200);
    assert.equal(forged.body.watcher.approvedBy, undefined, "an agent approved its own command");
    assert.equal(forged.body.watcher.id, check.id);
    assert.deepEqual(forged.body.watcher.fires, fires);
  });
});

test("an empty mentions edit clears a page's filter, and an edit without it keeps the filter", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", request("POST", { name: "Page owner" }));
  const page = { botId: bot.id, kind: "page", target: "http://127.0.0.1:1/", instruction: "Act", mentions: "launch", enabled: false };
  const { watcher } = await h.json("/api/watchers", request("POST", page));
  assert.equal(watcher.mentions, "launch", h.logs());
  const kept = await h.json(`/api/watchers/${watcher.id}`, request("PATCH", { name: "Renamed" }));
  assert.equal(kept.watcher.mentions, "launch", "an edit without mentions cleared the filter");
  const cleared = await h.json(`/api/watchers/${watcher.id}`, request("PATCH", { mentions: "" }));
  assert.equal(cleared.watcher.mentions, undefined, "an empty mentions edit kept the old filter");
  const saved = JSON.parse(readFileSync(join(h.home, ".bloks", "watchers.json"), "utf8"));
  assert.equal(saved[0].mentions, undefined, "the saved watcher kept the old filter");
});
