// Bloks as an MCP server, driven over stdio the way Claude Desktop does.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

const MCP = fileURLToPath(new URL("../bin/bloks-mcp.mjs", import.meta.url));

describe("bloks-mcp", () => {
  let h: Harness;
  let child: ChildProcess;
  let closeEngine = () => {};
  const pending = new Map<number, (message: any) => void>();
  let next = 1;
  const rpc = (method: string, params: object = {}) =>
    new Promise<any>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const tool = async (name: string, args: object = {}) => {
    const answer = await rpc("tools/call", { name, arguments: args });
    return { text: answer.result.content[0].text as string, isError: Boolean(answer.result.isError) };
  };

  before(async () => {
    h = await startHarness();
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Release notes drafted: three fixes, one feature." } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    closeEngine = () => engine.close();
    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Writer" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });

    child = spawn(process.execPath, [MCP], { env: { ...process.env, BLOKS_URL: h.url }, stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
  });
  after(async () => {
    child?.kill();
    closeEngine();
    await h.stop();
  });

  test("it introduces itself and lists a small set of tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "bloks");
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { result } = await rpc("tools/list");
    const names = result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(names, [
      "ask_agent",
      "browser_click",
      "browser_dialog",
      "browser_open",
      "browser_press",
      "browser_read",
      "browser_screenshot",
      "browser_scroll",
      "browser_select",
      "browser_snapshot",
      "browser_switch_tab",
      "browser_tabs",
      "browser_type",
      "browser_wait",
      "home_call",
      "home_entities",
      "home_history",
      "list_agents",
      "list_rooms",
      "list_skills",
      "message_room",
      "morning_brief",
      "propose_skill_revision",
      "read_conversation",
      "read_message",
      "read_skill",
      "search",
      "skill_history",
      "waiting_on_me",
    ]);
    assert.ok(!names.some((n: string) => /approve|delete|setting|key/i.test(n)), "nothing that approves, deletes or configures");
  });

  test("the home is closed to other apps until the owner opens it", async () => {
    const shut = await tool("home_entities");
    assert.equal(shut.isError, true);
    assert.match(shut.text, /not connected|has not let other AI apps/);
  });

  test("skills are read by version, and a change to one is only ever proposed", async () => {
    await h.json("/api/skills", { method: "POST", body: JSON.stringify({ id: "standup", name: "Standup", description: "The morning standup", body: "Three lines: done, doing, blocked." }) });
    assert.match((await tool("list_skills")).text, /- standup: Standup\. The morning standup \(version 1\)/);
    const read = await tool("read_skill", { skill: "standup" });
    assert.match(read.text, /^Standup, version 1\nFor: The morning standup\n\nThree lines/);
    assert.match((await tool("skill_history", { skill: "standup" })).text, /version 1 \(current\)/);

    const stale = await tool("propose_skill_revision", { skill: "standup", from: 0, why: "x", text: "y" });
    assert.equal(stale.isError, true);
    assert.match(stale.text, /version 1 now/);
    const proposed = await tool("propose_skill_revision", { skill: "standup", from: 1, why: "Name who is blocked", text: "Three lines: done, doing, blocked by whom." });
    assert.equal(proposed.isError, false);
    assert.match(proposed.text, /unchanged until they do/);
    const { skill } = await h.json("/api/skills/standup");
    assert.equal(skill.body, "Three lines: done, doing, blocked.", "proposing changed the skill");
    const { proposals } = await h.json("/api/skills/proposals");
    assert.ok(proposals.some((p: any) => p.skillId === "standup" && p.botName === "An app over MCP" && p.whole));
  });

  test("ask an agent by name and get its reply", async () => {
    assert.match((await tool("list_agents")).text, /- Writer/);
    const answer = await tool("ask_agent", { agent: "writer", message: "Draft the release notes" });
    assert.equal(answer.isError, false);
    assert.match(answer.text, /Release notes drafted/);
    assert.match((await tool("read_conversation", { agent: "Writer" })).text, /You: Draft the release notes/);
    assert.match((await tool("search", { query: "release notes" })).text, /Writer/);
  });

  test("the Bloks browser, on a server whose own browser is off, says so", async () => {
    const opened = await tool("browser_open", { url: "https://example.com" });
    assert.equal(opened.isError, true);
    assert.match(opened.text, /turned off on this server/);
  });

  test("an unknown agent is a readable error, and the rest answer plainly", async () => {
    const missing = await tool("ask_agent", { agent: "Nobody", message: "hi" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No agent called "Nobody"\. Agents: .*Writer/);
    assert.equal((await tool("waiting_on_me")).text, "Nothing is waiting on you.");
    assert.equal((await tool("morning_brief")).text, "No brief yet.");
  });

  test("an archived room is left out of the room list", async () => {
    const { bots } = await h.json("/api/bots?messages=0");
    const { bot: second } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Editor" }) });
    const memberIds = [bots.find((b: any) => b.name === "Writer").id, second.id];
    const room = (name: string) => h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name, memberIds }) });
    const { blok: open } = await room("Open room");
    const { blok: shelved } = await room("Shelved room");
    await h.json(`/api/bloks/${shelved.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });

    const { text } = await tool("list_rooms");
    assert.match(text, /- Open room: /);
    assert.doesNotMatch(text, /Shelved room/, "an archived room is listed as if it were open");

    await h.fetch(`/api/bloks/${open.id}`, { method: "DELETE" });
    await h.fetch(`/api/bloks/${shelved.id}`, { method: "DELETE" });
  });
});
