// Words an agent wrote are never read as the person's (server/said-by.ts).
//
// A message the person typed carries no mark of its own, so "no author,
// no agent note, no via" was read as "the owner's words" all over the
// server. An agent writing to itself, or a job one posted, used to land
// with none of those marks and pass. It is marked `selfSent` now, and each
// check that decides something from "the owner said it" holds it as an
// agent's: the owner's turn and its notifications, starting a chain of
// agents' messages over, which waiting words are theirs, recall, named
// skills, editing, redo, read places, the last time an agent was with
// the person, and how the app draws it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";

import { lastWithYou } from "../server/activity.ts";
import { wroteIt } from "../server/last-read.ts";
import { notOwners } from "../server/model-instructions.ts";
import { redoPlan } from "../server/redo.ts";
import { agentWrote, personsWords, startsChainOver } from "../server/said-by.ts";
import type { Message } from "../server/store.ts";
import { lastEditable } from "../src/lib/transcript.ts";
import { controlledChain } from "./helpers/agent-chain.ts";
import { inFlight, waitFor } from "./helpers/turns.ts";

const msg = (over: Partial<Message> & { id: string }, at = 1_000): Message => ({ role: "user", kind: "text", text: "words", at, ...over });
const own = msg({ id: "own" });
const self = msg({ id: "self", selfSent: true });
const peer = msg({ id: "peer", agent: { dir: "in", peerId: "b", peerName: "Ben" } });

describe("one test for who wrote it", () => {
  test("an agent wrote it when another agent did, or when it carries the self mark", () => {
    assert.equal(agentWrote(own), false);
    assert.equal(agentWrote(self), true);
    assert.equal(agentWrote(peer), true);
    assert.equal(agentWrote(undefined), false);
  });

  test("the person's own words exclude it, and so does starting a chain over", () => {
    assert.equal(personsWords(own), true);
    assert.equal(personsWords(self), false);
    assert.equal(personsWords(peer), false);
    assert.equal(personsWords(msg({ id: "w", via: "webhook" })), false);
    assert.equal(personsWords(msg({ id: "r", via: "routine", routine: { manual: false } })), false);
    assert.equal(startsChainOver(own), true);
    assert.equal(startsChainOver(self), false, "an agent's own words never reset the turn limit");
    assert.equal(startsChainOver(msg({ id: "j", via: "watcher" })), false);
  });

  test("an instruction to change models is never one of them", () => {
    assert.match(notOwners(self) ?? "", /an agent wrote it/);
  });
});

