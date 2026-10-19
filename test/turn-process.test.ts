import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";

import { OWN_GROUP } from "../server/no-console.ts";
import { TurnProcess } from "../server/drivers/turn-process.ts";

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    }
    return true;
  } catch {
    return false;
  }
};

function tidy(t: TestContext, child: ChildProcess, extras: () => number[] = () => []) {
  t.after(async () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    }
    for (const pid of extras()) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    const pids = [...(child.pid ? [child.pid] : []), ...extras()];
    const until = Date.now() + 2_000;
    while (pids.some(running) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    child.stdout?.destroy();
    child.stderr?.destroy();
    assert.equal(pids.some(running), false, "fixture cleanup left an executable process");
  });
}

function firstLine(child: ChildProcess) {
  return new Promise<string>((resolve, reject) => {
    let text = "";
    child.once("error", reject);
    child.stdout!.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.split("\n")[0]);
    });
  });
}

test("turn cleanup confirms leader exit and escalates a helper left holding its pipe, without stopping another lane", { skip: !OWN_GROUP, timeout: 10_000 }, async (t) => {
  const helper = `process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const helper = spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: ["ignore", "inherit", "ignore", "ipc"] });
    helper.on("message", () => console.log(JSON.stringify({ helper: helper.pid })));
    setInterval(() => {}, 1000);
  `], { detached: OWN_GROUP, stdio: ["ignore", "pipe", "ignore"] });
  let helperPid = 0;
  tidy(t, child, () => helperPid ? [helperPid] : []);
  helperPid = JSON.parse(await firstLine(child)).helper;
  const unrelated = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    detached: OWN_GROUP, stdio: ["ignore", "pipe", "ignore"],
  });
  tidy(t, unrelated);
  await firstLine(unrelated);
  let closed = false;
  child.once("close", () => { closed = true; });
  let confirmed = 0;
  const processOwner = new TurnProcess(child, { onConfirmed: () => { confirmed++; } });
  const leaderExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const ending = processOwner.end(400);
  assert.equal(processOwner.end(1), ending, "repeated end owns the same cleanup");
  await leaderExit;
  assert.equal(processOwner.confirmed, false, "leader exit cannot release the session while its helper runs");
  assert.equal(running(helperPid), true, "the helper resisted TERM");
  assert.equal(closed, false, "the helper still holds its inherited pipe");
  assert.equal(await ending, true, "actual cleanup was confirmed after escalation");
  assert.equal(running(helperPid), false);
  assert.equal(processOwner.confirmed, true);
  assert.equal(confirmed, 1);
  assert.equal(running(unrelated.pid!), true, "the other lane remains alive");
  // No stale cleanup is left to signal a later owner after confirmation.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(confirmed, 1);
  assert.equal(running(unrelated.pid!), true);
});

test("a polite turn confirms promptly instead of waiting for both grace periods", { skip: !OWN_GROUP, timeout: 10_000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
    detached: OWN_GROUP, stdio: ["ignore", "pipe", "ignore"],
  });
  tidy(t, child);
  await firstLine(child);
  const owner = new TurnProcess(child);
  const began = Date.now();
  assert.equal(await owner.end(3_000), true);
  assert.ok(Date.now() - began < 2_000);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
});

test("bounded unconfirmed cleanup keeps its barrier and confirms only on later observed exit", async () => {
  const signals: string[] = [];
  const fake = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, pid: undefined,
    kill(signal: string) { signals.push(signal); return true; },
  }) as unknown as ChildProcess;
  let confirmations = 0;
  const owner = new TurnProcess(fake, { onConfirmed: () => { confirmations++; } });
  assert.equal(await owner.end(10), false, "KILL sent is not an observed exit");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(owner.confirmed, false);
  assert.equal(confirmations, 0);
  fake.emit("exit", null, "SIGKILL");
  assert.equal(owner.confirmed, true);
  assert.equal(confirmations, 1);
  fake.emit("exit", null, "SIGKILL");
  assert.equal(confirmations, 1);
});

test("a failed spawn has no process to leave behind", async () => {
  const fake = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, pid: undefined, kill() { return false; },
  }) as unknown as ChildProcess;
  const owner = new TurnProcess(fake);
  fake.emit("error", new Error("spawn ENOENT"));
  assert.equal(await owner.end(10), true);
  assert.equal(owner.confirmed, true);
});
