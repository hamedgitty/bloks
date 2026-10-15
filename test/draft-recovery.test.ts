import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { intakeFiles, pasteAttachment, type Attachment } from "../src/lib/attachments.ts";
import {
  acceptDraft, boxFor, discardRecovery, keepDraft, readDraft, readRecoveries,
  recoverDraft, restoreRecovery, showBox, takeBack, type Draft,
} from "../src/lib/drafts.ts";

let nextKey = 0;
const empty = (): Draft<Attachment> => ({ text: "", attachments: [] });
const draft = (text: string, attachments: Attachment[] = []): Draft<Attachment> => ({ text, attachments });
const box = (text = "", attachments: Attachment[] = []) => ({ current: draft(text, attachments) });
function key(t: TestContext) {
  const value = `recovery-test-${++nextKey}`;
  t.after(() => {
    for (const item of readRecoveries(value)) discardRecovery(value, item.id);
    keepDraft(value, empty());
  });
  return value;
}
const file = (): Attachment => ({ kind: "file", id: "file", path: "/tmp/outline.txt", name: "outline.txt", bytes: 12 });
const image = (): Attachment => ({ kind: "image", id: "image", path: "/tmp/picture.png", name: "picture.png", bytes: 4, mime: "image/png" });

test("an empty original box receives the exact raw words and attachment order", t => {
  const k = key(t);
  const current = box();
  const sent = draft("  Zażółć 🌿\n<not-markup>\n", [pasteAttachment("one\ntwo\n"), file(), image()]);
  const expected = structuredClone(sent);
  assert.deepEqual(recoverDraft(k, current, sent), expected);
  assert.deepEqual(current.current, expected);
  assert.notEqual(current.current, sent);
  assert.deepEqual(readRecoveries(k), []);
});

test("two failures in one batch restore the first and retain the other", t => {
  const k = key(t);
  const current = box();
  recoverDraft(k, current, draft("First"));
  recoverDraft(k, current, draft("Second", [file()]));
  assert.deepEqual(current.current, draft("First"));
  assert.deepEqual(readRecoveries(k).map(r => r.draft), [draft("Second", [file()])]);
});

test("an occupied box retains every failed submission, including identical ones", t => {
  const k = key(t);
  const current = box("A newer thought");
  const before = structuredClone(current.current);
  recoverDraft(k, current, draft("Same words"));
  recoverDraft(k, current, draft("Same words"));
  assert.deepEqual(current.current, before);
  const items = readRecoveries(k);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
});

test("accepted words in the same batch protect the newer draft from a failure", t => {
  const k = key(t);
  const current = box();
  acceptDraft(current, draft("Accepted before the screen renders"));
  recoverDraft(k, current, draft("Failed input"));
  assert.equal(current.current.text, "Accepted before the screen renders");
  assert.equal(readRecoveries(k)[0].draft.text, "Failed input");
});

test("asynchronous image intake protects an attachment-only draft before a render", async t => {
  const k = key(t);
  const current = box();
  const incoming = { name: "picture.png", size: 4, type: "image/png", text: async () => "" };
  const added = await intakeFiles([incoming], { pathOf: () => "", uploadImage: async () => image() as Extract<Attachment, { kind: "image" }> });
  acceptDraft(current, draft("", added.attachments));
  recoverDraft(k, current, draft("Failed input"));
  assert.deepEqual(current.current, draft("", [image()]));
  const item = readRecoveries(k)[0];
  assert.equal(item.draft.text, "Failed input");
  assert.equal(restoreRecovery(k, item.id, current), null);
  assert.equal(readRecoveries(k).length, 1);
});

test("editing or removing newer attachments cannot mutate a retained payload", t => {
  const k = key(t);
  const attachment = file();
  const sent = draft("Original\n🌿", [pasteAttachment("raw\ntext"), attachment, image()]);
  const expected = structuredClone(sent);
  const current = box("Newer", [attachment]);
  recoverDraft(k, current, sent);
  if (attachment.kind === "file") attachment.name = "changed.txt";
  sent.text = "Changed outside recovery";
  sent.attachments.reverse();
  acceptDraft(current, empty());
  assert.deepEqual(readRecoveries(k)[0].draft, expected);
  assert.deepEqual(restoreRecovery(k, readRecoveries(k)[0].id, current), expected);
});

