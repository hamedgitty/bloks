// Real HTTP and a stand-in OpenAI-compatible engine. A saved summary that
// read a message the person then deletes or edits is dropped before the
// message changes, so the old words are not told again and its count
// cannot start a message late and skip the one after it. A message it
// never read leaves it as it was. A summary written meanwhile, one
// message at a time, is not saved over a message that changed under it,
// and a change that cannot be saved says so, leaving the summary dropped
// only when that much was saved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { startHarness, type Harness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";

type Kind = "turn" | "fold" | "absorb" | "defrag";
interface Row { role: "user" | "bot"; text: string; kind?: "text" | "notice"; deleted?: boolean; unsent?: boolean }
interface Context { summary: string; through: number; at: number; microFrom?: number }
interface Setup { rows?: Row[]; context?: Context | null; micro?: boolean; hold?: Kind[] }

const SUMMARISED = "[Earlier in this conversation, summarised]";
const has = (text: string, word: string) => new RegExp(`${word}(?![\\w-])`).test(text);
/** Told the summary, under the line that says what it is. */
const toldWith = (text: string, summary: string) => text.includes(SUMMARISED) && text.includes(summary);
const kindOf = (told: string): Kind =>
  /Summarise this part of a conversation|Produce one summary covering both/.test(told)
    ? "fold"
    : told.includes("This is a running summary of a conversation, written in pieces over time")
      ? "defrag"
      : /Here is a running summary of a conversation, and one more thing|Summarise this so it can be carried forward/.test(told)
        ? "absorb"
        : "turn";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Four settled messages the summary read, with rows it never counts
 * between them, then four it did not read. */
function lane(): Row[] {
  return [
    { role: "user", text: "FACT-1 where it started." },
    { role: "bot", kind: "notice", text: "NOTICE-1 between them." },
    { role: "bot", text: "FACT-2 the agent's first answer." },
    { role: "user", text: "", deleted: true },
    { role: "user", text: "FACT-3 OLD-3 a plan in its first words." },
    { role: "user", text: "UNSENT-1 never sent.", unsent: true },
    { role: "bot", text: "FACT-4 the last answer the summary read." },
    { role: "user", text: "FACT-5 the first message after the summary." },
    { role: "bot", text: "FACT-6 an answer to it." },
    { role: "user", text: "FACT-7 one more." },
    { role: "bot", text: "FACT-8 the end so far." },
  ];
}
const covering: Context = { summary: "Notes: FACT-1 FACT-2 FACT-3 OLD-3 FACT-4 SUMMARY-ONLY", through: 4, at: 1234 };

/** Ten messages, alternating, the first of them the agent's or the
 * person's, the first with words of its own to look for. */
function alternating(first: "user" | "bot"): Row[] {
  return Array.from({ length: 10 }, (_, i): Row => {
    const role = (i % 2 === 0) === (first === "user") ? "user" : "bot";
    return { role, text: i === 0 ? "FACT-0 OLD-0 the first message." : `FACT-${i} ${role === "user" ? "said" : "answered"} next.` };
  });
}

