// What one agent may do about another, and what it may read.
//
// 141: an agent that hired another, or outranks it in a room they share,
// can stop its current turn, and its reason is the next thing that agent
// hears; anyone else is refused. A message to a busy agent says it waits.
// 143: a recall hit cut short says so, and the agent can read it in full.
// 144: an agent can read the room it is in, and only a room it is in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("stopping another agent, reading a room, and reading a recalled message in full", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-agent-reach-"));
  const answers = join(home, "answers.json");
  const heard = join(home, "heard.log");
  const cli = join(home, "fake-claude.mjs");
  // Told CALLS <base64 json>, makes each request with its turn credential.
  // Told WORK-SLOWLY, keeps working until it is stopped. Every turn's
  // prompt is written down.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.on("SIGTERM", () => process.exit(143));
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  appendFileSync(${JSON.stringify(heard)}, input + "\\n----\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  if (input.includes("WORK-SLOWLY")) await new Promise((r) => setTimeout(r, 60_000));
  const asked = input.match(/CALLS ([A-Za-z0-9+\\/=]+)/);
  if (asked) {
    const out = [];
    for (const [method, path, body] of JSON.parse(Buffer.from(asked[1], "base64").toString("utf8"))) {
      const res = await fetch(process.env.BLOKS_URL + path, {
        method,
        headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      out.push({ status: res.status, body: await res.json().catch(() => null) });
    }
    writeFileSync(${JSON.stringify(answers)} + ".tmp", JSON.stringify(out)); renameSync(${JSON.stringify(answers)} + ".tmp", ${JSON.stringify(answers)});
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, result: "Done." }));
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const claude = { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } };
  const make = async (name: string, extra: Record<string, unknown> = {}) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ ...claude, ...extra }) });
    return bot;
  };
  const busy = async (id: string) => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === id)?.busy;
  const idle = (id: string) => waitFor(async () => ((await busy(id)) ? null : true));
  const as = async (botId: string, calls: unknown[]) => {
    rmSync(answers, { force: true });
    await idle(botId);
    await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text: `CALLS ${Buffer.from(JSON.stringify(calls)).toString("base64")}` }) });
    assert.ok(await waitFor(() => existsSync(answers)), "the turn never ran");
    const out = JSON.parse(readFileSync(answers, "utf8")) as Array<{ status: number; body: any }>;
    await idle(botId);
    return out;
  };

  const lead = await make("Lead", { seniority: 4 });
  const stranger = await make("Stranger");

  // the lead hires its worker, so it may stop it
  const [hired] = await as(lead.id, [["POST", "/api/bots", { name: "Worker" }]]);
  assert.ok(hired.status < 300, JSON.stringify(hired.body));
  const worker = hired.body.bot;
  await h.fetch(`/api/bots/${worker.id}`, { method: "PATCH", body: JSON.stringify(claude) });

  // the worker sets off on the wrong task
  await h.fetch(`/api/bots/${worker.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WORK-SLOWLY on the wrong thing" }) });
  assert.ok(await waitFor(() => busy(worker.id)), "the worker never started");

  // someone with no say over it is refused, and it keeps working
  const [refused] = await as(stranger.id, [["POST", `/api/bots/${worker.id}/interrupt`, { text: "stop" }]]);
  assert.equal(refused.status, 403);
  assert.equal(await busy(worker.id), true);

  // a plain message says it waits; the lead's stop stops it, and the reason is heard next
  const [said, stopped] = await as(lead.id, [
    ["POST", `/api/bots/${worker.id}/messages`, { text: "also check the totals" }],
    ["POST", `/api/bots/${worker.id}/interrupt`, { text: "STOP, the task is wrong" }],
  ]);
  assert.equal(said.status, 202);
  assert.match(said.body.note, /waits until that turn ends/);
  assert.match(said.body.note, /bloks stop/);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.stopped, true);
  assert.ok(await waitFor(() => (existsSync(heard) && readFileSync(heard, "utf8").includes("STOP, the task is wrong") ? true : null)), "the worker never heard why it was stopped");
  const { messages: workerChat } = await h.json(`/api/bots/${worker.id}/messages?limit=100`);
  assert.ok(workerChat.some((m: any) => m.kind === "notice" && /Lead stopped this turn/.test(m.text)));

  // a room: the senior member may stop the junior, not the other way round, and both may read it
  const peer = await make("Peer", { seniority: 2 });
  const { blok: room } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Launch", memberIds: [lead.id, peer.id] }) });
  const roomId = room?.id ?? (await h.json("/api/bloks")).bloks.find((b: any) => b.name === "Launch").id;
  const [upward] = await as(peer.id, [["POST", `/api/bots/${lead.id}/interrupt`, {}]]);
  assert.equal(upward.status, 403, "a junior stopped its senior");
  const [downward] = await as(lead.id, [["POST", `/api/bots/${peer.id}/interrupt`, {}]]);
  assert.equal(downward.status, 200, JSON.stringify(downward.body));
  assert.equal(downward.body.stopped, false, "nothing was running, and it says so");

  await h.fetch(`/api/bloks/${roomId}/messages`, { method: "POST", body: JSON.stringify({ text: "Launch moves to Friday." }) });
  await idle(lead.id);
  await idle(peer.id);
  const [read] = await as(peer.id, [["GET", `/api/bloks/${roomId}/messages?limit=20`]]);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(read.body.messages.some((m: any) => m.text === "Launch moves to Friday."));
  const [outsider] = await as(stranger.id, [["GET", `/api/bloks/${roomId}/messages`]]);
  assert.ok(outsider.status === 403 || outsider.status === 404, "an agent read a room it is not in");

  // a long instruction, cut short in recall and readable in full
  const long = "ZEBRA instructions: " + "keep every invoice under four hundred, ".repeat(30) + "and the last line matters most.";
  await h.fetch(`/api/bots/${lead.id}/messages`, { method: "POST", body: JSON.stringify({ text: long }) });
  await idle(lead.id);
  const { messages } = await h.json(`/api/bots/${lead.id}/messages?limit=100`);
  const original = messages.find((m: any) => m.text === long);
  const [found, full, foreign] = await as(lead.id, [
    ["GET", `/api/bots/${lead.id}/recall?q=zebra`],
    ["GET", `/api/bots/${lead.id}/recall/${original.id}`],
    ["GET", `/api/bots/${lead.id}/recall/${workerChat[0].id}`],
  ]);
  const hit = found.body.hits.find((x: any) => x.messageId === original.id);
  assert.equal(hit.clipped, true);
  assert.ok(hit.text.length <= 600);
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(full.body.message.text, long);
  assert.equal(full.body.message.by, "person");
  assert.equal(foreign.status, 404, "an agent read a message from another agent's conversation");
});
