// Redo: editing a message the agent already read starts it again from
// the new words (GitHub 258). Stop, rewind, send, in one call.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test, type TestContext } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const redoPath = (threadId: string, messageId: string) => `/api/threads/${threadId}/messages/${messageId}/redo`;
const redo = (h: Harness, threadId: string, messageId: string, text: string) =>
  h.fetch(redoPath(threadId, messageId), { method: "POST", body: JSON.stringify({ text }) });
const standing = (messages: any[]) => messages.filter((m) => m.kind === "text" && !m.deleted).map((m) => m.text as string);

describe("redo, on an engine that is told the conversation each turn", () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.stop();
  });

  /** An agent in a folder of its own, on an engine the test scripts: what
   * it does to the folder and says back depends on the last thing asked,
   * every request is kept, and one whose last message says HOLD is held
   * until the test lets it go or the turn is stopped. */
  async function agentIn(t: TestContext, provider: string, name: string, act: (last: string, desk: string) => string) {
    const desk = mkdtempSync(join(tmpdir(), "bloks-redo-desk-"));
    t.after(() => rmSync(desk, { recursive: true, force: true }));
    const heard: string[][] = [];
    const held: Array<() => void> = [];
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        const said = ((JSON.parse(body).messages ?? []) as Array<{ content: unknown }>).map((m) => String(m.content ?? ""));
        heard.push(said);
        const last = said[said.length - 1] ?? "";
        const reply = act(last, desk);
        const finish = () => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
        if (last.includes("HOLD")) held.push(finish);
        else finish();
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    t.after(() => {
      engine.closeAllConnections();
      engine.close();
    });
    await h.fetch(`/api/providers/${provider}/connect`, {
      method: "POST",
      body: JSON.stringify({ key: "sk-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: provider, model: "m-1" }, cwd: desk }),
    });
    assert.equal(set.status, 200, await set.clone().text());
    t.after(() => h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" }));
    const me = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    const settled = (reply: string) =>
      waitFor(async () => {
        const current = await me();
        return !current.busy && current.messages.some((m: any) => m.text === reply && !m.deleted) ? current : null;
      });
    const say = (text: string) => h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    return { bot, desk, heard, held, me, settled, say };
  }

  test("takes back the message and what came of it, puts the files back, and sends the new words", async (t) => {
    const a = await agentIn(t, "grok", "Editor", (last, desk) => {
      if (last.includes("first")) {
        writeFileSync(join(desk, "plan.md"), "two\n");
        return "Reply one.";
      }
      if (last.includes("secnod")) {
        writeFileSync(join(desk, "plan.md"), "three\n");
        writeFileSync(join(desk, "extra.md"), "made by the agent\n");
        writeFileSync(join(desk, "notes.md"), "agent\n");
        return "Reply two.";
      }
      if (last.includes("second")) {
        writeFileSync(join(desk, "plan.md"), "second, done right\n");
        return "Reply two, again.";
      }
      return "Noted.";
    });
    writeFileSync(join(a.desk, "plan.md"), "one\n");
    writeFileSync(join(a.desk, "notes.md"), "mine\n");

    await a.say("Do the first part");
    assert.ok(await a.settled("Reply one."));
    await a.say("Now the secnod part");
    assert.ok(await a.settled("Reply two."));
    // the changes card lands just after the turn; let it
    const carded = await waitFor(async () => {
      const current = await a.me();
      return current.messages.filter((m: any) => m.kind === "changes").length === 2 ? current : null;
    });
    assert.ok(carded, "the second turn left no changes card");
    // the person works on one of the files after the agent did
    writeFileSync(join(a.desk, "notes.md"), "mine again\n");

    const typo = carded.messages.find((m: any) => m.role === "user" && m.text === "Now the secnod part");
    const reply = carded.messages.find((m: any) => m.text === "Reply one.");

    // what it would do, before anything is pressed
    const preview = await h.json(redoPath(carded.threadId, typo.id));
    assert.deepEqual(preview, { offered: true, messages: 2, sent: false, files: 2, working: false, resend: 1 });
    // only the person's own words can be redone, and they need words
    assert.equal((await redo(h, carded.threadId, reply.id, "Reply one, improved.")).status, 400);
    assert.equal((await h.json(redoPath(carded.threadId, reply.id))).offered, false);
    assert.equal((await redo(h, carded.threadId, typo.id, "   ")).status, 400);
    assert.equal(readFileSync(join(a.desk, "plan.md"), "utf8"), "three\n", "a refused redo took something back");

    const res = await redo(h, carded.threadId, typo.id, "Now the second part");
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    assert.equal(out.sent, true);
    assert.deepEqual([...out.restored].sort(), ["extra.md", "plan.md"]);
    assert.deepEqual(out.skipped, [{ path: "notes.md", why: "changed since" }]);
    assert.equal(out.text, undefined, "the words went to the agent, not back to the box");

    const done = await a.settled("Reply two, again.");
    assert.ok(done, "the new words never got an answer");
    // the folder: what the wrong request did is gone, the person's own
    // edit is not, and the new turn worked from there
    assert.equal(readFileSync(join(a.desk, "plan.md"), "utf8"), "second, done right\n");
    assert.equal(existsSync(join(a.desk, "extra.md")), false);
    assert.equal(readFileSync(join(a.desk, "notes.md"), "utf8"), "mine again\n");

    // the conversation: the old words and their answer are rewound, the
    // notice names the file left alone, and the new words stand as an
    // ordinary message, not one that waited
    assert.deepEqual(standing(done.messages).slice(-4), ["Do the first part", "Reply one.", "Now the second part", "Reply two, again."]);
    const rewound = done.messages.filter((m: any) => m.rewound);
    assert.ok(rewound.some((m: any) => m.id === typo.id) && rewound.some((m: any) => m.text === "Reply two."));
    const note = done.messages.find((m: any) => m.kind === "notice" && /Rewound to before your message/.test(m.text));
    assert.match(note.text, /2 files are back as they were/);
    assert.match(note.text, /Left alone, because they changed since: notes\.md/);
    const fresh = done.messages.find((m: any) => m.text === "Now the second part");
    assert.notEqual(fresh.id, typo.id);
    assert.ok(!fresh.deliveredAt && !fresh.queued && !fresh.editedAt);

    // the agent was told the new words, and never the old ones again
    const told = a.heard[a.heard.length - 1].join("\n");
    assert.match(told, /first part/);
    assert.match(told, /second part/);
    assert.doesNotMatch(told, /secnod|Reply two\./);
  });

  test("stops the agent first when it is working, and takes back what that turn had done", async (t) => {
    const a = await agentIn(t, "kimi", "Busy", (last, desk) => {
      if (last.includes("HOLD")) {
        writeFileSync(join(desk, "draft.md"), "from the wrong request\n");
        return "Never said.";
      }
      return "Quick done.";
    });
    await a.say("HOLD on and write the slow draft");
    assert.ok(await waitFor(async () => existsSync(join(a.desk, "draft.md"))), "the turn never got going");
    const during = await a.me();
    assert.equal(during.busy, true);
    const asked = during.messages.find((m: any) => m.role === "user" && /slow draft/.test(m.text));

    // while it works, the files of the turn it is in are not counted yet
    const preview = await h.json(redoPath(during.threadId, asked.id));
    assert.equal(preview.offered, true);
    assert.equal(preview.working, true);
    assert.equal(preview.messages, 1);

    const res = await redo(h, during.threadId, asked.id, "Write the quick draft");
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    assert.equal(out.sent, true);
    assert.deepEqual(out.restored, ["draft.md"]);

    const done = await a.settled("Quick done.");
    assert.ok(done, "the new words never got an answer");
    assert.equal(existsSync(join(a.desk, "draft.md")), false, "the stopped turn's file is still there");
    assert.deepEqual(standing(done.messages).slice(-2), ["Write the quick draft", "Quick done."]);
    assert.ok(!standing(done.messages).includes("Never said."));
    assert.doesNotMatch(a.heard[a.heard.length - 1].join("\n"), /slow draft/);
  });

  test("a message still waiting for its turn is not redone, and goes after the redone turn", async (t) => {
    const a = await agentIn(t, "deepseek", "Queue", (last) => (last.includes("HOLD") ? "Never said." : "Both done."));
    await a.say("HOLD the first request");
    assert.ok(await waitFor(async () => (await a.me()).busy));
    // this engine takes no words mid-turn, so the next thing said waits
    const second = await (await a.say("And then the second request")).json();
    assert.equal(second.queued, true);
    const during = await a.me();
    const first = during.messages.find((m: any) => /first request/.test(m.text));
    const waiting = during.messages.find((m: any) => /second request/.test(m.text));
    assert.equal(waiting.queued, true);

    // waiting: there is nothing of it to take back, and it is edited
    // where it waits (GitHub 155)
    const preview = await h.json(redoPath(during.threadId, waiting.id));
    assert.equal(preview.offered, false);
    assert.match(preview.why, /still waiting for its turn/);
    const refused = await redo(h, during.threadId, waiting.id, "And then the other request");
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /still waiting for its turn/);
    const still = (await a.me()).messages.find((m: any) => m.id === waiting.id);
    assert.ok(still.queued && !still.deleted && still.text === "And then the second request");

    // redoing the one it is working on leaves the waiting one waiting,
    // and one turn then takes both, the redone words first
    const res = await redo(h, during.threadId, first.id, "The first request, fixed");
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).sent, true);
    const done = await a.settled("Both done.");
    assert.ok(done, "the redone turn never ran");
    assert.deepEqual(standing(done.messages).slice(-3), ["The first request, fixed", "And then the second request", "Both done."]);
    const kept = done.messages.find((m: any) => m.id === waiting.id);
    assert.ok(!kept.rewound && !kept.queued, "the waiting message was taken back with the rest");
    const told = a.heard[a.heard.length - 1];
    assert.match(told[told.length - 1], /The first request, fixed\nAnd then the second request/);
    assert.doesNotMatch(told.join("\n"), /HOLD/);
  });

  test("when the new words cannot be sent, the conversation is rewound and the words come back", async (t) => {
    const a = await agentIn(t, "groq", "Unplugged", () => "Answered.");
    await a.say("Ask the first thing");
    const before = await a.settled("Answered.");
    assert.ok(before);
    const asked = before.messages.find((m: any) => m.role === "user" && m.text === "Ask the first thing");
    // the engine goes away between the turn and the redo
    assert.equal((await h.fetch("/api/providers/groq", { method: "DELETE" })).status, 200);

    const res = await redo(h, before.threadId, asked.id, "Ask the first thing, properly");
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    // what Rewind to here leaves: taken back, said so, and the words
    // handed back for the box rather than lost
    assert.equal(out.sent, false);
    assert.equal(out.text, "Ask the first thing, properly");
    assert.ok(out.error, "nothing says why it was not sent");
    assert.ok(out.rewound >= 2);
    const after = await a.me();
    assert.equal(after.busy, false);
    assert.ok(after.messages.find((m: any) => m.id === asked.id).rewound);
    assert.ok(after.messages.some((m: any) => m.kind === "notice" && /Rewound to before your message/.test(m.text)));
    assert.ok(!standing(after.messages).includes("Ask the first thing, properly"), "words that were not sent stand in the conversation");
  });

  test("a room has no redo", async (t) => {
    const a = await agentIn(t, "mistral", "Roomy", () => "Here.");
    const b = await agentIn(t, "grok", "Roomier", () => "Here too.");
    const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Ops", memberIds: [a.bot.id, b.bot.id] }) });
    t.after(() => h.fetch(`/api/bloks/${blok.id}`, { method: "DELETE" }));
    await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Morning all" }) });
    const said = await waitFor(async () => {
      const { messages } = await h.json(`/api/bloks/${blok.id}/messages`);
      return (messages as any[]).find((m) => m.role === "user" && m.text === "Morning all");
    });
    assert.ok(said, "the room never got the message");
    const preview = await h.json(redoPath(blok.id, said.id));
    assert.equal(preview.offered, false);
    assert.match(preview.why, /not in a room/);
    const res = await redo(h, blok.id, said.id, "Good morning all");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not in a room/);
    const { messages } = await h.json(`/api/bloks/${blok.id}/messages`);
    assert.ok((messages as any[]).some((m) => m.id === said.id && m.text === "Morning all" && !m.deleted));
  });
});

