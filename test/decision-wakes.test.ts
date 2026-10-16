// A workflow approval is a real decision, with the same card before and
// after its answer. The phone here is a synthetic loopback relay client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chainRelay } from "./helpers/chain-relay.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";
import { alertWorkspace } from "./helpers/alert-workspace.ts";

for (const answer of ["Approve", "Decline"]) {
  test(`a workflow gate wakes with its question, and ${answer} settles the card it opens`, async (t) => {
    const h = await startHarness();
    t.after(() => h.stop());
    const pushes: Array<{ frames: any[]; wake: unknown }> = [];
    const previews = await chainRelay(t, h, pushes);
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Editor" }) });
    const { workflow } = await h.json("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: "Draft review", trigger: { kind: "manual" }, steps: [
        { id: "gate", action: "approve", text: "Publish the example draft?", targetId: bot.id, timeoutMin: 120 },
      ] }),
    });
    const { run } = await h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
    const preview = await waitFor(() => previews.find((p) => p.threadId === bot.threadId && /Publish the example draft/.test(p.body)));
    assert.ok(preview, "the workflow decision did not carry its question to the paired phone");
    assert.equal(preview.category, "question", "a workflow must open its card, not expose native engine Allow/Deny buttons");
    assert.equal(preview.requestId, undefined, "a workflow run is not a broker permission request");
    assert.match(preview.body, /Draft review is waiting/);
    assert.equal(preview.threadId, bot.threadId);
    const { messages } = await h.json(`/api/bots/${bot.id}/messages`);
    assert.ok(Array.isArray(messages), "the notification's conversation did not return its transcript");
    const card = messages.find((m: any) => m.card?.runId === run.id);
    assert.ok(card, "the notification target did not contain its decision");
    assert.equal(card.card.answered, undefined);
    assert.deepEqual(card.card.options, ["Approve", "Decline"]);
    const wakesBefore = previews.length;
    const response = await h.fetch(`/api/workflows/runs/${run.id}/answer`, {
      method: "POST", body: JSON.stringify({ answer }),
    });
    assert.equal(response.status, 200);
    const settled = await waitFor(() => pushes.flatMap((p) => p.frames).find((f) => f.kind === "message.patch" && f.message?.id === card.id && f.message.card?.answered === answer));
    assert.ok(settled, "the answered state did not reach the paired phone");
    const opened = (await h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id);
    assert.equal(opened.card.answered, answer, "opening the original target still presents an unanswered decision");
    assert.equal(previews.length, wakesBefore, "settling a decision must not send another decision alert");
    assert.equal((await h.fetch(`/api/workflows/runs/${run.id}/answer`, { method: "POST", body: JSON.stringify({ answer }) })).status, 409);
  });
}


test("a shared workflow gate wakes its owner, never collaborators", async (t) => {
  const w = await alertWorkspace(t);
  const { workflow } = await w.h.json("/api/workflows", { method: "POST", body: JSON.stringify({
    name: "Shared review", trigger: { kind: "manual", targetKind: "room", targetId: w.roomId }, steps: [
      { id: "gate", action: "approve", text: "Publish the shared draft?", timeoutMin: 120 },
    ],
  }) });
  assert.ok(workflow, "the isolated shared-room workflow was not created");
  const { run } = await w.h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  const card = await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.runId === run.id)?.message);
  assert.ok(card, "the gate record was not delivered");
  const stored = await w.h.json(`/api/bloks/${w.roomId}/messages`);
  assert.ok(stored.messages.some((m: any) => m.id === card.id), "the gate record was not stored");
  const pushed = w.captured(card.id)!;
  t.diagnostic("gate delivery and storage assertions passed before wake targeting");
  assert.equal(pushed.wake?.reason, "needs-you");
  assert.deepEqual(pushed.wake.clients, [w.devices[0].hash], "a workflow gate is the owner's decision, never a collaborator's");
  assert.equal(pushed.previews["owner-device"].category, "question");
  assert.match(pushed.previews["owner-device"].body, /Publish the shared draft\?.*Shared review is waiting/);
  assert.equal(pushed.previews["owner-device"].requestId, undefined);
});

