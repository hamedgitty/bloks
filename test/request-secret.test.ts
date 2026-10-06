// Asking for a key is not a permission check (GitHub 172).
//
// Every agent's prompt used to say "call the request_secret tool", but the
// tool lived only in Claude Code's approval bridge, which full access left
// out, and in the API tool loop. A full-access Claude agent and every Codex
// agent were told to call a tool they did not have. Now full access keeps
// the bridge with only the asking tools on it, the other engines with a
// shell get `bloks secret`, and the prompt names whichever one it has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAskBroker, type PendingAsk } from "../server/harness/ask-broker.ts";
import { startHarness } from "./helpers/server.ts";

const PROXY = fileURLToPath(new URL("../server/permission-proxy.ts", import.meta.url));

test("on full access the bridge serves the asking tools and never approve", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-asking-"));
  const asks: PendingAsk[] = [];
  const broker = createAskBroker({
    socketPath: join(dir, "b.sock"),
    onAsk: (ask) => {
      asks.push(ask);
      broker.answer(ask.id, "answer", "A secure field is in the chat.");
    },
    onResolve: () => {},
  });
  const proxy = spawn(process.execPath, [PROXY, join(dir, "b.sock")], {
    env: { ...process.env, BLOKS_PUBLISH: "ask_user,request_secret" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => {
    proxy.kill();
    broker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const replies = new Map<number, any>();
  let pending = "";
  proxy.stdout.on("data", (chunk) => {
    pending += chunk;
    for (let cut = pending.indexOf("\n"); cut !== -1; cut = pending.indexOf("\n")) {
      const frame = JSON.parse(pending.slice(0, cut));
      pending = pending.slice(cut + 1);
      replies.set(frame.id, frame);
    }
  });
  const call = async (id: number, method: string, params: object = {}) => {
    proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 25));
    return replies.get(id);
  };

  const listed = await call(1, "tools/list");
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), ["ask_user", "request_secret"]);

  // approve by name is refused here, not read as a permission request:
  // nothing on full access is there to answer one
  const approve = await call(2, "tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } });
  assert.equal(approve.result.isError, true);
  assert.equal(asks.length, 0, "an approve call reached the broker");

  const secret = await call(3, "tools/call", { name: "request_secret", arguments: { name: "Transistor API key" } });
  assert.equal(secret.result.content[0].text, "A secure field is in the chat.");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].kind, "question");
  assert.equal(asks[0].tool, "request_secret");
});

test("a full-access Claude agent is told about request_secret, and `bloks secret` plants the same card", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-secret-"));
  const seen = join(home, "seen.json");
  const cli = join(home, "fake-claude.mjs");
  // a stand-in for Claude Code that records how it was started and what it
  // was told, then asks for a key the way an engine without the tool does
  writeFileSync(
    cli,
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const prompt = readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8");
process.stdin.resume();
process.stdin.on("end", () => {
  const said = execFileSync(process.execPath, [process.env.BLOKS_CLI, "secret", "Transistor API key", "--hint", "From transistor.fm, under Account"], { encoding: "utf8" });
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, prompt, said: JSON.parse(said) }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "asked" }));
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

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Publisher" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ approvals: "full", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Publish the episode." }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), "the turn never ran");
  const { args, prompt, said } = JSON.parse(readFileSync(seen, "utf8"));

  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!args.includes("--permission-prompt-tool"), "full access has no permission checks to send anywhere");
  const { mcpServers } = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  assert.ok(mcpServers.bloks, "full access dropped the asking tools along with the approvals");
  // no Composio key, so nothing to connect with either
  assert.equal(mcpServers.bloks.env.BLOKS_PUBLISH, "ask_user,request_secret");
  assert.match(prompt, /call the request_secret tool/);

  assert.match(said.result, /TRANSISTOR_API_KEY/);
  const card = await (async () => {
    for (let i = 0; i < 100; i++) {
      const { bots } = await h.json("/api/bots");
      const found = bots.find((b: any) => b.id === bot.id).messages.find((m: any) => m.kind === "secret");
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  assert.ok(card, "no secure field in the chat");
  assert.equal(card.secret.envName, "TRANSISTOR_API_KEY");
  assert.equal(card.secret.status, "needs-value");
  assert.match(card.secret.hint, /transistor\.fm/);

  // only an agent asks from inside a turn; the person types the value
  const fromPerson = await h.fetch(`/api/bots/${bot.id}/secrets`, { method: "POST", body: JSON.stringify({ name: "Anything" }) });
  assert.equal(fromPerson.status, 403);
});
