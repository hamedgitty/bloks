import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";
import { foldTurns } from "../src/lib/turnFold.ts";

// These are fake native notifications, not a provider or installed-child run.
// The fake's internal receipt proves sequencing only: Codex, not this driver,
// implements actual native tool-result delivery.
test("selected-thread text alone reaches HTTP history, saved messages and SSE through completion", async t => {
  const home = mkdtempSync(join(tmpdir(), "bloks-child-output-"));
  mkdirSync(join(home, ".bloks"));
  const cli = join(home, "fake-codex.mjs");
  const receiptFile = join(home, "receipts.jsonl");
  writeFileSync(receiptFile, "");
  writeFileSync(cli, String.raw`#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") { console.log("codex-cli 0.162.1"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const out = x => process.stdout.write(JSON.stringify(x) + "\n");
const thread = "parent-thread", turn = "native-turn";
const item = (threadId, id, text, phase) => out({ method: "item/completed", params: {
  threadId, turnId: turn, item: { type: "agentMessage", id, text, phase, memoryCitation: null },
} });
const receipt = x => appendFileSync(${JSON.stringify(receiptFile)}, JSON.stringify(x) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = result => out({ id: m.id, result });
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sample model", isDefault: true }] });
  if (m.method === "thread/start" || m.method === "thread/resume") return reply({ thread: { id: thread } });
  if (m.method !== "turn/start") return reply({});
  const input = m.params.input.filter(x => x.type === "text").map(x => x.text).join(" ");
  const mode = /SCENE_(full|commentary|childonly|empty)/.exec(input)[1];
  reply({ turn: { id: turn } });
  out({ method: "turn/started", params: { threadId: thread, turn: { id: turn } } });
  for (const native of [thread, "child-thread"]) out({ method: "item/agentMessage/delta", params: {
    threadId: native, turnId: turn, itemId: "shared", delta: "RAW_DELTA_MUST_STAY_IGNORED",
  } });
  if (mode !== "empty") item("child-thread", "shared", "RAW_CHILD_BEFORE", "final_answer");
  if (mode === "full" || mode === "commentary") item(thread, "shared", "Checking the sample.", "commentary");
  if (mode !== "empty") {
    item("child-thread", "shared", "RAW_CHILD_AFTER_COMMENTARY", "final_answer");
    item("other-child", undefined, "RAW_CHILD_UNKNOWN_PHASE", "future_phase");
  }
  if (mode === "full") {
    const result = { finding: "two sections" };
    receipt({ stage: "native-tool-result", result });
    const summary = "The sample has " + result.finding + ".";
    receipt({ stage: "parent-response", text: summary });
    item(thread, "summary", summary, "final_answer");
    item("child-thread", "summary", "RAW_CHILD_AFTER_PARENT", "final_answer");
  }
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turn, status: "completed" } } });
});
`, { mode: 0o755 });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    compaction: { idle: false, beforeTurn: 0 },
    instances: { codex: { driver: "codex", config: { cli } } },
  }));
  const h = await startHarness({ HOME: home, CODEX_HOME: join(home, ".codex") });
  const abort = new AbortController();
  let pumping: Promise<void> | undefined;
  t.after(async () => { abort.abort(); await pumping; await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const response = await h.fetch("/api/events", { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const frames: any[] = [];
  pumping = (async () => {
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += new TextDecoder().decode(value);
        let i: number;
        while ((i = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, i); pending = pending.slice(i + 2);
          const data = frame.split("\n").find(l => l.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  assert.ok(await waitFor(() => frames.some(f => f.kind === "hello")), "SSE must be connected");
  const results = new Map<string, any[]>();
  for (const mode of ["full", "commentary", "childonly", "empty"]) {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Output fixture" }) });
    assert.ok((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) })).ok);
    assert.ok((await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `SCENE_${mode}` }) })).ok);
    assert.ok(await waitFor(() => frames.some(f => f.kind === "runtime" && f.event.threadId === bot.threadId && f.event.type === "turn.completed" && f.event.ok)), h.logs());
    assert.ok(await idle(h, bot), h.logs());
    const { messages } = await h.json(`/api/bots/${bot.id}/messages?limit=100`);
    const saved = JSON.parse(readFileSync(join(home, ".bloks", `messages-${bot.threadId}.json`), "utf8"));
    assert.deepEqual(messages, saved, "HTTP history and saved rows must agree through terminal completion");
    results.set(mode, messages);
    const laneFrames = frames.filter(f => f.threadId === bot.threadId || f.event?.threadId === bot.threadId);
    assert.doesNotMatch(JSON.stringify(laneFrames), /RAW_CHILD_|RAW_DELTA_/, "child text must reach neither previews nor message frames");
    assert.doesNotMatch(JSON.stringify(saved), /RAW_CHILD_|RAW_DELTA_/);
    const texts = messages.filter((m: any) => m.role === "bot" && m.kind === "text");
    const events = laneFrames.filter(f => f.kind === "runtime" && (f.event.type === "content.delta" || (f.event.type === "item.completed" && f.event.itemType === "assistant_text"))).map(f => f.event);
    const expected = mode === "full" ? ["Checking the sample.", "The sample has two sections."] : mode === "commentary" ? ["Checking the sample."] : [];
    assert.deepEqual(texts.filter((m: any) => m.codexText).map((m: any) => m.text), expected, "parent text must survive, including commentary-only fallback");
    assert.equal(events.length, expected.length * 2, "exactly one preview/completion pair per parent item");
    assert.deepEqual(events.map(e => [e.itemId, e.codexItem.phase]), expected.flatMap((_, i) => [[i ? "summary" : "shared", i ? "final_answer" : "commentary"], [i ? "summary" : "shared", i ? "final_answer" : "commentary"]]));
    for (const message of texts.filter((m: any) => m.codexText)) assert.ok(laneFrames.some(f => f.kind === "message" && f.message.id === message.id), "parent-positive saved text must also arrive over SSE");
    if (mode === "commentary") {
      const visible = foldTurns(messages, false).rows.flatMap(r => r.kind === "said" ? r.items.map(x => x.message.text) : []);
      assert.equal(visible.at(-1), "Checking the sample.", "child final must not displace the parent's terminal fallback");
    }
  }
  const botRows = (mode: string) => results.get(mode)!.filter(m => m.role === "bot").map(m => [m.kind, m.text ?? null]);
  assert.deepEqual(botRows("childonly"), botRows("empty"), "child-only text must have the unchanged empty-output outcome");
  const receipts = readFileSync(receiptFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(receipts, [
    { stage: "native-tool-result", result: { finding: "two sections" } },
    { stage: "parent-response", text: "The sample has two sections." },
  ]);
  abort.abort(); await pumping;
});
