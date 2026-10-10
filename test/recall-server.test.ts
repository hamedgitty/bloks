// Recall through the server: memory files are searched beside the
// conversations and named by file, and each conversation's index keeps
// up with what is said, edited and taken back.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf } from "./helpers/turns.ts";

test("memory files are searched too, named by file, and a link is never read through", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
  const recall = async (q: string) => (await h.json(`/api/bots/${bot.id}/recall?q=${encodeURIComponent(q)}`)).hits as any[];

  await h.fetch(`/api/bots/${bot.id}/memory`, {
    method: "PUT",
    body: JSON.stringify({ text: "# Memory\n\n## Vendors\n- Sticker Mule prints our stickers, net 30.\n" }),
  });
  const topics = join(h.home, ".bloks", "workspaces", bot.id, "memory");
  mkdirSync(topics, { recursive: true });
  writeFileSync(join(topics, "launch.md"), "## Launch\nThe launch party is in Zanzibar on a Friday.\n");
  const outside = join(h.home, "elsewhere.txt");
  writeFileSync(outside, "Plutonium inventory, not for agents.");
  symlinkSync(outside, join(topics, "secret.md"));

  const [vendor] = await recall("sticker mule");
  assert.equal(vendor?.memory, "MEMORY.md");
  assert.equal(vendor.where, "your memory file MEMORY.md");
  assert.match(vendor.text, /## Vendors/, "a piece keeps its heading");

  const [party] = await recall("zanzibar party");
  assert.equal(party?.where, "your memory file memory/launch.md");
  assert.deepEqual(await recall("plutonium inventory"), [], "recall read through a link");

  // a file that changed is read again
  writeFileSync(join(topics, "launch.md"), "## Launch\nThe launch party moved to Lisbon, in the old tram depot.\n");
  assert.equal((await recall("lisbon tram"))[0]?.where, "your memory file memory/launch.md");
  assert.deepEqual(await recall("zanzibar party"), []);
});

test("a conversation's index grows as it is spoken, and forgets what is edited or taken back", async (t) => {
  const engine = await fakeProvider(t);
  engine.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, engine.port, "Scout");
  const recall = async (q: string) => ((await h.json(`/api/bots/${bot.id}/recall?q=${encodeURIComponent(q)}`)).hits as any[]).map((hit) => hit.text);
  const say = async (text: string) => {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.ok(await idle(h, bot));
  };

  await say("The first code word is aardvark.");
  assert.deepEqual(await recall("aardvark code"), ["The first code word is aardvark."]);
  // searched once, the index is built; what is said next joins it
  await say("The second code word is bumblebee.");
  assert.deepEqual(await recall("bumblebee code"), ["The second code word is bumblebee."]);

  const second = (await messagesOf(h, bot)).find((m) => m.text === "The second code word is bumblebee.");
  await h.fetch(`/api/threads/${bot.threadId}/messages/${second.id}`, { method: "PATCH", body: JSON.stringify({ text: "The second code word is caterpillar." }) });
  assert.deepEqual(await recall("bumblebee code"), [], "an edit left the old words findable");
  assert.deepEqual(await recall("caterpillar code"), ["The second code word is caterpillar."]);

  await h.fetch(`/api/threads/${bot.threadId}/messages/${second.id}`, { method: "DELETE" });
  assert.deepEqual(await recall("caterpillar code"), [], "a message taken back was still found");
  assert.deepEqual(await recall("aardvark code"), ["The first code word is aardvark."]);
});
