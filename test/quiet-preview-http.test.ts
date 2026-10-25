// The actual forwarding, replay and commit paths, with a local model
// stream held open independently from each delta.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { quietPreviewFixture, nativePreviewFixture, post, previewText } from "./helpers/quiet-preview.ts";
import { waitFor } from "./helpers/turns.ts";

const pause = () => new Promise(resolve => setTimeout(resolve, 150));
const ended = (frames: any[], lane: string) => frames.some(frame => frame.event?.threadId === lane && frame.event?.type === "turn.completed");

test("unasked webhook marker stays out of live and replay previews while settled history still omits it", async t => {
  const f = await quietPreviewFixture(t), bot = await f.bot();
  const fire = await f.webhook(bot), live = await f.stream();
  const since = live.frames.at(-1)._seq ?? 0;
  await fire();
  const call = await f.call(0);
  for (const chunk of ["Q", "UI", "ET", ".", "\n"]) {
    call.delta(chunk);
    await pause();
    assert.equal(previewText(live.frames, bot.threadId), "", "silent marker escaped live preview before completion");
    assert.equal(ended(live.frames, bot.threadId), false, "completion was not held");
  }
  call.finish();
  assert.ok(await f.idle(bot), f.h.logs());
  assert.ok(await waitFor(() => ended(live.frames, bot.threadId)), "turn completion missing");
  const replay = await f.stream(`/api/events?since=${since}`);
  assert.ok(await waitFor(() => ended(replay.frames, bot.threadId)), "replay completion missing");
  assert.equal(replay.frames[0].resumed, true);
  assert.equal(previewText(replay.frames, bot.threadId), "", "silent marker escaped replay preview");
  assert.ok(!(await f.messages(bot)).some(row => row.role === "bot" && /^quiet\.\s*$/i.test(row.text)), "unasked marker was saved");
  const stored = JSON.parse(readFileSync(join(f.h.home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
  assert.ok(!stored.some((row: any) => row.role === "bot" && /^quiet\.\s*$/i.test(row.text)), "disk history saved the marker");
});

test("the first disambiguating token releases real text before completion, and incomplete Q/QUI are authoritative ordinary replies", async t => {
  const f = await quietPreviewFixture(t), bot = await f.bot();
  const fire = await f.webhook(bot), live = await f.stream();
  const cases = [
    ["QUI", "ET is an ordinary word in this report."],
    ['"', 'QUIET" is quoted.'],
    ["`", "QUIET` is a code word."],
    ["[", "QUIET] is a bracketed label."],
    ["é", "tage is ready."],
    ["😀", " Ready."],
    ["Q", ""], ["QUI", ""],
  ];
  for (let index = 0; index < cases.length; index++) {
    const [first, rest] = cases[index], at = live.frames.length;
    await fire(`ordinary-${index}`);
    const call = await f.call(index);
    call.delta(first);
    if (index === 0 || index >= 6) {
      await pause();
      assert.equal(previewText(live.frames.slice(at), bot.threadId), "", "an ambiguous prefix was prematurely forwarded");
    } else {
      assert.ok(await waitFor(() => previewText(live.frames.slice(at), bot.threadId) === first), "ordinary leading token waited for completion");
    }
    if (rest) {
      call.delta(rest);
      assert.ok(await waitFor(() => previewText(live.frames.slice(at), bot.threadId) === first + rest), "ordinary text waited for completion");
      assert.equal(ended(live.frames.slice(at), bot.threadId), false, "fixture completion was not held");
    }
    call.finish();
    assert.ok(await f.idle(bot), f.h.logs());
    assert.ok((await f.messages(bot)).some(row => row.role === "bot" && row.text === first + rest), "authoritative ordinary answer was lost");
  }
});

test("manual quiet routine retains success, quiet history, folded attention and raw run protocol", async t => {
  const f = await quietPreviewFixture(t), bot = await f.bot(), live = await f.stream();
  const { routine } = await f.h.json("/api/routines", post({ targetKind: "agent", targetId: bot.id, name: "Neutral check", prompt: "Inspect the neutral fixture", days: [], every: 30 }));
  await f.h.fetch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const before = (await f.h.json("/api/bots")).bots.find((row: any) => row.id === bot.id).tasks.find((row: any) => row.id === bot.threadId);
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post())).status, 202);
  const call = await f.call(0);
  call.delta("QUIET"); await pause();
  assert.equal(previewText(live.frames, bot.threadId), "");
  assert.equal(ended(live.frames, bot.threadId), false);
  call.finish();
  assert.ok(await f.idle(bot));
  const ran: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((row: any) => row.id === routine.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.equal(ran.runs[0].state, "ok");
  assert.equal(ran.runs[0].quiet, true);
  assert.equal(ran.runs[0].summary, undefined);
  assert.equal(ran.lastReport, undefined);
  const messages = await f.messages(bot), answer = messages.find(row => row.role === "bot" && row.text === "QUIET");
  assert.equal(answer?.quiet, true, "manual run must keep baseline quiet-marked saved answer");
  assert.ok(messages.find(row => row.role === "user")?.routine?.manual);
  const after = (await f.h.json("/api/bots")).bots.find((row: any) => row.id === bot.id).tasks.find((row: any) => row.id === bot.threadId);
  assert.equal(Boolean(after.unread), false);
  assert.equal(after.lastAt, before.lastAt);
  assert.ok(!(await f.h.json("/api/ledger")).entries.some((entry: any) => entry.kind === "routine.ran"));
  const savedFrame = live.frames.filter(frame => frame.kind === "message" && frame.message?.id === answer.id);
  assert.equal(savedFrame.length, 1);
  assert.equal(savedFrame[0].message.quiet, true);
});

test("person literal QUIET and a nonquiet timed routine retain immediate preview and ordinary settlement", async t => {
  const f = await quietPreviewFixture(t), bot = await f.bot(), live = await f.stream();
  await f.person(bot, "Say the literal word QUIET");
  const first = await f.call(0); first.delta("QUIET");
  assert.ok(await waitFor(() => previewText(live.frames, bot.threadId) === "QUIET"), "person literal was overfiltered");
  assert.equal(ended(live.frames, bot.threadId), false);
  first.finish(); assert.ok(await f.idle(bot));
  assert.ok((await f.messages(bot)).some(row => row.role === "bot" && row.text === "QUIET" && !row.quiet));
  const at = live.frames.length;
  const { routine } = await f.h.json("/api/routines", post({ targetKind: "agent", targetId: bot.id, name: "Timed report", prompt: "Report", days: [], time: "23:59" }));
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post())).status, 202);
  const second = await f.call(1); second.delta("QUIET");
  assert.ok(await waitFor(() => previewText(live.frames.slice(at), bot.threadId) === "QUIET"), "nonquiet routine was overfiltered");
  assert.equal(ended(live.frames.slice(at), bot.threadId), false);
  second.finish(); assert.ok(await f.idle(bot));
  const ran: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((row: any) => row.id === routine.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.equal(ran.runs[0].state, "ok");
  assert.equal(ran.runs[0].quiet, undefined);
  assert.ok((await f.messages(bot)).filter(row => row.role === "bot" && row.text === "QUIET").every(row => !row.quiet));
});

