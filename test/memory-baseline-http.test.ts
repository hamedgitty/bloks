// The Memory panel's actual request paths, with a failed baseline read.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

const controlHome = mkdtempSync(join(tmpdir(), "bloks-memory-http-"));
const faults = join(controlHome, "faults.json");
const renames = join(controlHome, "renames.jsonl");
writeFileSync(faults, "{}");
writeFileSync(renames, "");
let h: Harness;
before(async () => {
  h = await startHarness({
    // the URL rather than the path: NODE_OPTIONS splits on spaces, and a
    // checkout can sit in a folder with one
    NODE_OPTIONS: `--import=${new URL("./helpers/memory-read-fault.mjs", import.meta.url).href}`,
    TEST_MEMORY_READ_FAULT: faults,
    TEST_MEMORY_RENAMES: renames,
  });
});
after(async () => {
  await h?.stop();
  rmSync(controlHome, { recursive: true, force: true });
});

async function fixture() {
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Memory baseline" }) });
  const ws = join(h.home, ".bloks", "workspaces", bot.id);
  const journal = join(h.home, ".bloks", "memory-journal", `${bot.id}.json`);
  mkdirSync(join(ws, "memory"), { recursive: true });
  // Seed the journal through the real route, so byte preservation covers a
  // populated file, rather than only checking that no file was created.
  assert.equal((await h.fetch(`/api/bots/${bot.id}/memory`, { method: "PUT", body: JSON.stringify({ text: "seed" }) })).status, 200);
  return { id: bot.id as string, ws, journal };
}

/** Replay from a hello sequence obtained immediately before the request.
 * The response is sent after broadcast, so replay sees any notification. */
async function sequence() {
  const response = await h.fetch("/api/events");
  const reader = response.body!.getReader();
  const frame = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6))._seq as number;
}

async function changedSince(seq: number, id: string) {
  const response = await h.fetch(`/api/events?since=${seq}`);
  const reader = response.body!.getReader();
  let text = "";
  const until = Date.now() + 150;
  while (Date.now() < until) {
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), until - Date.now()))]);
    if (!chunk || chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  return text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
    .filter((frame) => frame.kind === "memory.changed" && frame.botId === id);
}