async function fixture(t: TestContext, setup: Setup = {}) {
  const rows = setup.rows ?? lane();
  const context = setup.context === undefined ? covering : setup.context;
  const home = mkdtempSync(join(tmpdir(), "bloks-summary-changes-"));
  const data = join(home, ".bloks");
  mkdirSync(data);
  const id = randomUUID(), threadId = randomUUID();
  const bot = {
    id, threadId, activeTaskId: threadId, name: "Changes fixture", title: "", description: "",
    color: "blue", shape: "circle", createdAt: 1, unread: false, notifications: false, resumeCursors: {},
    modelSelection: { instanceId: "grok", model: "grok-4" },
    tasks: [{ id: threadId, title: "General", createdAt: 1, lastInstanceId: "grok", resumeCursors: {}, ...(context ? { context } : {}) }],
  };
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot]));
  const ids = rows.map(() => randomUUID());
  writeFileSync(join(data, `messages-${threadId}.json`), JSON.stringify(rows.map((m, i) => ({ id: ids[i], at: i + 1, kind: "text", ...m }))));
  writeFileSync(join(data, "config.json"), JSON.stringify({ compaction: { micro: Boolean(setup.micro), beforeTurn: 0 } }));

  // Every request kept in order; one of a held kind is answered when let
  // go. A summary keeps every marked word it was given.
  const requests: Array<{ kind: Kind; told: string }> = [];
  const held: Array<() => Promise<void>> = [];
  let answers = 0;
  const engine = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (payload: object) =>
        new Promise<void>((resolve) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(payload), () => resolve());
        });
      if (req.url?.endsWith("/models")) return void send({ data: [{ id: "grok-4" }] });
      const told = ((JSON.parse(body || "{}").messages ?? []) as any[])
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
        .join("\n");
      const kind = kindOf(told);
      requests.push({ kind, told });
      const content = kind === "turn" ? `ok ANSWER-${++answers}` : `Notes: ${[...new Set(told.match(/\b[A-Z]+-[A-Z0-9]+\b/g) ?? [])].join(" ")}`;
      const answer = () => send({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
      if (setup.hold?.includes(kind)) held.push(answer);
      else void answer();
    });
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(engine.address() as { port: number }).port}`;

  let h: Harness = await startHarness({ HOME: home, USERPROFILE: home });
  const frames: any[] = [];
  const controller = new AbortController();
  let pump: Promise<void> | undefined;
  t.after(async () => {
    while (held.length) await held.shift()!();
    controller.abort();
    await pump;
    await h.stop();
    engine.closeAllConnections();
    engine.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });
  assert.ok((await h.fetch("/api/providers/grok/connect", { method: "POST", body: JSON.stringify({ key: "xai-test-000000000000", url }) })).ok, h.logs());
  assert.ok((await h.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }) })).ok, h.logs());

  // what the app is told, in order
  const stream = await h.fetch("/api/events", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  pump = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();

  const messages = async () => (await h.json(`/api/bots/${id}/messages?limit=200&thread=${threadId}`)).messages as any[];
  const f = {
    get h() {
      return h;
    },
    id, threadId, ids, data, requests, frames, messages,
    stored: () =>
      (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[]).find((b) => b.id === id)?.tasks.find((l: any) => l.id === threadId)?.context as Context | undefined,
    onDisk: (n: number) => (JSON.parse(readFileSync(join(data, `messages-${threadId}.json`), "utf8")) as any[]).find((m) => m.id === ids[n]),
    summary: async () => (await h.json(`/api/bots/${id}/tasks/${threadId}/summary`)).summary as { text: string; covers: number; at: string } | null,
    row: async (n: number) => (await messages()).find((m) => m.id === ids[n]),
    remove: (n: number) => h.fetch(`/api/threads/${threadId}/messages/${ids[n]}`, { method: "DELETE" }),
    edit: (n: number, text: string) => h.fetch(`/api/threads/${threadId}/messages/${ids[n]}`, { method: "PATCH", body: JSON.stringify({ text }) }),
    pid: async () => (await h.json("/api/health")).pid as number,
    /** The first turn told this word, once it has been asked. */
    told: (word: string) => waitFor(() => requests.find((r) => r.kind === "turn" && has(r.told, word))?.told),
    /** Says this and waits for the answer and a free lane; what the turn
     * was told. Its first word is its own. */
    say: async (text: string) => {
      assert.equal((await h.fetch(`/api/bots/${id}/messages`, { method: "POST", body: JSON.stringify({ text, taskId: threadId }) })).status, 202);
      const told = await f.told(text.split(" ")[0]);
      assert.ok(told, `the turn was not asked: ${h.logs()}`);
      assert.ok(
        await waitFor(async () => {
          const all = await messages();
          const at = all.findIndex((m) => m.text === text);
          return at >= 0 && all.slice(at + 1).some((m) => m.role === "bot" && m.kind === "text");
        }),
        `the turn did not answer: ${h.logs()}`,
      );
      assert.ok(await idle(h, { id }), h.logs());
      return told!;
    },
    /** Answers what is held, and waits until each answer has gone out. */
    release: async () => {
      while (held.length) await held.shift()!();
    },
    held: () => held.length,
    /** A bot update said after everything said before it. */
    barrier: async (title: string) => {
      assert.ok((await h.fetch(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ title }) })).ok);
      assert.ok(await waitFor(() => frames.some((fr) => fr.kind === "bot" && fr.bot?.id === id && fr.bot.title === title)));
      return frames.findIndex((fr) => fr.kind === "bot" && fr.bot?.id === id && fr.bot.title === title);
    },
    /** What the app was told about this agent and this lane's messages. */
    said: (from: number, to = frames.length) => ({
      bots: frames.slice(from, to).filter((fr) => fr.kind === "bot" && fr.bot?.id === id),
      patches: frames.slice(from, to).filter((fr) => fr.kind === "message.patch" && fr.threadId === threadId),
    }),
    summarised: (frame: any) => frame.bot.tasks.find((l: any) => l.id === threadId)?.context?.summarised,
    restart: async () => {
      controller.abort();
      await pump;
      await h.stop();
      h = await startHarness({ HOME: home, USERPROFILE: home });
    },
  };
  // the seeded summary is the lane's
  assert.deepEqual(await f.summary(), context ? { text: context.summary, covers: context.through, at: new Date(context.at).toISOString() } : null);
  return f;
}

describe("a saved summary and the messages it read", { concurrency: 4 }, () => {
  test("a message it read, deleted: it goes, and the next request is told the rest whole, the message after it too", async (t) => {
    const f = await fixture(t);
    // before: the summary, then what it did not read
    const before = await f.say("FACT-BEFORE what is told now.");
    assert.ok(toldWith(before, covering.summary), before);
    assert.ok(has(before, "FACT-5"));
    assert.equal(before.includes("where it started"), false);

    const asked = f.requests.length, from = f.frames.length;
    assert.equal((await f.remove(0)).status, 200);
    assert.equal(await f.summary(), null);
    assert.equal(f.stored(), undefined);
    assert.deepEqual([f.onDisk(0).deleted, f.onDisk(0).text], [true, ""]);
    // the app hears both: no summary now, and the message gone
    assert.ok(await waitFor(() => f.said(from).patches.some((fr) => fr.message.id === f.ids[0] && fr.message.deleted)), f.h.logs());
    assert.ok(f.said(from).bots.some((fr) => f.summarised(fr) === false));
    // and nothing is asked of the engine for it
    await pause(300);
    assert.equal(f.requests.length, asked);

    const next = await f.say("FACT-NEXT after the deletion.");
    assert.equal(next.includes(SUMMARISED), false);
    assert.equal(has(next, "SUMMARY-ONLY"), false);
    assert.equal(has(next, "FACT-1"), false, "the deleted words were told");
    for (const word of ["FACT-2", "FACT-3", "FACT-4", "FACT-5", "FACT-6", "FACT-7", "FACT-8", "FACT-BEFORE"]) assert.ok(has(next, word), `${word} was not told`);
    assert.equal(has(next, "UNSENT-1"), false);
  });

  test("a message it read, edited: it goes, and the next request is told the new words, not the old", async (t) => {
    const f = await fixture(t);
    const from = f.frames.length;
    const edited = await f.edit(4, "FACT-3 NEW-3 the plan in other words.");
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).message.text, "FACT-3 NEW-3 the plan in other words.");
    assert.equal(await f.summary(), null);
    assert.equal(f.stored(), undefined);
    assert.equal(f.onDisk(4).text, "FACT-3 NEW-3 the plan in other words.");
    assert.ok(await waitFor(() => f.said(from).patches.some((fr) => fr.message.id === f.ids[4] && fr.message.text.includes("NEW-3"))), f.h.logs());
    assert.ok(f.said(from).bots.some((fr) => f.summarised(fr) === false));

    const next = await f.say("FACT-NEXT after the edit.");
    assert.equal(next.includes(SUMMARISED), false);
    assert.equal(has(next, "OLD-3"), false, "the old words were told");
    for (const word of ["FACT-1", "FACT-2", "NEW-3", "FACT-4", "FACT-5", "FACT-8"]) assert.ok(has(next, word), `${word} was not told`);
  });

  test("messages it did not read, deleted or edited, leave it as it was", async (t) => {
    const f = await fixture(t);
    const saved = await f.summary();
    assert.equal((await f.remove(9)).status, 200);
    assert.equal((await f.edit(7, "FACT-5 NEW-5 said again.")).status, 200);
    assert.deepEqual(await f.summary(), saved);
    assert.deepEqual(f.stored(), covering);

    const next = await f.say("FACT-NEXT after them.");
    assert.ok(toldWith(next, covering.summary));
    for (const word of ["NEW-5", "FACT-6", "FACT-8"]) assert.ok(has(next, word), `${word} was not told`);
    assert.equal(has(next, "FACT-7"), false);
    assert.equal(next.includes("the first message after the summary"), false);
    // what it read is still not told whole
    assert.equal(next.includes("the last answer the summary read"), false);
  });

  test("rows it does not count, deleted or edited, leave it as it was", async (t) => {
    const f = await fixture(t);
    const saved = await f.summary();
    // a notice, one taken back before, one never sent
    for (const n of [1, 3, 5]) assert.equal((await f.remove(n)).status, 200);
    assert.deepEqual(await f.summary(), saved);
    assert.deepEqual(f.stored(), covering);

    const next = await f.say("FACT-NEXT after them.");
    assert.ok(toldWith(next, covering.summary));
    assert.ok(has(next, "FACT-5"), "the message after the summary was not told");
    assert.equal(next.includes("the last answer the summary read"), false);
  });

  test("an edit to the same words, and changes refused, leave it as it was", async (t) => {
    const f = await fixture(t);
    const saved = await f.summary();
    assert.equal((await f.edit(0, "FACT-1 where it started.")).status, 200);
    assert.equal((await f.edit(0, "  FACT-1 where it started.  ")).status, 200);
    // never sent, so never read
    assert.equal((await f.edit(5, "UNSENT-1 still never sent.")).status, 200);
    // the agent's words, no words, and one taken back
    assert.equal((await f.edit(2, "FACT-2 rewritten.")).status, 403);
    assert.equal((await f.edit(0, "   ")).status, 400);
    assert.equal((await f.edit(3, "FACT-9 words again.")).status, 409);
    assert.equal((await f.h.fetch(`/api/threads/${f.threadId}/messages/${randomUUID()}`, { method: "DELETE" })).status, 404);
    assert.deepEqual(await f.summary(), saved);
    assert.deepEqual(f.stored(), covering);
    assert.equal((await f.row(2)).text, "FACT-2 the agent's first answer.");
  });

  test("the person's message it counted after summarising one message at a time took over, deleted: it goes", async (t) => {
    // From microFrom on, the person's words are told whole after the
    // summary, but they are still counted: the agent's answer after the
    // deleted one would start inside the count and never be told.
    const f = await fixture(t, { context: { summary: "Notes: FACT-1 FACT-2 SUMMARY-ONLY", through: 3, at: 1234, microFrom: 2 } });
    const before = await f.say("FACT-BEFORE what is told now.");
    assert.ok(has(before, "OLD-3") && has(before, "FACT-4"), before);

    assert.equal((await f.remove(4)).status, 200);
    assert.equal(await f.summary(), null);
    assert.equal(f.stored(), undefined);
    const next = await f.say("FACT-NEXT after the deletion.");
    assert.equal(next.includes(SUMMARISED), false);
    assert.equal(has(next, "OLD-3"), false);
    for (const word of ["FACT-1", "FACT-2", "FACT-4", "FACT-5"]) assert.ok(has(next, word), `${word} was not told`);
  });
});

describe("a summary written one message at a time while a message changes", { concurrency: 4 }, () => {
  // The step after a turn reads the next message past the summary's count.
  // An answer is the engine's to work into the summary, and it is held
  // here while the test changes the lane.
  test("with no summary before it, the first step, nothing changed: it is saved", async (t) => {
    const f = await fixture(t, { rows: alternating("bot"), context: null, micro: true, hold: ["absorb"] });
    await f.say("FACT-T1 a turn.");
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    await f.release();
    await pause(1_000);
    assert.equal(f.stored()?.through, 1);
    assert.ok(has(f.stored()!.summary, "OLD-0"));
    const next = await f.say("FACT-T2 another turn.");
    assert.ok(next.includes(SUMMARISED) && has(next, "OLD-0"), next);
  });

  test("with no summary before it, the message it reads deleted meanwhile: nothing is saved", async (t) => {
    const f = await fixture(t, { rows: alternating("bot"), context: null, micro: true, hold: ["absorb"] });
    await f.say("FACT-T1 a turn.");
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    assert.ok(has(f.requests.find((r) => r.kind === "absorb")!.told, "OLD-0"));
    assert.equal((await f.remove(0)).status, 200);
    await f.release();
    await pause(1_000);
    assert.equal(f.stored(), undefined);
    assert.equal(await f.summary(), null);
    const next = await f.say("FACT-T2 another turn.");
    assert.equal(next.includes(SUMMARISED), false);
    assert.equal(has(next, "OLD-0"), false, "the deleted words were told");
    assert.ok(has(next, "FACT-1"));
  });

  test("after a summary, the next step, nothing changed: it is saved", async (t) => {
    const context: Context = { summary: "Notes: FACT-0 OLD-0 SUMMARY-ONLY", through: 1, at: 1234 };
    const f = await fixture(t, { rows: alternating("user"), context, micro: true, hold: ["absorb"] });
    await f.say("FACT-T1 a turn.");
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    await f.release();
    await pause(1_000);
    assert.equal(f.stored()?.through, 2);
    assert.equal(f.stored()?.microFrom, 1);
    assert.ok(has(f.stored()!.summary, "FACT-1"));
  });

  test("after a summary, the message the step reads deleted meanwhile: nothing is saved, and the summary stays as it was", async (t) => {
    const context: Context = { summary: "Notes: FACT-0 OLD-0 SUMMARY-ONLY", through: 1, at: 1234 };
    const f = await fixture(t, { rows: alternating("user"), context, micro: true, hold: ["absorb"] });
    await f.say("FACT-T1 a turn.");
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    assert.ok(has(f.requests.find((r) => r.kind === "absorb")!.told, "FACT-1"));
    // past the count, so the summary itself stays
    assert.equal((await f.remove(1)).status, 200);
    assert.deepEqual(f.stored(), context);
    await f.release();
    await pause(1_000);
    assert.deepEqual(f.stored(), context);
    const next = await f.say("FACT-T2 another turn.");
    assert.ok(toldWith(next, context.summary), next);
    assert.equal(has(next, "FACT-1"), false, "the deleted words were told");
    assert.ok(has(next, "FACT-2"));
  });

  test("after a summary, a message it read edited while a step is out: it goes and is not brought back", async (t) => {
    const context: Context = { summary: "Notes: FACT-0 OLD-0 SUMMARY-ONLY", through: 1, at: 1234 };
    const f = await fixture(t, { rows: alternating("user"), context, micro: true, hold: ["absorb"] });
    await f.say("FACT-T1 a turn.");
    assert.ok(await waitFor(() => f.held() > 0), f.h.logs());
    assert.equal((await f.edit(0, "FACT-0 NEW-0 in other words.")).status, 200);
    assert.equal(f.stored(), undefined);
    await f.release();
    await pause(1_000);
    assert.equal(f.stored(), undefined);
    assert.equal(await f.summary(), null);
    const next = await f.say("FACT-T2 another turn.");
    assert.equal(next.includes(SUMMARISED), false);
    assert.equal(has(next, "OLD-0"), false, "the old words were told");
    assert.ok(has(next, "NEW-0") && has(next, "FACT-1"));
  });
});

describe("a change that cannot be saved", { concurrency: 4 }, () => {
  test("when the summary cannot be dropped, the message and the summary stay as they were, and so after a restart", async (t) => {
    const f = await fixture(t);
    const saved = await f.summary();
    // the agents' file cannot be written: its next version has nowhere to go
    const blocked = join(f.data, `bots.json.${await f.pid()}.tmp`);
    mkdirSync(blocked);
    const from = f.frames.length;
    assert.equal((await f.remove(0)).status, 500);
    assert.equal((await f.edit(4, "FACT-3 NEW-3 the plan in other words.")).status, 500);
    assert.deepEqual(await f.summary(), saved);
    assert.deepEqual(f.stored(), covering);
    assert.equal((await f.row(0)).text, "FACT-1 where it started.");
    assert.equal((await f.row(0)).deleted, undefined);
    assert.equal((await f.row(4)).text, "FACT-3 OLD-3 a plan in its first words.");
    assert.equal(f.onDisk(0).text, "FACT-1 where it started.");
    assert.equal(f.onDisk(4).text, "FACT-3 OLD-3 a plan in its first words.");
    rmSync(blocked, { recursive: true });
    // nothing was said to the app about either
    const to = await f.barrier("Fixture after the refused changes");
    assert.deepEqual(f.said(from, to), { bots: [], patches: [] });

    await f.restart();
    assert.deepEqual(await f.summary(), saved);
    assert.equal((await f.row(0)).text, "FACT-1 where it started.");
    assert.equal((await f.row(4)).text, "FACT-3 OLD-3 a plan in its first words.");
    // and the same deletion goes through once it can be saved
    assert.equal((await f.remove(0)).status, 200);
    assert.equal(await f.summary(), null);
  });

  for (const change of ["deleted", "edited"] as const) {
    test(`when the summary is dropped but the message, ${change}, cannot be saved: the summary stays dropped, the message as it was, the app is told so, and so after a restart`, async (t) => {
      const f = await fixture(t);
      // the lane's file cannot be written, the agents' file can
      const blocked = join(f.data, `messages-${f.threadId}.json.${await f.pid()}.tmp`);
      mkdirSync(blocked);
      const from = f.frames.length;
      const n = change === "deleted" ? 0 : 4;
      const was = change === "deleted" ? "FACT-1 where it started." : "FACT-3 OLD-3 a plan in its first words.";
      const res = change === "deleted" ? await f.remove(n) : await f.edit(n, "FACT-3 NEW-3 the plan in other words.");
      assert.equal(res.status, 500);
      assert.equal(await f.summary(), null);
      assert.equal(f.stored(), undefined);
      assert.equal((await f.row(n)).text, was);
      assert.equal((await f.row(n)).deleted, undefined);
      assert.equal(f.onDisk(n).text, was);
      rmSync(blocked, { recursive: true });
      // told that the summary is gone, and nothing about the message
      const to = await f.barrier("Fixture after the failed change");
      const said = f.said(from, to);
      assert.equal(said.bots.length, 1);
      assert.equal(f.summarised(said.bots[0]), false);
      assert.deepEqual(said.patches, []);

      // the next turn is told the lane whole, the message as it is
      const next = await f.say("FACT-NEXT after the failed change.");
      assert.equal(next.includes(SUMMARISED), false);
      assert.ok(next.includes(was));
      assert.ok(has(next, "FACT-5"));

      await f.restart();
      assert.equal(await f.summary(), null);
      assert.equal((await f.row(n)).text, was);
    });
  }
});
