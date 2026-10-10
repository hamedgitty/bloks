// No engine outlives the server (server/drivers/engine-processes.ts).
//
// Engines run in process groups of their own, and a shutdown only sent
// each group SIGTERM and exited. An engine stuck in a tool call, or a
// connector deaf to SIGTERM, kept running after Bloks quit, and the next
// start resumed its session beside it.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { EngineProcesses } from "../server/drivers/engine-processes.ts";
import { startHarness } from "./helpers/server.ts";

const POSIX = process.platform !== "win32";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Until none of `pids` is running, or `ms` pass. A process killed a
 * moment ago can linger until whoever inherited it reaps it. */
async function goneWithin(pids: number[], ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!pids.some(alive)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pids.some(alive);
}

/** Whatever a failing run left behind is not left running. */
function sweep(t: TestContext, pids: () => number[]) {
  t.after(() => {
    for (const pid of pids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone, as it should be */
      }
    }
  });
}

// a process deaf to SIGTERM, standing in for a tool call that will not stop
const DEAF = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

/** An engine in a group of its own that starts one deaf process beside
 * it and prints both pids. `deaf` decides whether the engine itself
 * ignores SIGTERM too. */
function engine(deaf: boolean) {
  const script = `
const { spawn } = require("node:child_process");
${deaf ? "process.on('SIGTERM', () => {});" : ""}
const tool = spawn(process.execPath, ["-e", ${JSON.stringify(DEAF)}], { stdio: "ignore" });
console.log(JSON.stringify({ engine: process.pid, tool: tool.pid }));
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const pids = new Promise<{ engine: number; tool: number }>((resolve) => {
    let out = "";
    child.stdout!.on("data", (c) => {
      out += c;
      if (out.includes("\n")) resolve(JSON.parse(out));
    });
  });
  return { child, pids };
}

test("ending an instance's engines kills a group that would not stop, and what was left in it", { skip: !POSIX }, async (t) => {
  const seen: number[] = [];
  sweep(t, () => seen);
  const deaf = engine(true);
  const polite = engine(false);
  const [a, b] = await Promise.all([deaf.pids, polite.pids]);
  seen.push(a.engine, a.tool, b.engine, b.tool);

  const engines = new EngineProcesses();
  engines.add(deaf.child);
  engines.add(polite.child);
  const began = Date.now();
  await engines.end(400);
  assert.ok(Date.now() - began < 2_000, "ending them waited past its grace");
  assert.ok(await goneWithin(seen, 3_000), `still running: ${seen.filter(alive).join(", ")}`);
});

test("engines that stop when asked are not waited on for the whole grace", { skip: !POSIX }, async (t) => {
  const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  sweep(t, () => (child.pid ? [child.pid] : []));
  await new Promise((r) => child.once("spawn", r));
  const engines = new EngineProcesses();
  engines.add(child);
  const began = Date.now();
  await engines.end(10_000);
  assert.ok(Date.now() - began < 5_000, "a polite engine was waited on as if it were deaf");
  assert.ok(await goneWithin([child.pid!], 3_000));
  // and one that exited on its own, or never started, is nothing to end
  const never = spawn(join(tmpdir(), "no-such-engine-here"), [], { stdio: "ignore" });
  never.on("error", () => {});
  engines.add(never);
  const quick = Date.now();
  await engines.end(10_000);
  assert.ok(Date.now() - quick < 1_000);
});

test("a server stopping ends a Claude Code turn that will not stop, and what it started", { skip: !POSIX }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-engine-stop-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }),
  );
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
// stuck in a tool call: deaf to SIGTERM, and so is the tool
process.on("SIGTERM", () => {});
const tool = spawn(process.execPath, ["-e", ${JSON.stringify(DEAF)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(join(home, "engine.json"))}, JSON.stringify({ engine: process.pid, tool: tool.pid }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-deaf", model: "claude-sonnet-5" }));
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  let pids: { engine: number; tool: number } | null = null;
  sweep(t, () => (pids ? [pids.engine, pids.tool] : []));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const h = await startHarness({ HOME: home });
  let stopped = false;
  t.after(async () => {
    if (!stopped) await h.stop();
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Stuck" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "run the long tool" }) });
  for (let i = 0; i < 200 && !pids; i++) {
    try {
      pids = JSON.parse(readFileSync(join(home, "engine.json"), "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.ok(pids, "the engine never started");
  assert.ok(alive(pids.engine) && alive(pids.tool));

  const began = Date.now();
  await h.stop();
  stopped = true;
  // The engines' grace is 1.5 seconds, inside the two Electron gives a
  // server it kills; this bound is loose because stop() also tidies up.
  assert.ok(Date.now() - began < 5_000, `stopping took ${Date.now() - began} ms`);
  assert.ok(await goneWithin([pids.engine, pids.tool], 3_000), "an engine outlived the server");
});

const DRIVERS = fileURLToPath(new URL("../server/drivers/", import.meta.url));

test("every driver that starts an engine in a group of its own ends it on dispose", () => {
  let seen = 0;
  for (const file of readdirSync(DRIVERS).filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(join(DRIVERS, file), "utf8");
    const groups = code.match(/detached:\s*OWN_GROUP/g)?.length ?? 0;
    if (!groups) continue;
    seen++;
    assert.equal(code.match(/engines\.add\(child\)/g)?.length ?? 0, groups, `${file}: an engine started in its own group is not kept for dispose`);
    assert.match(code, /dispose: async \(\) => \{[\s\S]{0,300}?await engines\.end\(\)/, `${file}: dispose does not end its engines`);
  }
  assert.ok(seen >= 4, `found only ${seen} drivers; the scan itself is broken`);
});
