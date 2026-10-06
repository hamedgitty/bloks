// 169: an agent's `bloks say` into a room is that agent speaking, not the
// person. It used to go in as the owner's line, labelled "User" in every
// other member's prompt, and woke the whole room when it named nobody.
// Now it is stored as the agent's, and reaches only someone it names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("an agent's say into a room is its own line, and wakes only who it names", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-room-say-"));
  const answers = join(home, "answers.json");
  const heard = join(home, "heard.log");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential.
  // Every turn's prompt is written down, with what it was told about the
  // room (the persona file, where the room's recent lines go).
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const persona = process.argv.indexOf("--append-system-prompt-file");
  const told = persona > 0 ? readFileSync(process.argv[persona + 1], "utf8") : "";
  appendFileSync(${JSON.stringify(heard)}, told + input + "\\n----\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." }));
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

  const claude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
  const make = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(claude) });
    return bot;
  };
  const busy = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy;
  const idle = (id: string) => waitFor(async () => ((await busy(id)) ? null : true));
  const as = async (botId: string, calls: unknown[]) => {
    rmSync(answers, { force: true });
    await idle(botId);
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
    const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
    await idle(botId);
    return out;
  };
  const prompts = () => (existsSync(heard) ? readFileSync(heard, "utf8").split("\n----\n") : []);

  const lead = await make("Lead");
  const peer = await make("Peer");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Launch", memberIds: [lead.id, peer.id] }) });
  const roomId = room?.id ?? (await h.json("/api/bloks")).bloks.find((b: any) => b.name === "Launch").id;

  // naming nobody, it is stored as the lead's and wakes nobody: an
  // agent's line reaching the whole room is what made two agents chatter
  const [quiet] = await as(lead.id, [["POST", `/api/bloks/${roomId}/messages`, { text: "Launch notes are in the folder." }]]);
  assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
  assert.equal(quiet.body.message.role, "bot");
  assert.equal(quiet.body.message.from, lead.id);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!(await busy(peer.id)), "an unaddressed agent line woke the room");
  assert.ok(!prompts().some((p) => p.includes("Recent conversation in this room")), "an unaddressed agent line woke the room");

  // naming the peer reaches the peer, who reads it as the lead's, and
  // the lead is not woken by its own line
  const before = prompts().length;
  const [named] = await as(lead.id, [["POST", `/api/bloks/${roomId}/messages`, { text: "@Peer please check the totals" }]]);
  assert.equal(named.status, 201, JSON.stringify(named.body));
  const woken = await waitFor(() => prompts().find((p) => p.includes("Recent conversation in this room")));
  assert.ok(woken, "the named agent never heard it");
  assert.match(woken!, /Lead: @Peer please check the totals/);
  assert.doesNotMatch(woken!, /User: @Peer/);
  await idle(peer.id);
  await idle(lead.id);
  const roomTurns = prompts().slice(before).filter((p) => p.includes("Recent conversation in this room"));
  assert.equal(roomTurns.length, 1, "someone other than the named agent was woken");

  const { messages } = await h.json(`/api/bloks/${roomId}/messages?limit=50`);
  const said = messages.filter((m: any) => m.text === "Launch notes are in the folder." || m.text === "@Peer please check the totals");
  assert.equal(said.length, 2);
  for (const m of said) {
    assert.equal(m.role, "bot");
    assert.equal(m.from, lead.id);
  }
});
