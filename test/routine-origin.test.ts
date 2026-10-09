// A routine's stored prompt stays unchanged. Its engine input names the
// source, including after a transcript rebuild or a switch to the backup.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, inFlight, messagesOf, waitFor } from "./helpers/turns.ts";

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const futureTime = () => {
  const later = new Date(Date.now() + 60 * 60_000);
  return `${String(later.getHours()).padStart(2, "0")}:${String(later.getMinutes()).padStart(2, "0")}`;
};
const words = (name: string | undefined, manual: boolean, prompt: string) =>
  `(Your routine${name ? ` ${JSON.stringify(name)}` : ""} ${manual ? "was run by hand." : "started this turn on its schedule."})\n\n${prompt}`;

function makeDue(home: string, ids: string[]) {
  const path = join(home, ".bloks", "routines.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const due = new Date(Date.now() - 60_000);
  for (const row of saved.filter((r: any) => ids.includes(r.id))) {
    row.time = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
    row.scheduledAt = due.getTime() - 60_000;
    delete row.lastRunAt;
  }
  writeFileSync(path, JSON.stringify(saved));
}

function removeSelectedEngine(home: string, botId: string) {
  const path = join(home, ".bloks", "bots.json");
  const bots = JSON.parse(readFileSync(path, "utf8"));
  const bot = bots.find((b: any) => b.id === botId);
  bot.modelSelection = { instanceId: "missing-fixture-engine", model: "fixture-model" };
  delete bot.backupSelection;
  writeFileSync(path, JSON.stringify(bots));
}

async function native(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-routine-origin-"));
  const log = join(home, "requests.jsonl");
  const finish = join(home, "finish");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (process.argv[2] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
const take = async (chunk) => {
  input += chunk;
  let frame;
  while (input.includes("\\n")) {
    const end = input.indexOf("\\n");
    const next = JSON.parse(input.slice(0, end));
    input = input.slice(end + 1);
    if (next.type === "user") { frame = next; break; }
  }
  if (!frame) return;
  process.stdin.off("data", take);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ text: frame.message.content }) + "\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "routine-fixture", model: "claude-sonnet-5" }));
  if (frame.message.content === "/compact") console.log(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: "routine-fixture", compact_metadata: { trigger: "manual", pre_tokens: 176000, post_tokens: 50000 } }));
  while (!existsSync(${JSON.stringify(finish)})) await new Promise((r) => setTimeout(r, 20));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 300, session_id: "routine-fixture", result: "Done." }));
};
process.stdin.on("data", take);
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli } } },
    compaction: { idle: false, beforeTurn: 0 },
  }));
  let h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const { bot } = await h.json("/api/bots", post({ name: "Planner" }));
  const selected = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  assert.equal(selected.status, 200);
  const requests = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return {
    home, bot, requests,
    get h() { return h; },
    async restart(edit: () => void) { await h.stop(); edit(); h = await startHarness({ HOME: home, USERPROFILE: home }); },
    async finish() { writeFileSync(finish, "go"); assert.ok(await idle(h, bot), h.logs()); rmSync(finish); },
  };
}

test("a scheduled routine stores its source and sends one origin line, without byYou", async (t) => {
  const f = await native(t);
  const prompt = "Read the report.\nKeep this second line.";
  const { routine } = await f.h.json("/api/routines", post({ name: "Morning scan", prompt, time: futureTime(), days: [], targetId: f.bot.id, thread: "General", runsOn: "off" }));
  assert.ok(routine?.id);
  await f.restart(() => makeDue(f.home, [routine.id]));
  assert.ok(await waitFor(() => f.requests()[0], 20_000), f.h.logs());
  const said = (await messagesOf(f.h, f.bot)).filter((m: any) => m.role === "user" && m.text === prompt);
  assert.equal(said.length, 1);
  assert.equal(said[0].via, "routine");
  assert.deepEqual(said[0].routine, { name: "Morning scan", manual: false });
  assert.equal(f.requests()[0].text, '(Your routine "Morning scan" started this turn on its schedule.)\n\n' + prompt);
  const turn = inFlight(f.home).find((entry: any) => entry.laneId === f.bot.threadId);
  assert.ok(turn);
  assert.equal(turn.byYou, undefined);
  await f.finish();
});