test("human mentions target only the named device and agent mentions only leave a record", async (t) => {
  const w = await alertWorkspace(t);
  const bot = await w.hire(), other = await w.hire("Reviewer");
  assert.equal((await w.h.fetch(`/api/bloks/${w.roomId}`, { method: "PATCH", body: JSON.stringify({ memberIds: [bot.id, other.id], leadOnly: true }) })).status, 200);
  for (const [sender, text, named] of [
    [0, "@Aya first example", 1], [1, "@Host second example", 0], [1, "@Ben third example", 2],
  ] as const) {
    const response = sender === 0
      ? await w.h.json(`/api/bloks/${w.roomId}/messages`, { method: "POST", body: JSON.stringify({ text }) })
      : (await w.member(sender, `/api/member/rooms/${w.roomId}/messages`, { text })).body;
    assert.ok(response.message, `the person-authored message was not accepted: ${JSON.stringify(response)}`);
    const pushed = await waitFor(() => w.captured(response.message.id));
    assert.ok(pushed, "the person-authored message was not delivered");
    const stored = await w.h.json(`/api/bloks/${w.roomId}/messages`);
    assert.ok(stored.messages.some((m: any) => m.id === response.message.id), "the human message was not stored");
    t.diagnostic("human delivery and storage assertions passed before mention wake");
    assert.equal(pushed.wake?.reason, "mention", "a person-authored mention must wake the named person");
    assert.deepEqual(pushed.wake.clients, [w.devices[named].hash], "a person must wake only the person they named");
    assert.equal(pushed.previews[w.devices[named].id].title, `${w.devices[sender].name} in Draft room`);
    assert.equal(pushed.previews[w.devices[named].id].body, text);
  }
  assert.ok(await waitFor(async () => (await w.h.json("/api/bots?messages=0")).bots.every((b: any) => !b.busy) ? true : null), "the room turns did not settle");
  assert.equal((await w.h.fetch(`/api/bloks/${w.roomId}/messages`, { method: "POST", body: JSON.stringify({ text: "@Editor Run the example" }) })).status, 201);
  const spend = await waitFor(() => w.pushes.find((p) => p.frames.some((f) => f.device === "owner-device" && f.frame.kind === "room.spendWarning")));
  assert.ok(spend, `the configured spend warning did not reach the owner: ${JSON.stringify(w.ownerFrames().filter((f) => f.message?.kind === "notice").map((f) => f.message.text))}; ${w.h.logs().slice(-1000)}`);
  assert.equal(spend.wake.reason, "spend");
  assert.deepEqual(spend.wake.clients, [w.devices[0].hash]);
  const { existsSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  rmSync(join(w.home, "turn-token"), { force: true });
  assert.equal((await w.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "HOLD FOR AGENT POST" }) })).status, 202);
  assert.ok(await waitFor(() => existsSync(join(w.home, "turn-token")) ? true : null));
  const said = await w.h.json(`/api/bloks/${w.roomId}/messages`, { method: "POST", headers: { authorization: `Bearer ${readFileSync(join(w.home, "turn-token"), "utf8")}` }, body: JSON.stringify({ text: "@Host @Aya @Ben agent coordination" }) });
  const pushed = await waitFor(() => w.captured(said.message.id));
  assert.ok(pushed, "the agent mention was not delivered");
  assert.ok((await w.h.json(`/api/bloks/${w.roomId}/messages`)).messages.some((m: any) => m.id === said.message.id), "the agent mention was not stored");
  assert.equal(pushed.wake, undefined, "an agent's mention must not wake a person");
});

