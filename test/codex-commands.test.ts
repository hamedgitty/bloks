import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { RuntimeEvent } from "../server/contracts.ts";
import { CodexDriver } from "../server/drivers/codex.ts";

type Script = { compact?: "reject" | "failed" | "error" | "hold"; resume?: "reject" | "forgotten" | "legacy"; resumeFallbackFails?: boolean; skills?: "reject" | "hold"; late?: boolean; holdTurn?: boolean; onTurn?: (send: (frame: unknown) => void, thread: string) => void };
async function setup(t: TestContext, script: Script = {}) {
  const frames: any[] = [], children: any[] = [], native: any[] = [];
  const thread = "native-" + crypto.randomUUID();
  const rows = Array.from({ length: 20 }, (_, i) => ({ name: "skill-" + i, description: "Skill", path: `/PRIVATE/${i}/SKILL.md`, enabled: true }));
  t.mock.method(fs, "mkdirSync", () => undefined);
  t.mock.method(fs, "appendFileSync", (_path: unknown, data: unknown) => { native.push(JSON.parse(String(data))); });
  t.mock.method(childProcess, "spawn", (_cli: unknown, _args: unknown, options: any) => {
    const stdout = new PassThrough();
    const send = (frame: unknown) => stdout.write(JSON.stringify(frame) + "\n");
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), options, killed: false,
      kill() { this.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; },
      stdin: new Writable({ write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk)); frames.push({ ...frame, child: children.length - 1 });
        const reply = (result: unknown) => send({ id: frame.id, result });
        const refuse = (message: string) => send({ id: frame.id, error: { code: -32601, message } });
        if (frame.id !== undefined && frame.method) queueMicrotask(() => {
          if (frame.method === "model/list") return reply({ data: [] });
          if (frame.method === "skills/list") {
            if (script.skills === "hold") return;
            if (script.skills === "reject") return refuse("skills unavailable /PRIVATE/CATALOG_PATH");
            return reply({ data: [{ cwd: frame.params.cwds[0], skills: rows, errors: [] }], PRIVATE_METADATA: "/PRIVATE/CATALOG_PATH" });
          }
          if (frame.method === "thread/resume") {
            if (script.resume === "reject") return refuse("conversation missing");
            if (script.resume === "legacy" && frame.params.excludeTurns) return refuse("unknown field excludeTurns");
            if (script.resumeFallbackFails) return refuse("conversation missing");
            return reply({ thread: { id: script.resume === "forgotten" ? "replacement" : thread } });
          }
          if (frame.method === "thread/start") return reply({ thread: { id: thread } });
          if (frame.method === "thread/compact/start") {
            if (script.compact === "reject") return refuse("compact refused");
            reply({});
            send({ method: "turn/started", params: { threadId: thread, turn: { id: "compact-turn" } } });
            if (script.compact === "hold") return;
            if (script.compact === "error") {
              send({ method: "error", params: { threadId: thread, turnId: "compact-turn", error: { message: "compact error" }, willRetry: false } });
              return send({ method: "turn/completed", params: { threadId: thread, turn: { id: "compact-turn", status: "failed", error: { message: "compact error" } } } });
            }
            const item = { threadId: thread, turnId: "compact-turn", item: { type: "contextCompaction", id: "manual-item" } };
            send({ method: "item/started", params: item });
            if (!script.late) send({ method: "item/completed", params: item });
            send({ method: "turn/completed", params: { threadId: thread, turn: { id: "compact-turn", status: script.compact === "failed" ? "failed" : "completed", error: { message: "compact failed" } } } });
            if (script.late) send({ method: "item/completed", params: item });
            send({ method: "thread/compacted", params: { threadId: thread } });
            return;
          }
          reply({});
          if (frame.method === "turn/start") {
            send({ method: "turn/started", params: { threadId: thread, turn: { id: "work-turn" } } });
            script.onTurn?.(send, thread);
            if (script.holdTurn) return;
            send({ method: "item/completed", params: { threadId: thread, turnId: "work-turn", item: { type: "agentMessage", id: "answer", text: "ANSWER" } } });
            send({ method: "turn/completed", params: { threadId: thread, turn: { id: "work-turn", status: "completed" } } });
          }
        });
        done();
      } }),
    });
    children.push(child);
    return child as any;
  });
  syncBuiltinESMExports();
  const instance = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true, environment: {}, config: { cli: "fake", fullAuto: false } });
  await instance.catalogReady;
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  t.after(async () => { await instance.dispose(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const spin = async () => { for (let i = 0; i < 35; i++) await setImmediate(); };
  return { frames, children, native, instance, events, thread, spin, async turn(extra: Record<string, unknown> = {}) {
    await instance.adapter.sendTurn({ threadId: "lane", text: "UNCHANGED_WORDS", cwd: "/repo", ...extra });
    await spin();
  } };
}

const calls = (h: Awaited<ReturnType<typeof setup>>, method: string) => h.frames.filter((f) => f.method === method);
const markers = (h: Awaited<ReturnType<typeof setup>>) => h.events.filter((e) => e.type === "context.compacted");

test("one short cached native menu probe covers concurrent clients, expires, and is folder/instance scoped", async (t) => {
  const h = await setup(t);
  const results = await Promise.all(Array.from({ length: 20 }, () => h.instance.skills!("/repo")));
  assert.ok(results.every((rows) => rows?.length === 20));
  assert.equal(calls(h, "skills/list").length, 1);
  assert.ok(h.children.every((c) => c.killed && !('OPENAI_API_KEY' in c.options.env)));
  const now = Date.now(); t.mock.method(Date, "now", () => now + 60_001);
  await h.instance.skills!("/repo"); await h.instance.skills!("/other");
  assert.equal(calls(h, "skills/list").length, 3);
  assert.equal(await h.instance.skills!("relative"), null);
  assert.equal(calls(h, "thread/start").length, 0);
});

test("named skill input is fresh, exact, deduplicated, capped and absent from catalog logs", async (t) => {
  const h = await setup(t);
  const names = ["UNKNOWN", "SKILL-0", "skill-0", "skill-0", ...Array.from({ length: 20 }, (_, i) => "skill-" + i)];
  await h.turn({ skillNames: names });
  const input = calls(h, "turn/start")[0].params.input;
  assert.deepEqual(input[0], { type: "text", text: "UNCHANGED_WORDS" });
  assert.equal(input.filter((i: any) => i.type === "skill").length, 16);
  assert.deepEqual(input[1], { type: "skill", name: "skill-0", path: "/PRIVATE/0/SKILL.md" });
  assert.doesNotMatch(JSON.stringify(h.native), /CATALOG_PATH|PRIVATE_METADATA|skills\/list/);
});

for (const mode of ["reject", "hold"] as const) test(`optional skill lookup ${mode} keeps unchanged words and no invented item`, async (t) => {
  if (mode === "hold") t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await setup(t, { skills: mode });
  await h.turn({ skillNames: ["skill-0"] });
  if (mode === "hold") { t.mock.timers.tick(20_000); await h.spin(); }
  assert.deepEqual(calls(h, "turn/start")[0].params.input, [{ type: "text", text: "UNCHANGED_WORDS" }]);
  assert.equal(h.events.filter((e) => e.type === "runtime.error").length, 0);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
});

test("ordinary words make no skill lookup", async (t) => {
  const h = await setup(t); await h.turn();
  assert.equal(calls(h, "skills/list").length, 0);
});

test("a turn's named-item budget and dedupe cover its later steers too", async (t) => {
  const h = await setup(t, { holdTurn: true });
  await h.turn({ skillNames: ["skill-0"] });
  await h.instance.adapter.steerTurn!("lane", "More skills", { skillNames: Array.from({ length: 20 }, (_, i) => "skill-" + i) });
  await h.instance.adapter.steerTurn!("lane", "Again", { skillNames: ["skill-0", "skill-19"] });
  const items = [...calls(h, "turn/start"), ...calls(h, "turn/steer")].flatMap((c) => c.params.input.filter((i: any) => i.type === "skill"));
  assert.equal(items.length, 16);
  assert.equal(new Set(items.map((i: any) => i.name)).size, 16);
});

for (const late of [false, true]) test(`explicit compact has one marker, no generation and late=${late}`, async (t) => {
  const h = await setup(t, { late });
  await h.turn({ compactOnly: true, resumeCursor: h.thread });
  assert.equal(calls(h, "thread/compact/start").length, 1);
  assert.equal(calls(h, "turn/start").length, 0);
  assert.equal(calls(h, "thread/start").length, 0);
  assert.equal(markers(h).length, 1);
  assert.ok(h.events.some((e) => e.type === "turn.completed" && e.ok));
  assert.equal(h.instance.adapter.hasSession("lane"), false);
});

for (const mode of ["no-cursor", "resume-rejected", "forgotten", "reject", "failed", "error", "timeout", "stop"] as const) test(`explicit compact ${mode} refuses once, keeps the cursor, frees the lane and never replaces`, async (t) => {
  if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
  const script: Script = mode === "resume-rejected" ? { resume: "reject" } : mode === "forgotten" ? { resume: "forgotten" } : mode === "timeout" || mode === "stop" ? { compact: "hold" } : mode === "reject" || mode === "failed" || mode === "error" ? { compact: mode } : {};
  const h = await setup(t, script);
  await h.turn({ compactOnly: true, ...(mode === "no-cursor" ? {} : { resumeCursor: h.thread }) });
  if (mode === "timeout") { t.mock.timers.tick(5 * 60_000); await h.spin(); }
  if (mode === "stop") { await h.instance.adapter.interruptTurn("lane"); await h.spin(); }
  assert.equal(calls(h, "thread/start").length, 0);
  assert.equal(calls(h, "turn/start").length, 0);
  assert.equal(h.events.filter((e) => e.type === "session.started").length, 0);
  assert.equal(markers(h).length, 0);
  assert.equal(h.events.filter((e) => e.type === "runtime.error").length, 1);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
  if (mode !== "no-cursor") assert.equal(calls(h, "thread/resume")[0].params.threadId, h.thread);
});

test("ordinary compactFirst still replaces on refusal and continues with a bounded handoff", async (t) => {
  const h = await setup(t, { compact: "reject" });
  await h.turn({ compactFirst: true, resumeCursor: h.thread, handoff: "BOUNDED_STORY $skill-0" });
  assert.equal(calls(h, "thread/start").length, 1);
  assert.deepEqual(calls(h, "turn/start")[0].params.input, [{ type: "text", text: "BOUNDED_STORY $skill-0" }]);
  assert.equal(calls(h, "skills/list").length, 0);
});

test("late manual items do not duplicate a pre-turn marker before ordinary generation", async (t) => {
  const h = await setup(t, { late: true });
  await h.turn({ compactFirst: true, resumeCursor: h.thread });
  assert.equal(markers(h).length, 1);
  assert.equal(calls(h, "turn/start").length, 1);
});

for (const mode of ["ordinary", "compactFirst", "compactOnly"] as const) test(`state-only resume keeps the legacy field fallback for ${mode}`, async (t) => {
  const h = await setup(t, { resume: "legacy" });
  await h.turn({ resumeCursor: h.thread, model: "picked-model", fullAccess: true, ...(mode === "ordinary" ? {} : { [mode]: true }) });
  const resumes = calls(h, "thread/resume");
  assert.equal(resumes.length, 2);
  assert.equal(resumes[0].params.excludeTurns, true);
  assert.ok(!("excludeTurns" in resumes[1].params));
  for (const { params } of resumes) {
    assert.equal(params.threadId, h.thread);
    assert.equal(params.model, "picked-model");
    assert.equal(params.sandbox, "danger-full-access");
    assert.equal(params.approvalPolicy, "never");
  }
  assert.equal(calls(h, "thread/start").length, 0);
  assert.equal(calls(h, "turn/start").length, mode === "compactOnly" ? 0 : 1);
  assert.equal(calls(h, "thread/compact/start").length, mode === "ordinary" ? 0 : 1);
  assert.equal(markers(h).length, mode === "ordinary" ? 0 : 1);
  assert.equal(h.events.filter((e) => e.type === "runtime.error").length, 0);
  assert.ok(h.events.some((e) => e.type === "turn.completed" && e.ok));
});

test("explicit compact refuses after the legacy resume fallback fails without opening a thread", async (t) => {
  const h = await setup(t, { resume: "legacy", resumeFallbackFails: true });
  await h.turn({ resumeCursor: h.thread, compactOnly: true });
  assert.equal(calls(h, "thread/resume").length, 2);
  assert.equal(calls(h, "thread/start").length, 0);
  assert.equal(calls(h, "turn/start").length, 0);
  assert.equal(calls(h, "thread/compact/start").length, 0);
  assert.equal(markers(h).length, 0);
  assert.equal(h.events.filter((e) => e.type === "runtime.error").length, 1);
  assert.equal(h.instance.adapter.hasSession("lane"), false);
});

test("an abandoned thread cannot change the current turn, reading, skill steer or automatic marker", async (t) => {
  const abandoned = "abandoned-thread";
  let finishTurn: (() => void) | undefined;
  const h = await setup(t, { resume: "reject", holdTurn: true, onTurn(send, thread) {
    const usage = (native: string, input: number, output: number) => ({ method: "thread/tokenUsage/updated", params: { threadId: native, tokenUsage: { total: { inputTokens: input, outputTokens: output }, last: { inputTokens: input, outputTokens: output }, modelContextWindow: 400000 } } });
    const item = (native: string) => ({ threadId: native, turnId: "work-turn", item: { type: "contextCompaction", id: "shared-item" } });
    send(usage(thread, 170000, 10));
    send({ method: "turn/started", params: { threadId: abandoned, turn: { id: "abandoned-turn" } } });
    send(usage(abandoned, 999999, 999));
    send({ method: "item/started", params: item(abandoned) });
    send({ method: "item/completed", params: item(abandoned) });
    send({ method: "item/completed", params: { threadId: abandoned, turnId: "abandoned-turn", item: { type: "agentMessage", id: "old-answer", text: "ABANDONED_ANSWER" } } });
    send({ method: "error", params: { threadId: abandoned, error: { message: "ABANDONED_ERROR" }, willRetry: false } });
    send({ method: "turn/completed", params: { threadId: abandoned, turn: { id: "abandoned-turn", status: "failed" } } });
    send({ method: "item/completed", params: item("foreign-thread") });
    send({ method: "item/started", params: item(thread) });
    send({ method: "item/completed", params: item(thread) });
    finishTurn = () => send({ method: "turn/completed", params: { threadId: thread, turn: { id: "work-turn", status: "completed" } } });
  } });
  await h.turn({ resumeCursor: abandoned });
  assert.equal(calls(h, "thread/start").length, 1);
  assert.equal(h.instance.adapter.hasSession("lane"), true);
  assert.equal(h.events.filter((e) => e.type === "turn.completed").length, 0);
  assert.equal(h.events.filter((e) => e.type === "runtime.error").length, 0);
  assert.doesNotMatch(JSON.stringify(h.events), /ABANDONED_/);
  assert.equal(h.events.filter((e) => e.type === "context.reading").length, 1);
  assert.equal(h.events.filter((e) => e.type === "context.reading")[0].used, 170000);
  const spent = h.events.filter((e) => e.type === "thread.token-usage.updated").at(-1);
  assert.ok(spent && spent.type === "thread.token-usage.updated");
  assert.equal(spent.input, 170000);
  assert.equal(spent.output, 10);
  assert.equal(markers(h).length, 1);
  const marker = markers(h)[0];
  assert.ok(marker.type === "context.compacted");
  assert.equal(marker.trigger, "auto");
  assert.equal(marker.before, 170000);
  assert.equal(marker.after, null);
  assert.equal(await h.instance.adapter.steerTurn!("lane", "$skill-0 next", { skillNames: ["skill-0"] }), true);
  const steer = calls(h, "turn/steer")[0].params;
  assert.equal(steer.threadId, h.thread);
  assert.equal(steer.expectedTurnId, "work-turn");
  assert.deepEqual(steer.input[1], { type: "skill", name: "skill-0", path: "/PRIVATE/0/SKILL.md" });
  assert.ok(finishTurn);
  finishTurn(); await h.spin();
  assert.ok(h.events.some((e) => e.type === "turn.completed" && e.ok));
});

test("automatic compaction is classified by native thread/turn, with no orphan or deprecated marker", async (t) => {
  const h = await setup(t, { onTurn(send, thread) {
    const item = (id: string, native = thread) => ({ threadId: native, turnId: "work-turn", item: { type: "contextCompaction", id } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: { inputTokens: 170000, outputTokens: 10 }, last: { inputTokens: 170000, outputTokens: 10 }, modelContextWindow: 400000 } } });
    send({ method: "item/started", params: item("orphan") });
    send({ method: "item/started", params: item("auto") });
    send({ method: "item/completed", params: item("auto") });
    send({ method: "item/completed", params: item("auto") });
    send({ method: "thread/compacted", params: { threadId: thread } });
    send({ method: "item/completed", params: item("foreign", "another-thread") });
    send({ method: "item/completed", params: item("without-start") });
    send({ method: "thread/tokenUsage/updated", params: { threadId: thread, tokenUsage: { total: { inputTokens: 200000, outputTokens: 20 }, last: { inputTokens: 30000, outputTokens: 10 }, modelContextWindow: 400000 } } });
  } });
  await h.turn();
  assert.equal(markers(h).length, 2);
  assert.ok(markers(h).every((e) => e.type === "context.compacted" && e.trigger === "auto" && e.before === 170000 && e.after === null));
  assert.equal(h.events.filter((e) => e.type === "context.reading").at(-1)?.used, 30000);
  assert.equal(h.events.filter((e) => e.type === "thread.token-usage.updated").at(-1)?.input, 200000);
  assert.ok(h.events.some((e) => e.type === "turn.completed" && e.ok));
});

test("the completed compaction id set is bounded without forgetting a replay", async (t) => {
  const h = await setup(t, { onTurn(send, thread) {
    const item = (id: string) => ({ threadId: thread, turnId: "work-turn", item: { type: "contextCompaction", id } });
    for (let i = 0; i < 300; i++) send({ method: "item/completed", params: item(String(i)) });
    send({ method: "item/completed", params: item("0") });
  } });
  await h.turn(); assert.equal(markers(h).length, 256);
});