test("hand runs retain the prompt, optional name, and one escaped origin line", async (t) => {
  const f = await native(t);
  const cases = [
    { name: "Weekly COO scan", prompt: "Check the report." },
    { name: undefined, prompt: "Check the unnamed report." },
    { name: 'Quoted "scan"\nwith\u0007 control', prompt: "x".repeat(3_980) + "\nDO NOT DROP THE END" },
    { name: "Embedded\u0085\u2028\u2029\r\t\u202eend", prompt: "Keep the hostile name on one line." },
    { name: "x".repeat(59) + "😀", prompt: "The name cap cuts the emoji." },
    { name: "Other slash", prompt: "/status check the report" },
  ];
  for (const [i, item] of cases.entries()) {
    const { routine } = await f.h.json("/api/routines", post({ ...item, time: futureTime(), days: [], targetId: f.bot.id, thread: "General", runsOn: "off" }));
    assert.ok(routine?.id);
    assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
    assert.ok(await waitFor(() => f.requests()[i]), f.h.logs());
    const said = (await messagesOf(f.h, f.bot)).filter((m: any) => m.role === "user" && m.text === item.prompt);
    assert.equal(said.length, 1);
    assert.equal(said[0].via, "routine");
    assert.deepEqual(said[0].routine, routine.name ? { name: routine.name, manual: true } : { manual: true });
    const input = f.requests()[i].text;
    const line = input.slice(0, input.indexOf("\n\n"));
    assert.doesNotMatch(line, /[\u0000-\u001f\u0085\u2028\u2029\u202e]/);
    assert.equal(input.slice(line.length), "\n\n" + item.prompt);
    if (routine.name) {
      const quoted = line.slice('(Your routine '.length, -' was run by hand.)'.length);
      assert.equal(JSON.parse(quoted), routine.name);
      if (item.name?.startsWith("Embedded")) assert.equal(quoted, '"Embedded\\u0085\\u2028\\u2029\\r\\t\\u202eend"');
      if (item.name?.startsWith("xxxxx")) assert.ok(quoted.endsWith('\\ud83d"'));
    } else assert.equal(line, "(Your routine was run by hand.)");
    const turn = inFlight(f.home).find((entry: any) => entry.laneId === f.bot.threadId);
    assert.ok(turn);
    assert.equal(turn.byYou, undefined);
    await f.finish();
  }
});

