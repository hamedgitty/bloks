// One server per data folder (server/data-lock.ts, GitHub 140).
//
// Every store writes its whole file back on each change, so two servers
// on one ~/.bloks silently undo each other: an edit reverted, a hired
// agent gone, one message running two engines. A second server must stop
// before touching anything and say who holds the folder; a lock left by
// a server that died must not keep the next one out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { claimDataFolder, inUseMessage } from "../server/data-lock.ts";
import { startHarness } from "./helpers/server.ts";

const ENTRY = fileURLToPath(new URL("../server/index.ts", import.meta.url));

test("a live holder keeps the folder; a dead one's lock is taken over", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // a process standing in for a running server: named like one, holding the lock
  const holderScript = join(dir, "bloks-holder.mjs");
  writeFileSync(
    holderScript,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "server.lock"))}, JSON.stringify({ pid: process.pid, port: 8799, startedAt: Date.now() }));
console.log("ready");
setInterval(() => {}, 1000);`,
  );
  const holder = spawn(process.execPath, [holderScript], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => holder.kill("SIGKILL"));
  await new Promise((r) => holder.stdout!.once("data", r));

  const refused = claimDataFolder(dir, 18799);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.holder.pid === holder.pid && refused.holder.port === 8799);
  assert.match(inUseMessage(dir, (refused as any).holder), /DATA_FOLDER_IN_USE pid=\d+ port=8799/);

  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("exit", r));
  const claimed = claimDataFolder(dir, 18799);
  assert.equal(claimed.ok, true, "a dead server's lock kept the folder");
  assert.equal(JSON.parse(readFileSync(join(dir, "server.lock"), "utf8")).pid, process.pid);
});

test("a lock naming a live process that is not Bloks is stale", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  // what the system might hand a dead server's pid to: something alive, and not Bloks
  const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    other.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "server.lock"), JSON.stringify({ pid: other.pid, port: 8799, startedAt: 0 }));
  assert.equal(claimDataFolder(dir, 18799).ok, true);
});

test("a second server on the same home refuses to start, and the first keeps its data", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-two-servers-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = await startHarness({ HOME: home });
  const { bot } = await first.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper", description: "the right one" }) });

  const port = 20000 + Math.floor(Math.random() * 20000);
  const second = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BLOKS_PORT: String(port), PATH: "/nonexistent" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  second.stderr!.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => {
    second.once("exit", (c) => resolve(c));
    setTimeout(() => {
      second.kill("SIGKILL");
      resolve(-1);
    }, 60_000);
  });
  assert.equal(code, 3, `the second server did not refuse: ${stderr.slice(-400)}`);
  assert.match(stderr, /DATA_FOLDER_IN_USE pid=\d+ port=/);
  assert.match(stderr, /overwrite each other's changes/);

  // the first is untouched, and still the one answering for its agents
  const { bots } = await first.json("/api/bots?messages=0");
  assert.ok(bots.some((b: any) => b.id === bot.id));
  await first.stop();
  assert.equal(existsSync(join(home, ".bloks", "server.lock")), false, "a server that stopped left its lock behind");

  // and once it has stopped, the next one starts as usual
  const again = await startHarness({ HOME: home });
  t.after(() => again.stop());
  const { bots: after } = await again.json("/api/bots?messages=0");
  assert.equal(after.find((b: any) => b.id === bot.id)?.description, "the right one");
});
