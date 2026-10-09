import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";

const inputs = (s: Awaited<ReturnType<typeof codexCommands>>) => s.calls().filter((c) => c.method === "turn/start");
const named = (call: any) => call.params.input.filter((i: any) => i.type === "skill");

for (const refuseSteer of [false, true]) test(`a held skill lookup preserves two personal messages' order with refuse=${refuseSteer}`, async (t) => {
  const s = await codexCommands(t); await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  s.spec({ holdSkills: true, refuseSteer });
  const a = s.say("A $selected do X");
  await waitFor(() => s.calls().some((c) => c.method === "skills/list"));
  const b = s.say("B also Y");
  await new Promise((r) => setTimeout(r, 75));
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 0);
  s.skillsGate(); await Promise.all([a, b]);
  if (!refuseSteer) {
    const steers = s.calls().filter((c) => c.method === "turn/steer");
    assert.deepEqual(steers.map((c) => c.params.input[0].text), ["A $selected do X", "B also Y"]);
    assert.deepEqual(named(steers[0]).map((i: any) => i.name), ["selected"]);
  } else {
    assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 1);
  }
  const messages = await s.messages();
  assert.ok(messages.findIndex((m) => m.text === "A $selected do X") < messages.findIndex((m) => m.text === "B also Y"));
  s.gate(); await s.settled();
  if (refuseSteer) {
    await waitFor(() => inputs(s).length === 2);
    assert.ok(inputs(s)[1].params.input[0].text.indexOf("A $selected do X") < inputs(s)[1].params.input[0].text.indexOf("B also Y"));
    assert.deepEqual(named(inputs(s)[1]).map((i: any) => i.name), ["selected"]);
  }
});

for (const event of ["ends", "compacts"] as const) test(`a turn that ${event} during skill discovery queues the personal message once`, async (t) => {
  const s = await codexCommands(t); await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  s.spec({ holdSkills: true });
  const a = s.say("A $selected");
  await waitFor(() => s.calls().some((c) => c.method === "skills/list"));
  if (event === "ends") { s.gate(); await waitFor(() => s.calls().filter((c) => c.method === "skills/list").length === 2); }
  else { s.startAuto(); await new Promise((r) => setTimeout(r, 75)); }
  s.skillsGate(); await a;
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 0);
  if (event === "compacts") s.gate();
  await waitFor(() => inputs(s).length === 2); await s.settled();
  assert.deepEqual(named(inputs(s)[1]).map((i: any) => i.name), ["selected"]);
  assert.equal((await s.messages()).filter((m) => m.text === "A $selected").length, 1);
});

test("plain busy words need no lookup and lookup failure keeps the steering words", async (t) => {
  const s = await codexCommands(t); await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  await s.say("plain follow-up", { replyTo: { author: "Another message", excerpt: "$selected" } });
  assert.equal(s.calls().filter((c) => c.method === "skills/list").length, 0);
  s.spec({ refuseSkills: true }); await s.say("Use $selected");
  const steers = s.calls().filter((c) => c.method === "turn/steer");
  assert.deepEqual(steers.map((c) => c.params.input), [[{ type: "text", text: "plain follow-up" }], [{ type: "text", text: "Use $selected" }]]);
  s.gate(); await s.settled();
});

test("the actual menu and own message deliver a named item without exposing its path", async (t) => {
  const s = await codexCommands(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await s.h.fetch("/api/events", { signal: controller.signal });
  const reader = stream.body!.getReader();
  let events = "";
  const collect = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        events += new TextDecoder().decode(chunk.value);
      }
    } catch { /* the bounded read is closed below */ }
  })();
  const menu = await s.commands();
  assert.ok(menu.some((c) => c.id === "selected" && c.prefix === "$" && c.source === "engine"));
  assert.deepEqual(menu.filter((c) => c.kind === "command").map((c) => c.id), ["compact"]);
  assert.ok(!menu.some((c) => c.id === "off"));
  assert.doesNotMatch(JSON.stringify(menu), /PLANTED_PATH|OTHER_PATH|DISABLED_PATH/);
  const call = await s.turn("Use $selected. Then $other-skill, and $selected again.", { skillNames: ["FORGED"], path: "/FORGED/SKILL.md", namedSkills: false });
  assert.deepEqual(named(call), [
    { type: "skill", name: "selected", path: join(s.root, "PLANTED_PATH/SKILL.md") },
    { type: "skill", name: "other-skill", path: join(s.root, "OTHER_PATH/SKILL.md") },
  ]);
  assert.doesNotMatch(JSON.stringify(await s.messages()), /PLANTED_PATH|OTHER_PATH|FORGED/);
  await waitFor(() => events.includes("Use $selected.") && events.includes("ANSWER"));
  controller.abort(); await collect;
  assert.doesNotMatch(events, /PLANTED_PATH|OTHER_PATH|DISABLED_PATH|FORGED/);
  const native = readFileSync(join(s.root, ".bloks/native", `${s.bot.threadId}.ndjson`), "utf8");
  assert.doesNotMatch(native, /"method":"skills\/list"/);
});