for (const refusal of ["held", "archived", "missing engine"] as const) {
  test(`a hand-run routine refused for ${refusal} leaves no prompt or open run`, async (t) => {
    const f = await native(t);
    const prompt = "Do not leave this as a request.";
    const { routine } = await f.h.json("/api/routines", post({ name: "Refused scan", prompt, time: futureTime(), days: [], targetId: f.bot.id, thread: "General" }));
    if (refusal === "held") await f.h.json(`/api/bots/${f.bot.id}/wheel`, post({ why: "fixture hold" }));
    if (refusal === "archived") assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}`, { method: "DELETE" })).status, 200);
    if (refusal === "missing engine") await f.restart(() => removeSelectedEngine(f.home, f.bot.id));
    const before = await messagesOf(f.h, f.bot);
    const response = await f.h.fetch(`/api/routines/${routine.id}/run`, post({}));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, refusal === "held" ? /driving|wheel|held/i : refusal === "archived" ? /archived/ : /unavailable/);
    assert.deepEqual(await messagesOf(f.h, f.bot), before);
    const runs = (await f.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, "failed");
    assert.ok(runs[0].endedAt);
    assert.deepEqual(f.requests(), []);
  });
}

test("a scheduled routine with no engine closes its run without changing the transcript", async (t) => {
  const f = await native(t);
  const { routine } = await f.h.json("/api/routines", post({ name: "Unavailable scan", prompt: "Do not leave a scheduled request.", time: futureTime(), days: [], targetId: f.bot.id, thread: "General" }));
  const before = await messagesOf(f.h, f.bot);
  await f.restart(() => {
    makeDue(f.home, [routine.id]);
    removeSelectedEngine(f.home, f.bot.id);
  });
  const runs = await waitFor(async () => {
    const runs = (await f.h.json("/api/routines")).routines.find((r: any) => r.id === routine.id).runs;
    return runs?.[0]?.endedAt ? runs : null;
  }, 20_000);
  assert.ok(runs, f.h.logs());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "failed");
  assert.match(runs[0].error, /unavailable/);
  assert.deepEqual(await messagesOf(f.h, f.bot), before);
  assert.deepEqual(f.requests(), []);
});

for (const manual of [false, true]) {
  test(`a ${manual ? "hand-run" : "scheduled"} /compact routine stays a labelled native command`, async (t) => {
    const f = await native(t);
    const { routine } = await f.h.json("/api/routines", post({ name: "Compact scan", prompt: "/compact", time: futureTime(), days: [], targetId: f.bot.id, thread: "General" }));
    if (manual) assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
    else await f.restart(() => makeDue(f.home, [routine.id]));
    assert.ok(await waitFor(() => f.requests()[0], 20_000), f.h.logs());
    assert.equal(f.requests()[0].text, "/compact");
    const said = (await messagesOf(f.h, f.bot)).find((m: any) => m.role === "user" && m.text === "/compact");
    assert.equal(said.via, "routine");
    assert.deepEqual(said.routine, { name: "Compact scan", manual });
    assert.equal(said.commandInstance, "claude");
    assert.equal(inFlight(f.home).find((entry: any) => entry.laneId === f.bot.threadId)?.byYou, undefined);
    await f.finish();
    assert.ok((await messagesOf(f.h, f.bot)).some((m: any) => m.compaction?.before === 176000));
    if (manual) for (const [i, command] of ["/context", "/usage", "/recap"].entries()) {
      const { routine: next } = await f.h.json("/api/routines", post({ name: "Other native command", prompt: command, time: futureTime(), days: [], targetId: f.bot.id, thread: "General" }));
      assert.equal((await f.h.fetch(`/api/routines/${next.id}/run`, post({}))).status, 202);
      assert.ok(await waitFor(() => f.requests()[i + 1]), f.h.logs());
      assert.equal(f.requests()[i + 1].text, command);
      await f.finish();
    }
  });
}

test("a queued native routine command keeps its command path after a restart", async (t) => {
  const f = await native(t);
  await f.restart(() => {
    const file = join(f.home, ".bloks", `messages-${f.bot.threadId}.json`);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ id: "earlier-command-user", at: Date.now() - 2, role: "user", kind: "text", text: "An earlier request in this conversation." },
      { id: "earlier-command-answer", at: Date.now() - 1, role: "bot", kind: "text", text: "The earlier answer." });
    rows.push({ id: "queued-command", at: Date.now(), role: "user", kind: "text", text: "/compact", queued: true,
      queuedAt: Date.now(), via: "routine", routine: { name: "Queued compact", manual: false }, commandInstance: "claude" });
    writeFileSync(file, JSON.stringify(rows));
  });
  assert.ok(await waitFor(() => f.requests()[0], 20_000), f.h.logs());
  assert.equal(f.requests()[0].text, "/compact");
  assert.equal(inFlight(f.home).find((entry: any) => entry.laneId === f.bot.threadId)?.byYou, undefined);
  await f.finish();
  const said = (await messagesOf(f.h, f.bot)).filter((m: any) => m.id === "queued-command");
  assert.equal(said.length, 1);
  assert.equal(said[0].queued, false);
  assert.deepEqual(said[0].routine, { name: "Queued compact", manual: false });
});

test("a person's message stays unframed and byYou", async (t) => {
  const f = await native(t);
  const prompt = "I am asking this myself.\nKeep my words.";
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/messages`, post({ text: prompt }))).status, 202);
  assert.ok(await waitFor(() => f.requests()[0]), f.h.logs());
  assert.equal(f.requests()[0].text, prompt);
  const said = (await messagesOf(f.h, f.bot)).find((m: any) => m.role === "user" && m.text === prompt);
  assert.ok(said);
  assert.equal(said.via, undefined);
  assert.equal(said.routine, undefined);
  assert.equal(inFlight(f.home).find((entry: any) => entry.laneId === f.bot.threadId)?.byYou, true);
  await f.finish();
});

