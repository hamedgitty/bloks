// Stop the real handler at the new listener await, then deliver its old
// connect callback immediately or after a replacement turn has completed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { personFixture, SAM, until } from "./helpers/telegram-person.ts";

for (const releaseWhen of ["after Stop", "after replacement"] as const) {
  test(`HTTP Stop retires pending reply readiness, with its callback released ${releaseWhen}`, { skip: process.platform === "win32" }, async t => {
    const dir = mkdtempSync(join(tmpdir(), "bloks-preflight-test-"));
    const ready = join(dir, "ready"), release = join(dir, "release"), closed = join(dir, "closed");
    t.after(() => { writeFileSync(release, "release"); });
    const f = await personFixture(t, "codex", { env: {
      NODE_OPTIONS: `--import=${new URL("./helpers/telegram-fetch.mjs", import.meta.url).href} --import=${new URL("./helpers/telegram-reply-preflight.mjs", import.meta.url).href}`,
      BLOKS_TEST_REPLY_READY: ready, BLOKS_TEST_REPLY_RELEASE: release, BLOKS_TEST_REPLY_CLOSED: closed,
    } });
    // Registered after harness shutdown, so the preload cannot write into
    // an already removed test directory if an assertion fails.
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    f.say("@PlanningBot STOP_BEFORE_ENGINE FAKE_TEXT", SAM, {
      chat: { id: -7001, type: "supergroup", title: "Planning group" },
      entities: [{ type: "mention", offset: 0, length: 12 }],
    });
    await until(() => existsSync(ready), "real readiness probe was not reached");
    const endpoint = readFileSync(ready, "utf8");
    assert.equal(f.records().length, 0);
    const stop = await f.post(`/api/bots/${f.bot.id}/interrupt`, { taskId: f.bot.threadId });
    assert.equal(stop.ok, true);
    if (releaseWhen === "after Stop") {
      writeFileSync(release, "release");
      await until(() => existsSync(release + ".delivered"), "old connect callback was not injected");
    }
    await f.idle();
    assert.equal(f.records().some(r => r.text?.includes("STOP_BEFORE_ENGINE")), false, "stopped request reached engine input");
    await until(() => existsSync(closed), "pending probe connection was not closed");
    assert.equal(existsSync(dirname(endpoint)), false, "pending reply folder survived Stop");
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const socket = createConnection(endpoint);
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    }), /ENOENT|ECONNREFUSED/);
    const stoppedRows = (await f.messages()).filter(m => m.tool?.name?.includes("Stopped before Codex started"));
    assert.equal(stoppedRows.length, 1, "pending turn did not settle exactly once");
    assert.equal(f.records().some(r => r.text?.includes("STOP_BEFORE_ENGINE")), false);
    await f.post(`/api/bots/${f.bot.id}/messages`, { text: "REPLACEMENT_WORDS FAKE_TEXT" });
    await f.idle();
    assert.equal(f.records().filter(r => r.text?.includes("REPLACEMENT_WORDS")).length, 1);
    const accepted = f.records().filter(r => typeof r.text === "string");
    assert.equal(accepted.length, 1, "only the replacement may reach the engine");
    writeFileSync(release, "release");
    await until(() => existsSync(release + ".delivered"), "old connect callback was not injected");
    await f.idle();
    assert.deepEqual(f.records().filter(r => typeof r.text === "string"), accepted, "old readiness dispatched input after replacement");
    assert.equal(f.records().filter(r => r.text?.includes("REPLACEMENT_WORDS")).length, 1);
    assert.equal((await f.messages()).filter(m => m.tool?.name?.includes("Stopped before Codex started")).length, 1);
  });
}
