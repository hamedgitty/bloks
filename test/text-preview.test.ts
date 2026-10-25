import assert from "node:assert/strict";
import { test } from "node:test";
import { TextPreview } from "../server/text-preview.ts";
import type { RuntimeEvent } from "../server/contracts.ts";

const base = { provider: "fixture", threadId: "lane", turnId: "turn", eventId: "event", createdAt: "2026-01-01T00:00:00Z" };
const event = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as RuntimeEvent;
const begin = (p: TextPreview) => p.start(event({ type: "turn.started" }));
const chunk = (p: TextPreview, text: string, fields = {}) => p.delta(event({ type: "content.delta", streamKind: "assistant_text", delta: text, ...fields }) as Extract<RuntimeEvent, { type: "content.delta" }>);
const words = (e: RuntimeEvent | null) => e?.type === "content.delta" ? e.delta : "";
const complete = (p: TextPreview, fields = {}) => p.complete(event({ type: "item.completed", itemType: "assistant_text", text: "", ...fields }));

for (const text of ["QUIET", " Quiet. ", "quiet!", "\nQUIET…\n", "QUIET is a word", "Query complete", "Which account?", "QUI", "Q", "42"]) {
  test(`every split preserves safe preview or leaves the authoritative item to speak: ${JSON.stringify(text)}`, () => {
    for (let split = 0; split <= text.length; split++) {
      const p = new TextPreview(); begin(p);
      const shown = words(chunk(p, text.slice(0, split))) + words(chunk(p, text.slice(split)));
      assert.ok(shown === "" || shown === text, `partial or corrupt preview at ${split}: ${shown}`);
      if (/^\s*quiet(?:[.!…]|\s|$)/i.test(text)) assert.equal(shown, "");
      complete(p);
      assert.equal(words(chunk(p, "Ordinary next item")), "Ordinary next item", "anonymous completion did not reset");
    }
  });
}

test("anonymous consecutive items reset even when completion gains a native id", () => {
  const p = new TextPreview(); begin(p);
  assert.equal(chunk(p, "QUIET"), null); complete(p, { itemId: "completed-id" });
  assert.equal(words(chunk(p, "Report")), "Report"); complete(p);
  assert.equal(chunk(p, "QUIET"), null);
});

test("identified interleaving and capacity fallback stay settled-only until the actual next attempt", () => {
  const p = new TextPreview(); begin(p);
  assert.equal(chunk(p, "Q", { itemId: "one" }), null);
  assert.equal(chunk(p, "Real report", { itemId: "two" }), null);
  complete(p, { itemId: "one" }); complete(p, { itemId: "two" });
  assert.equal(chunk(p, "UIET", { itemId: "one" }), null, "an evicted prefix tail escaped");
  assert.equal(chunk(p, "More", { itemId: "third" }), null);
  p.end(event({ type: "turn.completed", ok: true })); begin(p);
  assert.equal(words(chunk(p, "New attempt")), "New attempt");
});

test("long ambiguous input, unknown attribution and structured prefixes wait for completion without a timer", () => {
  const p = new TextPreview(); begin(p);
  for (let i = 0; i < 1000; i++) assert.equal(chunk(p, " ".repeat(100)), null);
  assert.equal(chunk(p, "Real text after the bound"), null);
  complete(p); assert.equal(words(chunk(p, "Ready")), "Ready"); complete(p);
  for (const text of ['```bloks\n{"kind":"quote","text":"Report"}\n```\nQUIET', '"QUIET"', '`QUIET`']) {
    assert.equal(chunk(p, text), null); complete(p);
  }
  assert.equal(chunk(p, "Unknown attempt", { turnId: "other" }), null);
  assert.equal(words(chunk(p, "Still this attempt")), "Still this attempt");
});

test("a viewer has no reset; completion/end affect only their matching attempt, and reasoning is unchanged", () => {
  const p = new TextPreview(); begin(p); chunk(p, "Q");
  p.end(event({ type: "turn.completed", turnId: "other", ok: true }));
  assert.equal(chunk(p, "UIET"), null);
  const reasoning = event({ type: "content.delta", streamKind: "reasoning_text", delta: "QUIET" });
  assert.equal(p.delta(reasoning as Extract<RuntimeEvent, { type: "content.delta" }>), reasoning);
  p.end(event({ type: "turn.completed", ok: false }));
  assert.equal(chunk(p, "orphan"), null);
});


test("an actual session exit without a turn id retires preview state", () => {
  const p = new TextPreview(); begin(p); chunk(p, "Q");
  p.end(event({ type: "session.exited", turnId: undefined }));
  assert.equal(chunk(p, "orphan suffix"), null);
  begin(p); assert.equal(words(chunk(p, "Fresh answer")), "Fresh answer");
});


test("whole-message BoxAgent progress does not admit a later marker, but keeps real reports", () => {
  const p = new TextPreview(); begin(p);
  const box = { provider: "boxAgent" };
  assert.equal(words(chunk(p, "Checking the task.\n", box)), "Checking the task.\n");
  assert.equal(chunk(p, "QUIET", box), null);
  assert.equal(words(chunk(p, "QUIET is a word in this report.", box)), "");
  // Ambiguous prose still arrives through its authoritative completion.
  assert.equal(words(chunk(p, "The task is complete.", box)), "The task is complete.");
});

for (const text of ["Привет, работа идёт.", "你好，工作正在进行。", "État du travail", "🙂 Working", "¿Listo?"]) {
  test(`ordinary Unicode prose streams at every split: ${text}`, () => {
    for (let split = 0; split <= text.length; split++) {
      const p = new TextPreview(); begin(p);
      assert.equal(words(chunk(p, text.slice(0, split))) + words(chunk(p, text.slice(split))), text);
    }
  });
}
