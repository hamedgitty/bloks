// Protected Unix endpoints, and visible refusal before a dead tool is published.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { createAskBroker, socketPathFits } from "../server/harness/ask-broker.ts";
import { checkCodexReplyEndpoint, makeCodexReplyFolder } from "../server/person-turn.ts";
import { personFixture, SAM, until } from "./helpers/telegram-person.ts";

test("a Codex group endpoint really connects, is private and isolated, and is cleaned up", { skip: process.platform === "win32" }, async (t) => {
  const first = makeCodexReplyFolder(), second = makeCodexReplyFolder();
  t.after(() => { first.close(); second.close(); });
  assert.notEqual(first.socketPath, second.socketPath);
  assert.equal(statSync(dirname(first.socketPath)).mode & 0o777, 0o700);
  const broker = createAskBroker({ socketPath: first.socketPath, onAsk: () => {}, onResolve: () => {}, onReply: async () => "sent" });
  t.after(() => broker.close());
  await checkCodexReplyEndpoint(first.socketPath);
  assert.equal(socketPathFits(first.socketPath), true);
  broker.close(); first.close();
  assert.equal(existsSync(first.socketPath), false);
  assert.equal(existsSync(dirname(first.socketPath)), false);
});

test("long Unix and multibyte endpoint paths are refused without leaving a folder", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-endpoint-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["x".repeat(100), "é".repeat(50)]) {
    const long = join(root, name); mkdirSync(long);
    assert.throws(() => makeCodexReplyFolder({ platform: "linux", tempDir: long }), /socket path is too long/);
    assert.deepEqual(readdirSync(long), []);
  }
});

test("Windows selection refuses a filesystem socket instead of publishing an unprotected pipe", () => {
  assert.throws(() => makeCodexReplyFolder({ platform: "win32", tempDir: "C:\\Temp" }), /protected native endpoint on Windows/);
});

test("a failed listener is reported before its endpoint is advertised", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-endpoint-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(checkCodexReplyEndpoint(join(root, "missing.sock")), /endpoint could not listen/);
});

test("a Codex group request with a long temporary folder fails visibly before engine input", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bloks-endpoint-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const long = join(root, "x".repeat(100)); mkdirSync(long);
  const f = await personFixture(t, "codex", { env: { TMPDIR: long } });
  f.say("@PlanningBot GROUP_ENDPOINT_WORDS FAKE_TEXT", SAM, {
    chat: { id: -7001, type: "supergroup", title: "Planning" }, entities: [{ type: "mention", offset: 0, length: 12 }],
  });
  await until(async () => (await f.messages()).some((m) => /group reply socket path is too long/.test(m.tool?.name ?? "")), "the endpoint failure was not visible in the app's error row");
  await f.idle();
  assert.equal(f.records().length, 0, "an unusable native reply tool reached the engine");
  await until(() => f.sent(-7001).some((m) => m.body.text.includes("cannot answer from Telegram")), "the group did not receive its neutral hold");
  assert.deepEqual(readdirSync(long), []);
});
