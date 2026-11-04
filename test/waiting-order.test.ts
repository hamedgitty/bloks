// Moving waiting words up or down the line, end to end (moveWaiting in
// server/index.ts, server/queue-order.ts): the order the person sets is
// the order the words go in, in an agent's conversation and in a room;
// the transcript and every screen read the same line; and only the
// person, for words that have not started going, can move them.
import assert from "node:assert/strict";
import { test } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const move = (h: Harness, threadId: string, messageId: string, before: unknown) =>
  h.fetch(`/api/threads/${threadId}/messages/${messageId}/move`, { method: "POST", body: JSON.stringify({ before }) });

const texts = (list: any[]) => list.map((m) => m.text);

test("in an agent's conversation, the waiting words go in the order the person put them in", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");

  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST-TURN plan the launch" }) });
  assert.ok(await waitFor(() => fake.sent("FIRST-TURN") > 0), "the first turn never started");
  for (const word of ["ONE", "TWO", "THREE"]) {
    const said = await h.json(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: `WAIT-${word}`, delivery: "wait" }) });
    assert.equal(said.queued, true, `WAIT-${word} did not wait: ${JSON.stringify(said)}`);
  }
  let list = await messagesOf(h, ada);
  const id = (word: string) => list.find((m) => m.text === `WAIT-${word}`)!.id as string;
  const waiting = async () => texts((list = await messagesOf(h, ada)).filter((m) => m.queued));
  assert.deepEqual(await waiting(), ["WAIT-ONE", "WAIT-TWO", "WAIT-THREE"]);

  // the last one to the front
  let res = await move(h, ada.threadId, id("THREE"), id("ONE"));
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.changed, true);
  assert.deepEqual(texts(body.waiting), ["WAIT-THREE", "WAIT-ONE", "WAIT-TWO"]);
  assert.deepEqual(await waiting(), ["WAIT-THREE", "WAIT-ONE", "WAIT-TWO"], "the transcript reads the line as it now is");

  // the first one written to the end of the line
  res = await move(h, ada.threadId, id("ONE"), null);
  body = await res.json();
  assert.deepEqual(texts(body.waiting), ["WAIT-THREE", "WAIT-TWO", "WAIT-ONE"]);

  // asked to stay where it is: nothing changes
  body = await (await move(h, ada.threadId, id("ONE"), null)).json();
  assert.equal(body.changed, false);

  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await waitFor(() => fake.sent("WAIT-ONE") > 0), "the waiting words never went");
  const heard = fake.state.calls.find((c) => c.includes("WAIT-ONE"))!;
  const at = (word: string) => heard.lastIndexOf(`WAIT-${word}`);
  assert.ok(at("THREE") < at("TWO") && at("TWO") < at("ONE"), `heard out of order: ${heard.slice(-400)}`);
  assert.ok(await idle(h, ada));

  // they joined the conversation in that order, and nothing waits now
  list = await messagesOf(h, ada);
  assert.deepEqual(
    texts(list.filter((m) => typeof m.text === "string" && m.text.startsWith("WAIT-"))),
    ["WAIT-THREE", "WAIT-TWO", "WAIT-ONE"],
  );
  assert.equal(list.filter((m) => m.queued).length, 0);

  // words that have gone cannot move, and the refusal says how the line stands
  res = await move(h, ada.threadId, id("TWO"), null);
  assert.equal(res.status, 409);
  body = await res.json();
  assert.match(body.error, /not waiting any more/);
  assert.deepEqual(body.waiting, []);
  assert.equal(body.message?.id, id("TWO"));
});

test("only the person's waiting words move, to a place that is still in the line", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST-TURN go" }) });
  assert.ok(await waitFor(() => fake.sent("FIRST-TURN") > 0));
  await h.json(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WAIT-A", delivery: "wait" }) });
  await h.json(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "WAIT-B", delivery: "wait" }) });
  const list = await messagesOf(h, ada);
  const a = list.find((m) => m.text === "WAIT-A")!.id;
  const b = list.find((m) => m.text === "WAIT-B")!.id;
  const first = list.find((m) => m.text === "FIRST-TURN go")!.id;
  const agents = list.find((m) => m.role === "bot")?.id;

  assert.equal((await move(h, ada.threadId, "no-such-message", null)).status, 404);
  assert.equal((await move(h, ada.threadId, b, 42)).status, 400, "a place is another message's id or null");
  // beside words that already went: not a place in the line
  let res = await move(h, ada.threadId, b, first);
  assert.equal(res.status, 409);
  assert.deepEqual(texts((await res.json()).waiting), ["WAIT-A", "WAIT-B"]);
  if (agents) assert.equal((await move(h, ada.threadId, agents, null)).status, 403, "an agent's own words are its record");
  // a website cannot ask on the person's behalf
  res = await h.fetchAs("https://example.com", `/api/threads/${ada.threadId}/messages/${b}/move`, { method: "POST", body: JSON.stringify({ before: a }) });
  assert.equal(res.status, 403);
  // and an agent's credential is never let near it
  assert.equal(allows(ada.id, "POST", `/api/threads/${ada.threadId}/messages/${b}/move`).ok, false);

  // nothing refused moved anything
  assert.deepEqual(texts((await messagesOf(h, ada)).filter((m) => m.queued)), ["WAIT-A", "WAIT-B"]);
  res = await move(h, ada.threadId, b, a);
  assert.equal(res.status, 200);
  assert.deepEqual(texts((await res.json()).waiting), ["WAIT-B", "WAIT-A"]);
});

test("in a room, the posts waiting behind a round go in the order the person put them in", async (t) => {
  const fake = await fakeProvider(t);
  const h = await startHarness();
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  const ben = await agentOn(h, fake.port, "Ben");
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [ada.id, ben.id] }) });
  const room = async () => (await h.json(`/api/bloks/${blok.id}/messages?limit=200`)).messages as any[];

  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ROOM-ROUND plan the launch" }) });
  assert.ok(await waitFor(() => fake.sent("ROOM-ROUND") > 0), "Ada never spoke");
  for (const word of ["R-ONE", "R-TWO", "R-THREE"]) {
    const res = await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: word }) });
    assert.equal(res.status, 202, `${word} did not wait behind the round`);
  }
  let list = await room();
  const id = (text: string) => list.find((m) => m.text === text)!.id as string;

  let res = await move(h, blok.id, id("R-THREE"), id("R-ONE"));
  assert.equal(res.status, 200);
  assert.deepEqual(texts((await res.json()).waiting), ["R-THREE", "R-ONE", "R-TWO"]);
  res = await move(h, blok.id, id("R-ONE"), null);
  assert.deepEqual(texts((await res.json()).waiting), ["R-THREE", "R-TWO", "R-ONE"]);
  list = await room();
  assert.deepEqual(texts(list.filter((m) => m.queued)), ["R-THREE", "R-TWO", "R-ONE"]);

  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await waitFor(() => fake.sent("R-ONE") > 0), "the last post never went");
  assert.ok(await idle(h, ada));
  assert.ok(await idle(h, ben));
  const firstHeard = (word: string) => fake.state.calls.findIndex((c) => c.includes(word));
  assert.ok(firstHeard("R-THREE") < firstHeard("R-TWO") && firstHeard("R-TWO") < firstHeard("R-ONE"), "the room heard them out of order");
  list = await room();
  assert.deepEqual(texts(list.filter((m) => m.role === "user" && /^R-/.test(m.text ?? ""))), ["R-THREE", "R-TWO", "R-ONE"]);
  assert.equal(list.filter((m) => m.queued).length, 0);
});