test("API transcript rebuild after restart uses the recorded name, even after rename and deletion", async (t) => {
  const p = await fakeProvider(t);
  let h = await startHarness();
  let savedHome: string | undefined;
  t.after(async () => { await h.stop(); if (savedHome) rmSync(savedHome, { recursive: true, force: true }); });
  const bot = await agentOn(h, p.port, "Replay planner");
  const prompt = "Check the earlier report.";
  const { routine } = await h.json("/api/routines", post({ name: "Original name", prompt, time: futureTime(), days: [], targetId: bot.id, thread: "General" }));
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
  assert.ok(await waitFor(() => p.state.held.length));
  assert.equal(JSON.parse(p.state.calls.at(-1)!).messages.at(-1).content, words("Original name", true, prompt));
  assert.equal(inFlight(h.home).find((entry: any) => entry.laneId === bot.threadId)?.byYou, undefined);
  p.state.held.shift()!();
  assert.ok(await idle(h, bot));
  assert.equal((await h.fetch(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ name: "Changed later" }) })).status, 200);
  assert.equal((await h.fetch(`/api/routines/${routine.id}`, { method: "DELETE" })).status, 200);
  savedHome = mkdtempSync(join(tmpdir(), "bloks-routine-replay-"));
  cpSync(join(h.home, ".bloks"), join(savedHome, ".bloks"), { recursive: true });
  await h.stop();
  h = await startHarness({ HOME: savedHome, USERPROFILE: savedHome });
  const next = "Now I am asking for the next report.";
  assert.equal((await h.fetch(`/api/bots/${bot.id}/messages`, post({ text: next }))).status, 202);
  assert.ok(await waitFor(() => p.state.held.length));
  const sent = JSON.parse(p.state.calls.at(-1)!).messages;
  assert.equal(sent.filter((m: any) => m.content === words("Original name", true, prompt)).length, 1);
  assert.equal(sent.at(-1).content, next);
  assert.ok(!JSON.stringify(sent).includes("Changed later"));
  const said = (await messagesOf(h, bot)).find((m: any) => m.text === prompt);
  assert.deepEqual(said.routine, { name: "Original name", manual: true });
  p.state.held.shift()!();
  assert.ok(await idle(h, bot));
});

test("a fresh native session hears each earlier routine's saved framing exactly once", async (t) => {
  const f = await native(t);
  const prior = ["First saved scan", "Second saved scan"];
  for (const [i, name] of prior.entries()) {
    const { routine } = await f.h.json("/api/routines", post({ name, prompt: `Earlier report ${i}.`, time: futureTime(), days: [], targetId: f.bot.id, thread: "General" }));
    assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
    assert.ok(await waitFor(() => f.requests()[i]), f.h.logs());
    await f.finish();
  }
  await f.restart(() => {
    const file = join(f.home, ".bloks", "bots.json");
    const bots = JSON.parse(readFileSync(file, "utf8"));
    const lane = bots.find((b: any) => b.id === f.bot.id).tasks.find((l: any) => l.id === f.bot.threadId);
    lane.lastInstanceId = "earlier-engine";
    writeFileSync(file, JSON.stringify(bots));
  });
  assert.equal((await f.h.fetch(`/api/bots/${f.bot.id}/messages`, post({ text: "Continue in the fresh session." }))).status, 202);
  assert.ok(await waitFor(() => f.requests()[2]), f.h.logs());
  const text = f.requests()[2].text;
  assert.match(text, /picking up this conversation mid-thread/);
  for (const [i, name] of prior.entries()) assert.equal(text.split(words(name, true, `Earlier report ${i}.`)).length - 1, 1);
  await f.finish();
});