test("overlapping webhook lanes classify and settle independently", async t => {
  const f = await quietPreviewFixture(t), bot = await f.bot(), live = await f.stream();
  const silent = await f.webhook(bot, "Silent fixture"), ordinary = await f.webhook(bot, "Report fixture");
  await silent("silent-lane"); const one = await f.call(0);
  await ordinary("report-lane"); const two = await f.call(1);
  const tasks = (await f.h.json("/api/bots")).bots.find((row: any) => row.id === bot.id).tasks;
  const quietLane = tasks.find((row: any) => row.title === "Silent fixture").id;
  const reportLane = tasks.find((row: any) => row.title === "Report fixture").id;
  one.delta("QUI"); two.delta("QUI"); await pause();
  assert.equal(previewText(live.frames, quietLane), "");
  assert.equal(previewText(live.frames, reportLane), "");
  two.delta("ET is quoted in the report.");
  assert.ok(await waitFor(() => previewText(live.frames, reportLane) === "QUIET is quoted in the report."));
  one.delta("ET"); await pause();
  assert.equal(previewText(live.frames, quietLane), "");
  assert.equal(ended(live.frames, reportLane), false);
  one.finish(); two.finish(); assert.ok(await f.idle(bot));
  assert.ok(!(await f.messages({ ...bot, threadId: quietLane })).some(row => row.role === "bot" && row.text === "QUIET"));
  assert.ok((await f.messages({ ...bot, threadId: reportLane })).some(row => row.role === "bot" && row.text === "QUIET is quoted in the report."));
});

