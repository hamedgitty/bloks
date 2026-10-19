// An agent pausing an engine for itself with `bloks pause` (based on
// GitHub 305): only itself, a day at most, never stopping anything, and
// seeing only the pauses that cover it, with nobody else named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

const BLOKS = fileURLToPath(new URL("../bin/bloks.mjs", import.meta.url));

/** A stand-in for Claude Code: told HOLD, it leaves its turn's credential
 * in `token` and keeps the turn open until `release` exists. */
const fakeClaude = (token: string, release: string) => `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const [first] = process.argv.slice(2);
if (first === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (first === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let input = "";
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(async () => {
  if (input.includes("HOLD")) {
    writeFileSync(${JSON.stringify(token)}, process.env.BLOKS_TOKEN ?? "");
    for (let i = 0; i < 1200 && !existsSync(${JSON.stringify(release)}); i++) await new Promise((r) => setTimeout(r, 50));
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." }));
});
`;

test("an agent pauses only itself, for a day at most, and sees only what covers it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-pause-agent-"));
  const token = join(home, "token");
  const release = join(home, "release");
  const cli = join(home, "claude.mjs");
  writeFileSync(cli, fakeClaude(token, release), { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    writeFileSync(release, "");
    await h.stop();
  });
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
    assert.equal(set.status, 200);
    return bot as { id: string; threadId: string };
  };
  const ada = await hire("Ada");
  const ben = await hire("Ben");
  const owners = await (await h.fetch("/api/engine-pauses", { method: "POST", body: JSON.stringify({ what: { family: "google" }, agents: [ben.id], minutes: 60 }) })).json();

  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "HOLD" }) });
  const credential = await waitFor(() => (existsSync(token) ? readFileSync(token, "utf8") : null), 20_000);
  assert.match(credential ?? "", /^blk_/, "the stand-in engine never got a credential");
  const bloks = (...args: string[]) =>
    new Promise<any>((resolve) => {
      execFile(process.execPath, [BLOKS, ...args], { env: { ...process.env, BLOKS_URL: h.url, BLOKS_TOKEN: credential! } }, (_e, stdout) =>
        resolve(JSON.parse(stdout || "{}")),
      );
    });
  const asAda = (method: string, path: string, body?: unknown) =>
    fetch(`${h.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${credential}`, origin: h.url, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  // nobody else, not everyone, not longer than a day, and no stopping
  assert.equal((await asAda("POST", "/api/engine-pauses", { what: { instanceId: "claude" }, agents: [ben.id], minutes: 30 })).status, 403);
  assert.equal((await asAda("POST", "/api/engine-pauses", { what: { instanceId: "claude" }, agents: "all", minutes: 30 })).status, 403);
  assert.equal((await asAda("POST", "/api/engine-pauses", { what: { instanceId: "claude" }, minutes: 30, stopRunning: true })).status, 403);
  assert.match((await bloks("pause", "--for", "25h")).error ?? "", /1m to 24h/);
  assert.equal((await asAda("POST", "/api/engine-pauses", { what: { instanceId: "claude" }, minutes: 25 * 60 })).status, 400);
  // the owner's pause for Ben is not Ada's to see, or to end
  assert.deepEqual(await bloks("pauses"), []);
  assert.equal((await asAda("DELETE", `/api/engine-pauses/${owners.pause.id}`)).status, 404);

  // with nothing named, what it runs on now
  const made = await bloks("pause", "--for", "2h", "--why", "saving the plan");
  assert.ok(made.pause, JSON.stringify(made));
  assert.deepEqual(made.pause.what, { instanceId: "claude", model: "claude-sonnet-5" });
  assert.deepEqual(made.pause.agents, [ada.id]);
  assert.equal(made.stopped, 0, "an agent's pause stopped something");
  const mine = await bloks("pauses");
  assert.deepEqual(mine.map((p: any) => [p.id, p.by, p.note]), [[made.pause.id, "you", "saving the plan"]]);

  // the owner sees who paused itself, and Ben is untouched
  const listed = await h.json("/api/engine-pauses");
  assert.equal(listed.pauses.find((p: any) => p.id === made.pause.id).byName, "Ada");
  const said = await h.json(`/api/bots/${ben.id}/messages`, { method: "POST", body: JSON.stringify({ text: "for Ben" }) });
  assert.equal(said.queued, undefined, "Ada's pause held Ben");

  // she ends her own, and what it held would go
  assert.deepEqual(await bloks("unpause", made.pause.id), { pause: made.pause });
  assert.deepEqual((await h.json("/api/engine-pauses")).pauses.map((p: any) => p.id), [owners.pause.id]);
});
