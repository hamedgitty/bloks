// Requested outcomes use the actual adapters and isolated delivery peers.
// No vendor service, registered device, or installed workspace is touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT, STRANGER, fixture, heardContext, inputWords, waitFor } from "./helpers/telegram-native.ts";
import { quietFixture, noAnswer, request } from "./helpers/quiet-completion.ts";
import { idle } from "./helpers/turns.ts";
import { alertWorkspace } from "./helpers/alert-workspace.ts";
import { isQuietReply } from "../server/routines.ts";

const answered = (f: Awaited<ReturnType<typeof fixture>>, chat: number, text: string) => f.tg.calls("sendMessage").filter(c => c.body.chat_id === chat && c.body.text === text && !c.body.disable_notification);
function changePeer(f: Awaited<ReturnType<typeof fixture>>, edit: (text: string) => string) {
  const file = join(f.root, "fake-codex.mjs");
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}

test("owner and full-access Telegram marker-only turns return one honest outcome in their own chat, without an older answer", async t => {
  const f = await fixture(t);
  f.tg.say("An earlier question");
  await waitFor(() => answered(f, CHAT, "ANSWER").length === 1, "positive earlier Telegram answer did not arrive");
  await waitFor(async () => !(await f.h.json("/api/bots")).bots.find((b: any) => b.id === f.bot.id).busy, "earlier answer did not settle");
  changePeer(f, text => text.replace('finish("ANSWER");', 'finish("QUIET");'));
  f.tg.say("A new question");
  await waitFor(() => answered(f, CHAT, noAnswer).length === 1, "owner got no honest marker-only outcome");
  assert.equal(answered(f, CHAT, "ANSWER").length, 1, "the old answer was returned again");

  f.tg.say("Hello", undefined, STRANGER);
  const lee = await waitFor(async () => (await f.h.json(`/api/bots/${f.bot.id}/telegram`)).people.find((p: any) => p.name === "Lee"), "fixture delegate did not knock");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "allow" });
  await waitFor(() => f.tg.calls("sendMessage").some(c => c.body.chat_id === STRANGER && c.body.text.startsWith("This agent cannot answer from Telegram yet")), "restricted first turn was not held");
  await f.post(`/api/bots/${f.bot.id}/telegram`, { personId: lee.id, action: "full" });
  f.tg.say("A full-access question", undefined, STRANGER);
  await waitFor(() => answered(f, STRANGER, noAnswer).length === 1, "delegate got no honest marker-only outcome");
  assert.equal(answered(f, CHAT, noAnswer).length, 1, "delegate outcome leaked into the owner's chat");
  assert.equal(answered(f, STRANGER, "ANSWER").length, 0, "delegate got the owner's older answer");
  assert.equal((await f.messages()).filter(m => m.role === "bot" && isQuietReply(m.text)).length, 0);
});

for (const accepted of [true, false]) test(`rapid ${accepted ? "accepted" : "refused"} human steer cannot silently lose or borrow the requested outcome`, async t => {
  const f = await fixture(t, "codex", false, false);
  changePeer(f, text => text
    .replace('if (rapid === "RAPID_INPUT") writeFileSync(join(deliverables(), "rapid.txt"), "rapid request work");', '')
    .replace('"EARLIER RESULT" : "RAPID FINAL"', '"QUIET" : "QUIET"')
    .replace('return finish("QUEUED RESULT");', 'return finish("QUIET");')
    .replace('return finish("CTX DONE");', 'return;'));
  const { webhook } = await f.post("/api/webhooks", { botId: f.bot.id, name: "Fixture source" });
  assert.equal((await f.h.fetch(`/hook/${webhook.token}`, request("POST", { text: "CTX_HOLD" }))).status, 202);
  await waitFor(() => existsSync(join(f.root, "ctx-started")), "unattended source turn did not start");
  const text = accepted ? "RAPID_INPUT" : "RAPID_REFUSE";
  const response = await f.post(`/api/bots/${f.bot.id}/messages`, { text, delivery: "now" });
  assert.equal(response.steered === true, accepted, JSON.stringify(response));
  try { await waitFor(async () => (await f.messages()).some(m => m.text === noAnswer), "requested marker completion got no honest outcome"); }
  catch (error) { throw new Error(JSON.stringify({ response, rows: await f.messages(), calls: heardContext(f), log: f.h.logs() }), { cause: error }); }
  writeFileSync(join(f.root, "ctx-release"), "1");
  await waitFor(async () => !(await f.h.json("/api/bots")).bots.find((b: any) => b.id === f.bot.id).busy, "requested work did not settle");
  const rows = await f.messages();
  if (accepted) assert.equal((await f.h.json("/api/bots")).bots.find((b: any) => b.id === f.bot.id).tasks.find((lane: any) => lane.id === f.bot.threadId).unread, true, "accepted requested outcome did not mark the lane unread");
  assert.equal(rows.filter(m => m.text === noAnswer).length, 1, "the unattended/refused attempt borrowed the queued request's obligation");
  assert.equal(rows.filter(m => m.role === "bot" && isQuietReply(m.text)).length, 0);
  const human = rows.find(m => m.role === "user" && m.text === text);
  assert.ok(human); assert.equal(human.midTurn === true, accepted);
  assert.ok(heardContext(f).some(c => c.method === "turn/steer" && inputWords(c).includes(text)), "real steer dispatch was not exercised");
});

