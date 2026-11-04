// An MCP server whose command is not on this computer: found missing
// without running it and within a bound, shown in Settings, and left out
// of a turn with a word to the agent and one notice in the chat.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { commandMissing, expandHome, lookupEnv, serversMissingNote, serversMissingNotice, shownCommand } from "../server/mcp-command.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "bloks-mcp-command-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A program that leaves a mark if anything ever runs it. */
function program(dir: string, name: string, mark: string, mode = 0o755): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\ntouch ${JSON.stringify(mark)}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

test("an absolute path is missing when nothing runnable is there, and found when it is", { skip: process.platform === "win32" }, async (t) => {
  const dir = scratch(t);
  const mark = join(dir, "ran");
  assert.equal(await commandMissing(join(dir, "nope", "tool")), true);
  assert.equal(await commandMissing(program(dir, "tool", mark)), false);
  assert.equal(await commandMissing(program(dir, "plain-file", mark, 0o644)), true, "a file nobody may run");
  mkdirSync(join(dir, "folder"));
  assert.equal(await commandMissing(join(dir, "folder")), true, "a folder is not a program");
  assert.equal(await commandMissing(process.execPath), false);
  assert.equal(existsSync(mark), false, "a command was run to check it");
});

test("a ~/ path is looked for in the home folder, and handed over expanded", { skip: process.platform === "win32" }, async (t) => {
  const home = scratch(t);
  mkdirSync(join(home, "bin"));
  program(join(home, "bin"), "mine", join(home, "ran"));
  assert.equal(await commandMissing("~/bin/mine", { home }), false);
  assert.equal(await commandMissing("~/bin/gone", { home }), true);
  assert.equal(expandHome("~/bin/mine", home), join(home, "bin", "mine"));
  assert.equal(expandHome("npx", home), "npx");
  assert.equal(shownCommand(join(home, "bin", "gone"), home), "~/bin/gone");
  assert.equal(shownCommand("/opt/tool", home), "/opt/tool");
});

test("a bare name is looked for on PATH, the server's own PATH first", { skip: process.platform === "win32" }, async (t) => {
  const dir = scratch(t);
  const empty = join(dir, "empty");
  const tools = join(dir, "tools");
  mkdirSync(empty);
  mkdirSync(tools);
  program(tools, "my-mcp", join(dir, "ran"));
  assert.equal(await commandMissing("my-mcp", { env: { PATH: empty } }), true);
  assert.equal(await commandMissing("my-mcp", { env: { PATH: `${empty}:${tools}` } }), false);
  assert.equal(await commandMissing("my-mcp", { env: {} }), true, "no PATH at all");
  const env = lookupEnv({ env: { PATH: tools, OTHER: "x" } }, { PATH: empty });
  assert.equal(await commandMissing("my-mcp", { env }), false);
  assert.deepEqual(lookupEnv({ env: { PATH: "" } }, { PATH: empty }), { PATH: empty }, "an empty PATH is not one");
  // relative to wherever the engine starts: not something to judge
  assert.equal(await commandMissing("./bin/my-mcp", { env: { PATH: empty } }), false);
  assert.equal(existsSync(join(dir, "ran")), false);
});

test("on Windows a bare name is found through PATHEXT", async () => {
  const seen: string[] = [];
  const probe = (runnable: string[]) => async (file: string) => {
    seen.push(file);
    return runnable.includes(file) ? ("runnable" as const) : ("absent" as const);
  };
  const env = { Path: "C:\\tools;C:\\bin", PATHEXT: ".EXE;.CMD" };
  assert.equal(await commandMissing("npx", { platform: "win32", env, probe: probe(["C:\\bin\\npx.cmd"]) }), false);
  assert.ok(seen.includes("C:\\tools\\npx.exe") && seen.includes("C:\\bin\\npx.cmd"), seen.join(" "));
  assert.ok(!seen.includes("C:\\tools\\npx"), "a name without an extension is not run as is");
  assert.equal(await commandMissing("npx", { platform: "win32", env, probe: probe([]) }), true);
  assert.equal(await commandMissing("tool.exe", { platform: "win32", env, probe: probe(["C:\\tools\\tool.exe"]) }), false);
  assert.equal(await commandMissing("C:\\gone\\tool", { platform: "win32", env, probe: probe([]) }), true);
});

test("a slow look counts as found, and so does any trouble other than not found", async () => {
  const started = Date.now();
  const never = () => new Promise<never>(() => {});
  assert.equal(await commandMissing("/slow/volume/tool", { platform: "linux", probe: never, timeoutMs: 80 }), false);
  assert.equal(await commandMissing("tool", { platform: "linux", env: { PATH: "/a:/b" }, probe: never, timeoutMs: 80 }), false);
  assert.ok(Date.now() - started < 1_500, "the bound did not hold");
  assert.equal(await commandMissing("/x/tool", { platform: "linux", probe: async () => "unknown" }), false);
  assert.equal(await commandMissing("/x/tool", { platform: "linux", probe: async () => { throw new Error("EPERM"); } }), false);
  assert.equal(await commandMissing("tool", { platform: "linux", env: { PATH: "/a:/b" }, probe: async (f) => (f === "/b/tool" ? "unknown" : "absent") }), false);
});

