// The person's list (server/todos.ts, GitHub 378 and 430): what a routine's
// report found the person has to do themselves, put there by its agent,
// counted with what else waits on them in the morning brief, one line
// however many mornings it is reported, and closed by the person or
// cleared by the agent.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { allows } from "../server/agent-cli.ts";
import { briefNotice, composeBrief, type BriefInput, type BriefResult, type BriefWaiting } from "../server/brief.ts";
import { clearTodo, closeTodo, KEEP_CLOSED_MS, MAX_OPEN_PER_AGENT, pruneTodos, sayTodo, todoKey, type Todo } from "../server/todos.ts";
import { controlledChain, type ChainTurn } from "./helpers/agent-chain.ts";
import { waitFor } from "./helpers/turns.ts";

const CLI = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));
const at = (botId = "bot-a", now = 1_000) => ({ botId, threadId: "lane-a", now });

test("the same thing said again is one line with its newest words, and another agent's key is its own", () => {
  const first = sayTodo([], { title: "Replace the failing disk in the NAS", key: "nas-disk", detail: "sdb has 12 reallocated sectors." }, { ...at(), routine: { id: "r1", name: "Home lab health" } });
  assert.ok(first.ok);
  assert.equal(first.outcome, "added");
  assert.equal(first.todo.routineName, "Home lab health");

  const again = sayTodo(first.list, { title: "Replace the failing NAS disk", key: "NAS-Disk" }, at("bot-a", 2_000));
  assert.ok(again.ok);
  assert.equal(again.outcome, "updated");
  assert.equal(again.list.length, 1, "one thing, once");
  assert.equal(again.todo.id, first.todo.id);
  assert.equal(again.todo.title, "Replace the failing NAS disk");
  assert.equal(again.todo.detail, undefined, "the newest words, not a mix of two reports");
  assert.equal(again.todo.routineId, undefined, "said outside a routine's run now");
  assert.equal(again.todo.times, 2);
  assert.equal(again.todo.firstAt, 1_000);

  const theirs = sayTodo(again.list, { title: "Replace the failing disk in the NAS", key: "nas-disk" }, at("bot-b"));
  assert.ok(theirs.ok);
  assert.equal(theirs.outcome, "added");
  assert.equal(theirs.list.length, 2);
});

test("dismissed stays dismissed, done comes back as a new line, and cleared starts over", () => {
  const said = sayTodo([], { title: "Renew the TLS certificate", key: "tls" }, at());
  assert.ok(said.ok);

  const dismissed = closeTodo(said.list, said.todo.id, "dismissed", 2_000)!;
  const repeat = sayTodo(dismissed.list, { title: "Renew the TLS certificate", key: "tls" }, at("bot-a", 3_000));
  assert.ok(repeat.ok);
  assert.equal(repeat.outcome, "dismissed");
  assert.equal(repeat.todo.state, "dismissed", "a report does not put back what the person waved away");
  assert.equal(repeat.todo.at, 3_000, "kept fresh, so it is not forgotten while it is still being reported");

  const cleared = clearTodo(repeat.list, "bot-a", "TLS", 4_000)!;
  assert.equal(cleared.todo.state, "cleared");
  const back = sayTodo(cleared.list, { title: "Renew the TLS certificate", key: "tls" }, at("bot-a", 5_000));
  assert.ok(back.ok);
  assert.equal(back.outcome, "added");
  assert.notEqual(back.todo.id, said.todo.id);

  const done = closeTodo(back.list, back.todo.id, "done", 6_000)!;
  assert.equal(done.todo.state, "done");
  assert.equal(closeTodo(done.list, back.todo.id, "dismissed", 7_000)!.todo.state, "done", "closed once, it says how");
  const reopened = sayTodo(done.list, { title: "Renew the TLS certificate", key: "tls" }, at("bot-a", 8_000));
  assert.ok(reopened.ok);
  assert.equal(reopened.outcome, "reopened");
  assert.notEqual(reopened.todo.id, back.todo.id, "the line marked done stays done");
  assert.equal(reopened.list.find((t) => t.id === back.todo.id)?.state, "done");
});