for (const [kind, behavior] of [["QUESTION", "answer"], ["APPROVAL", "allow"], ["APPROVAL", "deny"]] as const) {
  test(`a broker ${kind} birth wakes before map registration and ${behavior} settles without a wake`, async (t) => {
    const w = await alertWorkspace(t);
    const bot = await w.hire();
    assert.equal((await w.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `BROKER ${kind}` }) })).status, 202);
    const card = await waitFor(() => w.ownerFrames().find((f) => f.threadId === bot.threadId && f.message?.card?.requestId)?.message);
    assert.ok(card, "the broker did not deliver its new request card");
    assert.ok((await w.h.json(`/api/bots/${bot.id}/messages`)).messages.some((m: any) => m.id === card.id), "the request was not stored");
    const pushed = w.captured(card.id)!;
    t.diagnostic("broker delivery and storage assertions passed before pre-map wake");
    assert.equal(pushed.wake?.reason, "needs-you", "a new broker card must wake at its real pre-map broadcast order");
    assert.deepEqual(pushed.wake.clients, [w.devices[0].hash]);
    const preview = pushed.previews["owner-device"];
    assert.equal(preview.category, kind === "QUESTION" ? "question" : "approval");
    assert.equal(preview.body, card.card.subtitle);
    if (kind === "QUESTION") assert.equal(preview.body, "Which draft should I publish?");
    else {
      assert.equal(preview.body, "echo publish the example draft");
      assert.equal(preview.requestId, card.card.requestId);
      assert.equal(preview.botId, bot.id);
    }
    const answered = await w.h.fetch(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.card.requestId, behavior, message: "Blue" }) });
    assert.equal(answered.status, 200);
    const settled = await waitFor(() => w.captured(card.id, "message.patch"));
    assert.ok(settled, "the broker settlement did not reach the paired phone");
    assert.equal(settled.wake, undefined, "answering or denying an ask must not send another alert");
    const opened = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id);
    assert.ok(opened.card.answered, "the original target still offers an unanswered card");
  });
}

test("restart closes a cut-off broker card without a new decision alert", async (t) => {
  const w = await alertWorkspace(t);
  const bot = await w.hire();
  await w.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "BROKER QUESTION" }) });
  const card = await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.requestId)?.message);
  assert.ok(card);
  assert.equal(w.captured(card.id)?.wake?.reason, "needs-you");
  const before = w.pushes.length;
  await w.restart();
  const opened = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id);
  assert.ok(opened.card.answered, "a restart must settle the old question");
  assert.equal(opened.card.cutOff, true, "the cut-off card must explain why it closed");
  assert.match(opened.card.answered, /Cut off when Bloks stopped/);
  const after = w.pushes.slice(before);
  assert.equal(after.some((p) => p.wake?.reason === "needs-you"), false, "recovery must not announce a stale question as a new ask");
  const late = await w.h.fetch(`/api/bots/${bot.id}/respond`, { method: "POST", body: JSON.stringify({ requestId: card.card.requestId, behavior: "answer", message: "Blue" }) });
  assert.equal(late.status, 200);
  assert.deepEqual(await late.json(), { ok: false, outcome: "unavailable" }, "a late answer must not reach a new engine request");
  assert.deepEqual((await w.h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id).card, opened.card);
});

test("a gate timing out is a settled record, not another alert", async (t) => {
  const w = await alertWorkspace(t);
  const bot = await w.hire();
  const { workflow } = await w.h.json("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Short review", trigger: { kind: "manual" }, steps: [
    { id: "gate", action: "approve", text: "Publish before the review ends?", targetId: bot.id, timeoutMin: 1 },
  ] }) });
  const { run } = await w.h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  const card = await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.runId === run.id)?.message);
  assert.ok(card);
  assert.equal(w.captured(card.id)?.wake?.reason, "needs-you");
  const settled = await waitFor(() => w.captured(card.id, "message.patch"), 105_000);
  assert.ok(settled, "the gate deadline did not settle its card");
  assert.equal(settled.wake, undefined, "a timed-out gate must not send another question alert");
  const opened = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id);
  assert.equal(opened.card.answered, "no answer in time", "opening the expired question must show that it closed");
  assert.notEqual(opened.card.dismissed, true, "a timeout must not hide a card the person did not put aside");
});


