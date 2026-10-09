// An answer to a room's card that cannot be delivered (server/index.ts,
// POST /api/bots/:id/respond).
//
// An agent speaking in a room asks from its own lane, so the answer goes
// to the lane, but the card is in the room. When the answer could not be
// delivered, the card was looked for in the lane, not found, and left open
// in the room, while the note that nothing was run landed in a lane the
// person was not looking at.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** A Claude Code that, asked for ASK-ME, raises a question through the
 * turn's ask socket the way its approval bridge would, and waits a few
 * seconds for the answer before it finishes. */
function claudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-room-card-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }),
  );
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { createConnection } from "node:net";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
const said = await new Promise((resolve) => {
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === "user") resolve(String(frame.message?.content ?? ""));
    }
  });
});
out({ type: "system", subtype: "init", session_id: "sess-card", model: "claude-sonnet-5" });
if (said.includes("ASK-ME")) {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const socket = createConnection(config.mcpServers.bloks.args[1]);
  socket.on("error", () => {});
  socket.write(JSON.stringify({ t: "ask", id: "ask-ship", kind: "question", tool: "ask_user", input: { question: "Ship it?" } }) + "\\n");
  await new Promise((r) => setTimeout(r, 4000));
  socket.destroy();
}
out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-card", result: "Done." });
setTimeout(() => process.exit(0), 50);
`,
    { mode: 0o755 },
  );
  return home;
}

test("an answer to a room's card that cannot be delivered settles the card in the room", async (t) => {
  const home = claudeHome();
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    return bot as { id: string; threadId: string };
  };
  const kat = await agent("Kat");
  const lee = await agent("Lee");
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ship", memberIds: [kat.id, lee.id] }) });
  const roomMessages = async () => (await h.json(`/api/bloks/${room.id}/messages?limit=50`)).messages as any[];

  await h.fetch(`/api/bloks/${room.id}/messages`, { method: "POST", body: JSON.stringify({ text: "@Kat ASK-ME before you ship" }) });
  const card = await waitFor(async () => (await roomMessages()).find((m) => m.kind === "options" && m.card?.requestId === "ask-ship"));
  assert.ok(card, "the question never reached the room");

  // An answer the ask cannot take: a question is answered, not allowed.
  // The engine refuses it, which is the path every undeliverable answer
  // takes.
  const answered = await h.json(`/api/bots/${kat.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ requestId: "ask-ship", behavior: "allow" }),
  });
  assert.equal(answered.outcome, "unavailable");

  const settled = (await roomMessages()).find((m) => m.id === card.id);
  assert.equal(settled.card.answered, "unavailable", "the room's card was left open");
  assert.equal(settled.card.dismissed, true);
  const closed = (m: any) => m.kind === "activity" && /already closed/.test(m.tool?.name ?? "");
  assert.ok((await roomMessages()).some(closed), "the room was not told nothing was run");
  const lane = (await h.json(`/api/bots/${kat.id}/messages?thread=${kat.threadId}&limit=50`)).messages as any[];
  assert.equal(lane.some(closed), false, "the note went to a lane the person was not looking at");
});
