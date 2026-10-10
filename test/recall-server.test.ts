// Recall through the server: memory files are searched beside the
// conversations and named by file, and each conversation's index keeps
// up with what is said, edited and taken back. The person's own search
// reads the same indexes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

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
  assert.match(vendor.text, /^Vendors - Sticker Mule/, "a piece keeps its heading, without the marks");

  const [party] = await recall("zanzibar party");
  assert.equal(party?.where, "your memory file memory/launch.md");
  assert.deepEqual(await recall("plutonium inventory"), [], "recall read through a link");

  // a file that changed is read again
  writeFileSync(join(topics, "launch.md"), "## Launch\nThe launch party moved to Lisbon, in the old tram depot.\n");
  assert.equal((await recall("lisbon tram"))[0]?.where, "your memory file memory/launch.md");
  assert.deepEqual(await recall("zanzibar party"), []);
});

test("the person's search is ranked the same way, and still finds small words as typed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-search-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  let h = await startHarness({ HOME: home });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
  await h.stop();
  const day = 24 * 60 * 60 * 1000;
  const said = (id: string, ago: number, text: string, extra: object = {}) => ({ id, at: Date.now() - ago * day, role: "user", kind: "text", text, ...extra });
  writeFileSync(
    join(home, ".bloks", `messages-${bot.threadId}.json`),
    JSON.stringify([
      ...Array.from({ length: 20 }, (_, i) => said(`standup-${i}`, 30 + i, `Standup ${i}: the launch prep is on track.`)),
      said("party", 9, "Zanzibar is where the launch party goes."),
      said("vendors", 5, "We planned the vendor shortlist on Monday."),
      said("gone", 2, "Zanzibar launch party, cancelled.", { deleted: true }),
      said("plain", 1, "It is going to be fine."),
    ]),
  );
  h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  const search = async (q: string) => (await h.json(`/api/search?q=${encodeURIComponent(q)}&limit=5`)).hits as any[];

  const [party] = await search("launch party zanzibar");
  assert.equal(party?.messageId, "party", "words out of order were not found, or a newer standup came first");
  assert.equal(party.botId, bot.id);
  assert.equal(party.task, "General");
  assert.match(party.snippet, /Zanzibar is where the launch party goes/);
  assert.equal((await search("planning vendors"))[0]?.messageId, "vendors", "a plural and an -ing form missed");
  assert.ok(!(await search("zanzibar cancelled")).some((hit) => hit.messageId === "gone"), "a message taken back was found");
  assert.equal((await search("to be"))[0]?.messageId, "plain", "small words alone found nothing");
});

test("a conversation's index grows as it is spoken, and forgets what is edited or taken back", async (t) => {
  const engine = await fakeProvider(t);
  engine.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, engine.port, "Scout");
  const recall = async (q: string) => ((await h.json(`/api/bots/${bot.id}/recall?q=${encodeURIComponent(q)}`)).hits as any[]).map((hit) => hit.text);
  // Said and answered, not merely accepted: on a busy machine the lane can
  // still be settling from the last turn, and words that wait are not
  // part of the conversation (nor findable) until their turn takes them.
  const say = async (text: string) => {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    const answered = await waitFor(async () => {
      const messages = await messagesOf(h, bot);
      const at = messages.findIndex((m) => m.text === text && !m.queued);
      return at >= 0 && messages.slice(at + 1).some((m) => m.role === "bot" && m.kind === "text") ? true : null;
    });
    assert.ok(answered, `"${text}" was never answered`);
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
