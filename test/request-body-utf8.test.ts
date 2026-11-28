// A request body is stored as it was sent, however it is cut on the way
// in. A character's bytes can arrive in two reads of the socket, and each
// read used to be decoded on its own, so an emoji in a table cell was
// stored as replacement characters while show answered 201.
//
// The real harness over real HTTP: each body is written in parts with a
// pause between them, so the server reads each part on its own, and what
// was kept is read back from the API and from the transcript on disk.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

import { startHarness, type Harness } from "./helpers/server.ts";
import { MAX_BODY_BYTES } from "../server/limits.ts";

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h.stop();
});

async function agent(name: string): Promise<{ id: string; threadId: string }> {
  return (await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) })).bot;
}

/** Shows a component whose body is written in these parts, 100 ms apart.
 * Answers the status, or the socket's error when the server hangs up. */
function show(botId: string, parts: Buffer[]): Promise<number | string> {
  const { port } = new URL(h.url);
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: "POST",
        path: `/api/bots/${botId}/show`,
        agent: false,
        headers: {
          origin: "http://localhost:5199",
          "content-type": "application/json",
          "content-length": String(parts.reduce((n, part) => n + part.length, 0)),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
    void (async () => {
      for (const [i, part] of parts.entries()) {
        if (i) await new Promise((r) => setTimeout(r, 100));
        req.write(part);
      }
      req.end();
    })();
  });
}

/** A one-cell table with these bytes between two words, written as raw
 * bytes so a malformed sequence can be sent as well as a valid one. `at`
 * is where the bytes start in the body. */
function table(label: string, bytes: number[]): { body: Buffer; at: number } {
  const head = Buffer.from(`{"kind":"table","data":{"columns":["Passage"],"rows":[["${label} before `);
  return { body: Buffer.concat([head, Buffer.from(bytes), Buffer.from(` after"]]}}`)]), at: head.length };
}

/** The body whole, then cut once at every point inside the sequence. */
function cuts(body: Buffer, at: number, length: number): Buffer[][] {
  const all = [[body]];
  for (let k = 1; k < length; k++) all.push([body.subarray(0, at + k), body.subarray(at + k)]);
  return all;
}

/** The first cell of each component in the lane, from the API and from disk. */
async function cells(bot: { id: string; threadId: string }): Promise<{ api: string[]; disk: string[] }> {
  const first = (messages: any[]) => messages.filter((m) => m.kind === "component").map((m) => m.component.rows[0][0]);
  const { bots } = await h.json("/api/bots");
  const api = first(bots.find((b: any) => b.id === bot.id).messages);
  const disk = first(JSON.parse(readFileSync(join(h.home, ".bloks", `messages-${bot.threadId}.json`), "utf8")));
  return { api, disk };
}

test("a character whose bytes arrive in two reads is stored whole", async () => {
  const bot = await agent("Unicode");
  const characters = ["é", "€", "�", "🚀"]; // 2, 3, 3 and 4 bytes; U+FFFD as somebody wrote it
  const expected: string[] = [];
  for (const [n, character] of characters.entries()) {
    const bytes = [...Buffer.from(character)];
    const { body, at } = table(`case ${n}`, bytes);
    for (const parts of cuts(body, at, bytes.length)) {
      assert.equal(await show(bot.id, parts), 201);
      expected.push(`case ${n} before ${character} after`);
    }
  }
  // and the four bytes of one emoji in four reads
  const { body, at } = table("one by one", [...Buffer.from("🚀")]);
  const parts = [body.subarray(0, at + 1), body.subarray(at + 1, at + 2), body.subarray(at + 2, at + 3), body.subarray(at + 3)];
  assert.equal(await show(bot.id, parts), 201);
  expected.push("one by one before 🚀 after");

  const { api, disk } = await cells(bot);
  assert.deepEqual(api, expected);
  assert.deepEqual(disk, expected);
});

test("malformed bytes are kept as one decoding of the whole body keeps them, cut or not", async () => {
  // what the reader did before for a body that arrived in one read: each
  // ill-formed sequence becomes U+FFFD and the component is accepted
  const bot = await agent("Malformed");
  const sequences = [
    [0xf0, 0x9f], // a four-byte character cut short
    [0xe2, 0x28, 0xa1], // a lead byte without its continuation
    [0xc0, 0xaf], // an overlong "/"
    [0xed, 0xa0, 0x80], // an encoded surrogate
    [0xf4, 0x90, 0x80, 0x80], // past U+10FFFF
  ];
  const expected: string[] = [];
  for (const [n, bytes] of sequences.entries()) {
    const { body, at } = table(`case ${n}`, bytes);
    const whole = JSON.parse(body.toString("utf8")).data.rows[0][0];
    assert.ok(whole.includes("�"));
    for (const parts of cuts(body, at, bytes.length)) {
      assert.equal(await show(bot.id, parts), 201);
      expected.push(whole);
    }
  }
  const { api, disk } = await cells(bot);
  assert.deepEqual(api, expected);
  assert.deepEqual(disk, expected);
});

test("a body ending in part of a character is refused the same, cut or not", async () => {
  const bot = await agent("Unfinished");
  const { body: valid } = table("unfinished", []);
  const body = Buffer.concat([valid, Buffer.from([0xf0, 0x9f])]);
  for (const parts of cuts(body, valid.length, 2)) assert.equal(await show(bot.id, parts), 400);
  assert.deepEqual((await cells(bot)).api, []);
});

test("the body limit counts characters, wherever the reads fall", async () => {
  // 2,000,000 characters of three bytes each is 6,000,000 bytes, read in
  // many parts with characters cut at their edges. The limit is unchanged:
  // at it the body is read, one character past it the body is refused.
  const bot = await agent("Large");
  const padded = (label: string, extra: number) => {
    const head = `{"kind":"table","data":{"columns":["Passage"],"rows":[["${label}"]]},"pad":"`;
    const tail = `"}`;
    return Buffer.from(head + "€".repeat(MAX_BODY_BYTES - head.length - tail.length + extra) + tail);
  };
  assert.equal(await show(bot.id, [padded("at the limit", 0)]), 201);
  assert.notEqual(await show(bot.id, [padded("past the limit", 1)]), 201);
  assert.deepEqual((await cells(bot)).api, ["at the limit"]);
});