test("ten busy toggles and two menu clients share one probe, while a new folder gets its own", async (t) => {
  const s = await codexCommands(t);
  for (let i = 0; i < 10; i++) {
    await Promise.all([s.commands(), s.commands()]);
    await s.turn("ordinary " + i);
    await Promise.all([s.commands(), s.commands()]);
  }
  assert.equal(s.calls().filter((c) => c.method === "skills/list").length, 1);
  const folder = join(s.root, "another-folder"); mkdirSync(folder);
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: folder }) });
  await s.commands();
  assert.deepEqual(s.calls().filter((c) => c.method === "skills/list").map((c) => c.params.cwds), [[join(s.root, ".bloks/workspaces", s.bot.id)], [folder]]);
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "other", model: "gpt-6.1-sol" } }) });
  await s.commands();
  assert.equal(s.calls().filter((c) => c.method === "skills/list").length, 3, "another instance reused the first instance's catalog");
});

test("only personal current words select skills, not notes or another engine's handoff", async (t) => {
  const s = await codexCommands(t);
  await s.turn("First $selected");
  await s.post("/api/profile/notes", { text: "NOTE $selected" });
  const ordinary = await s.turn("ordinary now");
  assert.ok(ordinary.params.input[0].text.includes("$selected"));
  assert.deepEqual(named(ordinary), []);
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "other", model: "gpt-6.1-sol" } }) });
  assert.deepEqual(named(await s.turn("switch engine")), []);
  const unknown = await s.turn("$HOME costs $5. $unknown $SELECTED $$selected a$selected \\$selected");
  assert.deepEqual(named(unknown), []);
});

test("another agent cannot inject a named skill through say or forged selection fields", async (t) => {
  const s = await codexCommands(t);
  const peer = await s.hire("Peer");
  await s.post(`/api/bots/${peer.id}/messages`, { text: "PING " + s.bot.id });
  await waitFor(() => inputs(s).some((c) => c.params.input[0].text.includes("AGENT $selected")));
  await s.settled();
  assert.deepEqual(named(inputs(s).find((c) => c.params.input[0].text.includes("AGENT $selected"))), []);
});

test("a webhook and routine carrying a valid name stay ordinary inputs", async (t) => {
  const s = await codexCommands(t);
  const { webhook } = await s.post("/api/webhooks", { name: "Synthetic", botId: s.bot.id });
  assert.equal((await s.h.fetch(`/hook/${webhook.token}`, { method: "POST", body: JSON.stringify({ text: "WEBHOOK $selected", namedSkills: true }) })).status, 202);
  await waitFor(() => inputs(s).some((c) => c.params.input[0].text.includes("WEBHOOK $selected")));
  await s.settled();
  assert.deepEqual(named(inputs(s).find((c) => c.params.input[0].text.includes("WEBHOOK $selected"))), []);
  const { routine } = await s.post("/api/routines", { targetId: s.bot.id, targetKind: "agent", prompt: "ROUTINE $selected", time: "09:00", days: [] });
  await s.post(`/api/routines/${routine.id}/run`);
  await waitFor(() => inputs(s).some((c) => c.params.input[0].text.includes("ROUTINE $selected")));
  await s.settled();
  assert.deepEqual(named(inputs(s).find((c) => c.params.input[0].text.includes("ROUTINE $selected"))), []);
});

test("notes sent from an artifact the agent named after a skill stay an ordinary input", async (t) => {
  const s = await codexCommands(t);
  const base = `/api/bots/${s.bot.id}/artifacts/${encodeURIComponent("$selected.csv")}/comments`;
  const note = await s.h.fetch(base, { method: "POST", body: JSON.stringify({ text: "Recheck this total", anchor: { kind: "cell", row: 2, column: 1 } }) });
  assert.equal(note.status, 201);
  assert.equal((await s.h.fetch(`${base}/send`, { method: "POST", body: "{}" })).status, 202);
  await waitFor(() => inputs(s).some((c) => c.params.input[0].text.includes("$selected.csv")));
  await s.settled();
  assert.deepEqual(named(inputs(s).find((c) => c.params.input[0].text.includes("$selected.csv"))), []);
  assert.equal(s.calls().filter((c) => c.method === "skills/list").length, 0);
});

