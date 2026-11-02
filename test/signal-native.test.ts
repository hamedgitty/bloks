// Signal end to end against the real harness: a fake signal-cli daemon on
// loopback, a fake engine, and every account and message made up. Linking,
// pairing, messages both ways, cards answered by typing, files back, and
// the people rules: a stranger knocks, the owner decides, and nobody is
// answered on the owner's own account but the owner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { agentCli, fixture, sleep, waitFor } from "./helpers/telegram-native.ts";
import { AGENT_ACI, AGENT_NUMBER, OWNER_ACI, OWNER_NUMBER, STRANGER_ACI, STRANGER_NUMBER, fakeSignal } from "./helpers/fake-signal.ts";

const STRANGER = { number: STRANGER_NUMBER, aci: STRANGER_ACI, name: "Lee" };

/** An agent with a Signal account of its own, linked by a scanned code,
 * and, unless `pair` is false, paired with the owner's own Signal. */
async function signalFixture(t: TestContext, pair = true, engine: "codex" | "claude" = "codex") {
  const sig = await fakeSignal(t);
  const f = await fixture(t, engine, false, false);
  const set = await f.post("/api/signal", { url: sig.url });
  assert.equal(set.reachable, true, JSON.stringify(set));
  const started = await f.post(`/api/bots/${f.bot.id}/signal`, { link: true });
  assert.equal(started.link?.state, "waiting", JSON.stringify(started));
  assert.match(started.link.uri, /^sgnl:\/\/linkdevice\?/);
  await waitFor(() => sig.calls("finishLink").length === 1, "Bloks never waited for the phone");
  sig.scan();
  const linked = await waitFor(async () => {
    const s = await f.h.json(`/api/bots/${f.bot.id}/signal`);
    return s.configured && s.pairing ? s : null;
  }, "the account never linked");
  assert.equal(linked.account, AGENT_NUMBER);
  await waitFor(() => sig.streams() > 0, "Bloks never opened the event stream");
  if (pair) {
    sig.say(linked.pairing);
    await waitFor(() => sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Paired.")), "pairing was never confirmed");
  }
  const lane = (title: string) => f.h.json("/api/bots?messages=0").then(({ bots }) => bots.find((b: any) => b.id === f.bot.id).tasks.find((task: any) => task.title === title));
  const messagesIn = async (threadId: string) => (await f.h.json(`/api/bots/${f.bot.id}/messages?thread=${threadId}&limit=500`)).messages as any[];
  return { ...f, sig, pairing: linked.pairing as string, lane, messagesIn };
}

test("linking shows a code to scan, and the pairing word makes the sender the owner", async (t) => {
  const f = await signalFixture(t, false);
  // a stranger who has not got the word is not answered before there is an owner
  f.sig.say("hello?", STRANGER);
  await sleep(600);
  assert.equal(f.sig.sent().length, 0, "nobody is answered before the owner pairs");
  f.sig.say(f.pairing);
  await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Paired.")), "never paired");
  const status = await f.h.json(`/api/bots/${f.bot.id}/signal`);
  assert.equal(status.ownerPaired, true);
  assert.equal(status.ownerSelf, false);
  assert.equal(status.pairing, null, "the word is single use");
  // Bloks never holds a Signal credential: only the account's name
  const saved = JSON.parse(readFileSync(join(f.root, ".bloks", "config.json"), "utf8")).signal.bots[f.bot.id];
  assert.deepEqual(Object.keys(saved).sort(), ["account", "aci", "enabled", "generation", "ownerAci", "ownerName", "ownerNumber", "pairing", "people"].sort());
  assert.equal(saved.ownerNumber, OWNER_NUMBER);
});

test("the owner's message is a turn in the agent's conversation, and the answer comes back", async (t) => {
  const f = await signalFixture(t);
  f.sig.say("what is on today");
  const answer = await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text === "ANSWER"), "the answer never came");
  assert.ok(answer);
  const said = await f.messages();
  const asked = said.find((m) => m.role === "user" && m.text === "what is on today");
  assert.ok(asked, "the words are in the agent's own conversation");
  assert.equal(asked.fromSignal.botId, f.bot.id);
  assert.equal(asked.fromSignal.personId, undefined, "said by the owner");
  assert.ok(f.sig.calls("sendTyping").length > 0, "typing is shown while it works");
  // the same message replayed by a reconnecting stream is not a second turn
  await sleep(300);
  assert.equal(f.sig.sent().filter((m) => m.text === "ANSWER").length, 1);
});