test("occupied restore keeps both payloads, and clearing does not restore by itself", t => {
  const k = key(t);
  const current = box("Newer");
  recoverDraft(k, current, draft("Saved", [image()]));
  const id = readRecoveries(k)[0].id;
  assert.equal(restoreRecovery(k, id, current), null);
  assert.equal(current.current.text, "Newer");
  assert.equal(readRecoveries(k).length, 1);
  acceptDraft(current, empty());
  assert.equal(current.current.text, "");
  assert.equal(readRecoveries(k).length, 1);
  assert.deepEqual(restoreRecovery(k, id, current), draft("Saved", [image()]));
  assert.equal(readRecoveries(k).length, 0);
});

test("a selected id is consumed without losing a failure appended since its render", t => {
  const k = key(t);
  const current = box("Newer");
  recoverDraft(k, current, draft("First"));
  const first = readRecoveries(k)[0].id;
  recoverDraft(k, current, draft("Appended"));
  const appended = readRecoveries(k)[1].id;
  discardRecovery(k, first);
  assert.deepEqual(readRecoveries(k).map(r => r.id), [appended]);
  recoverDraft(k, current, draft("Another"));
  const another = readRecoveries(k)[1].id;
  acceptDraft(current, empty());
  assert.equal(restoreRecovery(k, appended, current)?.text, "Appended");
  assert.deepEqual(readRecoveries(k).map(r => r.id), [another]);
  assert.equal(restoreRecovery(k, another, current), null);
  assert.equal(current.current.text, "Appended");
  assert.equal(restoreRecovery(k, appended, current), null);
  discardRecovery(k, first);
  assert.deepEqual(readRecoveries(k).map(r => r.id), [another]);
});

test("an id from another key or a stale click never consumes the wrong payload", t => {
  const a = key(t), b = key(t);
  const current = box("Occupied");
  recoverDraft(a, current, draft("A"));
  recoverDraft(b, current, draft("B"));
  const aid = readRecoveries(a)[0].id;
  discardRecovery(b, aid);
  assert.equal(restoreRecovery(b, aid, box()), null);
  assert.equal(readRecoveries(a)[0].draft.text, "A");
  assert.equal(readRecoveries(b)[0].draft.text, "B");
  const target = box();
  assert.equal(restoreRecovery(a, aid, target)?.text, "A");
  acceptDraft(target, draft("Edited after restoring"));
  assert.equal(restoreRecovery(a, aid, target), null);
  assert.equal(target.current.text, "Edited after restoring");
});

test("unmounted kept drafts preserve both same-batch failures and later cleanup", t => {
  const k = key(t);
  for (const sent of [draft("First"), draft("Second", [file()])]) {
    const back = recoverDraft(k, { current: readDraft<Attachment>(k) }, sent);
    if (back) keepDraft(k, back);
  }
  assert.equal(readDraft(k).text, "First");
  assert.equal(readRecoveries(k)[0].draft.text, "Second");
  keepDraft(k, draft("A later draft"));
  assert.equal(readRecoveries(k)[0].draft.text, "Second");
});

test("a late failure reaches the replacement box for its original key", t => {
  const a = key(t), b = key(t);
  const oldA = box(), newA = box("New A"), other = box("B draft");
  const hideOld = showBox<Attachment>(a, sent => { recoverDraft(a, oldA, sent); });
  hideOld();
  const hideB = showBox<Attachment>(b, sent => { recoverDraft(b, other, sent); });
  const hideNew = showBox<Attachment>(a, sent => { recoverDraft(a, newA, sent); });
  t.after(() => { hideB(); hideNew(); });
  hideOld();
  boxFor<Attachment>(a)!(draft("Old callback's payload"));
  assert.equal(newA.current.text, "New A");
  assert.equal(other.current.text, "B draft");
  assert.equal(readRecoveries(a)[0].draft.text, "Old callback's payload");
  assert.deepEqual(readRecoveries(b), []);
});

test("the existing room take-back contract creates no hidden recovery item", t => {
  const k = key(t);
  const newer = draft("Room draft");
  assert.equal(takeBack(newer, draft("Room failure")), null);
  assert.deepEqual(newer, draft("Room draft"));
  assert.deepEqual(readRecoveries(k), []);
});
