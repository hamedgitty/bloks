// Exercise the real harness and Codex driver across the workplace boundary.
// A stand-in app-server applies the thread's shell policy before running
// the actual Bloks CLI, so the process environment cannot hide stale paths.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakePlaces } from "./helpers/fake-places.ts";
import { startHarness } from "./helpers/server.ts";
import { idle, waitFor } from "./helpers/turns.ts";

for (const kind of ["ssh", "docker", "offline"] as const) {
  test(`Codex shell commands use the ${kind} workplace on new and resumed turns`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bloks-codex-place-"));
    const log = join(root, "shells.jsonl");
    const fake = fakePlaces(root, join(root, "unused.json"));
    const cli = join(fake.there, "codex");
    writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs"), cp = require("node:child_process");
if (process.argv[2] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }
if (process.argv[2] === "login") { console.log("Logged in using ChatGPT"); process.exit(0); }
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let config = {}, method, thread;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const reply = (result = {}) => out({ id: m.id, result });
  if (m.method === "model/list") return reply({ data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Test", isDefault: true }] });
  if (m.method === "config/read") return reply({ config: { shell_environment_policy: { inherit: "core", include_only: ["PATH", "HOME"] } } });
  if (m.method === "thread/start" || m.method === "thread/resume") {
    config = m.params.config; method = m.method; thread = m.params.threadId ?? "remote-thread";
    return reply({ thread: { id: thread }, model: "gpt-6.1-sol" });
  }
  if (m.method !== "turn/start") return reply();
  const set = Object.fromEntries(Object.entries(config).filter(([k]) => k.startsWith("shell_environment_policy.set.")).map(([k, v]) => [k.slice("shell_environment_policy.set.".length), String(v)]));
  const included = config["shell_environment_policy.include_only"];
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, ...set }).filter(([k]) => included.includes(k)));
  // fakePlaces runs on this host, where Docker's built-in DNS is absent.
  const shellEnv = { ...env, BLOKS_URL: env.BLOKS_URL.replace("host.docker.internal", "127.0.0.1") };
  const shell = cp.spawnSync(process.execPath, [env.BLOKS_CLI, "whoami"], { env: shellEnv, encoding: "utf8", timeout: 10000 });
  let answer; try { answer = JSON.parse(shell.stdout); } catch {}
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, cli: env.BLOKS_CLI, urlMatches: env.BLOKS_URL === process.env.BLOKS_URL, cliThere: fs.existsSync(env.BLOKS_CLI), status: shell.status, where: answer?.where, tokenMatches: env.BLOKS_TOKEN === process.env.BLOKS_TOKEN, localSecret: env.FAKE_LOCAL_SECRET ?? null }) + "\\n");
  reply({ turn: { id: "turn" } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: "turn", status: "completed" } } });
});
`, { mode: 0o755 });
    mkdirSync(join(root, ".bloks"), { recursive: true });
    writeFileSync(join(root, ".bloks", "config.json"), JSON.stringify({ instances: { codex: { driver: "codex", config: { cli } } } }));
    const h = await startHarness({ HOME: root, ...fake.env, FAKE_LOCAL_SECRET: "host-only" });
    t.after(async () => {
      await h.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const project = join(root, "project");
    mkdirSync(project);
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Scout" }) });
    await h.json(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd: project, modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } }) });
    const workplace = kind === "ssh"
      ? { kind: "ssh", host: "test-box", path: project, command: cli }
      : { kind: "docker", source: "image", image: "node:22-bookworm", name: "test-codex", folder: "mount", path: project, network: kind !== "offline", command: cli };
    const saved = await h.fetch(`/api/bots/${bot.id}/workplace`, { method: "PUT", body: JSON.stringify({ workplace }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const results = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    for (let i = 0; i < 2; i++) {
      await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "Check your own identity." }) });
      assert.ok(await waitFor(() => results().length > i, 30_000), h.logs().slice(-2000));
      const result = results()[i];
      assert.equal(result.method, i === 0 ? "thread/start" : "thread/resume");
      assert.equal(result.cliThere, true, "the shell received a host path instead of the staged CLI");
      assert.ok(result.cli.startsWith(fake.home + "/"));
      assert.equal(result.urlMatches, true, "the shell overrode the workplace gate address");
      assert.equal(result.status, 0, "the CLI could not reach its authenticated workplace gate");
      assert.equal(result.where.kind, kind === "ssh" ? "ssh" : "docker");
      assert.equal(result.tokenMatches, true);
      assert.equal(result.localSecret, null);
      assert.ok(await idle(h, bot));
    }
    assert.notEqual(results()[0].cli, results()[1].cli, "a resumed turn kept the retired CLI path");
    const argv = [...fake.dockerCalls(), ...fake.sshCalls()].flat().join("\n");
    assert.doesNotMatch(argv, /blk_|blg_|host-only/);
  });
}