describe("each check that reads the owner's words", () => {
  test("read places: the owner did not write it, so it is not where they read to", () => {
    assert.equal(wroteIt("owner")(own), true);
    assert.equal(wroteIt("owner")(self), false);
  });

  test("the last time an agent was with the person does not count its own words", () => {
    assert.equal(lastWithYou([msg({ id: "a" }, 10), msg({ id: "b", selfSent: true }, 50)]), 10);
  });

  test("redo is not offered for the agent's own words", () => {
    assert.equal(redoPlan([own, self], "self"), "not-yours");
    assert.notEqual(redoPlan([own, self], "own"), "not-yours");
  });

  test("the composer's arrow up skips them, and the chat draws them as the agent's, with no edit or redo", () => {
    assert.equal(lastEditable([own, self] as any)?.id, "own");
    const chat = readFileSync(new URL("../src/components/ChatView.tsx", import.meta.url), "utf8");
    assert.match(chat, /const sentByYou = \(m: Message\) => m\.role === "user" && !m\.via && !m\.agent && !m\.selfSent/);
    assert.match(chat, /m\.role === "bot" \|\| m\.selfSent \? \(/);
    assert.match(chat, /author=\{telegramSpeaker\(m\)\?\.name \?\? \(m\.role === "user" && !m\.selfSent \?/);
    assert.match(chat, /onEdit=\{m\.selfSent \? undefined :/);
    assert.match(chat, /onRedo=\{m\.selfSent \? undefined :/);
    assert.match(chat, /mine: m\.role === "user" && !m\.author && !m\.selfSent/);
  });

  test("the server's turn checks go through the same test", () => {
    const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    const at = (needle: string) => {
      const i = server.indexOf(needle);
      assert.ok(i >= 0, needle);
      return server.slice(i, i + 1_200);
    };
    // a waiting burst is the owner's turn only for the owner's words
    assert.match(at("const byYou = said.some("), /!agentWrote\(m\) && !m\.via/);
    // a cut-off turn picked up again, the same
    assert.match(at("const yours = alive.some(({ item }) =>"), /!agentWrote\(m\) && !m\.via/);
    // a chain of agents' messages starts over only for the owner's words
    assert.match(at("function burstChain("), /if \(startsChainOver\(m\)\) return 0;[\s\S]*if \(m\?\.selfSent\) depth = Math\.max/);
    // recall and named skills read only the owner's waiting words
    assert.match(at("const waited = recallWanted && opts.presetMessage"), /!agentWrote\(m\) && !m\.via/);
    assert.match(at("const personalWords = opts.personalMessages && !blok"), /!agentWrote\(m\) && !m\.via/);
    // which waiting words are the owner's, for joining and ordering
    assert.match(at("const earlierWaiting = (steerQueues"), /!agentWrote\(m\) && !m\.via/);
    assert.match(at("const earlierPersonal = ahead.some("), /!agentWrote\(m\) && !m\.via/);
    assert.match(at("const yoursWaiting = waiting.some("), /!agentWrote\(m\) && !m\.via/);
    assert.match(at("async function sendWaitingNow("), /!agentWrote\(m\) && !m\.via/);
    // the Burst a waiting run carries
    assert.match(at("function burstOf("), /said\.some\(personsWords\)/);
    // and nothing left that reads "no agent note" alone as the person
    assert.doesNotMatch(server, /!m\.agent && !m\.via/);
    // the edit route refuses them as it refuses an agent's reply
    assert.match(at("const refused = (row: Message | undefined)"), /if \(row\.selfSent\) return \{ status: 403/);
    // and an export of runs does not count them as the owner steering
    const exported = readFileSync(new URL("../server/run-export.ts", import.meta.url), "utf8");
    assert.match(exported, /const ownWords = \(m: Message\) => said\(m\) && !m\.agent && !m\.selfSent/);
  });
});

describe("over the wire", () => {
  test("an agent's words to itself are marked, start no owner's turn, and cannot be edited or redone as the owner's", async (t) => {
    const f = await controlledChain(t);
    const ada = await f.hire("Ada");
    const turn = await f.begin(ada, "Owner words");
    // the owner's own turn is the owner's
    const mine = inFlight(f.home).find((r: any) => r.laneId === ada.threadId);
    assert.equal(mine?.byYou, true, JSON.stringify(inFlight(f.home)));

    const n = f.turns().length;
    const said = await f.agent(turn, `/api/bots/${ada.id}/messages`, { text: "Self words", taskId: ada.threadId });
    assert.ok(said.ok, await said.clone().text());
    const row = (await f.messages(ada)).find((m) => m.role === "user" && m.text === "Self words");
    assert.equal(row?.selfSent, true);

    // the turn those words start is not the owner's
    writeFileSync(`${f.home}/finish-${turn.pid}`, "");
    const next = await f.turnAfter(n);
    assert.match(next.text, /Self words/);
    const theirs = await waitFor(() => inFlight(f.home).find((r: any) => r.laneId === ada.threadId && r.startedAt > mine.startedAt) ?? null);
    assert.ok(theirs);
    assert.notEqual(theirs.byYou, true, JSON.stringify(theirs));

    // the owner's app cannot edit or redo them as the owner's
    const edit = await f.h.fetch(`/api/threads/${ada.threadId}/messages/${row.id}`, { method: "PATCH", body: JSON.stringify({ text: "Now mine" }) });
    assert.equal(edit.status, 403);
    const preview = await f.h.json(`/api/threads/${ada.threadId}/messages/${row.id}/redo`);
    assert.equal(preview.offered, false, JSON.stringify(preview));
    assert.equal((await f.messages(ada)).find((m) => m.id === row.id)?.text, "Self words");
  });
});
