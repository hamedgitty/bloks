import assert from "node:assert/strict";
import { test } from "node:test";
import { botWords, replySpan, telegramFallback, telegramReply } from "../server/telegram-reply.ts";
import type { Message } from "../server/store.ts";
import { foldTurns } from "../src/lib/turnFold.ts";
import { splitWaiting } from "../src/lib/transcript.ts";
import type { Message as ClientMessage } from "../src/state/reducer.ts";

const notice = (text: string, extra: Partial<Message> = {}): Message => ({
  id: "notice", at: 1, role: "bot", kind: "notice", text, ...extra,
});
const fallback = (messages: Message[]) => telegramFallback(messages, (text) => text).text;

test("a turn without reply text carries its last plain error notice", () => {
  assert.equal(fallback([notice("first failure"), notice("provider refused this turn")]), "provider refused this turn");
});

test("a turn without text or an error keeps the empty-answer fallback", () => {
  assert.equal(fallback([]), "(the agent finished without saying anything)");
  const excluded = [
    notice("person's words", { role: "user" }), notice("removed", { deleted: true }),
    notice("quiet", { quiet: true }), notice("   "),
    notice("compacted", { compaction: { before: 100, after: 50 } }),
  ];
  assert.equal(fallback(excluded), "(the agent finished without saying anything)");
  assert.equal(fallback([notice("failure"), ...excluded]), "failure");
});

test("an error notice is one bounded message with whole Unicode characters", () => {
  const fitting = "a".repeat(3_998) + "😀";
  assert.equal(fallback([notice(fitting)]), fitting);
  const cut = fallback([notice(fitting + "tail")]);
  assert.equal(cut, "a".repeat(3_998) + "…");
  assert.ok(cut.length <= 4_000);
});

test("a provider notice is redacted before cutting and sent as plain text", () => {
  const redacted = telegramFallback([notice("Failure: *stored credential*")], (text) => text.replace("stored credential", "[redacted]"));
  assert.deepEqual(redacted, { text: "Failure: *[redacted]*", markdown: false });
});

const user = (id: string, extra: Partial<Message> = {}): Message => ({ id, at: 1, role: "user", kind: "text", text: id, ...extra });
const words = (text: string, extra: Partial<Message> = {}): Message => ({ id: text, at: 2, role: "bot", kind: "text", text, ...extra });
const tool: Message = { id: "tool", at: 3, role: "bot", kind: "activity", tool: { name: "test" } };
const reply = (messages: Message[], id = "request") => telegramReply(replySpan(messages, id), (text) => text).text;

test("the last visible reply stays the reply when tools, a card and a file follow it", () => {
  const rows = [user("request"), words("A note."), tool, words("The final reply."),
    { ...tool, id: "final-tool" }, { ...tool, id: "card", kind: "options" as const, card: { title: "Question", subtitle: "Continue?", options: ["Yes"], answered: "Yes" } },
    { ...tool, id: "file", kind: "artifact" as const, artifact: { name: "report.txt", mime: "text/plain", size: 1 } }];
  assert.equal(reply(rows), "The final reply.");
  const folded = foldTurns(splitWaiting(rows as unknown as ClientMessage[]).said, false);
  assert.equal(folded.hold?.message.text, "The final reply.");
});

test("reply eligibility agrees with the actual desktop fold on deleted, quiet and peer text", () => {
  const peer = { peerId: "helper", peerName: "Helper" };
  const rows = [user("request"), words("A note."), tool,
    words("Legacy reply.", { agent: { ...peer, dir: "reply" } }),
    words("deleted", { deleted: true }), words("quiet", { quiet: true }),
    words("outgoing", { agent: { ...peer, dir: "out" } })];
  assert.equal(reply(rows), "Legacy reply.");
  assert.equal(foldTurns(rows as unknown as ClientMessage[], false).hold?.message.text, "Legacy reply.");
  assert.equal(botWords(rows.at(-1)!), false);
});

for (const flag of ["queued", "unsent"] as const) test("another sender's " + flag + " row does not split the consuming turn", () => {
  const rows = [user("request"), words("First note."), user("waiting", { [flag]: true }), words("Final."), tool];
  assert.equal(reply(rows), "Final.");
  const visible = splitWaiting(rows as unknown as ClientMessage[]).said;
  assert.equal(foldTurns(visible, false).hold?.message.text, "Final.");
});

test("a request first in a delivered burst skips the rest of its head", () => {
  const rows = [user("earlier"), words("Other answer."), user("request"),
    user("peer request", { agent: { dir: "in", peerId: "helper", peerName: "Helper" } }),
    words("Note."), words("Our final reply."), tool, user("later"), words("Later answer.")];
  assert.equal(reply(rows), "Our final reply.");
  assert.deepEqual(replySpan(rows, "request").map((m) => m.id), ["Note.", "Our final reply.", "tool"]);
});

test("a steered request never receives text said before its own anchor", () => {
  const rows = [user("start"), words("Before the words."), user("request", { midTurn: true })];
  assert.equal(reply(rows), "(the agent finished without saying anything)");
  rows.push(words("After the words."), tool);
  assert.equal(reply(rows), "After the words.");
});

test("an immediately following new turn is not a steered request's head", () => {
  const rows = [user("start"), words("Before."), user("request", { midTurn: true }), user("next"), words("Not ours.")];
  assert.equal(reply(rows), "(the agent finished without saying anything)");
});

test("a fallback continuation with no new user row keeps the backup's last text", () => {
  const rows = [user("request"), words("Initial note."), notice("The backup is picking up."), words("Backup note."), words("Backup final.")];
  assert.equal(reply(rows), "Backup final.");
});

for (const flag of ["queued", "unsent", "deleted"] as const) test("a " + flag + " request never selects another turn's text or notice", () => {
  const rows = [user("other"), user("request", { [flag]: true }), words("Someone else's answer."), notice("Someone else's failure.")];
  assert.equal(reply(rows), "(the agent finished without saying anything)");
});

test("a later turn's notice is not the no-text request's answer", () => {
  const rows = [user("request"), tool, user("later"), notice("Later failure.")];
  assert.equal(reply(rows), "(the agent finished without saying anything)");
  assert.equal(reply(rows, "missing"), "(the agent finished without saying anything)");
});

test("a final empty eligible text does not revive an earlier note", () => {
  assert.equal(reply([user("request"), words("Earlier note."), words("   ")]), "(the agent finished without saying anything)");
});

test("a reply wins over the notice in its own span, with an ask or card in the middle", () => {
  const rows = [user("request"), words("Note."), { ...tool, kind: "options" as const },
    user("card answer", { midTurn: true }), words("Reply."), notice("A later failure.")];
  assert.equal(reply(rows), "Reply.");
});
