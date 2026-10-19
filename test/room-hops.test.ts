// 268: a room mention the hop bound held was stored, answered 201 and
// dropped without a word, and the count it was held by belonged to the
// agent rather than to the turn speaking, so a room chain that had ended
// could hold what the same agent said from an unrelated turn later.
//
// The count now travels with the turn, the way a chain place does: none
// for a turn the person (or anything but a room mention) started, one
// more than the turn that named it for a mention's. And a held mention
// leaves a notice in the room.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_AGENT_HOPS, heldMention, hopsNotice } from "../server/room-hops.ts";
import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** What the room says when `from` named `named` past the hop bound. */
const heldBy = (from: string, ...named: string[]) =>
  `${from} named ${named.join(", ")} after agents had already passed the room along 3 times in a row without you, so nobody was woken. Post in the room to carry on.`;

test("a held mention's notice says who named whom, and one notice covers both bounds", () => {
  assert.equal(MAX_AGENT_HOPS, 3);
  // inside both bounds it goes through
  assert.equal(heldMention("Bob", ["Alice"], { hops: 3, chain: 12 }, 12), null);
  assert.equal(heldMention("Bob", ["Alice"], { hops: 1, chain: 1 }, 12), null);
  // the room's own bound
  assert.equal(heldMention("Bob", ["Alice"], { hops: 4, chain: 4 }, 12), heldBy("Bob", "Alice"));
  assert.equal(hopsNotice("Bob", ["Alice", "Cara"]), heldBy("Bob", "Alice", "Cara"));
  // the chain bound, worded as it was before there were two
  const chained = heldMention("Bob", ["Alice"], { hops: 1, chain: 13 }, 12)!;
  assert.match(chained, /from Bob to Alice in this room woke nobody/);
  assert.match(chained, /helps prevent repeated messages from using up your plan/);
  assert.match(chained, /limit of 12 consecutive turns/);
  assert.match(chained, /Settings > General > Working with agents/);
  // past both, the room hears of it once
  assert.equal(heldMention("Bob", ["Alice"], { hops: 4, chain: 13 }, 12), heldBy("Bob", "Alice"));
});

type Reply = (last: string, n: number) => string | null | undefined;

/**
 * A workspace with two kinds of agent. `api` agents run on a stand-in
 * provider, each on its own model name so a call says whose turn it is: a
 * turn ends when the test finishes its call, or at once with whatever
 * `replies` answers for it (given the words it was asked and how many
 * calls that agent has had). `cli` agents run a stand-in Claude Code that
 * can act with its turn's credential: told RELAY room=<id> names=<A,B>,
 * in a conversation or in the room's own lines, it says that on in the
 * room with the real `bloks say`, naming each of them. Every one is a
 * line in says.jsonl. With SILENT turn=<n> after it, the nth of these
 * stand-in turns ends without a word of its own.
 */
