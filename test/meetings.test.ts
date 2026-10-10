// Meeting notes: a transcript in, a write-up and action items out.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

import { actionItems, cleanSegment, notesPrompt, transcriptOf } from "../server/meetings.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

describe("the transcript and the items", () => {
  test("turns of speech are joined, and each side is named", () => {
    const text = transcriptOf([
      { at: 1, who: "you", text: "Let's move launch." },
      { at: 2, who: "you", text: "Friday works." },
      { at: 3, who: "them", text: "Agreed, and I'll tell press." },
    ], { you: "Hamed", them: "Them" });
    assert.equal(text, "Hamed: Let's move launch. Friday works.\nThem: Agreed, and I'll tell press.");
  });

  test("action items are read from their section, owners matched to agents", () => {
    const notes = [
      "## Summary",
      "- Launch moves to Friday",
      "## Decisions",
      "- Friday",
      "## Action items",
      "- Scout: update the launch plan",
      "- **Hamed**: tell the board",
      "- [ ] juno: draft the press note",
      "Not a list line",
      "## Something else",
      "- Ivy: not an item",
    ].join("\n");
    const agents = [{ id: "s", name: "Scout" }, { id: "j", name: "Juno" }, { id: "i", name: "Ivy" }];
    assert.deepEqual(actionItems(notes, agents), [
      { owner: "Scout", text: "update the launch plan", botId: "s" },
      { owner: "Hamed", text: "tell the board" },
      { owner: "juno", text: "draft the press note", botId: "j" },
    ]);
  });

  test("the note-taker is told who is who and the shape to answer in", () => {
    const prompt = notesPrompt({ title: "Launch sync", startedAt: 0, endedAt: 30 * 60_000, system: true }, "Hamed: hi", ["Scout", "Juno"], "Hamed");
    assert.match(prompt, /called "Launch sync", about 30 minutes long/);
    assert.match(prompt, /"Them" is everyone else on the call/);
    assert.match(prompt, /## Action items/);
    assert.match(prompt, /Scout, Juno/);
  });

  test("segments are checked", () => {
    assert.equal(cleanSegment({ text: "   " }), null);
    assert.deepEqual(cleanSegment({ text: " hi  there ", who: "them", at: 5 }), { at: 5, who: "them", text: "hi there" });
    assert.equal(cleanSegment({ text: "x", who: "someone" })?.who, "you");
  });
});

describe("through the server", () => {
  let h: Harness;
  let close = () => {};
  const asked: string[] = [];
  /** Write-ups the engine refuses before it starts answering them. */
  let refuseWriteUps = 0;
  before(async () => {
    h = await startHarness();
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        }
        const messages = JSON.parse(body).messages ?? [];
        const last = String(messages[messages.length - 1]?.content ?? "");
        if (refuseWriteUps > 0 && /You took notes in a meeting/.test(last)) {
          refuseWriteUps--;
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "the model refused this request" } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        asked.push(last);
        const reply = /You took notes in a meeting/.test(last)
          ? "## Summary\n- Launch moves to Friday\n## Decisions\n- Friday\n## Action items\n- Scout: update the launch plan\n- Hamed: tell the board"
          : "On it.";
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    close = () => engine.close();
    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
  });
  after(async () => {
    close();
    await h.stop();
  });

  test("listen, stop, get notes, hand an item to its agent", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
    const { meeting } = await h.json("/api/meetings", { method: "POST", body: JSON.stringify({ botId: bot.id, title: "Launch sync", system: true }) });
    const heard = await h.json(`/api/meetings/${meeting.id}/segments`, {
      method: "POST",
      body: JSON.stringify({ segments: [{ who: "you", text: "Let's move the launch to Friday." }, { who: "them", text: "Agreed." }, { text: "" }] }),
    });
    assert.equal(heard.heard, 2);
    const ended = await h.json(`/api/meetings/${meeting.id}/end`, { method: "POST" });
    assert.ok(ended.laneId);
    let items: any[] | null = null;
    for (let i = 0; i < 150 && !items; i++) {
      const { meetings } = await h.json("/api/meetings");
      items = meetings.find((m: any) => m.id === meeting.id)?.items ?? null;
      if (!items) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(items, "no items came back");
    assert.deepEqual(items!.map((i: any) => [i.owner, Boolean(i.botId)]), [["Scout", true], ["Hamed", false]]);
    assert.ok(asked.some((q) => /You: Let's move the launch to Friday\.\nThem: Agreed\./.test(q)), "the note-taker saw the transcript");
    assert.equal((await h.fetch(`/api/meetings/${meeting.id}/items/1/send`, { method: "POST" })).status, 400, "Hamed is not an agent");
    const sent = await h.fetch(`/api/meetings/${meeting.id}/items/0/send`, { method: "POST" });
    assert.equal(sent.status, 200);
    assert.equal((await h.fetch(`/api/meetings/${meeting.id}/items/0/send`, { method: "POST" })).status, 409, "once");
    assert.equal((await h.fetch(`/api/meetings/${meeting.id}/end`, { method: "POST" })).status, 409);
  });

  test("a write-up that failed can be asked for again", async () => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Juno" }) });
    await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" } }) });
    const { meeting } = await h.json("/api/meetings", { method: "POST", body: JSON.stringify({ botId: bot.id, title: "Retro", system: false }) });
    await h.json(`/api/meetings/${meeting.id}/segments`, { method: "POST", body: JSON.stringify({ segments: [{ who: "you", text: "Ship it Friday." }] }) });
    const find = async () => ((await h.json("/api/meetings")).meetings as any[]).find((m) => m.id === meeting.id);

    refuseWriteUps = 1;
    const first = await h.json(`/api/meetings/${meeting.id}/end`, { method: "POST" });
    assert.ok(first.laneId);
    let released = false;
    for (let i = 0; i < 150 && !released; i++) {
      released = !(await find())?.laneId;
      if (!released) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(released, "the failed write-up let go of the meeting");

    const again = await h.fetch(`/api/meetings/${meeting.id}/end`, { method: "POST" });
    assert.equal(again.status, 200, "and it can be written up again");
    let items: any[] | null = null;
    for (let i = 0; i < 150 && !items; i++) {
      items = (await find())?.items ?? null;
      if (!items) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(items, "the second write-up brought its items back");
  });
});
