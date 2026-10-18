import assert from "node:assert/strict";
import { test } from "node:test";
import { Inbox, parseUpdates, type InboxHooks, type Incoming } from "../server/telegram.ts";

const ref = { id: "tg:42:11", author: "Sample author", excerpt: "Earlier sample" };
const original = { message_id: 11, chat: { id: 42 }, from: { first_name: "Sample author" }, text: "Earlier sample" };
function parsed(over: Record<string, unknown> = {}) {
  return parseUpdates({ result: [{ update_id: 1, message: { message_id: 22, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "Current sender" }, text: "Current words", reply_to_message: original, ...over } }] })[0];
}
function fixture(over: Partial<InboxHooks> = {}) {
  const seen = { delivered: [] as Array<{ text: string; replyTo: Incoming["replyTo"] }>, downloads: [] as string[], answers: [] as unknown[], paired: 0 };
  const hooks: InboxHooks = { state: () => ({ chatIds: [42] }), send: async () => { }, pair: async () => { seen.paired++ }, refuse: async () => { }, download: async id => { seen.downloads.push(id); return new Uint8Array([1]) }, transcriber: () => async () => "Heard current voice", saveImage: () => "/sample/current.png", saveVoice: () => "/sample/current.ogg", saveFile: () => "/sample/current.pdf", waiting: () => undefined, answer: async (_id, read) => { seen.answers.push(read) }, press: async () => { }, deliver: (_id, text, replyTo) => { seen.delivered.push({ text, replyTo }) }, ...over };
  return { seen, inbox: new Inbox(hooks, 100000) };
}
test("same-chat supplied text caption and selected quote become bounded reply context", () => {
  assert.deepEqual(parsed().replyTo, ref);
  assert.equal(parsed({ reply_to_message: { ...original, text: undefined, caption: "Sample document caption", document: { file_id: "quoted", file_name: "sample.pdf" } } }).replyTo?.excerpt, "Sample document caption");
  assert.equal(parsed({ quote: { text: "Selected portion" } }).replyTo?.excerpt, "Selected portion");
  const bounded = parsed({ reply_to_message: { ...original, from: { first_name: "A".repeat(100000) }, text: "B".repeat(100000) } }).replyTo!;
  assert.equal(bounded.author.length, 60); assert.equal(bounded.excerpt.length, 200);
});
test("captionless media and unavailable supplied originals have explicit short descriptions", () => {
  for (const [media, excerpt] of [[{ document: { file_name: "sample.pdf" } }, "[File: sample.pdf]"], [{ photo: [{ file_id: "x" }] }, "[Photo]"], [{ voice: {} }, "[Voice message]"], [{ video: {} }, "[Video]"], [{ sticker: {} }, "[Sticker]"], [{}, "[Message content unavailable]"]] as const) {
    assert.equal(parsed({ reply_to_message: { message_id: 11, ...media } }).replyTo?.excerpt, excerpt);
  }
});
test("reply author is the original visible sender and IDs are never invented", () => {
  assert.equal(parsed({ reply_to_message: { ...original, sender_chat: { title: "Visible channel" }, from: { first_name: "Compatibility user" } } }).replyTo?.author, "Visible channel");
  const missing = parsed({ reply_to_message: { text: "Supplied context" } }).replyTo!;
  assert.deepEqual(missing, { author: "Someone", excerpt: "Supplied context" });
  for (const message_id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "11", null]) assert.equal(parsed({ reply_to_message: { ...original, message_id } }).replyTo?.id, undefined);
  assert.equal(parsed({ reply_to_message: { ...original, chat: { id: 99 } } }).replyTo, undefined);
});
test("malformed and unrelated reply fields neither throw nor create a same-chat target", () => {
  for (const reply_to_message of [null, undefined, [], 1, "text"]) { assert.equal(parsed({ reply_to_message, quote: { text: "Not an original" }, external_reply: { message_id: 11 }, reply_to_story: { id: 1 }, forward_origin: { sender_user: { first_name: "Forwarded" } } }).replyTo, undefined) }
  assert.deepEqual(parsed({ reply_to_message: { ...original, reply_to_message: { text: "Nested words" } } }).replyTo, ref);
  assert.equal(parsed({ text: undefined, reply_to_message: original }), undefined, "reference alone is not current input");
  assert.equal(parsed({ reply_to_message: undefined }).text, "Current words");
});
test("ordinary Inbox delivery keeps supplied context without fetching quoted media", async () => {
  const f = fixture(); await f.inbox.take(parsed({ reply_to_message: { ...original, text: undefined, caption: "Quoted PDF", document: { file_id: "quoted" } } }));
  assert.equal(f.seen.delivered[0].replyTo?.excerpt, "Quoted PDF"); assert.deepEqual(f.seen.downloads, []);
  await f.inbox.take(parsed({ text: "Current caption", document: { file_id: "current", mime_type: "application/pdf" } }));
  assert.deepEqual(f.seen.downloads, ["current"]); assert.deepEqual(f.seen.delivered.at(-1)?.replyTo, ref);
});
test("quoted pairing words and approval options do not change current-text admission", async () => {
  const f = fixture({ state: () => ({ pairing: "PAIRWORD", pairOwner: true }) });
  await f.inbox.take(parsed({ reply_to_message: { ...original, text: "PAIRWORD" } })); assert.equal(f.seen.paired, 0);
  await f.inbox.take(parsed({ text: "PAIRWORD", reply_to_message: original })); assert.equal(f.seen.paired, 1); assert.equal(f.seen.delivered.length, 0);
  const q = fixture({ waiting: () => ({ permission: true, options: ["Yes", "No"] }) });
  await q.inbox.take(parsed({ text: "unclear", reply_to_message: { ...original, text: "Yes" } })); assert.deepEqual(q.seen.answers, []);
  await q.inbox.take(parsed({ text: "No" })); assert.deepEqual(q.seen.answers, [{ option: "No" }]); assert.deepEqual(q.seen.delivered, []);
});
test("voice and missing-media delivery preserve reply context", async () => {
  const f = fixture(); await f.inbox.take(parsed({ text: undefined, voice: { file_id: "current-voice" } })); assert.deepEqual(f.seen.delivered[0].replyTo, ref);
  const g = fixture({ download: async () => { throw Error("synthetic failure") } }); await g.inbox.take(parsed({ document: { file_id: "current", mime_type: "application/pdf" } })); assert.deepEqual(g.seen.delivered[0].replyTo, ref);
});
for (const failed of ["none", "first", "all"] as const) test(`album takes first usable reply before ${failed} download failures`, async () => {
  const f = fixture({ download: async id => { if (failed === "all" || (failed === "first" && id === "first")) throw Error("synthetic failure"); return new Uint8Array([1]) } });
  const one = parsed({ reply_to_message: undefined, text: undefined, media_group_id: "album", photo: [{ file_id: "first" }] });
  const two = parsed({ text: undefined, media_group_id: "album", photo: [{ file_id: "second" }] });
  const three = parsed({ text: undefined, media_group_id: "album", photo: [{ file_id: "third" }], reply_to_message: { ...original, message_id: 12, text: "Different later target" } });
  await f.inbox.take(one); await f.inbox.take(two); await f.inbox.take(three); await f.inbox.flush();
  assert.equal(f.seen.delivered.length, 1); assert.deepEqual(f.seen.delivered[0].replyTo, ref);
});