// Words said to a running turn go into it on Claude Code (GitHub 213),
// so these run on a stand-in for it: it reads stdin a line at a time and
// keeps what each process was handed in heard-<n>.
describe("redo, on an engine that takes words mid-turn", () => {
  function workspace(script: string) {
    const home = mkdtempSync(join(tmpdir(), "bloks-redo-"));
    mkdirSync(join(home, ".bloks"), { recursive: true });
    mkdirSync(join(home, "desk"), { recursive: true });
    writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
    const cli = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const n = (existsSync(home + "/spawns") ? Number(readFileSync(home + "/spawns", "utf8")) : 0) + 1;
writeFileSync(home + "/spawns", String(n));
const out = (frame) => console.log(JSON.stringify(frame));
const lines = [];
let wake = null;
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    const words = String(frame.message?.content ?? "");
    appendFileSync(home + "/heard-" + n, words + "\\n");
    lines.push(words);
  }
  wake?.();
});
const next = async (ms) => {
  const until = Date.now() + ms;
  while (!lines.length && Date.now() < until) {
    await new Promise((r) => { wake = r; setTimeout(r, 50); });
  }
  return lines.shift() ?? null;
};
const prompt = await next(10000);
out({ type: "system", subtype: "init", session_id: "sess-redo-" + n, model: "claude-sonnet-5" });
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
const done = (text, turns = 1) => out({ type: "result", subtype: "success", is_error: false, num_turns: turns, duration_api_ms: 400, total_cost_usd: 0, session_id: "sess-redo-" + n, result: text });
${script}
`;
    writeFileSync(join(home, "fake-claude.mjs"), cli, { mode: 0o755 });
    return home;
  }

  async function boot(t: TestContext, script: string) {
    const home = workspace(script);
    const h = await startHarness({ HOME: home });
    t.after(async () => {
      await h.stop();
      rmSync(home, { recursive: true, force: true });
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Steady" }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, cwd: join(home, "desk") }),
    });
    assert.equal(set.status, 200, await set.clone().text());
    const lanes = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id).tasks as any[];
    const messages = async (thread: string) => (await h.json(`/api/bots/${bot.id}/messages?thread=${thread}&limit=200`)).messages as any[];
    const idle = () => waitFor(async () => !(await lanes()).some((lane) => lane.state === "working"));
    return { home, desk: join(home, "desk"), h, bot: bot as { id: string; threadId: string }, lanes, messages, idle };
  }

  test("a message that joined a running turn goes back to that turn's start, and the person's words from it go again in order", async (t) => {
    const s = await boot(
      t,
      `if (prompt.includes("SECOND")) {
  writeFileSync("both.md", prompt + "\\n");
  say("Did both");
  done("Did both");
} else {
  writeFileSync("a.md", "from the first\\n");
  say("Working on it");
  const more = await next(15000);
  if (more) { writeFileSync("b.md", "from the second\\n"); say("Changed course"); done("Changed course", 2); }
  else { say("Nothing else came"); done("Nothing else came"); }
}`,
    );
    const { h, bot } = s;
    const thread = bot.threadId;
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "FIRST_ASK find a boat tour" }) });
    assert.ok(await waitFor(async () => standing(await s.messages(thread)).includes("Working on it")), "the turn never started");
    const sent = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "SECOND only in the mourning" }) });
    assert.equal(sent.steered, true, "the second message did not go into the running turn");
    assert.ok(await s.idle());
    assert.ok(await waitFor(async () => (await s.messages(thread)).some((m) => m.kind === "changes")), "the turn left no changes card");
    assert.ok(existsSync(join(s.desk, "a.md")) && existsSync(join(s.desk, "b.md")));

    const before = await s.messages(thread);
    const first = before.find((m) => m.text === "FIRST_ASK find a boat tour");
    const joined = before.find((m) => m.text === "SECOND only in the mourning");
    assert.equal(joined.midTurn, true, "nothing on the message says it joined a turn");
    assert.ok(!first.midTurn);

    // the whole turn comes back, since its files are undone together:
    // both of the person's messages, and both of the agent's
    const preview = await h.json(redoPath(thread, joined.id));
    assert.deepEqual(preview, { offered: true, messages: 4, sent: false, files: 2, working: false, resend: 2 });

    const res = await redo(h, thread, joined.id, "SECOND only in the morning");
    assert.equal(res.status, 200, await res.clone().text());
    const out = await res.json();
    assert.equal(out.sent, true);
    assert.deepEqual([...out.restored].sort(), ["a.md", "b.md"]);

    assert.ok(await waitFor(async () => standing(await s.messages(thread)).includes("Did both")), "the redone turn never answered");
    assert.ok(await s.idle());
    const after = await s.messages(thread);
    assert.deepEqual(standing(after).slice(-3), ["FIRST_ASK find a boat tour", "SECOND only in the morning", "Did both"]);
    for (const old of [first, joined]) assert.ok(after.find((m) => m.id === old.id).rewound, "an old message of the turn still stands");
    // before the first message of the turn: neither of its files is left
    assert.equal(existsSync(join(s.desk, "a.md")), false);
    assert.equal(existsSync(join(s.desk, "b.md")), false);
    // one new turn heard both, in the order they were said, with the change
    assert.equal(readFileSync(join(s.home, "spawns"), "utf8"), "2");
    assert.match(readFileSync(join(s.home, "heard-2"), "utf8"), /FIRST_ASK find a boat tour\nSECOND only in the morning/);
    assert.doesNotMatch(readFileSync(join(s.home, "heard-2"), "utf8"), /mourning/);
  });

  test("a message that joined a turn a routine started is not redone", async (t) => {
    const s = await boot(
      t,
      `say("Working on it");