function noMemoryRenames(ws: string) {
  const moves = readFileSync(renames, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(moves.filter((paths) => paths.some((path) => path.startsWith(ws + "/"))), [], "no Markdown file was renamed");
}

for (const operation of ["main PUT", "topic PUT", "topic DELETE"] as const) {
  test(`${operation} refuses an unreadable baseline; a readable retry records and undoes normally`, async () => {
    const { id, ws, journal } = await fixture();
    const file = operation === "main PUT" ? "MEMORY.md" : "memory/topic.md";
    const path = join(ws, file);
    const original = "# Private planted baseline\n";
    writeFileSync(path, original);
    const saved = readFileSync(journal);
    const route = `/api/bots/${id}/memory${file === "MEMORY.md" ? "" : "/topics/topic.md"}`;
    const init = { method: operation.endsWith("DELETE") ? "DELETE" : "PUT", body: operation.endsWith("DELETE") ? undefined : JSON.stringify({ text: "replacement" }) };
    const seq = await sequence();
    writeFileSync(faults, JSON.stringify({ [path]: "EACCES" }));
    let response: Response;
    try {
      response = await h.fetch(route, init);
    } finally {
      writeFileSync(faults, "{}");
    }
    // Main/topic PUT controls fail here on unchanged code, before a status
    // assertion can hide the actual write. DELETE's unchanged code is 404.
    assert.equal(readFileSync(path, "utf8"), original, "file unchanged");
    assert.deepEqual(readFileSync(journal), saved, "journal unchanged");
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.ok(body.includes(file));
    assert.match(body, /EACCES/);
    assert.match(body, /make sure Bloks can read it/i);
    assert.match(body, /nothing was changed/i);
    assert.ok(!body.includes(original.trim()) && !body.includes("planted memory text"));
    assert.deepEqual(await changedSince(seq, id), [], "refusal broadcasts no memory.changed");
    noMemoryRenames(ws);

    assert.equal((await h.fetch(route, init)).status, 200);
    const { entries } = await h.json(`/api/bots/${id}/memory/journal`);
    const entry = entries.find((e: any) => e.file === file);
    assert.equal(entry.by, "you");
    assert.equal(entry.created, false);
    assert.equal((await h.fetch(`/api/bots/${id}/memory/journal/${entry.id}/undo`, { method: "POST" })).status, 200);
    assert.equal(readFileSync(path, "utf8"), original);
    noMemoryRenames(ws);
  });
}

test("topic PUT names memory/MEMORY.md in an unreadable-baseline refusal", async () => {
  const { id, ws, journal } = await fixture();
  const main = join(ws, "MEMORY.md");
  const topic = join(ws, "memory/MEMORY.md");
  const mainText = "main memory stays here";
  const topicText = "topic memory stays here";
  writeFileSync(main, mainText);
  writeFileSync(topic, topicText);
  const saved = readFileSync(journal);
  writeFileSync(faults, JSON.stringify({ [topic]: "EACCES" }));
  let response: Response;
  try {
    response = await h.fetch(`/api/bots/${id}/memory/topics/MEMORY.md`, { method: "PUT", body: JSON.stringify({ text: "replacement" }) });
  } finally {
    writeFileSync(faults, "{}");
  }
  assert.equal(response.status, 409);
  assert.equal(readFileSync(main, "utf8"), mainText, "main memory unchanged");
  assert.equal(readFileSync(topic, "utf8"), topicText, "topic unchanged");
  assert.deepEqual(readFileSync(journal), saved, "journal unchanged");
  const body = await response.text();
  assert.ok(body.includes("memory/MEMORY.md"), "refusal names memory/MEMORY.md");
  assert.match(body, /EACCES/);
  assert.ok(!body.includes(mainText) && !body.includes(topicText));
  noMemoryRenames(ws);
});

test("HTTP Undo refuses an unreadable current file after a deletion, then respects changed-since", async () => {
  const { id, ws, journal } = await fixture();
  const path = join(ws, "memory/topic.md");
  writeFileSync(path, "before deletion");
  assert.equal((await h.fetch(`/api/bots/${id}/memory/topics/topic.md`, { method: "DELETE" })).status, 200);
  const { entries } = await h.json(`/api/bots/${id}/memory/journal`);
  const entry = entries.find((e: any) => e.file === "memory/topic.md");
  assert.equal(entry.deleted, true);
  writeFileSync(path, "later private text");
  const saved = readFileSync(journal);
  const seq = await sequence();
  writeFileSync(faults, JSON.stringify({ [path]: "EMFILE" }));
  let response: Response;
  try {
    response = await h.fetch(`/api/bots/${id}/memory/journal/${entry.id}/undo`, { method: "POST" });
  } finally {
    writeFileSync(faults, "{}");
  }
  assert.equal(readFileSync(path, "utf8"), "later private text", "Undo leaves the unreadable file intact");
  assert.deepEqual(readFileSync(journal), saved);
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.match(body, /EMFILE/);
  assert.ok(!body.includes("later private text") && !body.includes("planted memory text"));
  assert.deepEqual(await changedSince(seq, id), []);
  const retry = await h.fetch(`/api/bots/${id}/memory/journal/${entry.id}/undo`, { method: "POST" });
  assert.equal(retry.status, 409);
  assert.match(await retry.text(), /changed since/);
  noMemoryRenames(ws);
});

test("a genuinely missing topic still gives 404 and a newly created topic can be undone", async () => {
  const { id, ws } = await fixture();
  const route = `/api/bots/${id}/memory/topics/new.md`;
  assert.equal((await h.fetch(route, { method: "DELETE" })).status, 404);
  assert.equal((await h.fetch(route, { method: "PUT", body: JSON.stringify({ text: "new text" }) })).status, 200);
  const { entries } = await h.json(`/api/bots/${id}/memory/journal`);
  const entry = entries.find((e: any) => e.file === "memory/new.md");
  assert.equal(entry.created, true);
  assert.equal((await h.fetch(`/api/bots/${id}/memory/journal/${entry.id}/undo`, { method: "POST" })).status, 200);
  assert.equal(existsSync(join(ws, "memory/new.md")), false);
  noMemoryRenames(ws);
});

test("a real turn with unreadable baselines finishes; only the readable companion has Undo", async (t) => {
  const provider = await fakeProvider(t);
  const bot = await agentOn(h, provider.port, "Turn memory");
  const ws = join(h.home, ".bloks", "workspaces", bot.id);
  mkdirSync(join(ws, "memory"), { recursive: true });
  for (const file of ["MEMORY.md", "memory/topic.md", "memory/healthy.md"]) writeFileSync(join(ws, file), "before");
  writeFileSync(faults, JSON.stringify({ [join(ws, "MEMORY.md")]: "EACCES", [join(ws, "memory/topic.md")]: "EACCES" }));
  try {
    const sent = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "remember the changes" }) });
    assert.ok(sent.ok, "the message was not accepted");
    assert.ok(await waitFor(() => provider.state.held.length), "fixture provider never received the turn");
  } finally {
    writeFileSync(faults, "{}");
  }
  // The held local provider lets the fixture edit files between the real
  // server's begin and finish calls, without a real account or tool.
  for (const file of ["MEMORY.md", "memory/topic.md", "memory/healthy.md"]) writeFileSync(join(ws, file), "after");
  provider.state.held.shift()!();
  assert.ok(await idle(h, bot), "the turn did not free its lane");
  assert.ok((await messagesOf(h, bot)).some((m) => m.role === "bot" && m.text === "Done."));
  const { entries } = await h.json(`/api/bots/${bot.id}/memory/journal`);
  assert.deepEqual(entries.map((e: any) => e.file), ["memory/healthy.md"], "the real finish records only known observations");
  assert.equal((await h.fetch(`/api/bots/${bot.id}/memory/journal/${entries[0].id}/undo`, { method: "POST" })).status, 200);
  assert.equal(readFileSync(join(ws, "memory/healthy.md"), "utf8"), "before");
  assert.equal(readFileSync(join(ws, "MEMORY.md"), "utf8"), "after");
  assert.equal(readFileSync(join(ws, "memory/topic.md"), "utf8"), "after");
  noMemoryRenames(ws);
});