// Mail is an external return consumer, so a prior saved answer must not be
// selected after the current marker is omitted from the transcript.
test("mail marker-only completion returns its own honest failure instead of the earlier mail answer", async t => {
  const f = await quietFixture(t), b = await f.bot("Fixture helper");
  const sent: any[] = [], receipts = new Map<string, number>();
  let stream: ((frame: unknown) => void) | undefined;
  const relay = createServer((req, res) => {
    if (req.url?.startsWith("/space/agent/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" }); stream = frame => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      stream({ kind: "hello", spaceId: "fixture-space" }); return;
    }
    let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => {
      const body = JSON.parse(raw || "{}"); res.setHeader("content-type", "application/json");
      if (req.url === "/space/agent/result") receipts.set(body.id, body.status);
      if (req.url === "/space/agent/email") sent.push(body);
      res.end(JSON.stringify(req.url === "/space/agent/hook" ? { id: "0123456789abcdef0123", domain: "agents.bloks.dev" } : {}));
    });
  });
  await new Promise<void>(r => relay.listen(0, "127.0.0.1", r));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  await f.h.json("/api/pair", request("PUT", { enabled: true }));
  await f.h.json("/api/relay", request("PUT", { enabled: true, agentToken: "fixture-token", url: `http://127.0.0.1:${(relay.address() as { port: number }).port}` }));
  await waitFor(() => stream, "mail relay did not connect");
  const on = await f.h.json("/api/chat/email", request("PATCH", { enabled: true }));
  const address = on.addresses.find((a: any) => a.botId === b.id).address;
  for (const [i, text] of ["Earlier mail answer", "QUIET"].entries()) {
    f.setAnswer(text);
    const id = `mail-${i}`;
    stream!({ kind: "ask", id, payload: `hook:${JSON.stringify({ platform: "email", body: JSON.stringify({ to: address, from: "sender@example.com", subject: "Fixture question", text: "Inspect fixture", messageId: `<fixture-${i}@example.com>` }), signature: null })}` });
    await waitFor(() => receipts.has(id), "mail admission did not return"); assert.equal(receipts.get(id), 202);
    await waitFor(() => sent.length === i + 1, "mail result did not return");
    assert.equal(sent[i].text, i ? noAnswer : text);
    assert.equal(sent[i].inReplyTo, `<fixture-${i}@example.com>`);
    assert.ok(await idle(f.h, b));
  }
  assert.equal(sent.filter(x => x.text === "Earlier mail answer").length, 1);
  assert.ok(!sent.some(x => isQuietReply(x.text)));
});


