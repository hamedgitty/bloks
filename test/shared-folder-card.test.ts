// Change cards and the way back in a folder shared by concurrent turns.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { lastSaid, previewLine } from "../src/lib/preview.ts";
import { startHarness } from "./helpers/server.ts";

async function waitFor<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("the fixture did not finish within its bound");
}

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "bloks-shared-card-"));
  const desk = join(home, "desk");
  mkdirSync(desk);
  writeFileSync(join(desk, "notes.md"), "notes\n");
  writeFileSync(join(desk, "log.md"), "log\n");
  const began = join(home, "a-began"), flag = join(home, "b-wrote");
  const next = join(home, "next-began"), ids = join(home, "agents.json");
  const index = join(home, ".bloks", "checkpoints", "index.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const input = line.slice(0, at); line = line.slice(at + 1); if (!input.trim() || JSON.parse(input).type !== "user") continue; process.stdin.off("data", take); go(input); return; } }; process.stdin.on("data", take); })(async (input) => {
  const text = JSON.parse(input).message.content;
  const sessionId = value("--resume") ?? value("--session-id");
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" });
  if (text.includes("NEXT")) {
    writeFileSync(${JSON.stringify(next)}, readFileSync(${JSON.stringify(index)}, "utf8"));
  } else {
    const ada = text.includes("ADA"), command = text.includes("COMMAND"), edit = !text.includes("NONE");
    const file = join(${JSON.stringify(desk)}, ada ? "notes.md" : "log.md");
    if (edit) {
      out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: command ? "Bash" : ada ? "Edit" : "Write", input: command ? { command: "write notes.md" } : { file_path: file } }] } });
      writeFileSync(file, ada ? "notes, by Ada\\n" : "log, by Linus\\n");
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } });
    }
    if (ada) {
      if (text.includes("QUEUE")) {
        const owner = JSON.parse(readFileSync(${JSON.stringify(ids)}, "utf8"));
        const response = await fetch(process.env.BLOKS_URL + "/api/bots/" + owner.id + "/messages", {
          method: "POST", headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN, "content-type": "application/json" },
          body: JSON.stringify({ text: "NEXT follow-up", taskId: owner.threadId }),
        });
        writeFileSync(${JSON.stringify(join(home, "queued.json"))}, JSON.stringify({ status: response.status, body: await response.json() }));
      }
      writeFileSync(${JSON.stringify(began)}, "1");
      if (!text.includes("SOLO")) {
        for (let i = 0; i < 400 && !existsSync(${JSON.stringify(flag)}); i++) await new Promise((r) => setTimeout(r, 50));
        if (!existsSync(${JSON.stringify(flag)})) throw new Error("the second writer never arrived");
      }
    } else writeFileSync(${JSON.stringify(flag)}, "1");
  }
  const answer = text.includes("NEXT") ? "Follow-up done." : "Done.";
  out({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: sessionId, result: answer });
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"));
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  let h = await startHarness({ HOME: home });
  t.after(async () => { await h.stop(); rmSync(home, { recursive: true, force: true }); });
  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const response = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, cwd: desk }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return bot;
  };
  const ada = await hire("Ada"), linus = await hire("Linus");
  writeFileSync(ids, JSON.stringify(ada));
  const readRecords = (): any[] => {
    if (!existsSync(index)) return [];
    try { return JSON.parse(readFileSync(index, "utf8")); }
    catch (e) { if (e instanceof SyntaxError) return []; throw e; }
  };
  const bot = async (id: string) => (await h.json("/api/bots")).bots.find((b: any) => b.id === id);
  const run = async (words: string, solo = false) => {
    await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: words }) });
    await waitFor(() => existsSync(began));
    if (!solo) await h.fetch(`/api/bots/${linus.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LINUS write the log" }) });
    await waitFor(async () => !(await bot(ada.id)).busy && (solo || !(await bot(linus.id)).busy) && readRecords().some((r) => r.threadId === ada.threadId));
    return { ada: await bot(ada.id), linus: await bot(linus.id), record: readRecords().find((r) => r.threadId === ada.threadId) };
  };
  const legacy = async (record: any) => {
    await h.stop();
    const records = readRecords(), stored = records.find((r) => r.id === record.id);
    const file = join(home, ".bloks", `messages-${ada.threadId}.json`);
    const messages = JSON.parse(readFileSync(file, "utf8"));
    let card = messages.find((m: any) => m.changes?.checkpointId === record.id);
    if (!card) { card = { id: randomUUID(), role: "bot", kind: "changes", at: record.at + 1 }; messages.push(card); }
    card.changes = {
      checkpointId: record.id,
      files: record.files.map(({ path, status, big, added, removed, shared }: any) => ({ path, status, ...(big ? { big } : {}), ...(added !== undefined ? { added } : {}), ...(removed !== undefined ? { removed } : {}), ...(shared ? { shared } : {}) })),
      total: record.files.length,
      shared: { total: record.files.filter((f: any) => f.shared).length, alongside: record.alongside },
    };
    stored.card = { threadId: ada.threadId, messageId: card.id };
    writeFileSync(index, JSON.stringify(records));
    writeFileSync(file, JSON.stringify(messages));
    const changes = JSON.stringify(card.changes);
    h = await startHarness({ HOME: home });
    return { id: card.id, changes };
  };
  return { home, desk, next, index, ada, linus, run, bot, legacy, get h() { return h; }, readRecords };
}

test("overlapping turns show only their own files and Undo is silent about shared files", async (t) => {
  const f = await fixture(t), done = await f.run("ADA tidy the notes");
  const a = done.ada.messages.find((m: any) => m.kind === "changes"), b = done.linus.messages.find((m: any) => m.kind === "changes");
  await t.test("mixed summary has only own files and count", () => {
    assert.deepEqual(a.changes.files.map((p: any) => p.path), ["notes.md"]);
    assert.equal(a.changes.total, 1);
    assert.equal(Object.hasOwn(a.changes, "shared"), false);
    assert.equal(JSON.stringify(a.changes).includes("log.md"), false);
  });
  await t.test("the other editing turn still claims its own file", () => {
    assert.deepEqual(b.changes.files.map((p: any) => p.path), ["log.md"]);
    assert.equal(b.changes.total, 1);
    assert.equal(Object.hasOwn(b.changes, "shared"), false);
  });
  const undo = await f.h.json(`/api/checkpoints/${a.changes.checkpointId}/revert`, { method: "POST" });
  await t.test("Undo restores own files without reporting shared ones", async () => {
    assert.deepEqual(undo, { restored: ["notes.md"], skipped: [] });
    assert.equal(readFileSync(join(f.desk, "notes.md"), "utf8"), "notes\n");
    assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
    assert.equal((await f.bot(f.ada.id)).messages.find((m: any) => m.id === a.id).changes.reverted.skipped, 0);
  });
  const other = await f.h.json(`/api/checkpoints/${b.changes.checkpointId}/revert`, { method: "POST" });
  assert.deepEqual(other, { restored: ["log.md"], skipped: [] });
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log\n");
});

test("a mixed card still reports its own file changed since", async (t) => {
  const f = await fixture(t), done = await f.run("ADA tidy the notes");
  const card = done.ada.messages.find((m: any) => m.kind === "changes");
  writeFileSync(join(f.desk, "notes.md"), "the person changed it\n");
  const result = await f.h.json(`/api/checkpoints/${card.changes.checkpointId}/revert`, { method: "POST" });
  assert.deepEqual(result, { restored: [], skipped: [{ path: "notes.md", why: "changed since" }] });
  assert.equal((await f.bot(f.ada.id)).messages.find((m: any) => m.id === card.id).changes.reverted.skipped, 1);
  assert.equal(readFileSync(join(f.desk, "notes.md"), "utf8"), "the person changed it\n");
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
});

test("Undo of a mixed legacy card keeps the own changed-since line", async (t) => {
  const f = await fixture(t), done = await f.run("ADA tidy the notes");
  const old = await f.legacy(done.record);
  writeFileSync(join(f.desk, "notes.md"), "the person changed it\n");
  const result = await f.h.json(`/api/checkpoints/${done.record.id}/revert`, { method: "POST" });
  assert.deepEqual(result, { restored: [], skipped: [{ path: "notes.md", why: "changed since" }] });
  const card = (await f.bot(f.ada.id)).messages.find((m: any) => m.id === old.id);
  // ChangesCard's persistent "left N that changed since" line, after its
  // click-time skipped list is gone, subtracts the old shared total.
  assert.equal(card.changes.reverted.skipped - (card.changes.shared?.total ?? 0), 1);
  assert.deepEqual(card.changes.files.map((p: any) => p.path), ["notes.md"]);
  assert.equal(card.changes.total, 1);
  assert.equal(Object.hasOwn(card.changes, "shared"), false);
  assert.equal(JSON.stringify(card.changes).includes("log.md"), false);
  assert.equal(readFileSync(join(f.desk, "notes.md"), "utf8"), "the person changed it\n");
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
});

test("Undo keeps an old all-shared summary while recording its result", async (t) => {
  const f = await fixture(t), done = await f.run("ADA NONE");
  const old = await f.legacy(done.record);
  const result = await f.h.json(`/api/checkpoints/${done.record.id}/revert`, { method: "POST" });
  assert.deepEqual(result, { restored: [], skipped: [] });
  const card = (await f.bot(f.ada.id)).messages.find((m: any) => m.id === old.id);
  const { reverted, ...summary } = card.changes;
  assert.equal(JSON.stringify(summary), old.changes);
  assert.deepEqual({ restored: reverted.restored, skipped: reverted.skipped }, { restored: 0, skipped: 0 });
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
});

test("an overlapping turn that edited nothing of its own keeps its checkpoint without a card", async (t) => {
  const f = await fixture(t), done = await f.run("ADA NONE");
  assert.ok(done.record.files.length > 0);
  assert.ok(done.record.files.every((p: any) => p.shared));
  assert.equal(done.record.card, undefined);
  assert.equal(done.ada.messages.some((m: any) => m.kind === "changes"), false);
  assert.equal(done.ada.messages.at(-1).kind, "text");
  assert.equal(done.ada.messages.at(-1).text, "Done.");
  assert.equal(previewLine(lastSaid(done.ada.messages)), "Done.");
  assert.deepEqual(done.linus.messages.find((m: any) => m.kind === "changes").changes.files.map((p: any) => p.path), ["log.md"]);
});

test("an overlapping turn that ran a command still counts what changed, without Undo", async (t) => {
  // a command names none of the files it writes, so this card is the only
  // sign the folder moved while the turn worked
  const f = await fixture(t), done = await f.run("ADA COMMAND");
  assert.ok(done.record.files.every((p: any) => p.shared));
  const card = done.ada.messages.find((m: any) => m.kind === "changes");
  assert.ok(card, "a turn that ran a command left no sign the folder changed");
  assert.equal(card.changes.total, done.record.files.length);
  assert.equal(card.changes.shared.total, done.record.files.length);
  assert.ok(card.changes.files.every((p: any) => p.shared), "a shared file was offered as this turn's own");
  assert.deepEqual(done.linus.messages.find((m: any) => m.kind === "changes").changes.files.map((p: any) => p.path), ["log.md"]);
});

test("a cardless checkpoint finishes before the next queued turn starts", async (t) => {
  const f = await fixture(t);
  await f.run("ADA NONE QUEUE");
  const queued = JSON.parse(readFileSync(join(f.home, "queued.json"), "utf8"));
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queued, true);
  await waitFor(async () => existsSync(f.next) && !(await f.bot(f.ada.id)).busy);
  const first = JSON.parse(readFileSync(f.next, "utf8")).find((r: any) => r.threadId === f.ada.threadId);
  assert.ok(first, "next turn overtook the first checkpoint finishing");
  assert.equal(first.card, undefined);
  const current = await f.bot(f.ada.id);
  assert.equal(current.messages.some((m: any) => m.kind === "changes"), false);
  assert.equal(current.messages.filter((m: any) => m.kind === "text" && m.role === "bot").at(-1).text, "Follow-up done.");
});

test("solo command writes retain their ordinary card", async (t) => {
  const f = await fixture(t), done = await f.run("ADA COMMAND SOLO", true);
  const card = done.ada.messages.find((m: any) => m.kind === "changes");
  assert.deepEqual(card.changes.files.map((p: any) => p.path), ["notes.md"]);
  assert.equal(card.changes.total, 1);
  assert.equal(Object.hasOwn(card.changes, "shared"), false);
});

test("rewind keeps other files silent and refreshes mixed legacy summaries", async (t) => {
  const f = await fixture(t), done = await f.run("ADA tidy the notes");
  const old = await f.legacy(done.record), asked = done.ada.messages.find((m: any) => m.role === "user");
  const result = await f.h.json(`/api/threads/${f.ada.threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId: asked.id }) });
  assert.deepEqual(result.restored, ["notes.md"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
  const current = await f.bot(f.ada.id);
  const notice = current.messages.find((m: any) => m.kind === "notice" && m.text.startsWith("Rewound to before"));
  assert.equal(notice.text.includes("log.md"), false);
  const card = current.messages.find((m: any) => m.id === old.id);
  assert.equal(card.deleted, true);
  assert.ok(card.rewound);
  assert.equal(card.changes.checkpointId, done.record.id);
  assert.deepEqual(card.changes.files.map((p: any) => p.path), ["notes.md"]);
  assert.equal(card.changes.total, 1);
  assert.equal(Object.hasOwn(card.changes, "shared"), false);
});

test("rewind leaves an old all-shared card summary byte for byte", async (t) => {
  const f = await fixture(t), done = await f.run("ADA NONE");
  const old = await f.legacy(done.record), asked = done.ada.messages.find((m: any) => m.role === "user");
  const result = await f.h.json(`/api/threads/${f.ada.threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId: asked.id }) });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.skipped, []);
  const card = (await f.bot(f.ada.id)).messages.find((m: any) => m.id === old.id);
  assert.equal(JSON.stringify(card.changes), old.changes);
  assert.equal(card.deleted, true);
  assert.ok(card.rewound);
  assert.equal(readFileSync(join(f.desk, "log.md"), "utf8"), "log, by Linus\n");
});