test("configured brief and join-request wakes stay, and the brief still counts only live broker asks", async (t) => {
  const w = await alertWorkspace(t);
  const gateBot = await w.hire("Reviewer");
  const { workflow } = await w.h.json("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Review", trigger: { kind: "manual" }, steps: [
    { id: "gate", action: "approve", text: "Publish the review?", targetId: gateBot.id, timeoutMin: 120 },
  ] }) });
  const { run } = await w.h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  assert.ok(await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.runId === run.id)));
  const bot = await w.hire();
  await w.h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "BROKER QUESTION" }) });
  const question = await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.requestId)?.message);
  assert.ok(question);
  const { brief } = await w.h.json("/api/briefs", { method: "POST", body: "{}" });
  assert.equal(brief.waiting.length, 1, "the brief's existing map-based pending list must not start counting gates");
  assert.equal(brief.waiting[0].messageId, question.id);
  const ready = await waitFor(() => w.pushes.find((p) => p.frames.some((f) => f.device === "owner-device" && f.frame.kind === "brief.ready" && f.frame.id === brief.id)));
  assert.ok(ready, "the requested nonquiet brief did not publish its ready frame");
  assert.equal(ready.wake.reason, "brief");
  assert.deepEqual(ready.wake.clients, [w.devices[0].hash]);
  assert.equal(ready.previews["owner-device"].category, "brief");
  const { createHash } = await import("node:crypto");
  const claim = await w.inviteClaim("inv_example", createHash("sha256").update("example-invite-secret").digest("hex"), { name: "Cia", token: "c".repeat(43) });
  assert.equal(claim.status, 200);
  const joined = await waitFor(() => w.pushes.find((p) => p.frames.some((f) => f.device === "owner-device" && f.frame.kind === "room.joinRequest")));
  assert.ok(joined, "the room join request was not delivered");
  assert.equal(joined.wake.reason, "join-request");
  assert.deepEqual(joined.wake.clients, [w.devices[0].hash]);
});


for (const putAside of [false, true]) {
  test(`changing a workflow leaves a closed card and preserves put-aside=${putAside}`, async (t) => {
    const w = await alertWorkspace(t);
    const bot = await w.hire();
    const steps = [{ id: "gate", action: "approve", text: "Publish the first draft?", targetId: bot.id, timeoutMin: 120 }];
    const { workflow } = await w.h.json("/api/workflows", { method: "POST", body: JSON.stringify({ name: "Draft review", trigger: { kind: "manual" }, steps }) });
    const { run } = await w.h.json(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
    const card = await waitFor(() => w.ownerFrames().find((f) => f.message?.card?.runId === run.id)?.message);
    assert.ok(card);
    if (putAside) assert.equal((await w.h.fetch(`/api/bots/${bot.id}/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ dismissed: true }) })).status, 200);
    assert.equal((await w.h.fetch(`/api/workflows/${workflow.id}`, { method: "PATCH", body: JSON.stringify({ steps: [{ ...steps[0], text: "A different draft?" }] }) })).status, 200);
    const settled = await waitFor(() => w.pushes.find((p) => p.frames.some((f) => f.device === "owner-device" && f.frame.kind === "message.patch" && f.frame.message?.id === card.id && f.frame.message.card.answered === "the workflow changed")));
    assert.ok(settled, "the closed gate did not reach the paired phone");
    assert.equal(settled.wake, undefined);
    const opened = (await w.h.json(`/api/bots/${bot.id}/messages`)).messages.find((m: any) => m.id === card.id);
    assert.equal(opened.card.answered, "the workflow changed");
    assert.equal(Boolean(opened.card.dismissed), putAside, "settlement must not invent or undo the person's dismissal");
  });
}
