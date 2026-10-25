import assert from "node:assert/strict";
import { test } from "node:test";
import { TextPreview } from "../server/text-preview.ts";
import { isQuietReply } from "../server/routines.ts";
import type { RuntimeEvent } from "../server/contracts.ts";

const base = { provider: "fixture", threadId: "lane", turnId: "turn", eventId: "event", createdAt: "2026-01-01T00:00:00Z" };
const event = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as RuntimeEvent;
const begin = (p: TextPreview, fields = {}) => p.start(event({ type: "turn.started", ...fields }));
const chunk = (p: TextPreview, text: string, silent = true, fields = {}) => p.delta(event({ type: "content.delta", streamKind: "assistant_text", delta: text, ...fields }) as Extract<RuntimeEvent, { type: "content.delta" }>, silent);
const words = (e: RuntimeEvent | null) => e?.type === "content.delta" ? e.delta : "";
const complete = (p: TextPreview, fields = {}) => p.complete(event({ type: "item.completed", itemType: "assistant_text", text: "", ...fields }));

for (const text of ["QUIET", " Quiet. ", "quiet!", "\nQUIET…\n", "QUIET.!…", "\tqUiEt "]) {
  test(`every split keeps a bare marker out of preview: ${JSON.stringify(text)}`, () => {
    assert.ok(isQuietReply(text));
    for (let split = 0; split <= text.length; split++) {
      const p = new TextPreview(); begin(p);
      assert.equal(words(chunk(p, text.slice(0, split))) + words(chunk(p, text.slice(split))), "");
      complete(p);
      assert.equal(words(chunk(p, "Ordinary next item")), "Ordinary next item");
    }
  });
}

for (const text of ['"QUIET"', "'QUIET'", "```text\nQUIET\n```", "[QUIET]", "{card}", "<report>", "~Report", "Привет", "你好", "État du travail", "🙂 Working", "¿Listo?", "QUIET is a word", "Quietly done", "Query complete", "Which account?", "42", "QUIET !"]) {
  test(`real text releases on disambiguation before completion: ${JSON.stringify(text)}`, () => {
    for (let split = 0; split <= text.length; split++) {
      const p = new TextPreview(); begin(p);
      const shown = words(chunk(p, text.slice(0, split))) + words(chunk(p, text.slice(split)));
      assert.equal(shown, text);
    }
  });
}

test("the first disambiguating delta releases the complete prefix in order once", () => {
  const p = new TextPreview(); begin(p);
  assert.equal(chunk(p, "QUI"), null);
  assert.equal(words(chunk(p, "ET is a word")), "QUIET is a word");
  assert.equal(words(chunk(p, " in prose.")), " in prose.");
});

test("ineligible turns stream even a bare marker; a real eligibility change flushes only the same item", () => {
  const p = new TextPreview(); begin(p);
  assert.equal(words(chunk(p, "QUIET", false)), "QUIET");
  assert.equal(chunk(p, "QU", true), null);
  assert.equal(words(chunk(p, "IET", false)), "QUIET");
  assert.equal(words(chunk(p, " now", false)), " now");
  complete(p); assert.equal(chunk(p, "Q", true, { itemId: "old" }), null);
  assert.equal(words(chunk(p, "Other item", false, { itemId: "new" })), "Other item");
});

test("64-character ambiguous fallback is sticky and isolated from another lane and replacement attempt", () => {
  const p = new TextPreview(); begin(p); begin(p, { threadId: "other" });
  assert.equal(chunk(p, " ".repeat(63)), null);
  assert.equal(chunk(p, " "), null);
  assert.equal(chunk(p, "Now ordinary"), null);
  assert.equal(words(chunk(p, "[Immediate]", true, { threadId: "other" })), "[Immediate]");
  complete(p); assert.equal(chunk(p, "QUIET"), null);
  begin(p, { turnId: "replacement" });
  p.end(event({ type: "turn.completed", ok: true }));
  p.end(event({ type: "session.exited" }));
  assert.equal(words(chunk(p, "New ordinary", true, { turnId: "replacement" })), "New ordinary");
  assert.equal(words(chunk(p, " still streams", true, { threadId: "other" })), " still streams");
});

test("ambiguous interleaving never releases an evicted tail", () => {
  const p = new TextPreview(); begin(p);
  assert.equal(chunk(p, "Q", true, { itemId: "one" }), null);
  assert.equal(chunk(p, "Ordinary", true, { itemId: "two" }), null);
  complete(p, { itemId: "one" }); complete(p, { itemId: "two" });
  assert.equal(chunk(p, "UIET", true, { itemId: "one" }), null);
  begin(p); assert.equal(words(chunk(p, "Fresh")), "Fresh");
});

test("anonymous completion gaining an id resets; authoritative short Q/QUI is never modified", () => {
  const p = new TextPreview(); begin(p);
  for (const text of ["Q", "QUI"]) {
    assert.equal(chunk(p, text), null);
    const final = event({ type: "item.completed", itemType: "assistant_text", text, itemId: "gained" });
    p.complete(final);
    assert.equal(final.type === "item.completed" && final.itemType === "assistant_text" && final.text, text);
    assert.equal(words(chunk(p, "Real next")), "Real next"); complete(p);
  }
});

test("BoxAgent whole messages classify independently after ordinary progress", () => {
  const p = new TextPreview(); begin(p); const box = { provider: "boxAgent" };
  assert.equal(words(chunk(p, "Checking the task.\n", true, box)), "Checking the task.\n");
  assert.equal(chunk(p, "QUIET", true, box), null);
  for (const text of ["Q", "QUIET is a word", '"QUIET"', "[Report]", "The task is complete."]) assert.equal(words(chunk(p, text, true, box)), text);
  assert.equal(words(chunk(p, "QUIET", false, box)), "QUIET");
});

test("nontext, unmatched attempts, actual exit and orphan ambiguity", () => {
  const p = new TextPreview(); begin(p);
  const reason = event({ type: "content.delta", streamKind: "reasoning_text", delta: "QUIET" });
  assert.equal(p.delta(reason as Extract<RuntimeEvent, { type: "content.delta" }>, true), reason);
  assert.equal(chunk(p, "Orphan", true, { turnId: "old" }), null);
  assert.equal(chunk(p, "Q"), null);
  p.end(event({ type: "turn.completed", turnId: "old", ok: true }));
  assert.equal(chunk(p, "UIET"), null);
  p.end(event({ type: "session.exited", turnId: undefined }));
  assert.equal(chunk(p, "suffix"), null);
  assert.equal(words(chunk(p, "Requested", false)), "Requested");
});


test("oversized item attribution falls back, and deleting a lane does not retire its sibling", () => {
  const p = new TextPreview(); begin(p); begin(p, { threadId: "other" });
  assert.equal(chunk(p, "Q", true, { itemId: "x".repeat(257) }), null);
  assert.equal(chunk(p, "Later ordinary"), null);
  p.forget("lane");
  assert.equal(words(chunk(p, "Still here", true, { threadId: "other" })), "Still here");
  begin(p); assert.equal(words(chunk(p, "Recreated")), "Recreated");
});