test("an approval is asked on Signal and answered by typing yes", async (t) => {
  const f = await signalFixture(t);
  f.sig.say("APPROVE this");
  const card = await waitFor(() => f.sig.sent().find((m) => m.text.startsWith("Approval needed")), "the card never reached the chat");
  assert.match(card.text, /rm -rf build/);
  assert.match(card.text, /1\. Allow\n2\. Deny/);
  // something that is not a yes or a no asks again, rather than guessing
  f.sig.say("hmm, maybe");
  await waitFor(() => f.sig.sent().find((m) => m.text === "Reply yes or no, or answer it in the app."), "an unclear answer was not asked again");
  assert.equal(f.replies().length, 0);
  f.sig.say("yes");
  await waitFor(() => f.sig.sent().find((m) => m.text === "Sent."), "the answer was never taken");
  assert.deepEqual(f.replies().map((r) => r.result), [{ decision: "accept" }]);
  await waitFor(() => f.sig.sent().find((m) => m.text === "DECIDED accept"), "the turn never finished");
});

test("a question its agent withdrew is let go of on Signal without a word, and what is typed next is a message", async (t) => {
  // Signal cannot rewrite what it sent, and the person settled the
  // question themselves, so nothing is said there for a withdrawal.
  const f = await signalFixture(t);
  f.sig.say("ASYNC_ASK which colour");
  await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Your agent has a question")), "the question never reached the chat");
  await waitFor(() => f.sig.sent().find((m) => m.text === "Carried on."), "the turn never ended");
  const asked = (await f.messages()).find((m) => m.kind === "options" && m.card?.requestId);
  const before = f.sig.sent().length;
  const ran = await agentCli(f, ["unask", asked.id]);
  assert.deepEqual(ran, { status: 0, answer: { ok: true, withdrawn: asked.id } });
  await sleep(500);
  assert.deepEqual(f.sig.sent().slice(before).map((m) => m.text).filter((text) => text !== "RAN"), []);
  // what is typed next reaches the agent as a message, never as the answer
  f.sig.say("2");
  await waitFor(() => f.sig.sent().find((m) => m.text === "ANSWER"), "the next words never reached the agent");
  assert.ok((await f.messages()).some((m) => m.role === "user" && m.text === "2"), "the next words were not a message");
  assert.ok(!f.sig.sent().some((m) => m.text === "Sent." || /already closed/.test(m.text)), "they were taken as an answer to the closed question");
});

test("files the agent made come back after the answer, a few at most", async (t) => {
  const f = await signalFixture(t);
  f.sig.say("MANY");
  await waitFor(() => f.sig.sent().find((m) => m.text === "Seven parts."), "no answer");
  const files = await waitFor(() => {
    const sent = f.sig.sent().filter((m) => m.attachments.length);
    return sent.length === 5 ? sent : null;
  }, "the files never came");
  for (const file of files) assert.match(file.attachments[0]!, /^data:text\/plain;filename=part-\d\.txt;base64,/);
  await waitFor(() => f.sig.sent().find((m) => /^Not sent here: part-6\.txt; part-7\.txt\. They are in the app\.$/.test(m.text)), "the rest were not accounted for");
});

