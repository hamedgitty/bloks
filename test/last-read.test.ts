// Where each person left off (server/last-read.ts): the place kept per
// person per conversation, where the "New" line goes from it, and the
// routes that move it, against the real server. A place is its person's
// alone: nobody else is ever told where somebody left off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LastRead, newFrom, wroteIt, type Said } from "../server/last-read.ts";
import { memberCan } from "../server/member-access.ts";
import { startHarness } from "./helpers/server.ts";
import { teamPlan } from "./helpers/team-plan.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";
import { JoinClient } from "../server/join-client.ts";

const order = ["m1", "m2", "m3", "m4"];

test("a place moves forward as it is read, back only when marked unread, survives a restart, and goes with its person", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-last-read-"));
  try {
    const file = join(dir, "last-read.json");
    let now = 100;
    const places = new LastRead(file, () => now);
    assert.equal(places.of("t1", "owner"), null);
    assert.equal(places.readTo("t1", "owner", "m2", order), true);
    assert.deepEqual(places.of("t1", "owner"), { after: "m2", at: 100 });
    now = 200;
    assert.equal(places.readTo("t1", "owner", "m1", order), false, "an older word arriving late takes nothing back");
    assert.equal(places.readTo("t1", "owner", "m2", order), false, "the same place is no news");
    assert.equal(places.readTo("t1", "owner", "ghost", order), false, "a message that is not there");
    assert.equal(places.readToEnd("t1", "owner", order), true);
    assert.equal(places.of("t1", "owner")?.after, "m4");

    // marked unread from a message: just before it, back as far as asked
    assert.equal(places.unreadFrom("t1", "owner", "m3", order), true);
    assert.equal(places.of("t1", "owner")?.after, "m2");
    assert.equal(places.unreadFrom("t1", "owner", "m1", order), true);
    assert.deepEqual(places.of("t1", "owner"), { after: null, at: 200 }, "from the very first is before everything");
    assert.equal(places.unreadFrom("t1", "owner", "ghost", order), false);
    assert.equal(places.readTo("t1", "owner", "m1", order), true, "read on from before everything");

    // a place on a message that is gone moves on rather than sticking
    places.readTo("t2", "p_sam", "m3", order);
    assert.equal(places.readTo("t2", "p_sam", "m1", ["m1", "m2"]), true);
    places.readTo("t2", "owner", "m2", order);

    const again = new LastRead(file);
    assert.equal(again.of("t1", "owner")?.after, "m1");
    assert.equal(again.of("t2", "p_sam")?.after, "m1");
    again.forgetPerson("p_sam");
    assert.equal(new LastRead(file).of("t2", "p_sam"), null);
    assert.equal(new LastRead(file).of("t2", "owner")?.after, "m2", "only that person's go");
    again.forgetThread("t2");
    assert.equal(new LastRead(file).of("t2", "owner"), null);
    assert.equal(new LastRead(file).of("t1", "owner")?.after, "m1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved file with nonsense in it keeps only what is well formed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-last-read-"));
  try {
    const file = join(dir, "last-read.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        threads: {
          t1: { owner: { after: "m1", at: 1 }, "bad id!": { after: "m1", at: 1 }, p_x: { after: 5, at: 1 }, p_y: { after: null, at: 2 } },
          "../up": { owner: { after: "m1", at: 1 } },
        },
      }),
    );
    const places = new LastRead(file);
    assert.deepEqual(places.of("t1", "owner"), { after: "m1", at: 1 });
    assert.deepEqual(places.of("t1", "p_y"), { after: null, at: 2 });
    assert.equal(places.of("t1", "p_x"), null);
    assert.equal(places.of("../up", "owner"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const bot = (id: string, text?: Partial<Said>): Said => ({ id, role: "bot", kind: "text", ...text });
const you = (id: string, more?: Partial<Said>): Said => ({ id, role: "user", kind: "text", ...more });
const owner = wroteIt("owner");
const at = (after: string | null) => ({ after, at: 1 });

test("the line goes above the first thing since, when anything since is news", () => {
  const said = [you("a"), bot("b"), you("c"), bot("d", { kind: "activity" }), bot("e")];
  assert.equal(newFrom(said, at("c"), owner), "d", "a turn that ran while they were away is new from its start");
  assert.equal(newFrom(said, at("b"), owner), "d", "their own words are never news to them");
  assert.equal(newFrom(said, at("e"), owner), null, "read to the end");
  assert.equal(newFrom(said, null, owner), null, "no place kept yet: no line rather than a guess");
  assert.equal(newFrom(said, at("gone"), owner), null, "a place on a message no longer there");
  assert.equal(newFrom(said, at(null), owner), "b", "marked unread from the very first");
});

test("what is not news: work still going, quiet check-ins, markers, other agents, machines, words still waiting", () => {
  // opened while a turn streams: only its tool calls so far
  assert.equal(newFrom([you("a"), bot("b", { kind: "activity" }), bot("c", { kind: "screen" })], at("a"), owner), null);
  // a quiet routine run, and the engine's own markers
  assert.equal(
    newFrom([you("a"), you("q1", { via: "routine", quiet: true }), bot("q2", { quiet: true }), bot("k", { kind: "notice", compaction: {} }), bot("r", { kind: "notice", sessionReset: true })], at("a"), owner),
    null,
  );
  // a message to or from another agent, and a routine's prompt on its own
  assert.equal(newFrom([you("a"), you("x", { agent: { dir: "in" } }), bot("y", { kind: "activity", agent: { dir: "out" } }), you("z", { via: "watcher" })], at("a"), owner), null);
  // words of their own still waiting to go, and words taken back
  assert.equal(newFrom([you("a"), you("w", { queued: true }), bot("d", { deleted: true })], at("a"), owner), null);
  // but the reply a quiet run is followed by is
  assert.equal(newFrom([you("a"), bot("q", { quiet: true }), bot("r")], at("a"), owner), "r");
  // and a reply written for the agent that asked counts as its words
  assert.equal(newFrom([you("a"), bot("r", { agent: { dir: "reply" } })], at("a"), owner), "r");
  // a card, a file and a notice are news
  for (const kind of ["options", "artifact", "notice", "component", "changes"]) assert.equal(newFrom([you("a"), bot("n", { kind })], at("a"), owner), "n", kind);
});

test("whose words are whose: the owner's carry no author, a member's carry theirs, anybody else's are news", () => {
  const sam = wroteIt("p_sam");
  const team = [you("o1"), you("s1", { author: "p_sam" }), you("a1", { author: "p_ana" })];
  assert.equal(newFrom(team, at("o1"), owner), "s1", "Sam's words are news to the owner");
  assert.equal(newFrom(team, at("o1"), sam), "a1", "but not to Sam, who wrote them");
  assert.equal(newFrom(team.slice(0, 2), at("o1"), sam), null);
  assert.equal(newFrom([you("s1", { author: "p_sam" }), you("o1")], at("s1"), sam), "o1", "the owner's words are news to Sam");
  assert.equal(newFrom([you("o1"), you("t1", { telegramPerson: { name: "Kim" } })], at("o1"), owner), "t1", "somebody on Telegram");
  assert.equal(newFrom([you("o1"), you("t1", { via: "email" })], at("o1"), owner), "t1", "somebody by mail");
});

test("the member route for a place is a member's and a guest's", () => {
  assert.deepEqual(memberCan("POST", "/api/member/threads/t_1/last-read", () => null, () => false, "member"), { ok: true, action: { kind: "lastRead", threadId: "t_1" } });
  assert.equal(memberCan("POST", "/api/member/threads/t_1/last-read", () => null, () => false, null).ok, true);
  assert.equal(memberCan("GET", "/api/member/threads/t_1/last-read", () => null, () => false, "member").ok, false, "there is nothing to read back");
  assert.equal(memberCan("POST", "/api/member/threads/t_1/unread-from", () => null, () => false, "member").ok, false, "a member has no unread to mark");
});

test("the owner's place: opened, read on, read by opening on another screen, and read by writing", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const provider = await fakeProvider(t);
  provider.state.answerAtOnce = true;
  const chief = await agentOn(h, provider.port, "Chief");
  const post = (path: string, body: unknown) => h.fetch(path, { method: "POST", body: JSON.stringify(body) });
  const lastRead = async (through?: string) => (await (await post(`/api/threads/${chief.threadId}/last-read`, through ? { through } : {})).json()).from;
  const talk = async (text: string) => {
    await post(`/api/bots/${chief.id}/messages`, { text, taskId: chief.threadId });
    await idle(h, chief);
    const said = await waitFor(async () => {
      const all = await messagesOf(h, chief);
      const at = all.findIndex((m) => m.text === text);
      return at >= 0 && all.slice(at).some((m) => m.role === "bot" && m.kind === "text") ? all : null;
    });
    assert.ok(said);
    return { said, reply: said.findLast((m: any) => m.role === "bot" && m.kind === "text").id as string };
  };

  // nothing kept yet: no line
  assert.equal(await lastRead(), null);
  // writing read it to then: the reply that came after is where the line goes
  const first = await talk("first");
  assert.equal(await lastRead(), first.reply, "asking moves nothing");
  assert.equal(await lastRead(first.said.at(-1).id), first.reply);
  assert.equal(await lastRead(), null, "and opening it read it");

  // a screen that keeps its own place opens it without reading it
  const second = await talk("second");
  await h.fetch(`/api/bots/${chief.id}/tasks/${chief.threadId}/activate`, { method: "POST", body: JSON.stringify({ keepsPlace: true }) });
  await h.fetch(`/api/bots/${chief.id}`, { method: "PATCH", body: JSON.stringify({ unread: false, keepsPlace: true }) });
  assert.equal(await lastRead(), second.reply, "still there for the app's own chat");
  // one that does not (an older app, the iPhone's) reads it by opening it
  await h.fetch(`/api/bots/${chief.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) });
  assert.equal(await lastRead(), null);
  const third = await talk("third");
  await h.fetch(`/api/bots/${chief.id}/tasks/${chief.threadId}/activate`, { method: "POST" });
  assert.equal(await lastRead(), null, "opened there, read there");
  assert.ok(third.reply);

  // what comes back refused
  assert.equal((await post(`/api/threads/${chief.threadId}/last-read`, { through: 5 })).status, 400);
  assert.equal((await post("/api/threads/t_missing/last-read", {})).status, 404);

  // clearing the conversation takes its place with it
  await talk("fourth");
  assert.ok(await lastRead());
  assert.equal((await h.fetch(`/api/bots/${chief.id}/tasks/${chief.threadId}/clear`, { method: "POST" })).status, 200);
  assert.equal(await lastRead(), null);
});

test("Mark unread from here: the place goes back to just before a message, and the conversation is unread again", async (t) => {
  const h = await startHarness();
  t.after(() => h.stop());
  const provider = await fakeProvider(t);
  provider.state.answerAtOnce = true;
  const chief = await agentOn(h, provider.port, "Chief");
  const post = (path: string, body: unknown) => h.fetch(path, { method: "POST", body: JSON.stringify(body) });
  const lastRead = async (through?: string) => (await (await post(`/api/threads/${chief.threadId}/last-read`, through ? { through } : {})).json()).from;
  for (const text of ["first", "second"]) {
    await post(`/api/bots/${chief.id}/messages`, { text, taskId: chief.threadId });
    await idle(h, chief);
  }
  const said = await waitFor(async () => {
    const all = await messagesOf(h, chief);
    return all.filter((m) => m.role === "bot" && m.kind === "text").length >= 3 ? all : null;
  });
  assert.ok(said);
  const replies = said.filter((m: any) => m.role === "bot" && m.kind === "text");
  const answer = replies.at(-2).id as string;
  await lastRead(said.at(-1).id);
  assert.equal(await lastRead(), null, "read to the end");

  // from an earlier answer: the line goes above it, and the dot is back
  const marked = await post(`/api/threads/${chief.threadId}/unread-from`, { messageId: answer });
  assert.equal(marked.status, 200);
  assert.deepEqual(await marked.json(), { from: answer });
  const { bots } = await h.json("/api/bots");
  const shown = bots.find((b: any) => b.id === chief.id);
  assert.equal(shown.tasks[0].unread, true);
  assert.equal(shown.unread, true, "the agent's own flag follows, for the iPhone and the Dock");
  // every screen opens it there, until it is read again
  assert.equal(await lastRead(), answer);
  assert.equal(await lastRead(said.at(-1).id), answer);
  assert.equal(await lastRead(), null);

  // from the very first message: everything after is new
  assert.deepEqual(await (await post(`/api/threads/${chief.threadId}/unread-from`, { messageId: said[0].id })).json(), { from: said[0].id });

  // what is refused: no such message, no message named, no such conversation
  assert.equal((await post(`/api/threads/${chief.threadId}/unread-from`, { messageId: "nope" })).status, 404);
  assert.equal((await post(`/api/threads/${chief.threadId}/unread-from`, {})).status, 400);
  assert.equal((await post("/api/threads/t_missing/unread-from", { messageId: answer })).status, 404);
});

async function workspace(t: { after(fn: () => unknown): void }) {
  const home = mkdtempSync(join(tmpdir(), "bloks-team-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  const licence = await teamPlan();
  t.after(() => licence.close());
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ remote: { enabled: true }, profile: { name: "Hamed" }, ...licence.config }));
  const h = await startHarness({ HOME: home, ...licence.env });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lan = new URL(h.url).host;
  async function joinAs(name: string) {
    const made = await h.json("/api/workspace/invites", { method: "POST", body: JSON.stringify({ role: "member", name }) });
    const client = new JoinClient(() => "http://127.0.0.1:9");
    const found = (await client.lookup(`${made.invite.link}~${lan}`)) as any;
    await client.claim(found.session, { name });
    assert.equal((await h.fetch(`/api/workspace/requests/${made.invite.id}/approve`, { method: "POST" })).status, 200);
    return ((await client.status(found.session)) as any).credentials as { deviceToken: string; personId: string };
  }
  const as = (who: { deviceToken: string }, path: string, init: { method?: string; body?: unknown } = {}) =>
    h.fetchRemote(path, { method: init.method ?? "GET", token: who.deviceToken, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return { h, joinAs, as };
}

test("in a team conversation each person's place is their own, and nobody is told anybody else's", async (t) => {
  const { h, joinAs, as } = await workspace(t);
  const provider = await fakeProvider(t);
  provider.state.answerAtOnce = true;
  const chief = await agentOn(h, provider.port, "Chief");
  const sam = await joinAs("Sam");
  const ana = await joinAs("Ana");
  const say = async (text: string) => {
    assert.equal((await as(sam, `/api/member/agents/${chief.id}/team/messages`, { method: "POST", body: { text } })).status, 202);
    await idle(h, chief);
    const said = await waitFor(async () => {
      const list = (await as(sam, `/api/member/agents/${chief.id}/team/messages`)).body.messages as any[];
      const at = list.findIndex((m) => m.text === text);
      return at >= 0 && list.slice(at).some((m) => m.role === "bot" && m.kind === "text") ? list : null;
    });
    assert.ok(said);
    return { words: said.find((m) => m.text === text).id as string, reply: said.findLast((m: any) => m.role === "bot" && m.kind === "text").id as string };
  };

  // Sam writes in the team conversation and Chief answers
  const hello = await say("hello team");
  const threadId = (await as(sam, `/api/member/agents/${chief.id}/team/messages`)).body.threadId;
  const place = async (who: { deviceToken: string }, through?: string) =>
    (await as(who, `/api/member/threads/${threadId}/last-read`, { method: "POST", body: through ? { through } : {} })).body;
  // writing read it for Sam up to his words: the answer is his news
  assert.deepEqual(await place(sam, hello.reply), { from: hello.reply });
  // nothing kept for Ana yet: no line rather than a guess, kept from here
  assert.deepEqual(await place(ana, hello.reply), { from: null });

  // Sam writes again: for Ana the line goes above his words, for Sam
  // above the answer, since his own words are never news to him
  const second = await say("second");
  assert.deepEqual(await place(ana), { from: second.words });
  assert.deepEqual(await place(sam), { from: second.reply });

  // the owner's place is the owner's: Sam's words are news to them too,
  // and the owner reading moves nothing of Ana's
  const owner = (body: unknown) => h.fetch(`/api/threads/${threadId}/last-read`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  assert.deepEqual(await owner({ through: hello.reply }), { from: null }, "nothing kept for the owner yet");
  assert.deepEqual(await owner({ through: second.reply }), { from: second.words });
  assert.deepEqual(await owner({}), { from: null });
  assert.deepEqual(await place(ana), { from: second.words }, "Ana's place is where she left it");

  // Sam's private conversation: nobody else keeps a place there
  await as(sam, `/api/member/agents/${chief.id}/private/messages`, { method: "POST", body: { text: "just me" } });
  const mine = (await as(sam, `/api/member/agents/${chief.id}/private/messages`)).body;
  assert.equal((await as(sam, `/api/member/threads/${mine.threadId}/last-read`, { method: "POST", body: {} })).status, 200);
  assert.equal((await as(ana, `/api/member/threads/${mine.threadId}/last-read`, { method: "POST", body: {} })).status, 404);
  assert.equal((await h.fetch(`/api/threads/${mine.threadId}/last-read`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await h.fetch(`/api/threads/${mine.threadId}/unread-from`, { method: "POST", body: JSON.stringify({ messageId: mine.messages[0].id }) })).status, 404);

  // no transcript carries a place, anybody's
  const owners = await h.json(`/api/bots/${chief.id}/messages?thread=${threadId}`);
  assert.equal(JSON.stringify(owners).includes("\"after\""), false);
  assert.equal(JSON.stringify((await as(ana, `/api/member/agents/${chief.id}/team/messages`)).body).includes("\"after\""), false);
});

