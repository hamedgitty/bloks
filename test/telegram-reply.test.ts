import assert from "node:assert/strict";
import { test } from "node:test";
import { telegramFallback } from "../server/telegram-reply.ts";
import type { Message } from "../server/store.ts";

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