async function workspace(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-room-hops-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
let started = false;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim() || started) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    started = true;
    go(typeof frame.message?.content === "string" ? frame.message.content : JSON.stringify(frame.message?.content ?? ""));
  }
});
function go(prompt) {
  out({ type: "system", subtype: "init", session_id: "sess-hops", model: "claude-sonnet-5" });
  // which of this workspace's stand-in turns this is, counted from one
  appendFileSync(home + "/turns.log", "x");
  const turn = readFileSync(home + "/turns.log", "utf8").length;
  // SILENT turn=<n> rides along: that turn ends without a word of its own
  const relay = prompt.match(/RELAY room=([\\w-]+) names=([\\w,]+)( SILENT turn=(\\d+))?/);
  if (relay && !existsSync(home + "/quiet")) {
    const [, room, names, silent = ""] = relay;
    const words = names.split(",").map((name) => "@" + name).join(" ") + " RELAY room=" + room + " names=" + names + silent;
    let said;
    try { said = JSON.parse(execFileSync(process.execPath, [${JSON.stringify(BLOKS)}, "say", room, words], { encoding: "utf8" })); }
    catch (e) { said = { refused: true, ...JSON.parse(String(e.stdout || "{}")) }; }
    appendFileSync(home + "/says.jsonl", JSON.stringify({ turn, stored: Boolean(said.message?.id), refused: Boolean(said.refused) }) + "\\n");
  }
  const text = relay && Number(relay[4]) === turn ? "" : "Done";
  if (text) out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-hops", result: text });
}
`,
    { mode: 0o755 },
  );

  const calls: Array<{ who: string; last: string; finish: (text?: string) => void; done: boolean }> = [];
  const replies: Record<string, Reply | undefined> = {};
  const models = new Map<string, string>();
  let closing = false;
  const provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/models")) {
        return res.end(JSON.stringify({ data: ["alice-model", "bob-model"].map((id) => ({ id })) }));
      }
      const parsed = JSON.parse(body);
      const who = models.get(parsed.model) ?? "?";
      const users = (parsed.messages as any[]).filter((m) => m.role === "user");
      const content = users.at(-1)?.content;
      const last = typeof content === "string" ? content : JSON.stringify(content);
      const call = {
        who, last, done: false,
        finish: (text = "Done.") => {
          if (call.done) return;
          call.done = true;
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
        },
      };
      calls.push(call);
      const answer = closing ? "Done." : replies[who]?.(last, calls.filter((c) => c.who === who).length);
      if (typeof answer === "string") call.finish(answer);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as { port: number }).port;
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    closing = true;
    writeFileSync(join(home, "quiet"), "");
    calls.forEach((call) => call.finish());
    await h.stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown) => h.json(path, { method: "POST", body: JSON.stringify(body) });
  await post("/api/providers/grok/connect", { key: "test-key", url: `http://127.0.0.1:${port}` });
  const hire = async (name: string, modelSelection: { instanceId: string; model: string }) => {
    const { bot } = await post("/api/bots", { name });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection }) });
    return bot as { id: string; name: string };
  };
  const anyBusy = async () => ((await h.json("/api/bots?messages=0")).bots as any[]).some((b) => b.busy);
  let roomId = "";
  const lines = async () => (await h.json(`/api/bloks/${roomId}/messages?limit=200`)).messages as any[];
  return {
    h, home, calls, replies,
    api: (name: string) => {
      const model = `${name.toLowerCase()}-model`;
      models.set(model, name);
      return hire(name, { instanceId: "grok", model });
    },
    cli: (name: string) => hire(name, { instanceId: "claude", model: "claude-sonnet-5" }),
    async room(...members: Array<{ id: string }>) {
      const { blok } = await post("/api/bloks", { name: "Hops", memberIds: members.map((m) => m.id) });
      roomId = blok.id;
      return roomId;
    },
    /** The person, in the room. */
    say: (text: string) => post(`/api/bloks/${roomId}/messages`, { text }),
    /** The person, in an agent's own conversation. */
    direct: (bot: { id: string }, text: string) => post(`/api/bots/${bot.id}/messages`, { text }),
    lines,
    /** The room's notices for held mentions, oldest first. */
    held: async () => (await lines()).filter((m) => m.kind === "notice" && m.chainHeld).map((m) => m.text as string),
    of: (who: string) => calls.filter((c) => c.who === who),
    /** An agent's nth call, once it has been made. */
    nth: (who: string, n: number) => waitFor(() => calls.filter((c) => c.who === who)[n - 1]),
    says: () =>
      existsSync(join(home, "says.jsonl"))
        ? readFileSync(join(home, "says.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { turn: number; stored: boolean; refused: boolean })
        : [],
    /** Nobody busy, and the room's rounds (which poll every 250 ms) done. */
    async settled() {
      for (let quiet = 0; quiet < 2; ) {
        await waitFor(async () => !(await anyBusy()), 30_000);
        await new Promise((r) => setTimeout(r, 1_000));
        quiet = (await anyBusy()) ? 0 : quiet + 1;
      }
    },
  };
}

// Two agents that always name each other: one line from the person allows
// the turn it wakes and three more, each started by the one before.
const pingPong = (w: Awaited<ReturnType<typeof workspace>>) => {
  w.replies.Alice = () => "@Bob over to you";
  w.replies.Bob = () => "@Alice over to you";
};

test("after the person's post the fourth mention in a row is held with a notice, and their next post starts over", async (t) => {
  const w = await workspace(t);
  const alice = await w.api("Alice");
  const bob = await w.api("Bob");
  await w.room(alice, bob);
  pingPong(w);

  await w.say("@Alice start");
  await waitFor(() => w.calls.length >= 4);
  await w.settled();
  // Alice for the person, then Bob, Alice and Bob for one another; the
  // fourth mention is Bob's, and nobody is woken for it
  assert.deepEqual(w.calls.map((c) => c.who), ["Alice", "Bob", "Alice", "Bob"]);
  assert.deepEqual(await w.held(), [heldBy("Bob", "Alice")], "the room does not say the mention was held");
  const last = (await w.lines()).at(-1);
  assert.equal(last.kind, "notice");
  assert.equal(last.chainHeld, true, "the hold is not marked as waiting for the person");

  // the person has had a say: four more turns, and the same notice again
  // below them
  await w.say("@Alice once more");
  await waitFor(() => w.calls.length >= 8);
  await w.settled();
  assert.equal(w.calls.length, 8, `the person's post did not start a fresh chain: ${w.calls.length} turns`);
  assert.deepEqual(await w.held(), [heldBy("Bob", "Alice"), heldBy("Bob", "Alice")]);
});

test("a last turn that names nobody leaves no notice", async (t) => {
  const w = await workspace(t);
  const alice = await w.api("Alice");
  const bob = await w.api("Bob");
  await w.room(alice, bob);
  w.replies.Alice = () => "@Bob over to you";
  w.replies.Bob = (_last, n) => (n === 1 ? "@Alice over to you" : "Nothing more from me.");

  await w.say("@Alice start");
  await waitFor(() => w.calls.length >= 4);
  await w.settled();
  assert.equal(w.calls.length, 4);
  assert.deepEqual(await w.held(), [], "a turn at the bound that named nobody was reported as held");
});

test("a mention that waited for a busy agent is delivered once it is free, at the count of the chain it came from", async (t) => {
  const w = await workspace(t);
  const alice = await w.api("Alice");
  const bob = await w.api("Bob");
  await w.room(alice, bob);
  // Alice's second turn and Bob's own task end when the test says
  w.replies.Alice = (_last, n) => (n === 2 ? null : "@Bob over to you");
  w.replies.Bob = (last) => (last.includes("a long task") ? null : "@Alice over to you");

  await w.say("@Alice start");
  const second = await w.nth("Alice", 2);
  assert.ok(second, "the chain never reached Alice's second turn");
  // Bob has answered in the room and is idle: the person gives him work
  await waitFor(async () => !((await w.h.json("/api/bots?messages=0")).bots as any[]).find((b) => b.id === bob.id).busy);
  await w.direct(bob, "a long task of your own");
  const own = await w.nth("Bob", 2);
  assert.ok(own?.last.includes("a long task"), "Bob never started his own task");

  // Alice names him a third time in a row while he is busy: it waits
  second.finish("@Bob over to you");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(w.of("Bob").length, 2, "the mention interrupted the turn he was in");
  assert.deepEqual(await w.held(), []);

  // free, he hears it, once, three along as it was when it was said: so
  // his own mention of Alice is the fourth, and it is held
  own!.finish("Finished.");
  const late = await w.nth("Bob", 3);
  assert.ok(late?.last.includes("over to you"), "the waiting mention was never delivered");
  await w.settled();
  assert.equal(w.of("Bob").length, 3, "delivered more than once");
  assert.equal(w.of("Alice").length, 2, "the mention that waited started its chain over");
  assert.deepEqual(await w.held(), [heldBy("Bob", "Alice")]);

  // and nothing of it is left for what comes next
  w.replies.Alice = () => "@Bob over to you";
  await w.say("@Bob start again");
  await waitFor(() => w.calls.length >= 9);
  await w.settled();
  assert.deepEqual(w.calls.slice(5).map((c) => c.who), ["Bob", "Alice", "Bob", "Alice"]);
  assert.deepEqual(await w.held(), [heldBy("Bob", "Alice"), heldBy("Alice", "Bob")]);
});

test("a message waiting behind a room turn at the bound does not let that turn's mention through", async (t) => {
  const w = await workspace(t);
  const alice = await w.api("Alice");
  const bob = await w.api("Bob");
  await w.room(alice, bob);
  w.replies.Alice = () => "@Bob over to you";
  // Bob's second room turn, three along, ends when the test says
  w.replies.Bob = (last, n) => (last.includes("one more thing") ? "Noted." : n === 2 ? null : "@Alice over to you");

  await w.say("@Alice start");
  const third = await w.nth("Bob", 2);
  assert.ok(third, "the chain never reached Bob's second turn");
  // The person writes to Bob in his own conversation, where that turn is
  // running. It waits there for the lane's next turn, which is theirs and
  // starts at none; the turn ending is still judged by its own count.
  await w.direct(bob, "one more thing");
  third.finish("@Alice over to you");
  await waitFor(() => w.of("Bob").length >= 3);
  await w.settled();
  assert.ok(w.of("Bob")[2].last.includes("one more thing"));
  assert.equal(w.of("Alice").length, 2, "the fourth mention went through on the next turn's count");
  assert.deepEqual(await w.held(), [heldBy("Bob", "Alice")]);
});

test("an agent's say into a room is held at the fourth in a row, and from a fresh turn afterwards it is delivered", async (t) => {
  const w = await workspace(t);
  const alpha = await w.cli("Alpha");
  const bravo = await w.cli("Bravo");
  const roomId = await w.room(alpha, bravo);
  const relay = `RELAY room=${roomId} names=Alpha,Bravo`;
  const says = (n: number) => waitFor(() => (w.says().length >= n ? true : null), 60_000);

  // From a conversation: Alpha's turn there is the person's, so what it
  // says in the room is the first mention. Bravo, Alpha and Bravo each
  // say it on from the room, and the fourth, Bravo's, wakes nobody.
  await w.direct(alpha, relay);
  assert.ok(await says(4), `only ${w.says().length} of four were said`);
  await w.settled();
  assert.equal(w.says().length, 4, "the room was passed along past the bound");
  assert.ok(w.says().every((said) => said.stored && !said.refused), "a say into the room was refused");
  assert.deepEqual(await w.held(), [heldBy("Bravo", "Alpha")], "the fourth say was stored and the room does not say nobody was woken");

  // Bravo's last room turn was three along. A turn the person starts in
  // its own conversation is not: what it says in the room is delivered.
  await w.direct(bravo, relay);
  assert.ok(await says(8), `a fresh turn's mention was held by the old room chain: ${w.says().length} said`);
  await w.settled();
  assert.equal(w.says().length, 8);
  assert.deepEqual(await w.held(), [heldBy("Bravo", "Alpha"), heldBy("Alpha", "Bravo")]);

  // The same after the person's post in the room: the turn it wakes says
  // the first, and the fourth is held.
  await w.say("@Alpha once more");
  assert.ok(await says(12), `only ${w.says().length} of twelve were said`);
  await w.settled();
  assert.equal(w.says().length, 12);
  assert.deepEqual(await w.held(), [heldBy("Bravo", "Alpha"), heldBy("Alpha", "Bravo"), heldBy("Bravo", "Alpha")]);
});

test("a held say that is also its turn's last word in the room leaves one notice, not two", async (t) => {
  const w = await workspace(t);
  const alpha = await w.cli("Alpha");
  const bravo = await w.cli("Bravo");
  const roomId = await w.room(alpha, bravo);

  // The fourth turn says its line in the room and ends without another
  // word, so that line is passed on twice: as it is posted, and as the
  // last thing the turn said there.
  await w.say(`@Alpha RELAY room=${roomId} names=Alpha,Bravo SILENT turn=4`);
  assert.ok(await waitFor(() => (w.says().length >= 4 ? true : null), 60_000));
  await w.settled();
  assert.equal(w.says().length, 4);
  const lines = await w.lines();
  assert.deepEqual(await w.held(), [heldBy("Bravo", "Alpha")], `the same notice twice in a row: ${JSON.stringify(lines.slice(-4).map((m) => m.text))}`);
  assert.equal(lines.at(-1).text, heldBy("Bravo", "Alpha"));
});

test("someone still named when a round runs out is held with the notice too", async (t) => {
  const w = await workspace(t);
  const alice = await w.api("Alice");
  const bob = await w.api("Bob");
  const cara = await w.cli("Cara");
  const roomId = await w.room(alice, bob, cara);
  w.replies.Alice = () => "@Bob over to you";
  // Bob's second turn is the last the round runs, and ends when the test says
  w.replies.Bob = (_last, n) => (n === 2 ? null : "@Alice over to you");

  await w.say("@Alice start");
  const lastTurn = await w.nth("Bob", 2);
  assert.ok(lastTurn, "the round never reached its last turn");
  // Meanwhile Cara, from a turn of her own that the person started, names
  // Alice in the room. It is inside the bound, so it waits for the round.
  await w.direct(cara, `RELAY room=${roomId} names=Alice`);
  assert.ok(await waitFor(() => (w.says().length ? true : null), 30_000), "Cara never said it");
  assert.equal(w.says()[0].stored, true);
  lastTurn.finish("Nothing more from me.");
  await w.settled();

  assert.equal(w.of("Alice").length, 2, "the round went on past its bound");
  assert.deepEqual(await w.held(), [heldBy("Cara", "Alice")], "the mention left waiting was dropped without a word");
});
