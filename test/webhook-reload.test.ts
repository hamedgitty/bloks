// Persisted webhook targets through the real HTTP receiver after a fresh
// server start. The provider is local and the workspace is disposable.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, waitFor } from "./helpers/turns.ts";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

async function fixture(t: TestContext, seed?: unknown[]) {
  const home = mkdtempSync(join(tmpdir(), "bloks-webhook-reload-"));
  if (seed) {
    mkdirSync(join(home, ".bloks"), { recursive: true });
    writeFileSync(join(home, ".bloks", "webhooks.json"), JSON.stringify(seed), { mode: 0o600 });
  }
  let h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    get h() { return h; },
    async restart() {
      await h.stop();
      h = await startHarness({ HOME: home, USERPROFILE: home });
    },
    async saved(id: string) {
      return (await h.json("/api/webhooks")).webhooks.find((hook: any) => hook.id === id);
    },
    fire: (hook: any, event: string) => h.fetch(`/hook/${hook.token}`, post({ event })),
  };
}

test("a workflow-only webhook keeps its URL, token, enabled state and history on reload and still delivers", async (t) => {
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const f = await fixture(t);
  const bot = await agentOn(f.h, p.port, "Workflow receiver");
  const { workflow } = await f.h.json("/api/workflows", post({
    name: "Build checks", trigger: { kind: "webhook" },
    steps: [{ id: "inspect", action: "ask", text: "Inspect {{trigger.text}}", targetId: bot.id }],
  }));
  assert.ok(workflow);
  const made = await f.h.fetch("/api/webhooks", post({ name: "Build events", workflowId: workflow.id }));
  assert.equal(made.status, 201);
  const hook = (await made.json()).webhook;
  assert.equal(hook.botId, undefined);
  assert.equal(hook.blokId, undefined);
  const path = `/hook/${hook.token}`;
  const done = async (marker: string) => {
    const run = await waitFor(async () => (await f.h.json("/api/workflows")).workflows
      .find((w: any) => w.id === workflow.id)?.runs.find((r: any) => r.state === "done" && r.trigger.text.includes(marker)));
    assert.ok(run, f.h.logs());
    return run as any;
  };
  assert.equal((await f.fire(hook, "WORKFLOW-BEFORE-RELOAD")).status, 202);
  const firstRun = await done("WORKFLOW-BEFORE-RELOAD");
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ enabled: false }))).status, 200);
  const before = await f.saved(hook.id);
  assert.equal(before.firedCount, 1);
  assert.equal(before.enabled, false);
  assert.equal(before.deliveries.length, 1);

  await f.restart();
  const after = await f.saved(hook.id);
  assert.ok(after, "the workflow-only webhook was dropped on reload");
  assert.deepEqual(after, before, "reload changed the hook's identity, target, state or delivery history");
  assert.equal(`/hook/${after.token}`, path, "the existing sender's URL path changed");
  assert.equal((await f.fire(hook, "DISABLED-EVENT")).status, 404);
  assert.deepEqual(await f.saved(hook.id), before, "a disabled hook accepted an event");
  assert.equal((await f.h.fetch(`/api/webhooks/${hook.id}`, patch({ enabled: true }))).status, 200);
  assert.equal((await f.fire(hook, "WORKFLOW-AFTER-RELOAD")).status, 202);
  const secondRun = await done("WORKFLOW-AFTER-RELOAD");
  assert.notEqual(secondRun.id, firstRun.id);
  const input = JSON.parse(p.state.calls.at(-1)!).messages.filter((m: any) => m.role === "user").at(-1).content;
  assert.equal(input.split("WORKFLOW-AFTER-RELOAD").length - 1, 1);
  const fired = await f.saved(hook.id);
  assert.equal(fired.token, hook.token);
  assert.equal(fired.firedCount, 2);
  assert.equal(fired.enabled, true);
  assert.deepEqual(fired.deliveries.slice(1), before.deliveries);

  await f.restart();
  assert.deepEqual(await f.saved(hook.id), fired, "an enabled workflow hook changed on a second reload");
});

test("agent and room webhooks retain their targets, credentials and delivery across reload", async (t) => {
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const f = await fixture(t);
  const agent = await agentOn(f.h, p.port, "Agent receiver");
  const peer = await agentOn(f.h, p.port, "Room member");
  const { blok } = await f.h.json("/api/bloks", post({ name: "Hook room", memberIds: [agent.id, peer.id] }));
  const { webhook: agentHook } = await f.h.json("/api/webhooks", post({ name: "Agent events", botId: agent.id }));
  const { webhook: roomHook } = await f.h.json("/api/webhooks", post({ name: "Room events", blokId: blok.id }));
  assert.ok(agentHook && roomHook);
  const before = [await f.saved(agentHook.id), await f.saved(roomHook.id)];
  await f.restart();
  assert.deepEqual([await f.saved(agentHook.id), await f.saved(roomHook.id)], before);
  assert.equal((await f.fire(agentHook, "AGENT-AFTER-RELOAD")).status, 202);
  assert.ok(await waitFor(() => p.sent("AGENT-AFTER-RELOAD") > 0), f.h.logs());
  assert.ok(await waitFor(async () => (await f.h.json("/api/bots")).bots
    .find((b: any) => b.id === agent.id)?.tasks.every((lane: any) => lane.state === "idle")), f.h.logs());
  assert.equal((await f.fire(roomHook, "ROOM-AFTER-RELOAD")).status, 202);
  const roomMessage = await waitFor(async () => (await f.h.json("/api/bloks")).bloks
    .find((b: any) => b.id === blok.id)?.messages.find((m: any) => m.text?.includes("ROOM-AFTER-RELOAD")));
  assert.ok(roomMessage, "the reloaded room hook did not deliver to its room");
  for (const hook of [agentHook, roomHook]) {
    const saved = await f.saved(hook.id);
    assert.equal(saved.token, hook.token);
    assert.equal(saved.botId, hook.botId);
    assert.equal(saved.blokId, hook.blokId);
    assert.equal(saved.firedCount, 1);
    assert.equal(saved.deliveries.length, 1);
  }
});

test("reload keeps the existing row checks while accepting each supported target", async (t) => {
  const row = { id: "fixture", token: "t".repeat(32), name: "Fixture", enabled: true, createdAt: 1 };
  const valid = [
    { ...row, id: "workflow", workflowId: "flow" },
    { ...row, id: "agent", botId: "agent" },
    { ...row, id: "room", blokId: "room" },
  ];
  const invalid = [
    { ...row, id: "targetless" },
    { ...row, id: "numeric-target", workflowId: 7 },
    { ...row, id: "null-target", workflowId: null },
    { ...row, id: "object-target", workflowId: {} },
    { ...row, id: 7, workflowId: "flow" },
    { ...row, id: "short-token", token: "short", workflowId: "flow" },
    { ...row, id: "wrong-token", token: 7, workflowId: "flow" },
    { ...row, id: "wrong-name", name: 7, workflowId: "flow" },
    null,
  ];
  const f = await fixture(t, [...valid, ...invalid]);
  // a store from before one conversation per agent: the agent's hook keeps
  // the lane it used, as the upgrade gives it (GitHub 237)
  assert.deepEqual(
    (await f.h.json("/api/webhooks")).webhooks,
    valid.map((hook) => (hook.botId ? { ...hook, thread: "Webhooks" } : hook)),
  );
});
