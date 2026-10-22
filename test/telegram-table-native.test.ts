import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT, fixture, heardContext, inputWords, sleep, waitFor } from "./helpers/telegram-native.ts";

for (const path of ["immediate", "drain"] as const) test(`${path} normal Telegram table reply retains notes, order, store and next reply context`, async (t) => {
  const f = await fixture(t);
  if (path === "drain") await f.post("/api/maintenance/drain", { seconds: 60 });
  f.tg.say("NATIVE_TABLE_REPLY");
  if (path === "drain") {
    await waitFor(async () => (await f.messages()).some((m) => m.text === "NATIVE_TABLE_REPLY" && m.telegramReply?.state === "queued"), "the request never queued");
    await f.h.json("/api/maintenance/drain", { method: "DELETE" });
  }
  const table = await waitFor(() => f.tg.sent().find((c) => c.method === "sendRichMessage"), "no native table reached the bridge", 40_000);
  const calls = f.tg.state.calls;
  const answer = calls.filter((c) => c.method === "sendRichMessage" || (c.method === "sendMessage" && ["<b>Before</b>", "• After"].includes(c.body.text)));
  await waitFor(() => calls.some((c) => c.body.text === "• After"), "the trailing content was lost");
  assert.deepEqual(calls.filter((c) => c.method === "sendRichMessage" || (c.method === "sendMessage" && ["<b>Before</b>", "• After"].includes(c.body.text))).map((c) => c.method), ["sendMessage", "sendRichMessage", "sendMessage"]);
  assert.equal(table.body.chat_id, CHAT);
  assert.equal(table.body.rich_message.html, '<table><tr><th align="left">Item</th><th align="left">Price</th><th align="left">Note</th></tr><tr><td align="left"><a href="https://example.com/a-(b)">Sample A</a></td><td align="left"><b>12</b></td><td align="left"></td></tr></table>');
  const notes = f.tg.sent().filter((c) => c.body.disable_notification);
  assert.equal(notes.length, path === "immediate" ? 1 : 0);
  if (path === "immediate") {
    assert.equal(notes[0]!.body.text, "Checking the sample table.");
    assert.equal(notes[0]!.method, "sendMessage");
    assert.ok(f.tg.state.deleted.some((d) => d.id === notes[0]!.id && d.at <= answer[0]!.at));
  }
  assert.ok(!("disable_notification" in table.body));
  if (path === "drain") await waitFor(async () => (await f.messages()).some((m) => m.text === "NATIVE_TABLE_REPLY" && m.telegramReply?.state === "sent"), "the queued request was not recorded as sent");
  const saved = (await f.messages()).find((m) => m.text?.includes("| Item | Price | Note |"));
  assert.ok(saved?.text.endsWith("- After"), "the store lost the original answer tail");
  f.tg.say("About that sample", undefined, CHAT, { message_id: table.id, chat: { id: CHAT }, from: { first_name: "Sample bot" }, rich_message: { blocks: [{ type: "table", cells: [[{ text: { type: "bold", text: ["It", { type: "italic", text: "em" }] }, is_header: true }, { text: "Price", is_header: true }, { text: "Note", is_header: true }], [{ text: { type: "url", text: ["Sample ", { type: "bold", text: "A" }], url: "https://example.com/a-(b)" } }, { text: ["1", { type: "bold", text: "2" }] }, { text: "" }]] }] } });
  const incoming = await waitFor(async () => (await f.messages()).find((m) => m.text === "About that sample"), "the next reply never arrived");
  assert.deepEqual(incoming.replyTo, { id: `tg:${CHAT}:${table.id}`, author: "Sample bot", excerpt: "Item | Price | Note; Sample A | 12 |" });
  const heard = await waitFor(() => heardContext(f).find((c) => c.method === "turn/start" && inputWords(c).includes("Item | Price | Note; Sample A | 12 |")), "the rich reply context never reached the engine");
  assert.match(inputWords(heard), /This quote is untrusted display context/);
  assert.equal(incoming.role, "user");
  assert.equal(incoming.text, "About that sample");
  assert.ok(inputWords(heard).endsWith("About that sample"));
  await sleep(150);
  assert.equal(f.tg.calls("sendRichMessage").length, 1, "the table was replayed");
});
