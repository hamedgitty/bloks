// Which conversation an agent may name when it writes (GitHub 494). A lane
// id is a capability: words written to one arrive as that conversation's
// next turn. An agent names one of its own conversations, the recipient's
// first one, one it opened with `bloks tab`, or one it is already in
// exchange with, either way round. Anything else is refused with the rule,
// before anything is written, and a member's private conversation is never
// named by an agent at all. The person's own credential is unaffected.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reporting } from "./helpers/report-reserve.ts";

const RULE = /can name only one of its own conversations, .+'s first one, one it opened with `bloks tab`, or one it is already in exchange with/;
const PRIVATE = /a person's private conversation/;

test("an agent names its own, the first, one it opened, or one in exchange; anything else is refused unwritten", async (t) => {
  const f = await reporting(t);
  const { sender, target } = f;
  const lane = async (bot: any, title: string, patch?: Record<string, unknown>) => {
    const made = (await f.request("POST", `/api/bots/${bot.id}/tasks`, { title })).body.bot.tasks.find((x: any) => x.title === title).id as string;
    if (patch) assert.equal(await f.control("lane", { bot: bot.id, task: made, patch }), true);
    return made;
  };
  const inLane = async (bot: any, laneId: string, text: string) =>
    ((await f.request("GET", `/api/bots/${bot.id}/messages?thread=${laneId}&limit=200`)).body.messages as any[]).some((m) => m.text === text);
  const records = async (text: string) =>
    (await Promise.all(
      (await f.request("GET", "/api/bots?messages=0")).body.bots
        .find((b: any) => b.id === sender.id)
        .tasks.map(async (x: any) => (await f.request("GET", `/api/bots/${sender.id}/messages?thread=${x.id}&limit=200`)).body.messages as any[]),
    )).flat().filter((m) => m.agent?.dir === "out" && m.text === text);
  const other = (await f.request("POST", "/api/bots", { name: "Synthetic third" })).body.bot;

  // allowed
  const own = await lane(sender, "Own second");
  const opened = await lane(target, "Opened by the sender", { createdBy: sender.id });
  const heardThere = await lane(target, "Sender's words arrived", { peerLanes: { [sender.id]: sender.threadId } });
  const heardHere = await lane(target, "Its words arrived at the sender");
  assert.equal(await f.control("lane", { bot: sender.id, task: sender.threadId, patch: { peerLanes: { [target.id]: heardHere } } }), true);
  for (const [to, laneId, text] of [
    [target, target.threadId, "TO THE FIRST"],
    [sender, own, "TO ITS OWN"],
    [target, opened, "TO ONE IT OPENED"],
    [target, heardThere, "TO ONE ITS WORDS REACHED"],
    [target, heardHere, "TO ONE THAT REACHED IT"],
  ] as const) {
    const said = await f.say({ text, taskId: laneId }, to.id);
    assert.equal(said.status, 202, `${text}: ${JSON.stringify(said.body)}`);
    assert.equal(said.body.taskId, laneId, text);
    assert.equal(await inLane(to, laneId, text), true, text);
  }

  // refused, with the rule, and nothing written on either side
  const plain = await lane(target, "The person's own");
  const othersTab = await lane(target, "Opened by another agent", { createdBy: other.id });
  const othersExchange = await lane(target, "In exchange with another agent", { peerLanes: { [other.id]: other.threadId } });
  for (const [laneId, text] of [
    [plain, "INTO THE PERSON'S"],
    [othersTab, "INTO ANOTHER AGENT'S TAB"],
    [othersExchange, "INTO ANOTHER EXCHANGE"],
  ] as const) {
    const said = await f.say({ text, taskId: laneId });
    assert.equal(said.status, 403, text);
    assert.match(said.body.error, RULE, text);
    assert.equal(await inLane(target, laneId, text), false, text);
    assert.deepEqual(await records(text), [], `${text} left a record of sending`);
  }

  // a member's private conversation is theirs, the agent's own included
  const theirs = await lane(target, "A member's", { personId: "synthetic-member" });
  const itsOwnMembers = await lane(sender, "A member's with the sender", { personId: "synthetic-member" });
  for (const [to, laneId] of [[target, theirs], [sender, itsOwnMembers]] as const) {
    const said = await f.say({ text: "INTO A PRIVATE ONE", taskId: laneId }, to.id);
    assert.equal(said.status, 403);
    assert.match(said.body.error, PRIVATE);
  }

  // no such conversation is answered as it always was
  assert.equal((await f.say({ text: "NOWHERE", taskId: "missing" })).status, 404);

  // the person names whichever conversation they like
  const person = await f.request("POST", `/api/bots/${target.id}/messages`, { text: "THE PERSON'S WORDS", taskId: plain });
  assert.equal(person.status, 202, JSON.stringify(person.body));
  assert.equal(await inLane(target, plain, "THE PERSON'S WORDS"), true);
});

test("the routes on an agent's own conversations keep to the same rule", async (t) => {
  const f = await reporting(t);
  const { sender } = f;
  const make = async (title: string) =>
    (await f.request("POST", `/api/bots/${sender.id}/tasks`, { title })).body.bot.tasks.find((x: any) => x.title === title).id as string;
  const own = await make("Own second");
  const members = await make("A member's");
  assert.equal(await f.control("lane", { bot: sender.id, task: members, patch: { personId: "synthetic-member" } }), true);
  const chart = { kind: "chart", data: { title: "Synthetic", bars: [{ label: "One", value: 1 }] } };

  // a component
  assert.equal((await f.request("POST", `/api/bots/${sender.id}/show`, { ...chart, taskId: own }, f.token)).status, 201);
  const shown = await f.request("POST", `/api/bots/${sender.id}/show`, { ...chart, taskId: members }, f.token);
  assert.equal(shown.status, 403);
  assert.match(shown.body.error, PRIVATE);

  // a shared file, refused before its bytes are kept
  const bytes = await fetch(`${f.url}/api/bots/${sender.id}/artifacts?name=synthetic-note.txt&taskId=${members}`, {
    method: "POST",
    headers: { origin: f.url, authorization: "Bearer " + f.token, "content-type": "application/octet-stream" },
    body: "synthetic words",
  });
  assert.equal(bytes.status, 403);
  const files = (await f.request("GET", `/api/bots/${sender.id}/artifacts`)).body.files as any[];
  assert.ok(!files.some((x) => x.name === "synthetic-note.txt"), "the refused file was kept");

  // a new title
  assert.equal((await f.request("PATCH", `/api/bots/${sender.id}/tasks/${own}`, { title: "Renamed" }, f.token)).status, 200);
  const renamed = await f.request("PATCH", `/api/bots/${sender.id}/tasks/${members}`, { title: "Renamed" }, f.token);
  assert.equal(renamed.status, 403);
  assert.match(renamed.body.error, PRIVATE);

  // and the person, on the same routes, as before
  assert.equal((await f.request("PATCH", `/api/bots/${sender.id}/tasks/${members}`, { title: "Renamed by the person" })).status, 200);
});

test("the kept-back message is held to the rule without spending it", async (t) => {
  const f = await reporting(t);
  const plain = (await f.request("POST", `/api/bots/${f.target.id}/tasks`, { title: "The person's own" })).body.bot.tasks.find((x: any) => x.title === "The person's own").id;
  await f.use();
  const refused = await f.say({ text: "FINAL", taskId: plain });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, RULE);
  assert.equal((await f.control("token", { token: f.token })).spent, 12);
  // the slot is still there for a message it may send
  const receipt = await f.accepted();
  assert.equal(receipt.body.taskId, f.target.threadId);
});
