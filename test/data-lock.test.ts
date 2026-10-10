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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { claimDataFolder, fitsHolder, inUseMessage, parseWindowsProcess } from "../server/data-lock.ts";
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
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const { bots: after } = await again.json("/api/bots?messages=0");
  assert.equal(after.find((b: any) => b.id === bot.id)?.description, "the right one");
});

// Windows ends a killed server outright, so its lock stays behind, and it
// hands the pid on soon: often to the next Bloks.exe itself. Any live pid
// used to count, which kept Bloks from starting until the lock was gone.
test("on Windows a live pid holds the folder only as a program that can be Bloks, started before the lock", () => {
  const holder = { pid: 4242, port: 8799, startedAt: 1_700_000_000_000 };
  assert.equal(fitsHolder({ name: "Bloks", startedAt: holder.startedAt - 3_000 }, holder), true);
  assert.equal(fitsHolder({ name: "node", startedAt: holder.startedAt - 500 }, holder), true, "bloks-server runs under node");
  assert.equal(fitsHolder({ name: "Bloks", startedAt: holder.startedAt + 1_000 }, holder), true, "clock rounding is allowed for");
  // the pid handed on, to another program or to a later Bloks
  assert.equal(fitsHolder({ name: "notepad", startedAt: holder.startedAt - 3_000 }, holder), false);
  assert.equal(fitsHolder({ name: "Bloks", startedAt: holder.startedAt + 60_000 }, holder), false);
  // when Windows will not say when it started, the name has to do
  assert.equal(fitsHolder({ name: "Bloks", startedAt: null }, holder), true);
  assert.equal(fitsHolder({ name: "svchost", startedAt: null }, holder), false);

  assert.deepEqual(parseWindowsProcess("Bloks\r\n1700000000000\r\n"), { name: "Bloks", startedAt: 1_700_000_000_000 });
  assert.deepEqual(parseWindowsProcess("svchost\r\n\r\n"), { name: "svchost", startedAt: null });
  assert.equal(parseWindowsProcess(""), null);
});

// The desktop app asks its server to stop with a message (Electron's
// parentPort) before it kills it, so that on Windows, where a kill runs
// no exit handler, the server still gives up the folder itself.
test("a server the desktop app asks to stop exits and gives up the folder", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-asked-to-stop-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  // Electron's port to a utility process, as far as the server uses it:
  // the message arrives once the test drops a file
  const preload = join(home, "parent-port.mjs");
  writeFileSync(
    preload,
    `import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
const port = new EventEmitter();
process.parentPort = port;
const trigger = process.env.BLOKS_TEST_STOP_FILE;
const timer = setInterval(() => {
  if (!existsSync(trigger)) return;
  clearInterval(timer);
  port.emit("message", { data: { kind: "stop" } });
}, 50);
timer.unref();
`,
  );
  const stopFile = join(home, "stop-now");
  const h = await startHarness({
    HOME: home,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    BLOKS_TEST_STOP_FILE: stopFile,
  });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const { pid } = await h.json("/api/health");
  const lock = join(home, ".bloks", "server.lock");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, pid);

  writeFileSync(stopFile, "");
  const running = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 100 && running(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(running(), false, "the server kept running after it was asked to stop");
  assert.equal(existsSync(lock), false, "the server left its lock behind");
});
