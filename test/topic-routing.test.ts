// GitHub 523: the room's lead routing work into topics, in the request
// path. Nothing moves until the owner lets the lead route in that room;
// then the lead is told each person's message's id and the open topics,
// and may move one into a topic or a new one. Only the lead, only a
// person's main-stream words, each once, the move said in the main stream,
// and only the topic's agents woken there. An agent in a topic with a
// folder is told whether Bloks holds its writes to it, and Claude Code is
// handed the hook that does.
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

test("the lead moves people's messages into topics only once the owner lets it, and says so", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-topic-routing-"));
  const answers = join(home, "answers.json");
  const heard = join(home, "heard.log");
  const cli = join(home, "fake-claude.mjs");
  const project = join(home, "project");
  mkdirSync(join(project, "src", "auth"), { recursive: true });
  writeFileSync(
    cli,
    `#!${process.execPath}
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; if (typeof input !== "undefined") input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  const persona = process.argv.indexOf("--append-system-prompt-file");
  const told = persona > 0 ? readFileSync(process.argv[persona + 1], "utf8") : "";
  appendFileSync(${JSON.stringify(heard)}, "ARGV " + JSON.stringify(process.argv.slice(2)) + "\\n" + told + input + "\\n----\\n");
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s-" + Math.random().toString(36).slice(2), model: "claude-sonnet-5" }));
  // the newest CALLS: a carried-over conversation can hold earlier ones
  const asked = [...input.matchAll(/CALLS ([A-Za-z0-9+\\/=]+)/g)].at(-1);
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
  const make = async (name: string) => {
    const made = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    assert.ok(made.bot?.id, JSON.stringify(made));
    const bot = made.bot;
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify(claude) });
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
  const prompts = () => (existsSync(heard) ? readFileSync(heard, "utf8").split("\n----\n") : []);
  const roomMessages = async (id: string) => (await h.json(`/api/bloks/${id}/messages`)).messages as any[];

  const marlow = await make("Marlow");
  const ada = await make("Ada");
  const sam = await make("Sam");
  const made = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Core", memberIds: [marlow.id, ada.id, sam.id], leadId: marlow.id }) });
  const room = made.blok.id as string;
  assert.equal((await h.fetch(`/api/bloks/${room}`, { method: "PATCH", body: JSON.stringify({ answers: "lead", cwd: project }) })).status, 200);
  const opened = await h.json(`/api/bloks/${room}/topics`, { method: "POST", body: JSON.stringify({ title: "Auth", folder: "src/auth", agents: [ada.id] }) });
  const auth = opened.topic.id as string;

  // the person writes in the main stream; with routing off the lead is
  // told nothing about moving it
  await h.fetch(`/api/bloks/${room}/messages`, { method: "POST", body: JSON.stringify({ text: "Please fix the login bug." }) });
  await waitFor(() => prompts().some((p) => p.includes("Please fix the login bug.")));
  await idle(marlow.id);
  const first = (await roomMessages(room)).find((m) => m.text === "Please fix the login bug.");
  assert.ok(first?.id);
  assert.equal(prompts().some((p) => p.includes("may route work into topics")), false);
  const move = (body: Record<string, unknown>) => ["POST", `/api/bloks/${room}/topics/move`, body];

  // not yet: the owner has not let the lead route, and no agent can
  const [notLet, selfLet] = await as(marlow.id, [move({ messageId: first.id, topicId: auth }), ["PATCH", `/api/bloks/${room}`, { leadRoutes: true }]]);
  assert.equal(notLet.status, 403, JSON.stringify(notLet.body));
  assert.match(notLet.body.error, /has not let this room's lead/);
  assert.equal(selfLet.status, 403, JSON.stringify(selfLet.body));

  // the owner lets it; another agent still cannot
  assert.equal((await h.fetch(`/api/bloks/${room}`, { method: "PATCH", body: JSON.stringify({ leadRoutes: true }) })).status, 200);
  const [notLead] = await as(ada.id, [move({ messageId: first.id, topicId: auth })]);
  assert.equal(notLead.status, 403, JSON.stringify(notLead.body));

  // a new message: the lead is told its id, the open topics and the command
  await h.fetch(`/api/bloks/${room}/messages`, { method: "POST", body: JSON.stringify({ text: "We also need a sign up page." }) });
  const second = await waitFor(async () => (await roomMessages(room)).find((m) => m.text === "We also need a sign up page."));
  assert.ok(second?.id);
  // (the prompt is logged as the JSON line it arrived in, quotes escaped)
  assert.ok(await waitFor(() => prompts().some((p) => p.includes(`This message is ${second.id}`) && p.includes(`Auth\\" (${auth})`))), "the lead was never told how to route");
  await idle(marlow.id);

  // the lead moves the first into Auth: it wakes Ada there, and the main
  // stream says so
  const [moved, again, stranger, agentWords] = await as(marlow.id, [
    move({ messageId: first.id, topicId: auth }),
    move({ messageId: first.id, topicId: auth }),
    move({ messageId: second.id, topicId: auth, to: [sam.id] }),
    move({ messageId: (await roomMessages(room)).find((m) => m.from)?.id, topicId: auth }),
  ]);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.woke, ["Ada"]);
  assert.equal(again.status, 409, "a message moves once: " + JSON.stringify(again.body));
  assert.equal(stranger.status, 409, "only the topic's agents are woken there");
  assert.equal(agentWords.status, 400, "an agent's words are not the lead's to move");
  const after = await roomMessages(room);
  const filed = after.find((m) => m.id === first.id);
  assert.equal(filed.topicId, auth);
  assert.equal(filed.moved?.by, `agent:${marlow.id}`);
  assert.ok(after.some((m) => m.kind === "notice" && !m.topicId && /Marlow moved .*message into the topic "Auth": "Please fix the login bug\."/.test(m.text)), "the move was not said in the main stream");

  // Ada answers it in the topic, told the folder is held, and Claude Code
  // is handed the hook with the topic's folder
  const adaTurn = await waitFor(() => prompts().find((p) => p.includes("Please fix the login bug.") && p.includes('room\'s topic \\"Auth\\"')));
  assert.ok(adaTurn, "Ada was never woken in the topic");
  assert.match(adaTurn!, /Bloks holds your file tools to it/);
  const argv = JSON.parse(adaTurn!.match(/^ARGV (.*)$/m)![1]) as string[];
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
  const hook = settings.hooks.PreToolUse[0].hooks[0].command as string;
  assert.ok(hook.includes("topic-folder-hook"), hook);
  assert.ok(hook.includes(join(project, "src", "auth")), hook);
  await idle(ada.id);

  // and a new topic for new work, waking only whom the lead names
  const [fresh] = await as(marlow.id, [move({ messageId: second.id, title: "Sign up page", category: "Frontend", to: [sam.id] })]);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.topic.title, "Sign up page");
  assert.deepEqual(fresh.body.woke, ["Sam"]);
  const topics = (await h.json("/api/bloks?messages=0")).bloks.find((b: any) => b.id === room).topics;
  assert.equal(topics.find((tp: any) => tp.title === "Sign up page")?.createdBy, `agent:${marlow.id}`);
  assert.ok(await waitFor(() => prompts().some((p) => p.includes("We also need a sign up page.") && p.includes('topic \\"Sign up page\\"'))), "Sam was never woken in the new topic");
  // Sam is not in a topic with a folder, so it is handed no hook
  await idle(sam.id);

  // a workflow's post step opens a topic of its own and posts into it
  const made2 = await h.json("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Release",
      trigger: { kind: "manual" },
      steps: [{ id: "open", action: "post", targetId: room, text: "Run the release checks.", newTopic: { title: "Release check", category: "Ops" } }],
    }),
  });
  const workflow = made2.workflow ?? made2;
  assert.ok(workflow.id, JSON.stringify(made2));
  await h.fetch(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  const release = await waitFor(async () => (await h.json("/api/bloks?messages=0")).bloks.find((b: any) => b.id === room).topics.find((tp: any) => tp.title === "Release check"));
  assert.ok(release, "the workflow opened no topic");
  assert.equal(release.category, "Ops");
  const posted = await waitFor(async () => (await roomMessages(room)).find((m) => m.text === "Run the release checks."));
  assert.equal(posted?.topicId, release.id);
  assert.ok((await roomMessages(room)).some((m) => m.kind === "notice" && m.text === 'The workflow "Release" opened the topic "Release check".'));
  await idle(marlow.id);
});