test("a drain between scheduled routines preserves one queued origin on disk and frames it once after restart", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-routine-drain-"));
  let summary: (() => void) | undefined;
  const calls: any[] = [];
  const provider = createServer((req, res) => {
    let body = ""; req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const sent = JSON.parse(body).messages;
      const answer = (content = "Done.") => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      if (sent.length === 1 && sent[0].content.startsWith("Summarise this part")) summary = () => answer("Earlier history.");
      else { calls.push(sent); answer(); }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { summary?.(); provider.closeAllConnections(); provider.close(); });
  let h = await startHarness({ HOME: home, USERPROFILE: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const port = (provider.address() as { port: number }).port;
  const first = await agentOn(h, port, "First due planner");
  const second = await agentOn(h, port, "Second due planner");
  const firstRun = (await h.json("/api/routines", post({ name: "First due scan", prompt: "First scheduled report.", time: futureTime(), days: [], targetId: first.id, thread: "General" }))).routine;
  const prompt = "Second report waits on disk.";
  const secondRun = (await h.json("/api/routines", post({ name: "Waiting scan", prompt, time: futureTime(), days: [], targetId: second.id, thread: "General" }))).routine;
  await h.stop();
  const earlier = Array.from({ length: 9 }, (_, i) => ({ id: `earlier-${i}`, at: Date.now() - 10_000 + i, role: i % 2 ? "bot" : "user", kind: "text", text: `${i}:` + "x".repeat(80_000) }));
  writeFileSync(join(home, ".bloks", `messages-${first.threadId}.json`), JSON.stringify(earlier));
  makeDue(home, [firstRun.id, secondRun.id]);
  h = await startHarness({ HOME: home, USERPROFILE: home });
  assert.ok(await waitFor(() => summary, 20_000), h.logs());
  assert.equal((await h.json("/api/maintenance/drain", post({ seconds: 600 }))).draining, true);
  summary!(); summary = undefined;
  const queued = await waitFor(async () => (await messagesOf(h, second)).find((m: any) => m.text === prompt), 20_000);
  assert.ok(queued, h.logs());
  assert.equal(queued.queued, true);
  assert.equal(queued.via, "routine");
  assert.deepEqual(queued.routine, { name: "Waiting scan", manual: false });
  const disk = JSON.parse(readFileSync(join(home, ".bloks", `messages-${second.threadId}.json`), "utf8")).filter((m: any) => m.text === prompt);
  assert.equal(disk.length, 1);
  assert.deepEqual(disk[0], queued);
  assert.equal(calls.filter((sent) => sent.at(-1).content.includes(prompt)).length, 0);
  assert.ok(await idle(h, first));
  await h.stop();
  h = await startHarness({ HOME: home, USERPROFILE: home });
  assert.ok(await waitFor(() => calls.find((sent) => sent.at(-1).content.includes(prompt)), 20_000), h.logs());
  const delivered = calls.filter((sent) => sent.at(-1).content.includes(prompt));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].at(-1).content, words("Waiting scan", false, prompt));
  assert.ok(await idle(h, second));
  const said = (await messagesOf(h, second)).filter((m: any) => m.text === prompt);
  assert.equal(said.length, 1);
  assert.equal(said[0].queued, false);
  assert.deepEqual(said[0].routine, { name: "Waiting scan", manual: false });
});