test("a member room request gets an honest marker outcome, while the later agent handoff stays independent", async t => {
  const w = await alertWorkspace(t);
  const first = await w.hire("First"), second = await w.hire("Second");
  const answers = ["QUIET", "@Second continue", "QUIET", "QUIET"], calls: any[] = [];
  const engine = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
    const body = JSON.parse(raw); calls.push(body); const text = answers.shift() ?? "QUIET";
    if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => engine.listen(0, "127.0.0.1", r));
  t.after(() => { engine.closeAllConnections(); engine.close(); });
  const { endpoints } = await w.h.json("/api/custom-endpoints", request("POST", { name: "Fixture engine", url: `http://127.0.0.1:${(engine.address() as { port: number }).port}`, key: "fixture" }));
  for (const bot of [first, second]) await w.h.json(`/api/bots/${bot.id}`, request("PATCH", { modelSelection: { instanceId: endpoints[0].instanceId, model: "fixture" } }));
  assert.equal((await w.h.fetch(`/api/bloks/${w.roomId}`, request("PATCH", { memberIds: [first.id, second.id] }))).status, 200);
  const rows = async () => (await w.h.json(`/api/bloks/${w.roomId}/messages`)).messages as any[];
  assert.equal((await w.member(1, `/api/member/rooms/${w.roomId}/messages`, { text: "@First inspect the fixture" })).status, 202);
  await waitFor(async () => (await rows()).some(m => m.text === noAnswer), "member's first-round marker outcome was silently lost");
  assert.equal((await rows()).filter(m => m.text === noAnswer).length, 1);
  assert.equal((await w.member(1, `/api/member/rooms/${w.roomId}/messages`, { text: "@First coordinate the fixture" })).status, 202);
  await waitFor(() => calls.length === 3, "the subsequent agent handoff did not run");
  assert.ok(await idle(w.h, second), "handoff did not settle");
  const saved = await rows();
  assert.ok(saved.some(m => m.from === first.id && m.text === "@Second continue"), "first-round real report was lost");
  assert.equal(saved.filter(m => m.text === noAnswer).length, 1, "member permission identity became an obligation on a later agent handoff");
  assert.equal(saved.filter(m => m.role === "bot" && isQuietReply(m.text)).length, 0);
  // A new first-round marker must not replay First's older @Second line.
  assert.equal((await w.member(1, `/api/member/rooms/${w.roomId}/messages`, { text: "@First inspect the new fixture" })).status, 202);
  await waitFor(async () => (await rows()).filter(m => m.text === noAnswer).length === 2, "new member request got no current honest outcome");
  assert.ok(await idle(w.h, first)); assert.ok(await idle(w.h, second));
  await new Promise(r => setTimeout(r, 250));
  assert.equal(calls.length, 4, "marker completion replayed the previous turn's room mention");
  assert.equal((await rows()).filter(m => m.text === "@Second continue").length, 1);
});


test("direct and queued private member requests each retain their own marker-only outcome", async t => {
  const w = await alertWorkspace(t), bot = await w.hire("Direct helper");
  const file = join(w.home, "claude.mjs"), held = join(w.home, "quiet-held"), release = join(w.home, "quiet-release");
  const peer = readFileSync(file, "utf8").replaceAll('"Example complete"', '"QUIET"').replace(
    '// Stay alive so the test can speak with this turn\'s credential.',
    `void (async () => { writeFileSync(${JSON.stringify(held)}, "yes"); while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20)); finish(); })();`,
  ).replace('import { readFileSync, renameSync, writeFileSync }', 'import { existsSync, readFileSync, renameSync, writeFileSync }');
  writeFileSync(file, peer);
  // This test is about authenticated member dispatch, not joining. Seed
  // the existing neutral fixture device as a current workspace member;
  // the room-guest helper cannot decrypt newly admitted device envelopes.
  const peopleFile = join(w.home, ".bloks", "people.json");
  const people = JSON.parse(readFileSync(peopleFile, "utf8"));
  people.version = 3;
  Object.assign(people.people.find((p: any) => p.id === "p_aya"), { role: "member", joinedAt: 1, invitedBy: "owner" });
  writeFileSync(peopleFile, JSON.stringify(people));
  await w.restart();
  const path = `/api/member/agents/${bot.id}/private/messages`;
  const asMember = (body?: unknown) => w.member(1, path, body);
  const rows = async () => { const got = await asMember(); assert.equal(got.status, 200); return got.body.messages as any[]; };
  assert.equal((await asMember({ text: "Inspect the direct fixture" })).status, 202);
  await waitFor(async () => (await rows()).filter(m => m.text === noAnswer).length === 1, "direct private member request was left unanswered");
  assert.equal((await asMember({ text: "HOLD FOR AGENT POST" })).status, 202);
  await waitFor(() => existsSync(held), "private member hold did not start");
  const queued = await asMember({ text: "Inspect after the held fixture" });
  assert.equal(queued.status, 202); assert.equal(queued.body.queued, true);
  writeFileSync(release, "yes");
  await waitFor(async () => (await rows()).filter(m => m.text === noAnswer).length === 3, "queued private member request lost its own outcome");
  assert.equal((await rows()).filter(m => m.role === "bot" && isQuietReply(m.text)).length, 0);
});
