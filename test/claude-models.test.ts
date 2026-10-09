// The Claude model list ships with Bloks, because Claude Code cannot list
// models. So it says so, offers Claude Code's own aliases for the newest
// model in each family, and takes any model id typed in, which has to
// reach the CLI exactly as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";

test("a model id typed in reaches Claude Code exactly, and a malformed one is refused", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-claude-models-"));
  const seen = join(home, "argv.json");
  const cli = join(home, "fake-claude.mjs");
  writeFileSync(
    cli,
    `#!${process.execPath}
import { renameSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (argv.includes("text")) { console.log("ok"); process.exit(0); }
writeFileSync(${JSON.stringify(seen)} + ".tmp", JSON.stringify(argv)); renameSync(${JSON.stringify(seen)} + ".tmp", ${JSON.stringify(seen)});
process.stdin.resume();
((go) => { let line = ""; const take = (c) => { line += c; while (line.includes(String.fromCharCode(10))) { const at = line.indexOf(String.fromCharCode(10)); const next = line.slice(0, at); line = line.slice(at + 1); if (!next.trim() || JSON.parse(next).type !== "user") continue; if (typeof input !== "undefined") input = next; process.stdin.off("data", take); go(); return; } }; process.stdin.on("data", take); })(() => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })));
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  // the list says where it came from, and that any id is taken
  const { instances } = await h.json("/api/instances");
  const claude = instances.find((i: any) => i.instanceId === "claude");
  assert.equal(claude.models.acceptsAnyId, true);
  assert.match(claude.models.note, /not fetched/i);
  for (const alias of ["opus", "sonnet", "haiku"]) {
    assert.ok(claude.models.options.some((o: any) => o.id === alias), `no Latest entry for ${alias}`);
  }

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Newest" }) });
  const bad = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "a model; rm -rf" } }),
  });
  assert.equal(bad.status, 400, "a malformed model id was accepted");

  const wanted = "claude-not-in-the-list-9";
  const ok = await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "claude", model: wanted } }),
  });
  assert.equal(ok.status, 200);
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  const argv = JSON.parse(readFileSync(seen, "utf8")) as string[];
  assert.equal(argv[argv.indexOf("--model") + 1], wanted, "the typed id did not reach --model as written");

  // and the agent keeps it: nothing swapped it for the default
  const { bots } = await h.json("/api/bots");
  assert.equal(bots.find((b: any) => b.id === bot.id).modelSelection.model, wanted);
});