test("what a line takes: a few words, a key of letters and digits, and a limit per agent", () => {
  assert.equal(sayTodo([], { title: "no", key: "x" }, at()).ok, false);
  assert.equal(sayTodo([], { title: "Renew it", key: "has space" }, at()).ok, false);
  assert.equal(sayTodo([], { title: "Renew it", key: "-leading" }, at()).ok, false);
  // no key: one made from the title, so the same words are the same thing
  assert.equal(todoKey(undefined, "Reply to the maintainer on #430!"), "reply-to-the-maintainer-on-430");
  const long = sayTodo([], { title: "x ".repeat(200), detail: "y ".repeat(400), key: "long" }, at());
  assert.ok(long.ok);
  assert.ok(long.todo.title.length <= 140 && long.todo.detail!.length <= 500);
  assert.doesNotMatch(long.todo.title, /\s{2}/);

  let list: Todo[] = [];
  for (let i = 0; i < MAX_OPEN_PER_AGENT; i++) {
    const r = sayTodo(list, { title: `Thing number ${i}`, key: `k${i}` }, at());
    assert.ok(r.ok);
    list = r.list;
  }
  const over = sayTodo(list, { title: "One too many", key: "over" }, at());
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /untodo/);
  // the same thing said again is not one more
  assert.equal(sayTodo(list, { title: "Thing number 3", key: "k3" }, at()).ok, true);
  assert.equal(sayTodo(list, { title: "Someone else's", key: "over" }, at("bot-b")).ok, true);
});

test("an open line is never pruned; a closed one goes once it has not been said for a month", () => {
  const now = 10 * KEEP_CLOSED_MS;
  const line = (id: string, state: Todo["state"], age: number): Todo => ({ id, botId: "b", key: id, title: "Something to do", threadId: "l", firstAt: now - age, at: now - age, times: 1, state });
  const kept = pruneTodos([line("old-open", "open", 3 * KEEP_CLOSED_MS), line("old-done", "done", KEEP_CLOSED_MS + 1), line("new-dismissed", "dismissed", 1000)], now);
  assert.deepEqual(kept.map((t) => t.id), ["old-open", "new-dismissed"]);
});

test("the morning brief counts the person's list with what else waits, and its one notification says so", () => {
  const result = (id: string, text: string): BriefResult => ({ key: `routine:${id}`, kind: "routine", id, name: id, state: "reported", text, at: 900, fresh: true, briefOnly: true });
  const todo = (id: string, title: string): BriefWaiting => ({ botId: "b1", name: "Nova", title, threadId: "lane", messageId: id, kind: "todo", todoId: id, since: 500 });
  const input: BriefInput = {
    since: 0,
    now: 1_000,
    agents: [],
    waiting: [],
    spend: { turns: 0, cost: 0, costKnown: false },
    results: [result("health", "2 warnings. Replace the NAS disk."), result("github", "1 reply owed.")],
  };
  // the reporter's morning: two reports, and before this, nothing waiting
  assert.equal(composeBrief(input, "b").headline, "2 reports in, nothing waiting on you.");
  const brief = composeBrief({ ...input, waiting: [todo("t1", "Replace the failing disk in the NAS"), todo("t2", "Reply to the maintainer on #430")] }, "b");
  assert.equal(brief.headline, "2 reports in, 2 things waiting on you.");
  assert.equal(brief.quiet, false);
  assert.deepEqual(briefNotice(brief, { notify: true, allClear: false }), { title: "Your morning brief is ready", body: "2 reports in, 2 things waiting on you." });
  const closing = brief.parts[brief.parts.length - 1];
  assert.match(closing.script, /For you, from Nova: Replace the failing disk in the NAS/);
  // a line on the list alone is not a quiet night
  assert.equal(composeBrief({ ...input, results: [], waiting: [todo("t1", "Renew the certificate")] }, "b").quiet, false);
});

