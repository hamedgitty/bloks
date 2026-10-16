// Claude Code's one-shot answers (summaries, names) carry the
// conversation itself, so they go in on stdin rather than the command
// line, and a key in the environment does not bill them to the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import type { TestContext } from "node:test";

import { ClaudeDriver } from "../server/drivers/claude.ts";

test("a one-shot prompt goes over stdin, and no API key goes with it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bloks-oneshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = join(dir, "seen.json");
  const cli = join(dir, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, input, key: process.env.ANTHROPIC_API_KEY ?? null }));
  console.log("A short summary.");
});
`,
    { mode: 0o755 },
  );
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-travel";
  t.after(() => {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  });
  const instance = await ClaudeDriver.create({
    instanceId: "claude", displayName: "Claude", enabled: true, environment: {},
    config: { cli, permissionMode: "acceptEdits" } as any,
  });
  t.after(() => instance.dispose());

  const said = await instance.generateText!("SECRET-CONVERSATION about the launch");
  assert.equal(said, "A short summary.");
  const { args, input, key } = JSON.parse(readFileSync(seen, "utf8"));
  assert.ok(!args.some((a: string) => a.includes("SECRET-CONVERSATION")), "the prompt was on the command line");
  assert.equal(input, "SECRET-CONVERSATION about the launch");
  assert.equal(key, null, "the API key reached the one-shot call");
});

async function oneShot(t: TestContext, mode = "text", path: "absolute" | "relative" | "PATH" = "absolute") {
  const root = mkdtempSync(join(tmpdir(), "bloks-text-fixture-"));
  const temps = join(root, "temps");
  mkdirSync(temps);
  const records = join(root, "calls");
  mkdirSync(records);
  const env = { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, "auth"), TMPDIR: temps,
    ANTHROPIC_API_KEY: "fixture-key", CLAUDECODE: "fixture-parent", CLAUDE_CODE_ENTRYPOINT: "fixture-entrypoint",
    PATH: root + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "") };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const cli = join(root, "fake-claude.mjs"), seen = join(root, "seen.json"), target = join(root, "write-target.txt");
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, writeFileSync, renameSync } from "node:fs";
const args=process.argv.slice(2);
if(args[0]==="--version"){console.log("9.9.9 (Claude Code)");process.exit(0);}
const mode=${JSON.stringify(mode)};
const cwd=process.cwd();
const stopping=()=>{const path=${JSON.stringify(join(root, "stopping.json"))};writeFileSync(path+".part",JSON.stringify({cwdExists:existsSync(cwd)}));renameSync(path+".part",path);};
if(mode==="hang")process.on("SIGTERM",stopping);
if(mode==="late")process.on("SIGTERM",()=>{stopping();console.log("Late answer");process.exit(0);});
let input="";
process.stdin.on("data",c=>{input+=c;});
process.stdin.on("end",()=>{
 const value={args,input,cwd:process.cwd(),pid:process.pid,home:process.env.HOME,profile:process.env.USERPROFILE,auth:process.env.CLAUDE_CONFIG_DIR,key:process.env.ANTHROPIC_API_KEY??null,parent:process.env.CLAUDECODE??null,entry:process.env.CLAUDE_CODE_ENTRYPOINT??null};
 const record=${JSON.stringify(records)}+"/"+process.pid+".json";
 writeFileSync(record+".part",JSON.stringify(value));renameSync(record+".part",record);
 writeFileSync(${JSON.stringify(seen)}+"."+process.pid+".part",JSON.stringify(value));renameSync(${JSON.stringify(seen)}+"."+process.pid+".part",${JSON.stringify(seen)});
 if(mode==="hang"||mode==="late"){setInterval(()=>{},1000);return;}
 if(mode==="fail"){console.log("Partial output before failure.");console.error("Fixture failed");process.exit(7);}
 if(mode==="unsupported"){console.error("Unknown option --safe-mode");process.exit(2);}
 if(mode==="empty"){console.log("   ");return;}
 if(input.includes("WRITE_FIXTURE")&&args[args.indexOf("--tools")+1]!=="")writeFileSync(${JSON.stringify(target)},"unwanted fixture write");
 console.log(mode==="echo"?input:"A short fixture summary.");
});
`, { mode: 0o755 });
  // Resolve the configured CLI from the caller before changing cwd.
  const configured = path === "relative" ? "./" + relativePath(process.cwd(), cli) : path === "PATH" ? "fake-claude.mjs" : cli;
  const instance = await ClaudeDriver.create({
    instanceId: "claude", displayName: "Claude", enabled: true, environment: {},
    config: { cli: mode === "missing" ? join(root, "missing-cli") : configured, permissionMode: "acceptEdits" } as any,
  });
  t.after(async () => {
    t.mock.timers.reset();
    if ((mode === "hang" || mode === "late") && existsSync(seen)) {
      const pid = JSON.parse(readFileSync(seen, "utf8")).pid;
      if (readdirSync(temps).length) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already ended */ }
      }
    }
    await instance.dispose();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const waitFile = (file: string) => new Promise<void>(resolve => {
    if (existsSync(file)) return resolve();
    const check = () => { if (existsSync(file)) { watcher.close(); resolve(); } };
    const watcher = watch(root, check);
    t.after(() => watcher.close());
    check();
  });
  const waitGone = async () => {
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      if (!readdirSync(temps).length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(readdirSync(temps), [], "one-shot cwd outlived its child");
  };
  const ready = () => waitFile(seen);
  const stopping = async () => { const file = join(root, "stopping.json"); await waitFile(file); return JSON.parse(readFileSync(file, "utf8")); };
  return { root, temps, seen, target, records, instance, ready, stopping, waitGone, info: () => JSON.parse(readFileSync(seen, "utf8")) };
}