test("a watcher with a valid name stays an ordinary input", async (t) => {
  const s = await codexCommands(t);
  await s.h.json(`/api/bots/${s.bot.id}/tasks/${s.bot.threadId}`, { method: "PATCH", body: JSON.stringify({ title: "Work" }) });
  const folder = join(s.root, "watched"); mkdirSync(folder);
  const { watcher } = await s.post("/api/watchers", { botId: s.bot.id, kind: "folder", target: folder, instruction: "WATCHER $selected", thread: "Work" });
  await waitFor(async () => (await s.h.json("/api/watchers")).watchers.find((w: any) => w.id === watcher.id)?.lastCheck);
  await s.post(`/api/watchers/${watcher.id}/check`);
  const before = inputs(s).length;
  writeFileSync(join(folder, "new.txt"), "changed");
  const fired = await s.post(`/api/watchers/${watcher.id}/check`);
  assert.equal(fired.fired, true, JSON.stringify({ fired, watchers: (await s.h.json("/api/watchers")).watchers, tasks: (await s.current()).tasks }));
  await waitFor(() => inputs(s).length === before + 1); await s.settled();
  assert.deepEqual(named(inputs(s).at(-1)), []);
  assert.ok(inputs(s).at(-1).params.input[0].text.includes("$selected"));
});

test("a carry-on wrapper's tool name cannot acquire a skill, while its new personal segment can", async (t) => {
  const s = await codexCommands(t);
  s.spec({ refuseSteer: true });
  await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  await s.say("new words $other-skill");
  assert.ok((await s.messages()).some((m) => m.queued && m.namedSkills === true && m.text.includes("$other-skill")));
  await s.reboot(); await waitFor(() => inputs(s).length === 2); await s.settled();
  assert.ok(inputs(s)[1].params.input[0].text.includes("$selected"), "the wrapper did not carry the held tool");
  assert.deepEqual(named(inputs(s)[1]).map((i: any) => i.name), ["other-skill"]);
});

test("a room's automatic marker lands in the room, keeps the reading, and never selects from room lines", async (t) => {
  const s = await codexCommands(t); s.spec({ auto: true });
  const peer = await s.hire("Ivy");
  const { blok } = await s.post("/api/bloks", { name: "Ops", memberIds: [s.bot.id, peer.id] });
  await s.post(`/api/bloks/${blok.id}/messages`, { text: "@Rex ROOM $selected" });
  await waitFor(() => inputs(s).length === 1); await s.settled();
  assert.deepEqual(named(inputs(s)[0]), []);
  const room = (await s.h.json(`/api/bloks/${blok.id}/messages?limit=100`)).messages;
  assert.equal(room.filter((m: any) => m.compaction && m.from === s.bot.id).length, 1);
  assert.equal(room.find((m: any) => m.compaction).compaction.after, null);
  const lane = s.stored().tasks.find((task: any) => task.reading);
  assert.equal(lane.reading.used, 40000);
  assert.doesNotMatch(JSON.stringify(room), /PLANTED_PATH/);
});

test("an automatic marker does not invent a reading or alter the next request and usage", async (t) => {
  const s = await codexCommands(t); s.spec({ auto: true }); await s.turn("first request");
  const one = s.stored();
  assert.equal(one.tasks.find((task: any) => task.id === s.bot.threadId).reading.used, 40000);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 1);
  s.spec({ auto: false, used: 12000 }); await s.turn("next request");
  assert.equal(s.stored().tasks.find((task: any) => task.id === s.bot.threadId).reading.used, 12000);
  const usage = await s.h.json("/api/usage");
  assert.ok(JSON.stringify(usage).includes("52000"), "the two requests' native usage was not retained");
});

test("a busy compact with trailing words queues and delivers those words without compacting", async (t) => {
  const s = await codexCommands(t); await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  s.spec({ refuseSteer: true });
  const text = "/compact keep notes";
  assert.equal((await s.say(text)).queued, true);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 0);
  s.gate(); await waitFor(() => inputs(s).length === 2 || s.calls().some((c) => c.method === "thread/compact/start")); await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 0);
  assert.equal(inputs(s).length, 2);
  assert.ok(inputs(s)[1].params.input[0].text.endsWith(text));
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 0);
  assert.equal((await s.messages()).filter((m) => m.text === text).length, 1);
});

