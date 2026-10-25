import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { quietFixture, noAnswer, request } from "./helpers/quiet-completion.ts";
import { idle, waitFor } from "./helpers/turns.ts";
import { chainRelay } from "./helpers/chain-relay.ts";
import { desktopNotice } from "../server/desktop-notice.ts";
import { noticeFor } from "../src/lib/notify.ts";
import { foldRuntime } from "../src/lib/memberRules.ts";
import { isQuietReply } from "../server/routines.ts";

const markers = (rows: any[]) => rows.filter(m => m.role === "bot" && isQuietReply(m.text));
const output = (frames: any[]) => frames.filter(f => f.kind === "message" || f.kind === "reply.settled");
const lane = async (f: Awaited<ReturnType<typeof quietFixture>>, b: any) => (await f.h.json("/api/bots")).bots.find((x: any) => x.id === b.id).tasks.find((x: any) => x.id === b.threadId);

test("real scheduled timed routines ignore the quiet switch for markers, preserve prior reports/unread/time, and send no attention", { timeout: 150_000 }, async t => {
  const f = await quietFixture(t), pushes: Array<{ frames: any[]; wake: unknown }> = [];
  const previews = await chainRelay(t, f.h, pushes);
  const cases = [];
  for (const quiet of [undefined, false, true]) {
    const b = await f.bot();
    const now = new Date(), time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const { routine } = await f.h.json("/api/routines", request("POST", { targetKind: "agent", targetId: b.id, name: "Fixture check", prompt: "Inspect the neutral fixture", time, days: [], enabled: false, ...(quiet === undefined ? {} : { quiet }) }));
    f.answers.push("Earlier routine report");
    await f.h.json(`/api/routines/${routine.id}/run`, request("POST")); assert.ok(await idle(f.h, b));
    await f.h.json(`/api/bots/${b.id}/tasks/${b.threadId}`, request("PATCH", { unread: quiet === true }));
    cases.push({ b, routine, before: await lane(f, b) });
  }
  // Give the relay its positive earlier replies, then bound the no-report window.
  const control = await f.bot();
  const { workflow } = await f.h.json("/api/workflows", request("POST", { name: "Wake control", trigger: { kind: "manual" }, steps: [{ id: "gate", action: "approve", targetId: control.id, text: "Confirm fixture?" }] }));
  const { run } = await f.h.json(`/api/workflows/${workflow.id}/run`, request("POST", {}));
  assert.ok(await waitFor(() => previews.some(p => p.body.includes("Confirm fixture"))), "positive wake control did not arrive");
  await f.h.json(`/api/workflows/runs/${run.id}/answer`, request("POST", { answer: "Approve" }));
  assert.ok(pushes.flatMap(p => p.frames).some(x => x.kind === "reply.settled" && x.message?.text === "Earlier routine report"), "positive relay reply did not arrive");
  const at = f.frames.length, wakes = previews.length;
  const next = new Date(Date.now() + 60_000);
  const slot = `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
  for (const { routine } of cases) await f.h.json(`/api/routines/${routine.id}`, request("PATCH", { time: slot, enabled: true }));
  assert.ok(await waitFor(async () => (await f.h.json("/api/routines")).routines.every((r: any) => r.runs?.some((run: any) => run.quiet)) ? true : null, 95_000), f.h.logs());
  for (const { b, routine, before } of cases) {
    const stored = (await f.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id);
    assert.equal(stored.runs[0].quiet, true); assert.equal(stored.runs[0].summary, undefined);
    assert.equal(stored.lastReport.summary, "Earlier routine report");
    const after = await lane(f, b); assert.equal(after.unread, before.unread); assert.equal(after.lastAt, before.lastAt);
    const messages = await f.messages(b); assert.equal(markers(messages).length, 0);
    assert.ok(messages.some(m => m.via === "routine" && m.routine?.manual === false && m.quiet));
    const saved = JSON.parse(readFileSync(join(f.h.home, ".bloks", `messages-${b.threadId}.json`), "utf8"));
    assert.equal(markers(Array.isArray(saved) ? saved : saved.messages).length, 0);
    const actual = f.frames.slice(at).filter(x => x.threadId === b.threadId || x.event?.threadId === b.threadId);
    assert.equal(actual.filter(x => x.kind === "reply.settled").length, 0);
    assert.ok(!actual.some(x => isQuietReply(x.event?.delta) || isQuietReply(x.event?.text)));
    assert.ok(output(actual).every(frame => !noticeFor(frame.message, { focused: false, selectedId: "", threadId: b.threadId, bot: { id: b.id, name: "Fixture", notifications: true } })));
    assert.ok(output(actual).every(frame => !desktopNotice(frame, { bot: () => ({ id: b.id, name: "Fixture" }), room: () => null, goalRunning: () => false })));
  }
  await new Promise(r => setTimeout(r, 600)); assert.equal(previews.length, wakes);
  assert.ok(!pushes.flatMap(p => p.frames).some(x => isQuietReply(x.event?.delta) || isQuietReply(x.message?.text)), "relay carried the marker");
  const { entries } = await f.h.json("/api/ledger");
  assert.ok(entries.filter((e: any) => e.kind === "routine.ran").every((e: any) => !isQuietReply(e.text)));
});

test("actual token streams preserve completed near-matches, quotes and same-item cards while never previewing extracted markers", async t => {
  const f = await quietFixture(t), b = await f.bot();
  for (const text of ["Q", "QUI", "Query complete", "QUIET is the internal word.", '`QUIET`', '"QUIET"', '```text\nQUIET\n```', " ".repeat(80) + "A real report", '```bloks\n{"kind":"quote","text":"A real card"}\n```\nQUIET', 'QUIET\n```bloks\n{"kind":"quote","text":"Another real card"}\n```']) {
    const at = f.frames.length; f.setAnswer(text); await f.send(b);
    const rows = output(f.frames.slice(at)).filter(x => x.kind === "message").map(x => x.message);
    const card = text.includes('"kind":"quote"');
    assert.equal(markers(rows).length, 0);
    if (card) { assert.ok(rows.some(m => m.kind === "component" && m.component.kind === "quote")); assert.ok(!rows.some(m => m.text === noAnswer)); }
    else assert.ok(rows.some(m => m.kind === "text" && m.text === text.trim()), text);
    const runtime = f.frames.slice(at).filter(x => x.kind === "runtime");
    assert.ok(!runtime.some(x => isQuietReply(x.event?.delta)), "transient marker preview");
    let member: Record<string, string> = {};
    for (const frame of f.frames.slice(at)) {
      member = foldRuntime(member, frame);
      assert.ok(!Object.values(member).some(isQuietReply), "assembled transient marker preview");
    }
    assert.deepEqual(member, {}, "member preview stayed after authoritative output");
  }
});

test("watcher and webhook marker-only outcomes do not reuse the previous turn's answer; workflow keeps raw value but no marker summary", async t => {
  const f = await quietFixture(t);
  for (const kind of ["watcher", "webhook", "workflow"]) {
    const b = await f.bot(); f.setAnswer("Older answer"); await f.send(b);
    await f.h.json(`/api/bots/${b.id}/tasks/${b.threadId}`, request("PATCH", { unread: false }));
    let workflow: any;
    if (kind === "workflow") {
      ({ workflow } = await f.h.json("/api/workflows", request("POST", { name: "Fixture", trigger: { kind: "manual" }, steps: [{ id: "inspect", action: "ask", targetId: b.id, text: "Inspect fixture" }] })));
      await f.h.json(`/api/workflows/${workflow.id}/run`, request("POST", {}));
      assert.ok(await waitFor(async () => (await f.h.json("/api/workflows")).workflows.find((w: any) => w.id === workflow.id)?.runs?.[0]?.state === "done"));
      b.threadId = (await f.h.json("/api/bots")).bots.find((x: any) => x.id === b.id).tasks.find((x: any) => x.title === "Workflows").id;
      await f.h.json(`/api/bots/${b.id}/tasks/${b.threadId}`, request("PATCH", { unread: false }));
    }
    f.setAnswer("QUIET"); const at = f.frames.length;
    if (kind === "watcher") {
      let text = "baseline";
      const site = createServer((_req, res) => res.end(`<p>${text}</p>`));
      await new Promise<void>(r => site.listen(0, "127.0.0.1", r)); t.after(() => { site.closeAllConnections(); site.close(); });
      const { watcher } = await f.h.json("/api/watchers", request("POST", { kind: "page", target: `http://127.0.0.1:${(site.address() as { port: number }).port}`, botId: b.id, instruction: "Inspect the fixture result", every: 1440 }));
      assert.ok(watcher); assert.ok(await waitFor(async () => (await f.h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck));
      text = "changed";
      assert.equal((await f.h.json(`/api/watchers/${watcher.id}/check`, request("POST"))).fired, true);
    }
    else if (kind === "webhook") {
      const { webhook } = await f.h.json("/api/webhooks", request("POST", { botId: b.id, name: "Neutral input" }));
      assert.equal((await f.h.fetch(`/hook/${webhook.token}`, request("POST", { event: "fixture" }))).status, 202);
    } else {
      await f.h.json(`/api/workflows/${workflow.id}/run`, request("POST", {}));
      assert.ok(await waitFor(async () => (await f.h.json("/api/workflows")).workflows.find((w: any) => w.id === workflow.id)?.runs?.[0]?.state === "done"));
      const run = (await f.h.json("/api/workflows")).workflows.find((w: any) => w.id === workflow.id).runs[0];
      assert.equal(run.values.inspect.text, "QUIET"); assert.equal(run.steps[0].summary, undefined);
    }
    assert.ok(await waitFor(() => f.frames.slice(at).some(x => x.event?.threadId === b.threadId && x.event?.type === "turn.completed")), `${kind}: ${f.h.logs()}`);
    assert.ok(await idle(f.h, b));
    const current = f.frames.slice(at).filter(x => x.threadId === b.threadId || x.event?.threadId === b.threadId);
    assert.equal(output(current).filter(x => x.kind === "reply.settled").length, 0);
    assert.equal((await lane(f, b)).unread, false);
    assert.ok(!current.some(x => isQuietReply(x.message?.text) || isQuietReply(x.event?.delta)));
  }
});