test("accepted person steering makes an unasked native turn requested, while refused steering keeps the current turn silent", async t => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  await f.fire(); await f.called("turn/start", 1);
  await f.delta("QU"); await pause();
  assert.equal(previewText(live, f.bot.threadId), "");
  const accepted = await f.say("Show me the literal word");
  assert.equal(accepted.steered, true, JSON.stringify(accepted));
  await f.delta("IET");
  assert.ok(await waitFor(() => previewText(live, f.bot.threadId) === "QUIET"), "accepted person steering did not release subsequent literal marker");
  assert.equal(ended(live, f.bot.threadId), false);
  f.finish("QUIET"); await f.settled();
  assert.ok((await f.messages()).some(row => row.role === "bot" && row.text === "QUIET"));
  assert.equal(previewText(live, f.bot.threadId), "QUIET", "held prefix or later authoritative delta was duplicated");
  const replay = await f.stream("/api/events?since=0");
  assert.ok(await waitFor(() => ended(replay, f.bot.threadId)));
  assert.equal(previewText(replay, f.bot.threadId), "QUIET", "replay did not preserve exact ordered held-prefix flush");

  f.reset(); f.spec({ refuseSteer: true });
  const at = live.length;
  await f.fire(); await f.called("turn/start", 2);
  await f.delta("QU"); await pause();
  const refused = await f.say("Wait for my own turn");
  assert.notEqual(refused.steered, true, JSON.stringify(refused));
  await f.delta("IET"); await pause();
  assert.equal(previewText(live.slice(at), f.bot.threadId), "", "queued person words changed the current unasked preview");
  f.finish("QUIET");
  // Refused words legitimately start a later requested turn. Reset its
  // action log before that new process reads the finished turn's gates.
  // The old turn has already read finish synchronously before start is
  // sent; wait for native completion through SSE, then release the next.
  assert.ok(await waitFor(() => ended(live.slice(at), f.bot.threadId)));
  f.reset();
  await f.called("turn/start", 3);
  f.finish("The later requested answer."); await f.settled();
  assert.ok((await f.messages()).some(row => row.role === "bot" && row.text === "The later requested answer."));
});

test("accepted steering keeps quiet check-in preview eligibility and baseline requested settlement", async t => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  const { routine } = await f.post("/api/routines", { targetKind: "agent", targetId: f.bot.id, name: "Native quiet progress", prompt: "Inspect neutral records", days: [], every: 30 });
  await f.h.fetch(`/api/bots/${f.bot.id}/tasks/${f.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  const response = await f.h.fetch(`/api/routines/${routine.id}/run`, post()); assert.equal(response.status, 202);
  await f.called("turn/start", 1);
  await f.delta("QU"); await pause();
  const accepted = await f.say("Keep checking"); assert.equal(accepted.steered, true);
  await f.delta("IET"); await pause();
  assert.equal(previewText(live, f.bot.threadId), "", "person steering disabled check-in suppression");
  assert.equal(ended(live, f.bot.threadId), false);
  f.finish("QUIET"); await f.settled();
  const ran: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((row: any) => row.id === routine.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.equal(ran.runs[0].state, "ok");
  assert.equal(ran.runs[0].quiet, undefined, "baseline treats the joined run as requested at settlement");
  const rows = await f.messages();
  assert.ok(rows.some(row => row.role === "bot" && row.text === "QUIET" && row.quiet), "check-in marker remains quiet-marked even when the joined run is requested");
});

test("unjoined quiet run folds earlier authoritative progress and retains successful raw state", async t => {
  const f = await nativePreviewFixture(t), live = await f.stream();
  const { routine } = await f.post("/api/routines", { targetKind: "agent", targetId: f.bot.id, name: "Native quiet progress", prompt: "Inspect neutral records", days: [], every: 30 });
  await f.h.fetch(`/api/bots/${f.bot.id}/tasks/${f.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post())).status, 202);
  await f.called("turn/start", 1);
  f.complete("Checking the neutral records.", "progress");
  assert.ok(await waitFor(() => previewText(live, f.bot.threadId) === "Checking the neutral records."));
  f.finish("QUIET"); await f.settled();
  const ran: any = await waitFor(async () => {
    const row = (await f.h.json("/api/routines")).routines.find((row: any) => row.id === routine.id);
    return row?.runs?.[0]?.state !== "running" ? row : null;
  });
  assert.equal(ran.runs[0].state, "ok"); assert.equal(ran.runs[0].quiet, true);
  const rows = await f.messages();
  assert.ok(rows.some(row => row.role === "bot" && row.text === "Checking the neutral records." && row.quiet), "saved progress did not fold into the quiet run");
  assert.ok(rows.filter(row => row.role === "bot" && row.text === "QUIET").every(row => row.quiet));
  assert.equal(Boolean((await f.current()).tasks.find((row: any) => row.id === f.bot.threadId).unread), false);
});