test("the backup receives the same routine origin, with no duplicate stored prompt", async (t) => {
  const main = createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
    res.writeHead(429);
    res.end(JSON.stringify({ error: { message: "Rate limit reached. Retry in 20 minutes." } }));
  });
  await new Promise<void>((resolve) => main.listen(0, "127.0.0.1", resolve));
  t.after(() => { main.closeAllConnections(); main.close(); });
  const spare = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, (main.address() as { port: number }).port, "Backup planner");
  await h.json("/api/providers/kimi/connect", post({ key: "test-key", url: `http://127.0.0.1:${spare.port}` }));
  assert.equal((await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ backupSelection: { instanceId: "kimi", model: "grok-4" } }) })).status, 200);
  const prompt = "Try the report on the backup.";
  const { routine } = await h.json("/api/routines", post({ name: "Backup scan", prompt, time: futureTime(), days: [], targetId: bot.id, thread: "General" }));
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
  assert.ok(await waitFor(() => spare.state.held.length), h.logs());
  assert.equal(JSON.parse(spare.state.calls.at(-1)!).messages.at(-1).content, words("Backup scan", true, prompt));
  assert.equal(inFlight(h.home).find((entry: any) => entry.laneId === bot.threadId)?.byYou, undefined);
  spare.state.held.shift()!();
  assert.ok(await idle(h, bot));
  assert.equal((await messagesOf(h, bot)).filter((m: any) => m.role === "user" && m.text === prompt).length, 1);
});

test("a context-error retry keeps the routine origin after folding the earlier conversation", async (t) => {
  const prompt = "Check the report after the fold.";
  const expected = words("Fold scan", true, prompt);
  const requests: string[] = [];
  let summaries = 0;
  let finish: (() => void) | undefined;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const sent = JSON.parse(body).messages;
      const answer = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }] }));
      if (sent.at(-1).content === expected || sent.at(-1).content === prompt) {
        requests.push(sent.at(-1).content);
        if (requests.length === 1) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: { message: "maximum context length exceeded" } }));
        }
        finish = answer;
      } else {
        if (sent.length === 1 && sent[0].content.startsWith("Summarise this part")) summaries++;
        answer();
      }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => { finish?.(); provider.closeAllConnections(); provider.close(); });
  const h = await startHarness();
  t.after(() => h.stop());
  const bot = await agentOn(h, (provider.address() as { port: number }).port, "Fold planner");
  for (const text of ["Earlier report one.", "Earlier report two."]) {
    assert.equal((await h.fetch(`/api/bots/${bot.id}/messages`, post({ text }))).status, 202);
    assert.ok(await idle(h, bot));
  }
  const { routine } = await h.json("/api/routines", post({ name: "Fold scan", prompt, time: futureTime(), days: [], targetId: bot.id, thread: "General" }));
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
  assert.ok(await waitFor(() => finish), h.logs());
  assert.deepEqual(requests, [expected, expected]);
  assert.equal(summaries, 1);
  assert.equal(inFlight(h.home).find((entry: any) => entry.laneId === bot.threadId)?.byYou, undefined);
  finish!();
  assert.ok(await idle(h, bot));
  const said = (await messagesOf(h, bot)).filter((m: any) => m.role === "user" && m.text === prompt);
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].routine, { name: "Fold scan", manual: true });
});

test("a room routine still stores its plain room message, without agent routine metadata", async (t) => {
  const p = await fakeProvider(t);
  p.state.answerAtOnce = true;
  const h = await startHarness();
  t.after(() => h.stop());
  const a = await agentOn(h, p.port, "First member");
  const b = await agentOn(h, p.port, "Second member");
  const { blok } = await h.json("/api/bloks", post({ name: "Routine room", memberIds: [a.id, b.id] }));
  const prompt = "Post a one-line room report.";
  const { routine } = await h.json("/api/routines", post({ name: "Room scan", prompt, time: futureTime(), days: [], targetId: blok.id, targetKind: "room" }));
  assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, post({}))).status, 202);
  const room = (await h.json("/api/bloks")).bloks.find((item: any) => item.id === blok.id);
  const said = room.messages.filter((m: any) => m.role === "user" && m.text === prompt);
  assert.equal(said.length, 1);
  assert.equal(said[0].via, undefined);
  assert.equal(said[0].routine, undefined);
});
