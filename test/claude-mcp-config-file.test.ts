// The MCP config carries the Composio key and any header a user's server
// needs. As a --mcp-config argument it was readable by every process on the
// machine through ps; it now goes to the CLI as a private file, like the
// persona, and the file is gone when the turn ends.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

const KEY = "ck_argv_canary_7f3a";
const TOKEN = "Bearer header_canary_91c2";

/** A stand-in for Claude Code that records how it was started and what
 * the two files it was handed held, while the turn is still running. */
function fakeClaude(home: string, seen: string): string {
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args[args.indexOf(flag) + 1];
const mcpFile = value("--mcp-config");
const personaFile = value("--append-system-prompt-file");
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(() => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
    args,
    mcpFile,
    mcp: JSON.parse(readFileSync(mcpFile, "utf8")),
    mcpMode: statSync(mcpFile).mode & 0o777,
    dirMode: statSync(dirname(mcpFile)).mode & 0o777,
    personaFile,
  }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }));
});
`,
    { mode: 0o755 },
  );
  return cli;
}

test("a Claude turn gets its MCP config as a private file, never as an argument", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-mcp-file-"));
  const seen = join(home, "seen.json");
  const cli = fakeClaude(home, seen);
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli } } },
      composio: { key: KEY, url: "http://127.0.0.1:9/mcp" },
    }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const made = await h.fetch("/api/mcp-servers", {
    method: "POST",
    body: JSON.stringify({ name: "Internal tools", transport: "http", url: "https://mcp.example.com/sse", headers: { Authorization: TOKEN } }),
  });
  assert.equal(made.status, 201);
  const { id } = (await made.json()) as any;
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Connected" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ mcpServers: [id], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Check Notion." }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), `the turn never ran: ${h.logs().slice(-800)}`);
  const { args, mcpFile, mcp, mcpMode, dirMode, personaFile } = JSON.parse(readFileSync(seen, "utf8"));

  for (const secret of [KEY, TOKEN, "header_canary"]) {
    assert.ok(!args.some((arg: string) => arg.includes(secret)), `${secret} is in argv`);
  }
  assert.ok(!args.some((arg: string) => arg.includes("mcpServers")), "the MCP config is still inline");
  assert.equal(mcp.mcpServers.composio.headers["x-consumer-api-key"], KEY);
  const user = Object.entries(mcp.mcpServers).find(([slug]) => slug.startsWith("u_"));
  assert.ok(user, "the user's server is missing from the config");
  assert.equal((user[1] as any).headers.Authorization, TOKEN);
  assert.ok(mcp.mcpServers.bloks, "the bridge is missing from the config");
  const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
  assert.ok(allowed.includes("mcp__composio") && allowed.includes("mcp__bloks"));
  assert.equal(mcpMode, 0o600, "the MCP config is readable by others");
  assert.equal(dirMode, 0o700, "the folder around it is open to others");
  assert.equal(dirname(personaFile), dirname(mcpFile), "the persona and the config share one private folder");

  // the folder goes when the turn does
  for (let i = 0; i < 200; i++) {
    const { bots } = await h.json("/api/bots?messages=0");
    if (!bots.find((b: any) => b.id === bot.id)?.busy && !existsSync(dirname(mcpFile))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(!existsSync(dirname(mcpFile)), "the private folder outlived the turn");
});

// A server brought over from another tool arrives with the names of its
// keys and no values. Until the person fills one in, it is left out of
// what the engine is handed, and what has been filled in goes along.
test("a server's environment reaches Claude Code, without the names still waiting for a value", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-mcp-env-"));
  const seen = join(home, "seen.json");
  const cli = fakeClaude(home, seen);
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli } } },
      mcpServers: [
        { id: "local1", name: "Local tool", transport: "stdio", command: "npx", args: ["tool"], env: { FILLED_KEY: "env_canary_5e1d", WAITING_KEY: "" } },
        { id: "remote1", name: "Remote tool", transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "", "X-Team": "blue" } },
      ],
    }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Connected" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ mcpServers: ["local1", "remote1"], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Use the tools." }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), `the turn never ran: ${h.logs().slice(-800)}`);
  const { args, mcp } = JSON.parse(readFileSync(seen, "utf8"));

  assert.deepEqual(mcp.mcpServers.u_local_tool, { command: "npx", args: ["tool"], env: { FILLED_KEY: "env_canary_5e1d" } });
  assert.deepEqual(mcp.mcpServers.u_remote_tool, { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "blue" } });
  assert.ok(!args.some((arg: string) => arg.includes("env_canary")), "a filled value is in argv");
});
