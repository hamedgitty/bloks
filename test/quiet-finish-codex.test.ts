// `bloks quiet` on Codex's event shapes (server/quiet-finish.ts), with the
// native fixture of test/quiet-preview-http.test.ts: authoritative progress
// items, and text that arrives in pieces before its item completes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { nativePreviewFixture, post } from "./helpers/quiet-preview.ts";
import { previewOf, settledIn } from "./helpers/quiet-finish.ts";
import { waitFor } from "./helpers/turns.ts";

type Native = Awaited<ReturnType<typeof nativePreviewFixture>>;

/** This turn's own credential, as its shell has it. */
const token = (f: Native) => readFileSync(join(f.root, "credentials.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).token as string).at(-1)!;
const quiet = async (f: Native) => {
  const res = await fetch(`${f.h.url}/api/bots/${f.bot.id}/tasks/${f.bot.threadId}/quiet`, { method: "POST", headers: { authorization: `Bearer ${token(f)}` } });
  return { status: res.status, body: await res.json() as any };
};

test("a check-in whose Codex progress was already shown is not finished quietly, and nothing of it folds", async (t) => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  f.spec({ captureCredential: true });
  const { routine } = await f.post("/api/routines", { targetKind: "agent", targetId: f.bot.id, name: "Native quiet progress", prompt: "Inspect neutral records", days: [], every: 30 });
  await f.h.fetch(`/api/bots/${f.bot.id}/tasks/${f.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post())).status, 202);
  await f.called("turn/start", 1);
  f.complete("Checking the neutral records.", "progress");
  assert.ok(await waitFor(() => previewOf(live, f.bot.threadId) === "Checking the neutral records."));
  const refused = await quiet(f);
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.body.reason, "already_shown");
  f.finish("Two neutral records changed."); await f.settled();
  const ran: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((row: any) => row.id === routine.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.notEqual(ran.runs[0].quiet, true);
  const rows = await f.messages();
  assert.ok(rows.some((row) => row.role === "bot" && row.text === "Checking the neutral records." && !row.quiet), "the progress stays shown");
  assert.ok(rows.some((row) => row.role === "bot" && row.text === "Two neutral records changed." && !row.quiet));
});

test("text already previewed refuses the finish before its item is saved", async (t) => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  f.spec({ captureCredential: true });
  await f.fire();
  await f.called("turn/start", 1);
  await f.delta("Looking at the neutral records");
  assert.ok(await waitFor(() => previewOf(live, f.bot.threadId) === "Looking at the neutral records"));
  const refused = await quiet(f);
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.body.reason, "already_shown");
  f.complete("Looking at the neutral records.");
  f.finish("Looking at the neutral records."); await f.settled();
  assert.ok((await f.messages()).some((row) => row.role === "bot" && row.text === "Looking at the neutral records." && !row.quiet));
});

test("a quiet word's first letters held at the finish never reach the screen, live or on replay", async (t) => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  f.spec({ captureCredential: true });
  await f.h.fetch(`/api/bots/${f.bot.id}/tasks/${f.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  await f.fire();
  await f.called("turn/start", 1);
  await f.delta("QUI");
  assert.equal(previewOf(live, f.bot.threadId), "", "a possible quiet word is held");
  const accepted = await quiet(f);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  await f.delta("ET is a neutral word.");
  f.complete("QUIET is a neutral word.");
  f.finish("Done."); await f.settled();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(previewOf(live, f.bot.threadId), "", JSON.stringify(live.filter((frame) => frame.event?.threadId === f.bot.threadId)));
  const replay = await f.stream("/api/events?since=0");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(previewOf(replay, f.bot.threadId), "", "nor on a reconnect");
  assert.deepEqual(settledIn(live, f.bot.threadId), []);
  const rows = await f.messages();
  const said = rows.slice(rows.findLastIndex((row) => row.via === "webhook") + 1).filter((row) => row.role === "bot" && row.kind === "text");
  assert.ok(said.length >= 1);
  assert.deepEqual(said.filter((row) => !row.quiet).map((row) => row.text), [], "what it wrote is kept quiet");
  assert.equal(Boolean((await f.current()).tasks.find((row: any) => row.id === f.bot.threadId).unread), false);
});