test("a photo arrives as the composer's image, and a voice note without a speech key is asked for as text", async (t) => {
  const f = await signalFixture(t);
  // a one pixel PNG
  f.sig.state.attachments.set("photo1", Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a0f00000000049454e44ae426082", "hex"));
  f.sig.say("look", undefined, { attachments: [{ id: "photo1", contentType: "image/png", size: 70 }] });
  const asked = await waitFor(async () => (await f.messages()).find((m) => m.role === "user" && m.text?.startsWith("look")), "the photo never reached the agent");
  assert.match(asked.text, /<attached-image path="[^"]+\.png" \/>/);
  f.sig.state.attachments.set("voice1", Buffer.from("not really audio"));
  f.sig.say("", undefined, { attachments: [{ id: "voice1", contentType: "audio/aac", size: 16, voiceNote: true }] });
  await waitFor(() => f.sig.sent().find((m) => /^I couldn't take that voice note \(there is no speech key/.test(m.text)), "the person was not told");
  assert.equal(f.sig.calls("getAttachment").filter((c) => c.params.id === "voice1").length, 0, "nothing is downloaded that cannot be heard");
});

test("a stranger knocks once, the owner lets them in by replying to the card, and their words run in a conversation of their own", async (t) => {
  const f = await signalFixture(t);
  f.sig.say("hi, can I ask something?", STRANGER);
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text.startsWith("I have asked the owner")), "the stranger was not told");
  const card = await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Let Lee in?")), "the owner was not asked");
  assert.match(card.text, /\+15550000003 on Signal/);
  assert.match(card.text, /They wrote: "hi, can I ask something\?"/);
  const appCard = (await f.messages()).find((m) => m.card?.requestId?.startsWith("signal-person:"));
  assert.equal(appCard.card.ownerOnly, true);
  // again: no second card, one "still waiting"
  f.sig.say("hello??", STRANGER);
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text === "Still waiting for the owner to let you in."), "no word on waiting");
  f.sig.say("hello???", STRANGER);
  await sleep(500);
  assert.equal(f.sig.sent().filter((m) => m.to === STRANGER_ACI).length, 2, "a knock repeated is not a reply repeated");
  assert.equal(f.sig.sent().filter((m) => m.text.startsWith("Let Lee in?")).length, 1);
  // the owner's ordinary words are not an answer to a knock
  f.sig.say("hello agent");
  await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text === "ANSWER"), "the owner's own message was eaten");
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/signal`)).people[0].state, "pending");
  // a reply quoting the card is
  f.sig.say("yes", undefined, { quote: { id: card.timestamp, author: AGENT_NUMBER, authorUuid: AGENT_ACI, text: card.text } });
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text.startsWith("You are in.")), "never let in");
  // On Codex a person without full access is held: its shell reads the disk
  const held = await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text.startsWith("Could not answer:")), "the hold was not said");
  assert.match(held.text, /engine whose tools cannot be switched off/);
  const theirs = await waitFor(() => f.lane("Signal: Lee"), "no conversation of their own");
  const there = await f.messagesIn(theirs.id);
  assert.ok(there.some((m) => m.role === "user" && m.text.startsWith('A Signal message from "Lee"') && m.text.includes("who is not the owner")), "their words are framed as theirs");
  assert.ok(!(await f.messages()).some((m) => m.role === "user" && m.text?.includes("can I ask something")), "and never land in the owner's conversation");
  // given full access, they are answered, in their own conversation, and the files come back to them
  const person = (await f.h.json(`/api/bots/${f.bot.id}/signal`)).people[0];
  await f.post(`/api/bots/${f.bot.id}/signal`, { personId: person.id, action: "full" });
  f.sig.say("now?", STRANGER);
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text === "ANSWER"), "a person with full access was not answered");
  const after = await f.messagesIn(theirs.id);
  assert.ok(after.some((m) => m.role === "user" && m.fromSignal?.personId === person.id && m.text.includes("whom the owner gave full access")));
  // taken out: silence, and nothing reaches the agent
  await f.post(`/api/bots/${f.bot.id}/signal`, { personId: person.id, action: "remove" });
  const before = f.sig.sent().length;
  f.sig.say("still there?", STRANGER);
  await sleep(700);
  assert.equal(f.sig.sent().length, before, "a person taken out hears nothing");
  assert.ok(!(await f.messagesIn(theirs.id)).some((m) => m.text?.includes("still there?")));
});

test("declined in the app, a stranger is told once and then never answered", async (t) => {
  const f = await signalFixture(t);
  f.sig.say("let me in", STRANGER);
  const card = await waitFor(async () => (await f.messages()).find((m) => m.card?.requestId?.startsWith("signal-person:")), "no card in the app");
  await f.post(`/api/bots/${f.bot.id}/respond`, { requestId: card.card.requestId, behavior: "answer", message: "Not now" });
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text === "Not now. The owner has not let you in."), "the decline was not said");
  const status = await f.h.json(`/api/bots/${f.bot.id}/signal`);
  assert.equal(status.people[0].state, "declined");
  const before = f.sig.sent().length;
  f.sig.say("please?", STRANGER);
  await sleep(600);
  assert.equal(f.sig.sent().length, before);
  const settled = (await f.messages()).find((m) => m.id === card.id);
  assert.equal(settled.card.answered, "Not now");
});

test("on the owner's own account only Note to Self is read; every other conversation is dropped", async (t) => {
  const f = await signalFixture(t, false);
  f.sig.noteToSelf(f.pairing);
  await waitFor(() => f.sig.sent().find((m) => m.to === AGENT_NUMBER && m.text.startsWith("Paired. Write to")), "Note to Self pairing was not confirmed");
  const status = await f.h.json(`/api/bots/${f.bot.id}/signal`);
  assert.equal(status.ownerSelf, true);
  // a friend writing to the owner is the owner's life, not a knock
  f.sig.say("are we still on for dinner?", STRANGER);
  // and the owner's own reply to them, from the phone, is not a turn
  f.sig.syncTo("yes, 7pm", STRANGER);
  await sleep(700);
  assert.equal(f.sig.sent().filter((m) => m.to !== AGENT_NUMBER).length, 0, "nobody else is ever written to");
  assert.equal((await f.h.json(`/api/bots/${f.bot.id}/signal`)).people.length, 0, "nobody knocked");
  assert.ok(!(await f.messages()).some((m) => m.text?.includes("dinner") || m.text?.includes("7pm")), "nothing of theirs reached the agent");
  f.sig.noteToSelf("remind me what is next");
  await waitFor(() => f.sig.sent().find((m) => m.to === AGENT_NUMBER && m.text === "ANSWER"), "Note to Self was not answered there");
});

test("switched off, removed or unpaired, the account answers nobody", async (t) => {
  const f = await signalFixture(t);
  await f.post(`/api/bots/${f.bot.id}/signal`, { enabled: false });
  f.sig.say("are you there?");
  await sleep(600);
  assert.equal(f.sig.sent().filter((m) => m.text === "ANSWER").length, 0);
  await f.post(`/api/bots/${f.bot.id}/signal`, { enabled: true });
  await f.post(`/api/bots/${f.bot.id}/signal`, { unpair: true });
  f.sig.say("and now?");
  await sleep(600);
  assert.equal(f.sig.sent().filter((m) => m.text === "ANSWER").length, 0, "an unpaired owner is nobody");
  const gone = await f.post(`/api/bots/${f.bot.id}/signal`, { forget: true });
  assert.equal(gone.configured, false);
});

test("an agent's credential cannot read or change Signal settings", async (t) => {
  const f = await signalFixture(t, false);
  const statuses = await (await import("./helpers/telegram-native.ts")).agentTries(f, [["GET", "/api/signal"], ["GET", `/api/bots/${f.bot.id}/signal`], ["POST", `/api/bots/${f.bot.id}/signal`, { pair: true }]]);
  assert.deepEqual(statuses, [403, 403, 403]);
});

test("a person without full access is answered on Claude Code, with nothing of the owner's, and their turn's card asks the owner", async (t) => {
  const f = await signalFixture(t, true, "claude");
  f.sig.say("which database should I use?", STRANGER);
  const knock = await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Let Lee in?")), "the owner was not asked");
  f.sig.say("yes", undefined, { quote: { id: knock.timestamp, author: AGENT_NUMBER, authorUuid: AGENT_ACI, text: knock.text } });
  // the fake engine asks a question: it goes to the owner, never to Lee
  const card = await waitFor(() => f.sig.sent().find((m) => m.to === OWNER_ACI && m.text.startsWith("Your agent has a question")), "the card did not reach the owner");
  assert.match(card.text, /\(for Lee on Signal\)/);
  assert.match(card.text, /Reply to this message/);
  assert.ok(!f.sig.sent().some((m) => m.to === STRANGER_ACI && m.text.includes("Which database")), "the person never sees the card");
  f.sig.say("2", undefined, { quote: { id: card.timestamp, author: AGENT_NUMBER, authorUuid: AGENT_ACI, text: card.text } });
  await waitFor(() => f.sig.sent().find((m) => m.to === STRANGER_ACI && m.text === "TOLD answer SQLite"), "the answer never reached the person");
  // an outsider's turn: no tools, no owner context, a fresh session each time
  const theirs = await f.lane("Signal: Lee");
  const asked = (await f.messagesIn(theirs.id)).find((m) => m.role === "user" && m.fromSignal);
  assert.ok(asked.text.includes("Only the owner can approve actions"));
});