for (const path of ["direct", "queued", "steered"] as const) test(`a decision label creates no named skill item through ${path}`, async (t) => {
  const s = await codexCommands(t);
  if (path !== "direct") { await s.say("HOLD"); await waitFor(() => inputs(s).length === 1); }
  if (path === "queued") s.spec({ refuseSteer: true });
  const label = "Proceed with $selected";
  await s.post(`/api/bots/${s.bot.id}/show`, { kind: "decision", data: {
    question: "Which next step?", options: [{ label }, { label: "Wait" }],
  } });
  const card = (await s.messages()).find((m) => m.component?.kind === "decision");
  assert.ok(card);
  const result = await s.post(`/api/threads/${s.bot.threadId}/messages/${card.id}/choose`, { choice: 0, personal: true, skillNames: ["selected"] });
  assert.equal(result.message.decisionChoice, 0);
  if (path === "queued") {
    const queued = (await s.messages()).find((m) => m.replyTo?.messageId === card.id);
    assert.equal(queued?.queued, true);
    assert.equal(queued?.namedSkills, false);
    s.gate(); await waitFor(() => inputs(s).length === 2); await s.settled();
    assert.ok(inputs(s)[1].params.input[0].text.includes(label));
  } else if (path === "steered") {
    assert.deepEqual(s.calls().filter((c) => c.method === "turn/steer").map((c) => c.params.input), [[{ type: "text", text: label }]]);
    s.gate(); await s.settled();
  } else {
    await waitFor(() => inputs(s).length === 1); await s.settled();
    assert.ok(inputs(s)[0].params.input[0].text.includes(label));
  }
  assert.equal(s.calls().filter((c) => c.method === "skills/list").length, 0);
  assert.ok(s.calls().filter((c) => c.method === "turn/start" || c.method === "turn/steer").every((c) => named(c).length === 0));
  assert.equal((await s.messages()).filter((m) => m.text === label && m.replyTo?.messageId === card.id).length, 1);
});

test("a busy compact is never steered, adds no generation, and defers changed memory to ordinary work", async (t) => {
  const s = await codexCommands(t);
  const first = await s.turn("initial");
  await s.say("HOLD"); await waitFor(() => inputs(s).length === 2);
  const memory = join(s.root, ".bloks/workspaces", s.bot.id, "MEMORY.md"); writeFileSync(memory, "CHANGED_MEMORY");
  assert.equal((await s.say("/compact")).queued, true);
  await s.say("after command");
  s.gate(); await waitFor(() => inputs(s).length === 3); await s.settled();
  assert.equal(s.calls().filter((c) => c.method === "turn/steer").length, 0);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.ok(inputs(s)[2].params.input[0].text.includes("CHANGED_MEMORY"));
  const after = await s.turn("once more");
  assert.ok(after.params.input[0].text.endsWith("once more"));
  assert.equal(first.params.threadId, after.params.threadId);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 1);
});

test("a command above both automatic thresholds compacts once with no generation or new cursor", async (t) => {
  const s = await codexCommands(t); s.spec({ used: 250000, window: 400000 });
  await s.turn("large request"); const before = s.stored();
  await s.say("/compact"); await waitFor(() => s.calls().some((c) => c.method === "thread/compact/start")); await s.settled();
  assert.equal(inputs(s).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 1);
  assert.deepEqual(s.stored().tasks.find((task: any) => task.id === s.bot.threadId).resumeCursors, before.tasks.find((task: any) => task.id === s.bot.threadId).resumeCursors);
});

test("explicit compact failure is one lane refusal, with no backup or changed cursor", async (t) => {
  const s = await codexCommands(t); await s.turn("first"); s.spec({ compact: "reject" });
  await s.say("/compact"); await s.settled();
  assert.equal(inputs(s).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "thread/start").length, 1);
  assert.equal((await s.messages()).filter((m) => m.kind === "notice" && m.text.includes("Compaction refused")).length, 1);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 0);
});

test("Stop during an explicit compact leaves one notice and no replacement", async (t) => {
  const s = await codexCommands(t); await s.turn("initial"); s.spec({ compact: "hold" });
  const before = (await s.messages()).length;
  await s.say("/compact"); await waitFor(() => s.calls().some((c) => c.method === "thread/compact/start"));
  const stopped = await s.h.fetch(`/api/bots/${s.bot.id}/interrupt`, { method: "POST", body: JSON.stringify({ taskId: s.bot.threadId }) });
  assert.equal(stopped.status, 200); await s.settled();
  const notices = (await s.messages()).slice(before).filter((m) => m.kind === "notice");
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(inputs(s).length, 1);
  assert.equal(s.calls().filter((c) => c.method === "thread/start").length, 1);
  assert.equal((await s.messages()).filter((m) => m.compaction).length, 0);
});

test("edits use the current words and current personal selection in the dispatched queue segment", async (t) => {
  const s = await codexCommands(t); await s.say("HOLD"); await waitFor(() => inputs(s).length === 1);
  await s.say("/compact");
  const command = (await s.messages()).find((m) => m.queued);
  await s.h.json(`/api/threads/${s.bot.threadId}/messages/${command.id}`, { method: "PATCH", body: JSON.stringify({ text: "edited $selected", namedSkills: false, skillNames: ["FORGED"] }) });
  s.gate(); await waitFor(() => inputs(s).length === 2); await s.settled();
  assert.deepEqual(named(inputs(s)[1]).map((i: any) => i.name), ["selected"]);
  assert.equal(s.calls().filter((c) => c.method === "thread/compact/start").length, 0);
});
