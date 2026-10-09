// One conversation per agent, unless somebody asks for another (GitHub 237).
//
// A routine, a watcher or a webhook that named no conversation used to open
// one of its own ("Routines", "Watching: <name>", "Webhooks"), and after it
// answered, the person's next message, or another agent's, often went there
// instead of to General. Now such work speaks in the agent's first
// conversation. Naming one still works, by its title or by its id, and an
// id is never made into a conversation's title. What was filed before the
// update keeps going where it went.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

const waitFor = async <T,>(check: () => Promise<T | null | undefined> | T | null | undefined, ms = 20_000): Promise<T | null> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

/** A workspace on a throwaway home, with one agent on a chat engine served
 * from this machine. The engine answers "Noted." and remembers what it was
 * asked; while `hold` is set it keeps its answers back. */
async function workspace(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-one-conversation-"));
  const asked: string[] = [];
  const held: Array<() => void> = [];
  const state = { hold: false };
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
      const messages = JSON.parse(body).messages ?? [];
      asked.push(String(messages[messages.length - 1]?.content ?? ""));
      const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Noted." } }] }));
      if (state.hold) held.push(finish);
      else finish();
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    held.splice(0).forEach((f) => f());
    provider.closeAllConnections();
    provider.close();
  });
  const w = {
    home,
    h: await startHarness({ HOME: home }),
    asked,
    state,
    release: () => held.splice(0).forEach((f) => f()),
    botId: "",
    async restart() {
      await w.h.stop();
      w.h = await startHarness({ HOME: home });
    },
    async me() {
      return (await w.h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === w.botId);
    },
    async titles(): Promise<string[]> {
      return (await w.me()).tasks.map((task: any) => task.title);
    },
    async said(laneId: string): Promise<any[]> {
      return (await w.h.json(`/api/bots/${w.botId}/messages?thread=${laneId}&limit=100`)).messages;
    },
    async idle() {
      return waitFor(async () => ((await w.me()).tasks.every((task: any) => task.state !== "working") ? true : null));
    },
    post: (path: string, body: unknown) => w.h.fetch(path, { method: "POST", body: JSON.stringify(body) }),
  };
  // the server first, then its home: only once it has stopped writing there
  t.after(() => w.h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  await w.post("/api/providers/grok/connect", { key: "test-key", url: `http://127.0.0.1:${(provider.address() as { port: number }).port}` });
  const { bot } = await (await w.post("/api/bots", { name: "Contact" })).json();
  w.botId = bot.id;
  await w.h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) });
  return w;
}

type Workspace = Awaited<ReturnType<typeof workspace>>;

/** A folder watcher that has taken its first look, so a change counts. */
async function watching(w: Workspace, name: string, thread?: string) {
  const dir = mkdtempSync(join(w.home, "watched-"));
  const made = await w.post("/api/watchers", {
    botId: w.botId, kind: "folder", target: dir, instruction: `Note the ${name} change.`, name, ...(thread ? { thread } : {}),
  });
  const { watcher } = await made.json();
  assert.equal(made.status, 201, JSON.stringify(watcher));
  await waitFor(async () => ((await w.h.json("/api/watchers")).watchers.find((x: any) => x.id === watcher.id)?.lastCheck ? true : null));
  return {
    id: watcher.id as string,
    async fire(file: string) {
      writeFileSync(join(dir, file), "x");
      const look = await w.h.json(`/api/watchers/${watcher.id}/check`, { method: "POST" });
      assert.equal(look.fired, true, look.note);
    },
  };
}

const routine = async (w: Workspace, name: string, thread?: string) =>
  w.post("/api/routines", { targetId: w.botId, targetKind: "agent", name, prompt: `Run the ${name}.`, time: "08:00", ...(thread ? { thread } : {}) });

const webhook = async (w: Workspace, name: string, thread?: string) =>
  w.post("/api/webhooks", { name, botId: w.botId, ...(thread ? { thread } : {}) });

const fire = (w: Workspace, token: string, payload: unknown) =>
  w.h.fetch(`/hook/${token}`, { method: "POST", body: JSON.stringify(payload) });