const more = await next(15000);
say(more ? "Heard you" : "Nothing else came");
done("Done", more ? 2 : 1);`,
    );
    const { h, bot } = s;
    const { routine } = await h.json("/api/routines", {
      method: "POST",
      body: JSON.stringify({ targetId: bot.id, targetKind: "agent", name: "Tides", prompt: "ROUTINE check the tides", time: "03:00", days: [] }),
    });
    assert.equal((await h.fetch(`/api/routines/${routine.id}/run`, { method: "POST" })).status, 202);
    // a routine may run in a conversation of its own
    const lane = await waitFor(async () => (await s.lanes()).find((l) => l.state === "working"));
    assert.ok(lane, "the routine never started a turn");
    assert.ok(await waitFor(async () => standing(await s.messages(lane.id)).includes("Working on it")));
    const sent = await h.json(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Only the morning ones", taskId: lane.id }) });
    assert.equal(sent.steered, true, "the person's words did not go into the routine's turn");
    assert.ok(await s.idle());

    const said = await s.messages(lane.id);
    const theirs = said.find((m) => m.text === "ROUTINE check the tides");
    const mine = said.find((m) => m.text === "Only the morning ones");
    assert.equal(theirs.via, "routine");
    assert.equal(mine.midTurn, true);

    // the routine's own words are not the person's to redo
    assert.equal((await h.json(redoPath(lane.id, theirs.id))).offered, false);
    assert.equal((await redo(h, lane.id, theirs.id, "ROUTINE check the weather")).status, 400);
    // and the person's joined a turn whose request cannot be sent again
    const preview = await h.json(redoPath(lane.id, mine.id));
    assert.equal(preview.offered, false);
    assert.match(preview.why, /a turn you did not start/);
    const res = await redo(h, lane.id, mine.id, "Only the evening ones");
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /a turn you did not start/);

    // nothing was taken back, and saving the words still works
    const after = await s.messages(lane.id);
    assert.ok(!after.some((m) => m.rewound));
    assert.equal(readFileSync(join(s.home, "spawns"), "utf8"), "1");
    const saved = await h.fetch(`/api/threads/${lane.id}/messages/${mine.id}`, { method: "PATCH", body: JSON.stringify({ text: "Only the evening ones" }) });
    assert.equal(saved.status, 200);
    await h.fetch(`/api/routines/${routine.id}`, { method: "DELETE" });
  });
});
