import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { controlledChain } from "./helpers/agent-chain.ts";
import { alertWorkspace } from "./helpers/alert-workspace.ts";
import { waitFor } from "./helpers/turns.ts";
import { lastSaid, agentPreview, lastHeardAt } from "../src/lib/preview.ts";
import { noticeFor } from "../src/lib/notify.ts";
import { desktopNotice } from "../server/desktop-notice.ts";
import { towardYou } from "../server/activity.ts";
import { telegramFallback } from "../server/telegram-reply.ts";
import { foldRoom, foldTurns } from "../src/lib/turnFold.ts";
import type { Message } from "../server/store.ts";
import type { Message as ClientMessage } from "../src/state/reducer.ts";

const copy = "Session reset. You can keep chatting.\nChat history and saved memory are kept. The new session may not include earlier messages.";
const marker: Message = { id: "reset", at: 20, role: "bot", kind: "notice", sessionReset: true, text: copy };

test("immediate reset is saved once, reaches the relay without a wake, and does not change unread or lane time", async (t) => {
  const w = await alertWorkspace(t);
  const bot = await w.hire("Writer");
  const current = async () => (await w.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id);
  const before = await current(), previous = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages;
  const path = `/api/bots/${bot.id}/tasks/${bot.threadId}/fresh`;
  assert.deepEqual(await w.h.json(path, { method: "POST" }), { ok: true, fresh: "now" });
  const saved = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages;
  assert.equal(saved.length, previous.length + 1);
  const row = saved.at(-1);
  assert.equal(row.sessionReset, true); assert.equal(row.text, copy); assert.equal(row.event, undefined);
  const pushed = await waitFor(() => w.captured(row.id));
  assert.ok(pushed); assert.equal(pushed.wake, undefined);
  assert.equal(w.ownerFrames().filter((f: any) => f.message?.id === row.id).length, 1);
  const after = await current();
  assert.equal(after.unread, before.unread);
  assert.equal(after.tasks[0].lastAt, before.tasks[0].lastAt);
  assert.equal((await w.h.fetch(path, { method: "POST", headers: { authorization: "Bearer invalid-example" } })).status, 401);
  assert.equal((await w.h.fetch(`/api/bots/${bot.id}/tasks/missing/fresh`, { method: "POST" })).status, 404);
  await w.h.json(path, { method: "POST" });
  const repeated = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages.filter((m: any) => m.sessionReset);
  assert.equal(repeated.length, 2); assert.notEqual(repeated[0].id, repeated[1].id);
  await w.restart();
  assert.deepEqual((await w.h.json(`/api/bots/${bot.id}/messages`)).messages.filter((m: any) => m.sessionReset), repeated);
});

for (const origin of ["agent", "person"] as const) test(`deferred ${origin} reset waits, coalesces, and precedes queued work`, async (t) => {
  const c = await controlledChain(t);
  const bot = await c.hire("Writer"), other = await c.hire("Other");
  const path = `/api/bots/${bot.id}/tasks/${bot.threadId}/fresh`;
  const turn = await c.begin(bot, "Earlier example context");
  const fresh = () => origin === "agent" ? c.agent(turn, path) : c.h.fetch(path, { method: "POST" });
  for (let i = 0; i < 2; i++) {
    const response = await fresh(); assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, fresh: "when this turn ends" });
  }
  assert.equal((await c.messages(bot)).filter((m) => m.sessionReset).length, 0);
  assert.equal((await c.agent(turn, `/api/bots/${other.id}/tasks/${other.threadId}/fresh`)).status, 403);
  const queued = await c.h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Queued next work", steer: false }) });
  assert.equal(queued.queued, true);
  writeFileSync(join(c.home, `finish-${turn.pid}`), "");
  const next = await c.turnAfter(1);
  const rows = await c.messages(bot);
  assert.equal(rows.filter((m) => m.sessionReset).length, 1);
  assert.equal(rows.find((m) => m.sessionReset).text, copy);
  assert.ok(rows.some((m) => m.text === "Earlier example context"));
  assert.ok(rows.findIndex((m) => m.sessionReset) < rows.findIndex((m) => m.text === "Queued next work"));
  assert.doesNotMatch(next.text, /Earlier example context/, "native fresh turn replayed old context");
  await c.finish(next, bot);
});

test("reset maintenance is visible outside folds and never replaces content, errors or empty baselines", () => {
  const reply: Message = { id: "reply", at: 10, role: "bot", kind: "text", text: "The result." };
  assert.equal(lastSaid([reply, marker]), reply); assert.equal(lastSaid([marker]), undefined);
  const row = { threadId: "lane", busy: false, messages: [marker], tasks: [{ id: "lane", createdAt: 1, lastAt: 1 }] };
  assert.equal(agentPreview(row), "New agent"); assert.equal(lastHeardAt(row), undefined);
  assert.equal(agentPreview({ ...row, messages: [reply, marker] }), "The result.");
  assert.equal(lastHeardAt({ ...row, messages: [reply, marker] }), reply.at);
  assert.equal(towardYou(marker, true), false); assert.equal(towardYou(marker, false), false);
  assert.equal(telegramFallback([marker], (s) => s).text, "(the agent finished without saying anything)");
  const error: Message = { ...marker, id: "error", sessionReset: undefined, text: "Sign in to continue." };
  assert.equal(telegramFallback([error, marker], (s) => s).text, error.text);
  const ctx = { focused: false, selectedId: "", threadId: "lane", bot: { id: "bot", name: "Writer", notifications: true } };
  assert.equal(noticeFor(marker, ctx), null); assert.ok(noticeFor(error, ctx));
  const desk = { bot: () => ctx.bot, room: () => null, goalRunning: () => false };
  assert.equal(desktopNotice({ kind: "message", threadId: "lane", message: marker }, desk), null);
  assert.ok(desktopNotice({ kind: "message", threadId: "lane", message: error }, desk));
  const transcript = [{ id: "ask", at: 1, role: "user", kind: "text", text: "Example" }, reply, marker] as ClientMessage[];
  for (const folded of [foldTurns(transcript, false), foldRoom(transcript.map((m) => ({ ...m, from: "bot" })), new Map())]) {
    assert.ok(folded.rows.some((r) => r.kind === "said" && r.items.some((i) => i.message.id === marker.id)));
    assert.ok(folded.rows.every((r) => r.kind !== "fold" || r.fold.messages.every((m) => m.id !== marker.id)));
  }
});
