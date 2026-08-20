// The local sandbox, against a runtime small enough to fit in a test.
//
// The fake executes exec commands for real in a per-container directory,
// so the round trip below proves the whole path: route, module, runtime
// argv, and the working directory the files persist in.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { startHarness, type Harness } from "./helpers/server.ts";

let h: Harness;
let stateDir: string;

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "bloks-fake-rt-"));
  process.env.BLOKS_SANDBOX_RUNTIME = resolve("test/helpers/fake-runtime.sh");
  process.env.FAKE_RT_STATE = stateDir;
  h = await startHarness();
});
after(async () => {
  await h?.stop();
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env.BLOKS_SANDBOX_RUNTIME;
  delete process.env.FAKE_RT_STATE;
});

describe("the local sandbox", () => {
  test("lives, works, sleeps and dies on request", async () => {
    const { bots } = await h.json("/api/bots");
    const id = bots[0].id;

    // nothing exists until asked for
    let status = await h.json(`/api/bots/${id}/sandbox`);
    assert.equal(status.available, true);
    assert.equal(status.state, "none");

    // provisioning creates and starts it
    status = await h.json(`/api/bots/${id}/sandbox/provision`, { method: "POST" });
    assert.equal(status.state, "running");

    // a command runs inside it and files persist between commands
    const wrote = await h.json(`/api/bots/${id}/sandbox/exec`, {
      method: "POST",
      body: JSON.stringify({ command: "echo persisted > note.txt && cat note.txt" }),
    });
    assert.equal(wrote.exitCode, 0);
    assert.match(wrote.stdout, /persisted/);

    const readBack = await h.json(`/api/bots/${id}/sandbox/exec`, {
      method: "POST",
      body: JSON.stringify({ command: "cat note.txt" }),
    });
    assert.match(readBack.stdout, /persisted/, "the file must survive across execs");

    // stop keeps the container; provision wakes it again
    status = await h.json(`/api/bots/${id}/sandbox/stop`, { method: "POST" });
    assert.equal(status.state, "stopped");
    status = await h.json(`/api/bots/${id}/sandbox/provision`, { method: "POST" });
    assert.equal(status.state, "running");

    // destroy removes every trace
    await h.json(`/api/bots/${id}/sandbox/destroy`, { method: "POST" });
    status = await h.json(`/api/bots/${id}/sandbox`);
    assert.equal(status.state, "none");
  });

  test("the sandbox mode round-trips on the agent record", async () => {
    const { bots } = await h.json("/api/bots");
    const res = await h.fetch(`/api/bots/${bots[0].id}`, {
      method: "PATCH",
      body: JSON.stringify({ computer: "sandbox" }),
    });
    assert.equal(res.status, 200);
    const { bot } = await res.json() as any;
    assert.equal(bot.computer, "sandbox");
  });
});
