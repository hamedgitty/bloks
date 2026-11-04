// Branch from here: a new conversation that starts from one of the
// agent's answers in another (server/branch.ts, the branch route in
// server/index.ts). The rules about what is copied and what the branch
// is called, then the route end to end on a scripted engine that keeps
// sessions, so the branch's first turn can be seen to be a new session
// told the copy and nothing after it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { allows } from "../server/agent-cli.ts";
import { branchCopy, branchPoint, branchTitle, carriedSummary, dividerText, TITLE_MAX } from "../server/branch.ts";
import { memberCan } from "../server/member-access.ts";
import type { Message } from "../server/store.ts";
import { freshTurnText } from "../server/turn-context.ts";
import { branchBlocked, branchSource } from "../src/lib/branch.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

let seq = 0;
const msg = (over: Partial<Message> & Pick<Message, "role">): Message => ({
  id: `m${++seq}`,
  kind: "text",
  text: "words",
  at: 1_000 + seq,
  ...over,
});
const minted = () => {
  let n = 0;
  return () => `new-${++n}`;
};

describe("what a branch copies", () => {
  test("a branch starts from one of the agent's answers, never from the person's words or a card", () => {
    const asked = msg({ role: "user", text: "Plan it" });
    const answer = msg({ role: "bot", text: "Here is a plan." });
    const card = msg({ role: "bot", kind: "options", text: "", card: { title: "Pick", subtitle: "", options: ["A"] } });
    const toAgent = msg({ role: "bot", text: "Asking Kat", agent: { peerId: "kat", peerName: "Kat", dir: "out" } as Message["agent"] });
    const gone = msg({ role: "bot", text: "Taken back", deleted: true });
    const list = [asked, answer, card, toAgent, gone];
    assert.equal(branchPoint(list, answer.id), 1);
    assert.match(String(branchPoint(list, asked.id)), /use Rewind/);
    assert.match(String(branchPoint(list, card.id)), /one of the agent's answers/);
    assert.match(String(branchPoint(list, toAgent.id)), /one of the agent's answers/);
    assert.match(String(branchPoint(list, gone.id)), /no longer here/);
    assert.match(String(branchPoint(list, "nope")), /no longer here/);
    assert.match(String(branchPoint(list, 42)), /no longer here/);
  });

  test("everything up to the answer, as it reads, and nothing taken back, waiting or never sent", () => {
    const first = msg({ role: "user", text: "One" });
    const rewound = msg({ role: "user", text: "Taken back", deleted: true, rewound: 5 });
    const reply = msg({ role: "bot", text: "Two", replyTo: { id: first.id, author: "You", excerpt: "One" } });
    const unsent = msg({ role: "user", text: "Never went", unsent: true });
    const compacted = msg({ role: "bot", kind: "notice", text: "Compacted", compaction: { before: 10, after: 2 } });
    const dismissed = msg({ role: "user", text: "Unknown", preparation: { attempt: "a", state: "uncertain", dismissed: true } });
    const quoting = msg({ role: "user", text: "About that", replyTo: { id: rewound.id, author: "You", excerpt: "Taken back" } });
    const answer = msg({ role: "bot", text: "Three" });
    const later = msg({ role: "user", text: "After the branch point" });
    const list = [first, rewound, reply, unsent, compacted, dismissed, quoting, answer, later];
    const copy = branchCopy(list, list.indexOf(answer), minted());
    assert.deepEqual(copy.map((m) => m.text), ["One", "Two", "About that", "Three"]);
    // new ids, the same times
    assert.deepEqual(copy.map((m) => m.id), ["new-1", "new-2", "new-3", "new-4"]);
    assert.deepEqual(copy.map((m) => m.at), [first.at, reply.at, quoting.at, answer.at]);
    // a reply points at its copy; one whose message stayed out keeps its quote
    assert.deepEqual(copy[1].replyTo, { id: "new-1", author: "You", excerpt: "One" });
    assert.deepEqual(copy[2].replyTo, { author: "You", excerpt: "Taken back" });
    // the original is untouched
    assert.equal(list[2].replyTo?.id, first.id);
  });

  test("nothing in the copy is live: cards close, Undo stays with the original, return addresses stay behind", () => {
    const waiting = msg({ role: "bot", kind: "options", text: "", card: { title: "Allow?", subtitle: "", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash" } });
    const answered = msg({ role: "bot", kind: "options", text: "", card: { title: "Pick", subtitle: "", options: ["A", "B"], answered: "A", requestId: "req-2" } });
    const secret = msg({ role: "bot", kind: "secret", text: "", secret: { envName: "API_KEY", label: "Key", status: "needs-value", resumeKey: "k" } });
    const connector = msg({ role: "bot", kind: "connector", text: "", connector: { slug: "gmail", label: "Gmail", status: "needs-auth", authUrl: "https://example.invalid/auth", resumeKey: "k" } });
    const changes = msg({ role: "bot", kind: "changes", text: "", changes: { checkpointId: "cp-1", files: [{ path: "a.md", status: "modified" }], total: 1 } });
    const telegram = msg({
      role: "user",
      text: "From my phone",
      fromTelegram: true,
      telegramReply: { chatId: 1 } as Message["telegramReply"],
      telegramBinding: { botId: "b", generation: "g" },
      commandInstance: "claude",
      joinedTurnId: "turn-1",
    });
    const cutOff = msg({ role: "bot", kind: "notice", text: "Cut off", carryOn: { laneId: "source" } });
    const answer = msg({ role: "bot", text: "Done." });
    const copy = branchCopy([waiting, answered, secret, connector, changes, telegram, cutOff, answer], 7, minted());
    assert.equal(copy[0].card?.dismissed, true);
    assert.equal(copy[0].card?.requestId, undefined);
    assert.equal(copy[0].card?.tool, "Bash", "what it was about is still shown");
    assert.equal(copy[1].card?.answered, "A");
    assert.equal(copy[1].card?.dismissed, undefined, "an answered card stays answered");
    assert.equal(copy[2].secret?.status, "dismissed");
    assert.equal(copy[2].secret?.resumeKey, undefined);
    assert.equal(copy[3].connector?.status, "dismissed");
    assert.equal(copy[3].connector?.authUrl, undefined);
    assert.equal(copy[4].changes?.copied, true);
    assert.equal(copy[4].changes?.checkpointId, "cp-1", "its diff can still be read");
    assert.equal(changes.changes?.copied, undefined, "the original card is untouched");
    assert.equal(copy[5].fromTelegram, true, "who said it is kept");
    for (const field of ["telegramReply", "telegramBinding", "commandInstance", "joinedTurnId"] as const) {
      assert.equal(copy[5][field], undefined, field);
    }
    assert.equal(copy[6].carryOn, undefined, "a Continue is the original's to press");
  });

  test("the branch is called after the conversation, numbered, and kept to one line", () => {
    assert.equal(branchTitle("Plan the launch", ["General", "Plan the launch"]), "Plan the launch (branch)");
    assert.equal(branchTitle("Plan the launch", ["Plan the launch", "Plan the launch (branch)"]), "Plan the launch (branch 2)");
    // a branch of a branch goes on with the same numbers
    assert.equal(
      branchTitle("Plan the launch (branch)", ["Plan the launch", "Plan the launch (branch)", "Plan the launch (branch 2)"]),
      "Plan the launch (branch 3)",
    );
    // a number freed by a closed branch is used again rather than skipped
    assert.equal(branchTitle("Plan the launch", ["Plan the launch (branch 2)"]), "Plan the launch (branch)");
    const long = "A conversation with a very long title indeed, past the line";
    const named = branchTitle(long, []);
    assert.ok(named.length <= TITLE_MAX, named);
    assert.match(named, /… \(branch\)$/);
    assert.ok(branchTitle(long, [named]).length <= TITLE_MAX);
    assert.match(branchTitle(long, [named]), /… \(branch 2\)$/);
  });

  test("the line says where it came from, and that the files are shared", () => {
    assert.equal(dividerText("Plan the launch"), "Branched from Plan the launch. Files in the workspace are shared with the original.");
    assert.equal(dividerText("Plan the launch", true), "Branched from a conversation that was deleted. Files in the workspace are shared with the original.");
  });

  test("the original's summary goes with the copy only when it covers nothing past the branch point", () => {
    const list = [msg({ role: "user", text: "a" }), msg({ role: "bot", text: "b" }), msg({ role: "user", text: "c" }), msg({ role: "bot", text: "d" })];
    const copy = branchCopy(list, 1, minted());
    const summary = (through: number) => ({ summary: "so far", through, at: 1 });
    assert.deepEqual(carriedSummary(summary(2), list, 1, copy), summary(2));
    assert.equal(carriedSummary(summary(3), list, 1, copy), undefined);
    assert.equal(carriedSummary(undefined, list, 1, copy), undefined);
  });

  test("the branch's first turn is told it is a branch, and of what", () => {
    const told = freshTurnText([{ role: "user", text: "Plan it" }, { role: "assistant", text: "Here is a plan." }], "Try it smaller", { why: "branch" });
    assert.match(told, /^You are picking up this conversation in a new session: the person branched it off another conversation/);
    assert.match(told, /files in the workspace are shared with it/);
    assert.match(told, /User: Plan it\n\nAssistant: Here is a plan\.\n\n--- the new message ---\n\nTry it smaller$/);
  });

  test("an agent and a member's device never reach the route", () => {
    assert.equal(allows("bot-1", "POST", "/api/threads/lane-1/branch").ok, false);
    assert.equal(memberCan("POST", "/api/threads/lane-1/branch", () => "collaborator", () => true, "member").ok, false);
  });
});

describe("Branch from here in the app", () => {
  const idle = { state: "idle" as const };
  const room = { name: "Planner", lanes: 3, max: 20, working: false };

  test("greyed with the server's reason, before anyone presses into a refusal", () => {
    assert.equal(branchBlocked(idle, room), null);
    assert.equal(branchBlocked(idle, { ...room, working: true }), "Planner is working in this conversation. Branch from here once it is done.");
    assert.match(String(branchBlocked({ state: "needs-you" }, room)), /is working/);
    // its changes card is still being made: the turn is not over yet
    assert.match(String(branchBlocked({ ...idle, settling: true }, room)), /is working/);
    assert.equal(branchBlocked(idle, { ...room, lanes: 20 }), "Planner has 20 conversations open. Close one to branch.");
    // what the conversation is says more than what it is doing
    assert.equal(
      branchBlocked({ state: "working", noBranch: "rehearsal" }, room),
      "A rehearsal cannot be branched. Apply it or discard it first.",
    );
    for (const kind of ["notYours", "room", "team", "guestMail", "signal", "rehearsal"] as const) {
      assert.doesNotMatch(String(branchBlocked({ ...idle, noBranch: kind }, room)), /^branch\./, `${kind} has words`);
    }
  });

  test("the line goes back to the conversation by its title now, and not once it is closed", () => {
    const line = { from: "lane-a", messageId: "m1", title: "Old title" };
    assert.deepEqual(branchSource(line, [{ id: "lane-a", title: "New title" }]), { title: "New title" });
    assert.equal(branchSource(line, [{ id: "lane-b", title: "Other" }]), null);
    assert.equal(branchSource({ ...line, gone: true }, [{ id: "lane-a", title: "New title" }]), null);
    assert.deepEqual(branchSource(line, undefined), { title: "Old title" });
  });
});

// A scripted Claude Code. It answers "Re: " and the last line it was
// told, keeps a session (so a resumed turn is told only the new words),
// writes down what each turn was told and whether it resumed, and holds
// a turn whose words say HOLD until the test lets it go, writing its
// credential down first.
const CLI = String.raw`#!__NODE__
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const dir=__DIR__;
const out=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log('2.1.299 (Claude Code)');process.exit();}
if(process.argv.includes('auth')){out({loggedIn:true});process.exit();}
const words=c=>typeof c==='string'?c:Array.isArray(c)?c.map(x=>x?.text??'').join(''):'';
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.type!=='user')return;
 const told=words(m.message?.content);
 appendFileSync(dir+'/told.jsonl',JSON.stringify({told,resumed:process.argv.includes('--resume')})+'\n');
 out({type:'system',subtype:'init',session_id:'fixture-session',model:'claude-sonnet-5'});
 if(told.includes('HOLD')){
  writeFileSync(dir+'/token',process.env.BLOKS_TOKEN??'');
  const until=Date.now()+14000;
  while(!existsSync(dir+'/release')&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
 }
 const last=told.trim().split('\n').at(-1);
 out({type:'assistant',message:{id:'a'+Date.now(),model:'claude-sonnet-5',content:[{type:'text',text:'Re: '+last}],usage:{input_tokens:1,output_tokens:1}}});
 out({type:'result',subtype:'success',is_error:false,num_turns:1,duration_api_ms:1,total_cost_usd:0,result:'ok'});
});
`;

// The smallest PNG there is, so the attachment route takes it as one.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

describe("branching a conversation", () => {
  let h: Harness;
  let home: string;
  before(async () => {
    home = mkdtempSync(join(tmpdir(), "bloks-branch-"));
    mkdirSync(join(home, ".bloks"));
    const cli = join(home, "claude.mjs");
    writeFileSync(cli, CLI.replaceAll("__NODE__", process.execPath).replaceAll("__DIR__", JSON.stringify(home)), { mode: 0o755 });
    writeFileSync(join(home, ".bloks/config.json"), JSON.stringify({ instances: { fake: { driver: "claudeAgent", config: { cli } } } }));
    h = await startHarness({ HOME: home, USERPROFILE: home });
  });
  after(async () => {
    await h?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor<T>(check: () => Promise<T | null | undefined | false>, why: string, ms = 20_000): Promise<T> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const got = await check();
      if (got) return got;
      await pause(50);
    }
    assert.fail(`${why}\n${h.logs().slice(-1500)}`);
  }
  const told = (): Array<{ told: string; resumed: boolean }> =>
    existsSync(join(home, "told.jsonl"))
      ? readFileSync(join(home, "told.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const agent = async (id: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === id);
  const lane = async (botId: string, threadId: string): Promise<any[]> =>
    (await h.json(`/api/bots/${botId}/messages?thread=${threadId}&limit=500`)).messages;
  const say = async (botId: string, taskId: string, text: string) => {
    const r = await h.fetch(`/api/bots/${botId}/messages`, { method: "POST", body: JSON.stringify({ text, taskId }) });
    assert.ok(r.ok, await r.text());
  };
  const answered = (botId: string, taskId: string, text: string) =>
    waitFor(async () => {
      const bot = await agent(botId);
      // over, its changes card included
      const task = bot.tasks.find((t: any) => t.id === taskId);
      const idle = task?.state === "idle" && !task.settling;
      return idle && (await lane(botId, taskId)).some((m) => m.text === `Re: ${text}`);
    }, `no answer to "${text}"`);
  const branch = (threadId: string, body: Record<string, unknown>, init: RequestInit = {}) =>
    h.fetch(`/api/threads/${threadId}/branch`, { method: "POST", body: JSON.stringify(body), ...init });

  test("copies the conversation to one answer, opens it, leaves the original alone, and starts a new session told only the copy", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Planner" }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "fake", model: "claude-sonnet-5" } }) });
    // the source is a conversation of its own, so it can be closed later
    const opened = await h.json(`/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Launch plan" }) });
    const sourceId: string = opened.bot.activeTaskId;

    // a picture, attached the way the app attaches one
    const upload = await h.fetch("/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    assert.equal(upload.status, 200, await upload.clone().text());
    const picture: string = (await upload.json()).path;
    const pictureName = picture.split(/[\\/]/).at(-1)!;
    const firstWords = `<attached-image path="${picture}"/>\nFirst question`;

    await say(bot.id, sourceId, firstWords);
    await answered(bot.id, sourceId, "First question");
    await say(bot.id, sourceId, "Second question");
    await answered(bot.id, sourceId, "Second question");
    const original = await lane(bot.id, sourceId);
    const at = original.find((m) => m.text === "Re: First question");
    const mine = original.find((m) => m.text === "Second question");

    // only one of the agent's answers, in a conversation with one agent
    assert.equal((await branch(sourceId, { messageId: mine.id })).status, 400);
    assert.equal((await branch(sourceId, { messageId: "no-such-message" })).status, 400);
    assert.equal((await branch(sourceId, { messageId: at.id, requestId: "has spaces" })).status, 400);
    const { bot: other } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Other" }) });
    const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Room", memberIds: [bot.id, other.id] }) });
    const inRoom = await branch(blok.id, { messageId: at.id });
    assert.equal(inRoom.status, 400);
    assert.match((await inRoom.json()).error, /not in a room/);
    await h.fetch(`/api/bloks/${blok.id}`, { method: "DELETE" });
    await h.fetch(`/api/bots/${other.id}?forget=1`, { method: "DELETE" });

    const res = await branch(sourceId, { messageId: at.id, requestId: "req-one" });
    assert.equal(res.status, 201, await res.clone().text());
    const made = await res.json();
    const branchId: string = made.threadId;
    assert.notEqual(branchId, sourceId);
    // answered as opening a conversation is: the branch is the open one
    assert.equal(made.bot.activeTaskId, branchId);
    assert.equal(made.bot.tasks.find((t: any) => t.id === branchId).title, "Launch plan (branch)");
    const copied = made.bot.messages as any[];
    assert.deepEqual(copied.filter((m) => m.kind === "text").map((m) => m.text), [firstWords, "Re: First question"]);
    assert.ok(copied.every((m) => !original.some((o) => o.id === m.id)), "every copy has an id of its own");
    const divider = copied.at(-1);
    assert.equal(divider.kind, "notice");
    assert.deepEqual(divider.branch, { from: sourceId, messageId: at.id, title: "Launch plan" });
    assert.equal(divider.text, "Branched from Launch plan. Files in the workspace are shared with the original.");

    // the original has not changed at all
    assert.deepEqual(await lane(bot.id, sourceId), original);

    // the same request again is the same branch, opened again
    const again = await branch(sourceId, { messageId: at.id, requestId: "req-one" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).threadId, branchId);
    assert.equal((await agent(bot.id)).tasks.length, 3, "one branch, however many times it was asked for");
    assert.equal((await branch(sourceId, { messageId: mine.id, requestId: "req-one" })).status, 409);

    // the branch's first turn: a new session, told the copy and nothing after it
    await say(bot.id, branchId, "Try another way");
    await answered(bot.id, branchId, "Try another way");
    const first = told().at(-1)!;
    assert.equal(first.resumed, false, "a new session, not the original's");
    assert.match(first.told, /branched it off another conversation/);
    assert.match(first.told, /First question/);
    assert.match(first.told, /Re: First question/);
    assert.doesNotMatch(first.told, /Second question/);
    // and the one after it carries on the branch's own session
    await say(bot.id, branchId, "Smaller still");
    await answered(bot.id, branchId, "Smaller still");
    assert.equal(told().at(-1)!.resumed, true);
    assert.match(told().at(-1)!.told, /Smaller still$/);
    assert.doesNotMatch(told().at(-1)!.told, /First question/, "a resumed session is told only the new words");

    // another branch of the same conversation is numbered
    const second = await (await branch(sourceId, { messageId: original.find((m) => m.text === "Re: Second question").id })).json();
    assert.equal(second.bot.tasks.find((t: any) => t.id === second.threadId).title, "Launch plan (branch 2)");

    // closing the original: each line says so, and the picture is still there
    const closed = await h.fetch(`/api/bots/${bot.id}/tasks/${sourceId}`, { method: "DELETE" });
    assert.equal(closed.status, 200, await closed.clone().text());
    const line = (await lane(bot.id, branchId)).find((m) => m.branch);
    assert.equal(line.branch.gone, true);
    assert.equal(line.text, "Branched from a conversation that was deleted. Files in the workspace are shared with the original.");
    assert.equal((await lane(bot.id, second.threadId)).find((m) => m.branch).branch.gone, true);
    const kept = await h.fetch(`/api/attachments/${pictureName}`);
    assert.equal(kept.status, 200, "an attachment in a branch outlives the conversation it was copied from");
    assert.ok((await lane(bot.id, branchId)).some((m) => m.text === firstWords));

    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("waits for a running turn, and is never an agent's", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Busy" }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "fake", model: "claude-sonnet-5" } }) });
    const laneId: string = (await agent(bot.id)).threadId;
    await say(bot.id, laneId, "Start here");
    await answered(bot.id, laneId, "Start here");
    const at = (await lane(bot.id, laneId)).find((m) => m.text === "Re: Start here");

    rmSync(join(home, "token"), { force: true });
    rmSync(join(home, "release"), { force: true });
    await say(bot.id, laneId, "HOLD this one");
    const token = await waitFor(async () => existsSync(join(home, "token")) && readFileSync(join(home, "token"), "utf8"), "no credential");
    try {
      const busy = await branch(laneId, { messageId: at.id });
      assert.equal(busy.status, 409);
      assert.match((await busy.json()).error, /Busy is working in this conversation/);
      const asAgent = await branch(laneId, { messageId: at.id }, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(asAgent.status, 403);
    } finally {
      writeFileSync(join(home, "release"), "yes");
    }
    await answered(bot.id, laneId, "HOLD this one");
    assert.equal((await branch(laneId, { messageId: at.id })).status, 201, "and goes once the turn is over");
    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });
});
