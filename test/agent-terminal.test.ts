// An agent's own terminal tabs and `bloks dock show` (GitHub 522), from
// inside a real turn: a stand-in engine makes the requests `bloks
// terminal` and `bloks dock` make, with the turn's own credential. It
// starts a tab (the person approves it on a card, the agent being on
// "ask"), reads it back, cannot reach the person's tab, shows its own,
// and stops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { cleanCommand, lastLines, plainText, readLines } from "../server/terminal.ts";

test("what an agent reads back is the text a person would see", () => {
  assert.equal(plainText("\u001b[32mgreen\u001b[0m done"), "green done");
  assert.equal(plainText("\u001b]0;title\u0007prompt$ ls"), "prompt$ ls");
  assert.equal(plainText("50%\r100%\r\nnext"), "100%\nnext", "a carriage return writes over its line");
  assert.equal(plainText("abd\bc"), "abc", "a backspace takes back a character");
  assert.equal(lastLines("a\nb\nc\n\n", 2), "b\nc");
  assert.equal(readLines("9999"), 400);
  assert.equal(readLines("abc"), 80);
  assert.equal(cleanCommand("  npm run dev  "), "npm run dev");
  assert.equal(cleanCommand("echo a\nrm -rf x"), null, "one line only");
  assert.equal(cleanCommand(""), null);
  assert.equal(cleanCommand("x".repeat(2001)), null);
});

test("an agent's own tab: approved on a card, read back, shown, stopped, and never the person's", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-terminal-"));
  const out = join(home, "said.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const person = (input.match(/PERSON ([\\w-]+)/) || [])[1];
  const auth = { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json", origin: process.env.BLOKS_URL };
  const ask = async (method, path, body) => {
    const res = await fetch(process.env.BLOKS_URL + path, { method, headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  const said = {};
  said.empty = await ask("GET", "/api/agent/terminals");
  said.run = await ask("POST", "/api/agent/terminals", { command: "echo hello-from-tab", title: "Greeter" });
  const tab = said.run.body.tab;
  await new Promise((r) => setTimeout(r, 2500));
  said.read = await ask("GET", "/api/agent/terminals/" + tab + "?lines=50");
  said.list = await ask("GET", "/api/agent/terminals");
  said.readPerson = await ask("GET", "/api/agent/terminals/" + person);
  said.stopPerson = await ask("DELETE", "/api/agent/terminals/" + person);
  said.showTab = await ask("POST", "/api/agent/dock", { panel: "terminal", target: tab });
  said.showPerson = await ask("POST", "/api/agent/dock", { panel: "terminal", target: person });
  said.showMissing = await ask("POST", "/api/agent/dock", { panel: "files", target: "nowhere.md" });
  said.showBadPage = await ask("POST", "/api/agent/dock", { panel: "browser", target: "file:///etc/passwd" });
  said.showUnknown = await ask("POST", "/api/agent/dock", { panel: "spaceship" });
  said.showChanges = await ask("POST", "/api/agent/dock", { panel: "changes" });
  said.personRoute = await ask("GET", "/api/bots/" + (input.match(/BOT ([\\w-]+)/) || [])[1] + "/terminals");
  said.stop = await ask("DELETE", "/api/agent/terminals/" + tab);
  said.after = await ask("GET", "/api/agent/terminals");
  writeFileSync(${JSON.stringify(out)} + ".tmp", JSON.stringify(said)); renameSync(${JSON.stringify(out)} + ".tmp", ${JSON.stringify(out)});
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Runner" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, approvals: "ask" }),
  });
  // the person's own tab, which the agent must never reach
  const mine = await h.json(`/api/bots/${bot.id}/terminals`, { method: "POST", body: JSON.stringify({ cols: 80, rows: 24 }) });
  const personTab = mine.terminal.id as string;

  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `PERSON ${personTab} BOT ${bot.id}` }) });
  // the agent is on "ask": its run waits on a card in the conversation
  let card: any;
  for (let i = 0; i < 200 && !card; i++) {
    const { bots } = await h.json("/api/bots");
    const messages = bots.find((b: any) => b.id === bot.id).messages as any[];
    card = messages.find((m) => m.kind === "options" && m.card?.requestId?.startsWith("browser:"));
    if (!card) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(card, "no card asked the person");
  assert.match(card.card.subtitle, /echo hello-from-tab/);
  await h.json(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.card.requestId, behavior: "allow" }) });

  for (let i = 0; i < 300 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(out), "the turn never finished");
  const said = JSON.parse(readFileSync(out, "utf8"));

  assert.deepEqual(said.empty.body.tabs, [], "the person's tab is not listed as the agent's");
  assert.equal(said.run.status, 200, JSON.stringify(said.run.body));
  assert.equal(said.run.body.title, "Greeter");
  assert.equal(said.read.status, 200);
  assert.match(said.read.body.output, /hello-from-tab/);
  assert.doesNotMatch(said.read.body.output, /\u001b/, "no escape sequences");
  assert.equal(said.list.body.tabs.length, 1);
  assert.equal(said.list.body.tabs[0].command, "echo hello-from-tab");
  assert.equal(said.readPerson.status, 404, "the person's tab is not the agent's to read");
  assert.equal(said.stopPerson.status, 404, "nor to stop");
  assert.equal(said.showTab.status, 200, JSON.stringify(said.showTab.body));
  assert.equal(said.showPerson.status, 404, "nor to show");
  assert.equal(said.showMissing.status, 404);
  assert.equal(said.showBadPage.status, 400);
  assert.equal(said.showUnknown.status, 400);
  assert.equal(said.showChanges.status, 200);
  assert.equal(said.personRoute.status, 403, "the person's terminal routes refuse an agent's credential");
  assert.equal(said.stop.status, 200);
  assert.deepEqual(said.after.body.tabs, []);

  // the person sees the agent's tab labelled while it lasted, and their
  // own is still there and still theirs
  const left = await h.json(`/api/bots/${bot.id}/terminals`);
  assert.deepEqual(left.terminals.map((x: any) => x.id), [personTab]);
  assert.equal(left.terminals[0].agent, undefined);
});
