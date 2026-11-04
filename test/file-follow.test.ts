// An open file viewer following its file (src/lib/followFile.ts and the
// ?version answer on the shared file route): the version a file is now,
// what the viewer makes of each answer, and nothing more reachable by
// asking for a version than by asking for the file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { followAnswer, tagOfEtag, UNSEEN, type Seen } from "../src/lib/followFile.ts";
import { startHarness } from "./helpers/server.ts";

test("the first answer is where the viewer starts, and only a new tag reloads", () => {
  let seen: Seen = UNSEEN;
  let step = followAnswer(seen, { status: 200, tag: "a" });
  assert.deepEqual(step, { seen: { tag: "a", removed: false }, follow: "none" });
  seen = step.seen;
  assert.equal(followAnswer(seen, { status: 200, tag: "a" }).follow, "none");
  step = followAnswer(seen, { status: 200, tag: "b" });
  assert.deepEqual(step, { seen: { tag: "b", removed: false }, follow: "reload" });
});

test("a removed file is said once, and a file that comes back is read again", () => {
  let seen: Seen = { tag: "a", removed: false };
  let step = followAnswer(seen, { status: 404 });
  assert.deepEqual(step, { seen: { tag: "a", removed: true }, follow: "removed" });
  seen = step.seen;
  assert.equal(followAnswer(seen, { status: 404 }).follow, "none");
  // back, even as the very same version: what is on screen says removed
  step = followAnswer(seen, { status: 200, tag: "a" });
  assert.deepEqual(step, { seen: { tag: "a", removed: false }, follow: "reload" });
});

test("a failure that is not a 404 is no news", () => {
  const seen: Seen = { tag: "a", removed: false };
  for (const answer of [{ status: 0 }, { status: 500 }, { status: 502, tag: "b" }, { status: 403 }, { status: 200 }, { status: 200, tag: "" }, { status: 200, tag: 7 }]) {
    assert.deepEqual(followAnswer(seen, answer), { seen, follow: "none" }, JSON.stringify(answer));
  }
});

test("a read that failed leaves the tag empty, so the next answer reads again", () => {
  assert.equal(followAnswer({ tag: "", removed: false }, { status: 200, tag: "b" }).follow, "reload");
});

test("an ETag gives its tag, quotes and weakness taken off", () => {
  assert.equal(tagOfEtag('"abc_-1"'), "abc_-1");
  assert.equal(tagOfEtag('W/"abc"'), "abc");
  for (const header of [null, undefined, "", "abc", '""', '"a"b"']) assert.equal(tagOfEtag(header), null, String(header));
});

test("a shared file says its version, which moves when it is written and is gone when it is", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-file-follow-"));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Writer" }) });
  const files = join(home, ".bloks", "artifacts", bot.id);
  mkdirSync(join(files, "reports"), { recursive: true });
  writeFileSync(join(files, "reports", "plan.md"), "# One");
  writeFileSync(join(home, "secret.txt"), "the key");
  symlinkSync(join(home, "secret.txt"), join(files, "escape.txt"));
  const route = `/api/bots/${bot.id}/artifacts/reports/plan.md`;

  const whole = await h.fetch(route);
  assert.equal(await whole.text(), "# One");
  const first = await h.json(`${route}?version`);
  assert.deepEqual(Object.keys(first).sort(), ["size", "tag"]);
  assert.equal(first.size, 5);
  // the same version the file itself is sent under
  assert.equal(first.tag, tagOfEtag(whole.headers.get("etag")));
  assert.equal((await h.json(`${route}?version`)).tag, first.tag);

  // written again, even at the same size, is another version
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(join(files, "reports", "plan.md"), "# Two");
  const second = await h.json(`${route}?version`);
  assert.notEqual(second.tag, first.tag);

  unlinkSync(join(files, "reports", "plan.md"));
  assert.equal((await h.fetch(`${route}?version`)).status, 404);
  // a link out is a file that is not there, for its version as for its bytes
  assert.equal((await h.fetch(`/api/bots/${bot.id}/artifacts/escape.txt?version`)).status, 404);
  assert.equal((await h.fetch(`/api/bots/${bot.id}/artifacts/..%2F..%2Fsecret.txt?version`)).status, 404);
});
