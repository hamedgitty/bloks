// Transcript tails and the metadata-only agent list use the real HTTP route.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const metadata = ({ messages: _messages, olderMessages: _older, ...fields }: any) => fields;
const sameMetadata = (zero: any, all: any) => {
  assert.equal(zero.bots.length, all.bots.length);
  for (const bot of zero.bots) assert.deepEqual(bot.messages, []);
  assert.deepEqual(zero.bots.map(metadata), all.bots.map(metadata));
};

test("agent list tails preserve every agent's metadata", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-list-tail-"));
  let h: Harness | undefined;
  t.after(async () => { await h?.stop(); rmSync(home, { recursive: true, force: true }); });
  h = await startHarness({ HOME: home });
  const initial = (await h.json("/api/bots")).bots[0];
  await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Other" }) });
  await h.stop();
  const at = Date.now();
  const messages = [
    { id: randomUUID(), at: at - 3000, role: "user", kind: "text", text: "First message" },
    { id: randomUUID(), at: at - 2000, role: "bot", kind: "text", text: "Second message" },
    { id: randomUUID(), at: at - 1000, role: "user", kind: "text", text: "Third message" },
    { id: randomUUID(), at: at - 500, role: "bot", kind: "text", text: "Last reply" },
    { id: randomUUID(), at, role: "bot", kind: "notice", text: "Context compacted",
      compaction: { before: 80_000, after: null } },
  ];
  writeFileSync(join(home, ".bloks", `messages-${initial.threadId}.json`), JSON.stringify(messages));
  h = await startHarness({ HOME: home });
  const all = await h.json("/api/bots");

  await t.test("zero returns no messages for every agent and keeps the last reply time behind a compaction", async () => {
    const zero = await h!.json("/api/bots?messages=0");
    sameMetadata(zero, all);
    const bot = zero.bots.find((b: any) => b.id === initial.id);
    assert.equal(bot.tasks[0].state, "idle");
    assert.equal(bot.tasks[0].lastAt, messages[3].at);
  });
  await t.test("fractional tails below one and negative zero return no messages", async () => {
    for (const value of ["0.5", "-0"]) {
      sameMetadata(await h!.json("/api/bots?messages=" + value), all);
    }
  });
  await t.test("one and three return the newest one and three messages", async () => {
    for (const count of [1, 3]) {
      const listed = await h!.json("/api/bots?messages=" + count);
      const bot = listed.bots.find((b: any) => b.id === initial.id);
      assert.deepEqual(bot.messages, messages.slice(-count));
      assert.deepEqual(listed.bots.map(metadata), all.bots.map(metadata));
    }
  });
  await t.test("missing, empty and invalid tails retain all local messages", async () => {
    for (const query of ["", "?messages=", "?messages=-1", "?messages=NaN", "?messages=Infinity", "?messages=abc"]) {
      const listed = await h!.json("/api/bots" + query);
      assert.deepEqual(listed, all, query);
    }
  });
  await t.test("new and cleared conversations keep their complete metadata", async () => {
    await h!.json(`/api/bots/${initial.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "Empty conversation" }),
    });
    const zero = await h!.json("/api/bots?messages=0");
    sameMetadata(zero, await h!.json("/api/bots"));
    const bot = zero.bots.find((b: any) => b.id === initial.id);
    const empty = bot.tasks.find((task: any) => task.title === "Empty conversation");
    assert.equal(empty.state, "idle");
    assert.equal(empty.lastAt, empty.createdAt);

    await h!.json(`/api/bots/${initial.id}/tasks/${initial.threadId}/clear`, { method: "POST" });
    const after = await h!.json("/api/bots?messages=0");
    sameMetadata(after, await h!.json("/api/bots"));
    const cleared = after.bots.find((b: any) => b.id === initial.id);
    const general = cleared.tasks.find((task: any) => task.id === initial.threadId);
    assert.equal(general.state, "idle");
    assert.equal(general.lastAt, general.createdAt);
    assert.notEqual(general.lastAt, messages[3].at);
  });
});

test("zero-message metadata follows working turns, live questions and workflow gates", async (t) => {
  const provider = await fakeProvider(t);
  provider.state.askOn = "LIST-QUESTION";
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, provider.port, "Questioner");
  const compare = async (state: string, lastAt?: number) => {
    const zero = await h.json("/api/bots?messages=0");
    sameMetadata(zero, await h.json("/api/bots"));
    const lane = zero.bots.find((b: any) => b.id === bot.id).tasks.find((task: any) => task.id === bot.threadId);
    assert.equal(lane.state, state);
    if (lastAt !== undefined) assert.equal(lane.lastAt, lastAt);
  };

  await t.test("a working turn keeps its state and lastAt", async () => {
    await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LIST-WORK" }) });
    assert.ok(await waitFor(() => provider.state.held.length), "the provider did not hold the turn");
    const last = (await messagesOf(h, bot)).at(-1);
    try {
      await compare("working", last.at);
    } finally {
      provider.state.held.shift()!();
      assert.ok(await idle(h, bot), "the working turn did not finish");
    }
  });
  await t.test("a live request and its answer keep the same state and lastAt", async () => {
    provider.state.answerAtOnce = true;
    await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LIST-QUESTION" }) });
    const question = await waitFor(async () => (await messagesOf(h, bot)).find((message) => message.card?.requestId));
    assert.ok(question, "no live question reached the lane");
    await compare("needs-you", question.at);
    await h.json(`/api/bots/${bot.id}/respond`, {
      method: "POST", body: JSON.stringify({ requestId: question.card.requestId, behavior: "answer", message: "Yes" }),
    });
    assert.ok(await idle(h, bot), "the answered turn did not finish");
    await compare("idle");
  });
  await t.test("a workflow gate and its dismissal keep the same state and lastAt", async () => {
    const { workflow } = await h.json("/api/workflows", {
      method: "POST", body: JSON.stringify({ name: "List gate", trigger: { kind: "manual" },
        steps: [{ id: "gate", action: "approve", text: "Proceed?", targetId: bot.id, timeoutMin: 120 }] }),
    });
    const { run } = await h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
    const gate = await waitFor(async () => (await messagesOf(h, bot)).find((message) => message.card?.runId === run.id));
    assert.ok(gate, "no live workflow gate reached the lane");
    await compare("needs-you", gate.at);
    await h.json(`/api/bots/${bot.id}/cards/${gate.id}`, { method: "PATCH", body: JSON.stringify({ dismissed: true }) });
    await compare("idle", gate.at);
    await h.json(`/api/workflows/runs/${run.id}/answer`, { method: "POST", body: JSON.stringify({ answer: "Approve" }) });
    await h.fetch(`/api/workflows/${workflow.id}`, { method: "DELETE" });
  });
});