test("the agent's note and the chat's notice name the servers plainly", () => {
  assert.match(serversMissingNote(["Files"]), /"Files", but this MCP server did not start this turn: its command was not found/);
  assert.match(serversMissingNote(["A", "B"]), /"A" and "B", but these MCP servers did not start/);
  assert.equal(
    serversMissingNotice("Scout", ["Files"]),
    "Files did not start: its command was not found. Scout works without it until it is fixed in Settings, under Plugins.",
  );
  assert.match(serversMissingNotice("Scout", ["A", "B", "C"]), /^A, B and C did not start: their commands were not found\./);
});

// ── through the server ─────────────────────────────────────────────────

test("Settings says which servers' commands are missing, when saved and when listed", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const add = async (name: string, commandLine: string) => {
    const res = await h.fetch("/api/mcp-servers", { method: "POST", body: JSON.stringify({ name, transport: "stdio", commandLine }) });
    assert.equal(res.status, 201);
    return (await res.json()) as { id: string; missing?: string };
  };
  const gone = await add("Gone", "/nonexistent/bin/files-mcp --root /srv");
  assert.equal(gone.missing, "/nonexistent/bin/files-mcp", "the program alone, never its arguments");
  const home = await add("Home tool", "~/nope/tool");
  assert.equal(home.missing, "~/nope/tool");
  const bare = await add("Bare", "bloks-test-no-such-command-7c1 serve");
  assert.equal(bare.missing, "bloks-test-no-such-command-7c1");
  const here = await add("Here", `"${process.execPath}" server.mjs`);
  assert.equal(here.missing, undefined);
  const remote = await h.fetch("/api/mcp-servers", { method: "POST", body: JSON.stringify({ name: "Remote", transport: "http", url: "https://mcp.example.test/mcp" }) });
  assert.equal(remote.status, 201);

  const { servers } = await h.json("/api/mcp-servers");
  const by = Object.fromEntries(servers.map((s: any) => [s.name, s]));
  assert.equal(by.Gone.missing, "/nonexistent/bin/files-mcp");
  assert.equal(by["Home tool"].missing, "~/nope/tool");
  assert.equal(by.Bare.missing, "bloks-test-no-such-command-7c1");
  assert.equal(by.Here.missing, undefined);
  assert.equal(by.Remote.missing, undefined);
  assert.ok(!JSON.stringify(servers).includes("--root"), "arguments came back");
});

/** A stand-in for Claude Code that keeps, for every turn, the servers it
 * was handed and the system words it was given. */
function fakeClaude(dir: string, seen: string): string {
  const cli = join(dir, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null;
process.stdin.resume();
let line = "";
process.stdin.on("data", (c) => {
  line += c;
  while (line.includes("\\n")) {
    const at = line.indexOf("\\n");
    const next = line.slice(0, at);
    line = line.slice(at + 1);
    if (!next.trim() || JSON.parse(next).type !== "user") continue;
    const mcp = value("--mcp-config");
    const persona = value("--append-system-prompt-file");
    appendFileSync(${JSON.stringify(seen)}, JSON.stringify({
      servers: mcp ? Object.keys(JSON.parse(readFileSync(mcp, "utf8")).mcpServers) : [],
      config: mcp ? JSON.parse(readFileSync(mcp, "utf8")).mcpServers : {},
      system: persona ? readFileSync(persona, "utf8") : "",
    }) + "\\n");
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" }));
    setTimeout(() => process.exit(0), 20);
  }
});
`,
    { mode: 0o755 },
  );
  return cli;
}

test("a turn leaves out a server whose command is missing, tells the agent every turn and the chat once", async (t) => {
  const dir = scratch(t);
  const seen = join(dir, "seen.jsonl");
  const cli = fakeClaude(dir, seen);
  const tool = program(dir, "present-mcp", join(dir, "ran"));
  mkdirSync(join(dir, ".bloks"), { recursive: true });
  writeFileSync(
    join(dir, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli } } },
      mcpServers: [
        { id: "here1", name: "Present tool", transport: "stdio", command: tool, args: ["--stdio"] },
        { id: "gone1", name: "Missing tool", transport: "stdio", command: "/nonexistent/bin/missing-mcp", args: [] },
      ],
    }),
  );
  const h = await startHarness({ HOME: dir, USERPROFILE: dir });
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ mcpServers: ["here1", "gone1"], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }),
  });
  const turns = () => (existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const idle = () => waitFor(async () => !(await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy);
  for (const [i, words] of ["First turn.", "Second turn."].entries()) {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: words }) });
    assert.ok(await waitFor(() => turns().length > i, 15_000), `turn ${i + 1} never ran: ${h.logs().slice(-800)}`);
    assert.ok(await idle());
  }
  const [first, second] = turns();
  for (const turn of [first, second]) {
    assert.ok(turn.servers.some((s: string) => s.startsWith("u_present")), "the present server was left out");
    assert.ok(!turn.servers.some((s: string) => s.startsWith("u_missing")), "the missing server was handed over");
    assert.match(turn.system, /"Missing tool", but this MCP server did not start this turn/);
  }
  const present = Object.entries(first.config).find(([slug]) => slug.startsWith("u_present"))![1] as any;
  assert.equal(present.command, tool);
  const { messages } = await h.json(`/api/bots/${bot.id}/messages?thread=${bot.threadId}&limit=200`);
  const notices = messages.filter((m: any) => m.kind === "notice" && /Missing tool did not start: its command was not found/.test(m.text));
  assert.equal(notices.length, 1, "the chat was told more than once, or never");
  assert.equal(existsSync(join(dir, "ran")), false, "a server was run to check it");
});