for (const path of ["absolute", "relative", "PATH"] as const) test(`text-only launch preserves sign-in, rejects a requested write and removes its cwd, path=${path}`, async t => {
  const f = await oneShot(t, "text", path);
  const prompt = "WRITE_FIXTURE: write a local fixture file and summarise.";
  assert.equal(await f.instance.generateText!(prompt), "A short fixture summary.");
  const seen = f.info();
  assert.deepEqual(seen.args, [
    "-p", "--model", "claude-haiku-4-5", "--output-format", "text",
    "--safe-mode", "--setting-sources", "", "--tools", "",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence",
  ]);
  assert.equal(seen.input, prompt);
  assert.ok(!seen.args.some((arg: string) => arg.includes(prompt)));
  assert.notEqual(seen.cwd, process.cwd());
  assert.ok(!seen.cwd.startsWith(process.cwd() + "/"));
  assert.equal(seen.cwd.startsWith(f.temps), true);
  assert.deepEqual([seen.home, seen.profile, seen.auth], [f.root, f.root, join(f.root, "auth")]);
  assert.deepEqual([seen.key, seen.parent, seen.entry], [null, null, null]);
  const value = (flag: string) => seen.args[seen.args.indexOf(flag) + 1];
  for (const flag of ["--safe-mode", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(seen.args.includes(flag), flag);
  assert.equal(value("--tools"), "");
  assert.equal(value("--setting-sources"), "");
  assert.deepEqual(JSON.parse(value("--mcp-config")), { mcpServers: {} });
  assert.equal(seen.args.includes("--bare"), false);
  assert.equal(seen.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(existsSync(f.target), false);
  assert.equal(existsSync(seen.cwd), false);
});

for (const mode of ["empty", "fail", "missing", "unsupported"]) test(`one-shot ${mode} keeps its result semantics and cleans up`, async t => {
  const f = await oneShot(t, mode);
  if (mode === "empty") assert.equal(await f.instance.generateText!("A fixture prompt"), "");
  else await assert.rejects(f.instance.generateText!("A fixture prompt"), mode === "fail" ? /Fixture failed/ : mode === "unsupported" ? /Unknown option --safe-mode/ : /ENOENT/);
  await f.waitGone();
  assert.equal(readdirSync(f.records).length, mode === "missing" ? 0 : 1, "a rejected child was retried without isolation");
});

for (const mode of ["hang", "late"]) test(`a timed-out ${mode} child cannot return a summary and its cwd is reaped`, async t => {
  const f = await oneShot(t, mode);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gone = f.ready();
  const pending = f.instance.generateText!("A fixture timeout");
  await gone;
  assert.equal(existsSync(f.info().cwd), true);
  const stopped = f.stopping();
  const rejects = assert.rejects(pending, /within a minute/);
  t.mock.timers.tick(60_000);
  await rejects;
  try {
    assert.equal((await stopped).cwdExists, true, "the cwd was removed before the child closed");
  } finally {
    t.mock.timers.tick(3_000);
    t.mock.timers.reset();
  }
  await f.waitGone();
});

test("concurrent one-shots have separate temporary directories", async t => {
  const f = await oneShot(t, "echo");
  const answers = await Promise.all([
    f.instance.generateText!("First fixture prompt"),
    f.instance.generateText!("Second fixture prompt"),
  ]);
  const calls = readdirSync(f.records).map(name => JSON.parse(readFileSync(join(f.records, name), "utf8")));
  assert.deepEqual(answers, ["First fixture prompt", "Second fixture prompt"]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  assert.equal(calls.some(call => existsSync(call.cwd)), false);
});

for (const mode of ["text", "fail"]) test(`a cleanup error logs once and preserves the ${mode} result`, async t => {
  const f = await oneShot(t, mode);
  const logged = t.mock.method(console, "error", () => {});
  t.mock.method(fs, "rmSync", () => { throw new Error("Fixture cleanup failed"); });
  syncBuiltinESMExports();
  try {
    if (mode === "text") assert.equal(await f.instance.generateText!("A fixture prompt"), "A short fixture summary.");
    else await assert.rejects(f.instance.generateText!("A fixture prompt"), /Fixture failed/);
    assert.equal(logged.mock.calls.length, 1);
    assert.match(String(logged.mock.calls[0].arguments[0]), /could not remove the temporary folder/);
    assert.equal(existsSync(f.info().cwd), true, "the cleanup failure was not exercised");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