test("a routine, a watcher and a webhook that name no conversation speak in General, and open none", async (t) => {
  const w = await workspace(t);
  const general = (await w.me()).tasks[0].id;

  const { routine: daily } = await (await routine(w, "daily digest")).json();
  assert.equal(daily.thread, undefined);
  assert.equal((await w.h.fetch(`/api/routines/${daily.id}/run`, { method: "POST" })).status, 202);
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Run the daily digest."))), "the routine never ran");
  await w.idle();
  assert.ok((await w.said(general)).some((m) => m.via === "routine" && m.text === "Run the daily digest."), "the routine did not run in General");

  const inbox = await watching(w, "inbox");
  await inbox.fire("new.txt");
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Note the inbox change."))), "the watcher never fired");
  await w.idle();
  assert.ok((await w.said(general)).some((m) => m.via === "watcher" && /inbox/.test(m.text)), "the watcher did not speak in General");
  assert.equal((await w.h.json("/api/watchers")).watchers.find((x: any) => x.id === inbox.id).laneId, undefined, "General is nobody's own lane");

  const { webhook: hook } = await (await webhook(w, "Deploys")).json();
  assert.equal(hook.thread, undefined);
  assert.equal((await fire(w, hook.token, { event: "deployed-one" })).status, 202);
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("deployed-one"))), "the webhook never reached the agent");
  await w.idle();
  assert.ok((await w.said(general)).some((m) => /deployed-one/.test(m.text ?? "")), "the webhook did not land in General");

  assert.deepEqual(await w.titles(), ["General"], "background work opened a conversation of its own");

  // General busy with the person: an event waits there, behind their turn
  w.state.hold = true;
  await w.post(`/api/bots/${w.botId}/messages`, { text: "a long question" });
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("a long question"))));
  const busy = await fire(w, hook.token, { event: "deployed-two" });
  assert.equal(busy.status, 202);
  assert.equal((await busy.json()).queued, true);
  const waiting = (await w.said(general)).find((m) => /deployed-two/.test(m.text ?? ""));
  assert.equal(waiting?.queued, true, "the event does not wait in General");
  assert.ok(!w.asked.some((a) => a.includes("deployed-two")), "the event ran beside the person's turn");
  w.state.hold = false;
  w.release();
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("deployed-two"))), "the waiting event never went");
  await w.idle();
  assert.deepEqual(await w.titles(), ["General"]);
});

test("a conversation is named by its title or its id, and an id is never made into a title", async (t) => {
  const w = await workspace(t);
  const general = (await w.me()).tasks[0].id;
  const { bot } = await (await w.post(`/api/bots/${w.botId}/tasks`, { title: "Research" })).json();
  const research = bot.tasks.find((task: any) => task.title === "Research").id;

  // by id: the watcher's turn goes to Research, the routine's to General
  const notes = await watching(w, "notes", research);
  await notes.fire("one.txt");
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Note the notes change."))));
  await w.idle();
  assert.ok((await w.said(research)).some((m) => m.via === "watcher"), "the watcher did not speak in the conversation it named by id");

  const { routine: weekly } = await (await routine(w, "weekly review", general)).json();
  assert.equal(weekly.thread, general);
  await w.h.fetch(`/api/routines/${weekly.id}/run`, { method: "POST" });
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Run the weekly review."))));
  await w.idle();
  assert.ok((await w.said(general)).some((m) => m.via === "routine"), "the routine did not run in the conversation it named by id");

  const { webhook: hook } = await (await webhook(w, "Papers", research)).json();
  assert.equal(hook.thread, research);
  await fire(w, hook.token, { paper: "by-id" });
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("by-id"))));
  await w.idle();
  assert.ok((await w.said(research)).some((m) => /by-id/.test(m.text ?? "")), "the webhook did not land in the conversation it named by id");
  assert.deepEqual(await w.titles(), ["General", "Research"]);

  // an id that is none of this agent's conversations is refused when filed
  const stranger = "0b0e7c0e-5d1a-4c4e-9b51-3d2f6a7b8c9d";
  for (const refused of [await routine(w, "lost", stranger), await webhook(w, "Lost", stranger)]) {
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /not the id of any of Contact's conversations/);
  }
  const lostWatcher = await w.post("/api/watchers", {
    botId: w.botId, kind: "page", target: "https://example.invalid/", instruction: "Act.", name: "lost", thread: stranger,
  });
  assert.equal(lostWatcher.status, 400);
  const moved = await w.h.fetch(`/api/routines/${weekly.id}`, { method: "PATCH", body: JSON.stringify({ thread: stranger }) });
  assert.equal(moved.status, 400);

  // and one whose conversation has since closed sends the work to General
  assert.equal((await w.h.fetch(`/api/bots/${w.botId}/tasks/${research}`, { method: "DELETE" })).status, 200);
  await notes.fire("two.txt");
  assert.ok(await waitFor(() => w.asked.filter((a) => a.includes("Note the notes change.")).length === 2));
  await w.idle();
  assert.equal((await w.said(general)).filter((m) => m.via === "watcher").length, 1, "the work of a closed conversation did not come to General");
  assert.deepEqual(await w.titles(), ["General"], "a conversation was named after an id");
});

