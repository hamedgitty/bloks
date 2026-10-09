// A start refused after it had marked its lane (server/index.ts,
// startTurn).
//
// startTurn checks for a hold and an archive twice: once on the way in,
// and again after folding a long conversation, which can take a model
// call. By the second check it has already marked the lane as speaking
// (activeRoom), and the refusal left that mark behind with no turn under
// it. A lane marked as speaking is one idle compaction passes over, so a
// quiet Claude Code conversation that was refused once while getting
// ready lost its compaction, and paid to write its whole cache again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

/** Idle compaction on, and a Claude Code that answers every turn with a
 * big freshly cached prompt, compacts when sent /compact, and fails every
 * fold (`-p`), slowly while `slow-fold` exists. */
function claudeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "bloks-refused-start-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({
      instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } },
      compaction: { idle: true },
    }),
  );
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const home = ${JSON.stringify(home)};
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
// a one-shot call, which is what a fold is; a turn streams json
if (args[args.indexOf("--output-format") + 1] === "text") {
  if (existsSync(home + "/slow-fold")) {
    writeFileSync(home + "/folding", "1");
    await new Promise((r) => setTimeout(r, 4000));
  }
  process.exit(1);
}
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
const said = await new Promise((resolve) => {
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === "user") resolve(String(frame.message?.content ?? ""));
    }
  });
});
appendFileSync(home + "/runs.jsonl", JSON.stringify({ said: said.slice(0, 40) }) + "\\n");
out({ type: "system", subtype: "init", session_id: "sess-refused", model: "claude-sonnet-5" });
if (said === "/compact") {
  out({ type: "system", subtype: "compact_boundary", session_id: "sess-refused", compact_metadata: { trigger: "manual", pre_tokens: 106000, post_tokens: 30000 } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-refused", result: "" });
} else {
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }], usage: { input_tokens: 10, cache_read_input_tokens: 104000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000 }, output_tokens: 40 } } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 100, total_cost_usd: 0, session_id: "sess-refused", result: "Done." });
}
setTimeout(() => process.exit(0), 50);
`,
    { mode: 0o755 },
  );
  return home;
}

test("a start refused after folding leaves its quiet lane free to be compacted", async (t) => {
  const home = claudeHome();
  // An hour's cache is fifteen seconds here, so the compaction window is
  // a little under fourteen seconds after the lane's last request.
  const h = await startHarness({ HOME: home, BLOKS_IDLE_CACHE_MS: "15000" });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runs = () =>
    existsSync(join(home, "runs.jsonl"))
      ? readFileSync(join(home, "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).said as string)
      : [];
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Keeper" }) });
  // a model the table does not know gets a small window, so one long
  // message makes the lane fold before a later turn
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "tiny-model" } }) });
  const busy = async () => (await h.json("/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy;
  for (const text of ["x".repeat(99_000), "two", "three", "four"]) {
    await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    assert.ok(await waitFor(async () => !(await busy()) && runs().length > 0), "a turn setting the lane up never ended");
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const before = runs().length;

  // The next turn folds first, slowly, and the wheel is taken meanwhile,
  // so the second check refuses it.
  writeFileSync(join(home, "slow-fold"), "1");
  const refused = h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: "five" }) });
  assert.ok(await waitFor(() => existsSync(join(home, "folding"))), "the turn did not fold first, so this proves nothing");
  await h.fetch(`/api/bots/${bot.id}/wheel`, { method: "POST", body: JSON.stringify({ why: "checking something" }) });
  assert.equal((await refused).status, 409, "the turn was not refused after its fold");
  rmSync(join(home, "slow-fold"));
  await h.fetch(`/api/bots/${bot.id}/wheel`, { method: "DELETE" });
  assert.equal(runs().length, before, "the refused turn reached the engine");

  const compacted = await waitFor(() => runs().includes("/compact"), 30_000);
  assert.ok(compacted, "the quiet lane was never compacted: the refused start left it marked as speaking");
});
