// Rewind: back to before one of your messages, conversation and folder.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

async function waitFor<T>(check: () => Promise<T | null | undefined>, timeoutMs = 15_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe("rewind", () => {
  let h: Harness;
  const desk = mkdtempSync(join(tmpdir(), "bloks-rewind-desk-"));
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.stop();
    rmSync(desk, { recursive: true, force: true });
  });

  test("takes the conversation and the folder back, and the agent forgets what was rewound", async (t) => {
    writeFileSync(join(desk, "plan.md"), "one\n");
    // An engine that, like a real agent, edits the folder mid-turn: what
    // it does depends on what it was asked. It also keeps every request,
    // so the test can see what the agent was told afterwards.
    const heard: string[][] = [];
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        }
        const messages: Array<{ role: string; content: unknown }> = JSON.parse(body).messages ?? [];
        const said = messages.map((m) => String(m.content ?? ""));
        heard.push(said);
        const last = said[said.length - 1] ?? "";
        let reply = "Noted.";
        if (last.includes("first")) {
          writeFileSync(join(desk, "plan.md"), "two\n");
          reply = "Reply one.";
        } else if (last.includes("second")) {
          writeFileSync(join(desk, "plan.md"), "three\n");
          writeFileSync(join(desk, "extra.md"), "made by the agent\n");
          reply = "Reply two.";
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    t.after(() => engine.close());
    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({ key: "xai-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });

    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Editor" }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "m-1" }, cwd: desk }),
    });
    assert.equal(set.status, 200, await set.clone().text());

    const me = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    const say = async (text: string, expect: string) => {
      await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
      const done = await waitFor(async () => {
        const current = await me();
        return !current.busy && current.messages.some((m: any) => m.text === expect) ? current : null;
      });
      assert.ok(done, `no "${expect}"`);
      // the changes card lands just after the turn; let it
      await waitFor(async () => ((await me()).messages.some((m: any) => m.kind === "changes") ? true : null), 3_000);
      return done;
    };

    await say("Do the first part", "Reply one.");
    await say("Now the second part", "Reply two.");
    assert.equal(readFileSync(join(desk, "plan.md"), "utf8"), "three\n");
    assert.ok(existsSync(join(desk, "extra.md")));

    const before = await me();
    const second = before.messages.find((m: any) => m.role === "user" && m.text === "Now the second part");
    const reply = before.messages.find((m: any) => m.text === "Reply one.");

    // only your own words are a place to rewind to
    const wrong = await h.fetch(`/api/threads/${before.threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId: reply.id }) });
    assert.equal(wrong.status, 400);

    const res = await h.fetch(`/api/threads/${before.threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId: second.id }) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.text, "Now the second part", "your message comes back to you");
    assert.deepEqual([...out.restored].sort(), ["extra.md", "plan.md"]);
    assert.deepEqual(out.skipped, []);

    // the folder is as it was before the second message
    assert.equal(readFileSync(join(desk, "plan.md"), "utf8"), "two\n");
    assert.equal(existsSync(join(desk, "extra.md")), false);

    // the conversation: everything from that message on is rewound, and
    // a note says what happened
    const after = await me();
    const rewound = after.messages.filter((m: any) => m.rewound);
    assert.ok(rewound.length >= 2, "the message and its reply are rewound");
    assert.ok(rewound.every((m: any) => m.deleted), "rewound messages are out of every transcript");
    assert.ok(after.messages.some((m: any) => m.text === "Reply one." && !m.deleted), "what came before stays");
    const note = after.messages.find((m: any) => m.kind === "notice" && /Rewound to before your message/.test(m.text));
    assert.ok(note);
    assert.match(note.text, /2 files are back as they were/);

    // the next turn starts from what is left, and has never heard the rest
    await say("Try it differently", "Noted.");
    const told = heard[heard.length - 1].join("\n");
    assert.match(told, /first part/);
    assert.doesNotMatch(told, /second part|Reply two/);

    // and it is on the record
    const ledger = await h.json("/api/ledger");
    assert.ok((ledger.entries ?? []).some((e: any) => e.kind === "conversation.rewound"));

    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });

  test("a file you changed since is left alone, and named", async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "bloks-rewind-mine-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, "notes.md"), "mine\n");
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "m-1" }] }));
        }
        writeFileSync(join(folder, "notes.md"), "agent\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Edited." } }] }));
      });
    });
    await new Promise<void>((r) => engine.listen(0, "127.0.0.1", () => r()));
    t.after(() => engine.close());
    await h.fetch("/api/providers/kimi/connect", {
      method: "POST",
      body: JSON.stringify({ key: "sk-test-0000000000", url: `http://127.0.0.1:${(engine.address() as any).port}` }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Careful" }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "kimi", model: "m-1" }, cwd: folder }),
    });
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Edit my notes" }) });
    const me = async () => (await h.json("/api/bots")).bots.find((b: any) => b.id === bot.id);
    const done = await waitFor(async () => {
      const current = await me();
      return !current.busy && current.messages.some((m: any) => m.kind === "changes") ? current : null;
    });
    assert.ok(done);
    // the person edits the file after the agent did
    writeFileSync(join(folder, "notes.md"), "mine again\n");
    const asked = done.messages.find((m: any) => m.role === "user");
    const out = await h.json(`/api/threads/${done.threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId: asked.id }) });
    assert.deepEqual(out.restored, []);
    assert.deepEqual(out.skipped, [{ path: "notes.md", why: "changed since" }]);
    assert.equal(readFileSync(join(folder, "notes.md"), "utf8"), "mine again\n", "your edit survives");
    await h.fetch(`/api/bots/${bot.id}?forget=1`, { method: "DELETE" });
  });
});