test("an agent reaches its own lines and nobody else's, and never the person's list", () => {
  assert.equal(allows("bot-a", "GET", "/api/bots/bot-a/todos").ok, true);
  assert.equal(allows("bot-a", "POST", "/api/bots/bot-a/todos").ok, true);
  assert.equal(allows("bot-a", "DELETE", "/api/bots/bot-a/todos/nas-disk").ok, true);
  assert.equal(allows("bot-a", "POST", "/api/bots/bot-b/todos").ok, false);
  assert.equal(allows("bot-a", "DELETE", "/api/bots/bot-b/todos/nas-disk").ok, false);
  assert.equal(allows("bot-a", "GET", "/api/todos").ok, false);
  assert.equal(allows("bot-a", "POST", "/api/todos/t1/done").ok, false);
  assert.match(allows("bot-a", "POST", "/api/todos/t1/dismiss").reason ?? "", /not something an agent can reach/);
});

async function bloks(url: string, turn: ChainTurn, home: string, args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { HOME: home, BLOKS_URL: url, BLOKS_TOKEN: turn.token } });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { exit, err, body: out.trim() ? JSON.parse(out) : null };
}

test("a routine's run puts a line on the list, the brief counts it once, and the person closes it", async (t) => {
  const f = await controlledChain(t);
  const nova = await f.hire("Nova");
  const ivy = await f.hire("Ivy");
  const { routine } = await f.h.json("/api/routines", {
    method: "POST",
    body: JSON.stringify({ targetId: nova.id, targetKind: "agent", name: "Home lab health", prompt: "Check the home lab and report.", time: "07:00", days: [], briefOnly: true }),
  });
  const before = f.turns().length;
  assert.equal((await f.h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
  const run = await f.turnAfter(before);
  // the run is told how, in its own words, with its own command line
  assert.match(run.text, /^\(Your routine "Home lab health" was run by hand\. Your answer is shown on this routine.s card[^)]* If it finds something the person has to do themselves, put it on their list with `[^`]+ todo "<what to do>" --key <name>`/);
  assert.match(run.text, /untodo <name>/);

  const said = await bloks(f.h.url, run, f.home, ["todo", "Replace the failing disk in the NAS", "--key", "nas-disk", "--detail", "sdb has 12 reallocated sectors."]);
  assert.equal(said.exit, 0, said.err || JSON.stringify(said.body));
  assert.equal(said.body.outcome, "added");
  assert.equal(said.body.todo.key, "nas-disk");
  const again = await bloks(f.h.url, run, f.home, ["todo", "Replace the failing NAS disk", "--key", "nas-disk"]);
  assert.equal(again.body.outcome, "updated");

  // the person's list: one line, linked to its report and its routine
  let { waiting } = await f.h.json("/api/waiting");
  let line = waiting.filter((w: any) => w.kind === "todo");
  assert.equal(line.length, 1);
  assert.equal(line[0].title, "Replace the failing NAS disk");
  assert.equal(line[0].name, "Nova");
  assert.equal(line[0].routine, "Home lab health");
  assert.equal(line[0].threadId, nova.threadId, "where the report is");
  assert.equal(line[0].messageId, line[0].todoId);
  const { brief } = await f.h.json("/api/briefs", { method: "POST" });
  assert.match(brief.headline, /1 thing waiting on you/);
  assert.equal(brief.waiting.filter((w: any) => w.kind === "todo").length, 1);
  const listed = await f.h.json("/api/briefs");
  assert.equal(listed.todos.length, 1);
  assert.equal(listed.todos[0].state, "open");

  // another agent: its own keys, never Nova's lines, never the person's list
  const other = await f.begin(ivy);
  assert.deepEqual((await bloks(f.h.url, other, f.home, ["todos"])).body, []);
  assert.equal((await bloks(f.h.url, other, f.home, ["untodo", "nas-disk"])).exit, 1);
  assert.equal((await f.agent(other, `/api/bots/${nova.id}/todos`, { title: "Ignore the disk", key: "nas-disk" })).status, 403);
  assert.equal((await f.agent(other, `/api/bots/${nova.id}/todos/nas-disk`, undefined, "DELETE")).status, 403);
  assert.equal((await f.agent(other, "/api/todos", undefined, "GET")).status, 403);
  assert.equal((await f.agent(other, `/api/todos/${line[0].todoId}/dismiss`)).status, 403);
  // and the person's own route never takes a line from anyone but an agent
  assert.equal((await f.h.fetch(`/api/bots/${nova.id}/todos`, { method: "POST", body: JSON.stringify({ title: "Written by hand", key: "hand" }) })).status, 403);

  // the person dismisses it, and the next report leaves it off the list
  const closed = await f.h.json(`/api/todos/${line[0].todoId}/dismiss`, { method: "POST" });
  assert.equal(closed.todo.state, "dismissed");
  const reported = await bloks(f.h.url, run, f.home, ["todo", "Replace the failing NAS disk", "--key", "nas-disk"]);
  assert.equal(reported.body.outcome, "dismissed");
  assert.match(reported.body.note, /dismissed/);
  ({ waiting } = await f.h.json("/api/waiting"));
  assert.equal(waiting.filter((w: any) => w.kind === "todo").length, 0);

  // fixed and back again: cleared, then a new line; done, then reopened
  assert.equal((await bloks(f.h.url, run, f.home, ["untodo", "nas-disk"])).body.todo.state, "cleared");
  const anew = await bloks(f.h.url, run, f.home, ["todo", "Replace the failing NAS disk", "--key", "nas-disk"]);
  assert.equal(anew.body.outcome, "added");
  ({ waiting } = await f.h.json("/api/waiting"));
  line = waiting.filter((w: any) => w.kind === "todo");
  assert.equal(line.length, 1);
  assert.equal((await f.h.json(`/api/todos/${line[0].todoId}/done`, { method: "POST" })).todo.state, "done");
  assert.equal((await f.h.fetch(`/api/todos/${line[0].todoId}/done`, { method: "POST" })).status, 200, "closing it twice says how it was closed");
  assert.equal((await bloks(f.h.url, run, f.home, ["todo", "Replace the failing NAS disk", "--key", "nas-disk"])).body.outcome, "reopened");
  const mine = (await bloks(f.h.url, run, f.home, ["todos"])).body;
  // the dismissed line was cleared, the next marked done, the last is open
  assert.deepEqual(mine.map((x: any) => x.state).sort(), ["cleared", "done", "open"]);

  // an archived agent's lines wait with it, and one deleted for good
  // takes them along
  await f.finish(run, nova);
  assert.equal((await f.h.fetch(`/api/bots/${nova.id}`, { method: "DELETE" })).status, 200);
  assert.ok(await waitFor(async () => ((await f.h.json("/api/todos")).todos.length === 0 ? true : null), 5_000));
  assert.equal((await f.h.json("/api/waiting")).waiting.filter((w: any) => w.kind === "todo").length, 0);
  assert.equal((await f.h.fetch(`/api/bots/${nova.id}/restore`, { method: "POST" })).status, 200);
  assert.equal((await f.h.json("/api/todos")).todos.filter((x: any) => x.state === "open").length, 1, "back with the agent");
  assert.equal((await f.h.fetch(`/api/bots/${nova.id}?forget=1`, { method: "DELETE" })).status, 200);
  assert.ok(await waitFor(async () => ((await f.h.json("/api/todos")).todos.length === 0 ? true : null), 5_000));
  assert.equal((await f.h.fetch("/api/todos/nope/done", { method: "POST" })).status, 404);
});