test("manual solo and room routines get exactly one honest outcome, without storing the marker", async t => {
  const f = await quietFixture(t);
  for (const targetKind of ["agent", "room"]) {
    const b = await f.bot("First");
    const other = targetKind === "room" ? await f.bot("Second") : null;
    const room = other ? (await f.h.json("/api/bloks", request("POST", { name: "Fixture room", memberIds: [b.id, other.id] }))).blok : null;
    if (other) assert.ok(room);
    const { routine } = await f.h.json("/api/routines", request("POST", { targetKind, targetId: room?.id ?? b.id, prompt: "@First inspect fixture", time: "23:59", days: [], enabled: false }));
    const at = f.frames.length; await f.h.json(`/api/routines/${routine.id}/run`, request("POST", {}));
    assert.ok(await waitFor(() => f.frames.slice(at).some(x => x.kind === "message" && x.message?.text === noAnswer)));
    assert.ok(await idle(f.h, b));
    const rows = room ? (await f.h.json("/api/bloks")).bloks.find((x: any) => x.id === room.id).messages : await f.messages(b);
    assert.equal(markers(rows).length, 0); assert.equal(rows.filter((m: any) => m.text === noAnswer).length, 1);
  }
});

test("the requested no-answer notice records a failed manual run without buying an incident turn", async t => {
  const f = await quietFixture(t), lead = await f.bot("Fixture lead"), worker = await f.bot("Fixture worker");
  await f.h.json("/api/config", request("PUT", { incidents: { enabled: true, lead: lead.id } }));
  const { routine } = await f.h.json("/api/routines", request("POST", { targetKind: "agent", targetId: worker.id, prompt: "Inspect fixture", time: "23:59", days: [], enabled: false }));
  await f.h.json(`/api/routines/${routine.id}/run`, request("POST", {}));
  assert.ok(await waitFor(async () => (await f.h.json("/api/routines")).routines[0].runs?.[0]?.state === "failed"));
  assert.ok(await idle(f.h, worker)); await new Promise(r => setTimeout(r, 350));
  assert.equal((await f.h.json("/api/incidents")).incidents.length, 0, "honest no-answer outcome started an incident");
  assert.equal(f.calls.length, 1, "honest no-answer outcome dispatched another model turn");
  assert.equal((await f.messages(worker)).filter(m => m.text === noAnswer).length, 1);
});