test("what was filed before the update keeps running where it ran, and what is filed after stays in General", async (t) => {
  const w = await workspace(t);
  const general = (await w.me()).tasks[0].id;

  // What an older Bloks left: a routine and a webhook that named nothing,
  // a watcher with a lane of its own (which the person has renamed since),
  // and one that never fired, so has none yet. Both watchers name nothing
  // either, as none did then.
  const { routine: brief } = await (await routine(w, "morning brief")).json();
  const { webhook: hook } = await (await webhook(w, "Builds")).json();
  const own = (await (await w.post(`/api/bots/${w.botId}/tasks`, { title: "Inbox watch" })).json()).bot.tasks
    .find((task: any) => task.title === "Inbox watch").id;
  const inbox = await watching(w, "inbox");
  const feed = await watching(w, "feed");

  await w.h.stop();
  const data = join(w.home, ".bloks");
  const rewrite = (file: string, change: (rows: any[]) => any[]) =>
    writeFileSync(join(data, file), JSON.stringify(change(JSON.parse(readFileSync(join(data, file), "utf8")))));
  rewrite("watchers.json", (rows) => rows.map((row) => (row.id === inbox.id ? { ...row, laneId: own } : row)));
  const config = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
  assert.equal(typeof config.oneConversationAt, "number", "the upgrade was not noted");
  delete config.oneConversationAt;
  writeFileSync(join(data, "config.json"), JSON.stringify(config));
  w.h = await startHarness({ HOME: w.home });

  const routines = (await w.h.json("/api/routines")).routines;
  assert.equal(routines.find((r: any) => r.id === brief.id).thread, "Routines");
  assert.equal((await w.h.json("/api/webhooks")).webhooks.find((x: any) => x.id === hook.id).thread, "Webhooks");
  const watchers = (await w.h.json("/api/watchers")).watchers;
  assert.equal(watchers.find((x: any) => x.id === inbox.id).thread, "Inbox watch", "a watcher left the lane it spoke in");
  assert.equal(watchers.find((x: any) => x.id === inbox.id).laneId, own);
  assert.equal(watchers.find((x: any) => x.id === feed.id).thread, "Watching: feed");
  assert.ok((await w.titles()).includes("Inbox watch"), "a lane was closed on the upgrade");

  // each runs where it ran before
  await w.h.fetch(`/api/routines/${brief.id}/run`, { method: "POST" });
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Run the morning brief."))));
  await fire(w, hook.token, { build: "green" });
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("green"))));
  await inbox.fire("new.txt");
  assert.ok(await waitFor(() => w.asked.some((a) => a.includes("Note the inbox change."))));
  await w.idle();
  const lanes = (await w.me()).tasks;
  const lane = (title: string) => lanes.find((task: any) => task.title === title)?.id;
  assert.ok(lane("Routines") && (await w.said(lane("Routines"))).some((m) => m.via === "routine"), "the routine left Routines");
  assert.ok(lane("Webhooks") && (await w.said(lane("Webhooks"))).some((m) => /green/.test(m.text ?? "")), "the webhook left Webhooks");
  assert.ok((await w.said(own)).some((m) => m.via === "watcher"), "the watcher left its own lane");
  assert.ok(!(await w.said(general)).some((m) => m.role === "user"), "older work moved into General");

  // done once: a routine filed now, with no conversation, stays in General
  const { routine: later } = await (await routine(w, "evening wrap")).json();
  await w.restart();
  assert.equal((await w.h.json("/api/routines")).routines.find((r: any) => r.id === later.id).thread, undefined);
});
