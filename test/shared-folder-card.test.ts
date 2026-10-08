// GitHub 153, end to end: two agents share a folder and their turns
// overlap. Each change card claims only what its own engine said it
// edited; the other agent's file is listed apart and Undo leaves it be.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";

test("overlapping turns in one folder each claim their own edits", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-shared-card-"));
  const desk = join(home, "desk");
  mkdirSync(desk, { recursive: true });
  writeFileSync(join(desk, "notes.md"), "notes\n");
  writeFileSync(join(desk, "log.md"), "log\n");
  const flag = join(home, "b-wrote");
  const cli = join(home, "fake-claude.mjs");
  // Ada's turn edits notes.md with the Edit tool and waits until Linus has
  // written log.md, so the two turns are sure to overlap. Linus edits
  // log.md with the Write tool and raises the flag.
  writeFileSync(cli, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
((go) => { let line = ""; const take = (c) => { line += c; if (!line.includes(String.fromCharCode(10))) return; process.stdin.off("data", take); go(); }; process.stdin.on("data", take); })(async () => {
  const text = JSON.parse(input.trim()).message.content;
  const sessionId = value("--resume") ?? value("--session-id");
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" });
  const ada = text.includes("ADA");
  const file = join(${JSON.stringify(desk)}, ada ? "notes.md" : "log.md");
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: ada ? "Edit" : "Write", input: { file_path: file } }] } });
  writeFileSync(file, ada ? "notes, by Ada\\n" : "log, by Linus\\n");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } });
  if (ada) {
    for (let i = 0; i < 200 && !existsSync(${JSON.stringify(flag)}); i++) await new Promise((r) => setTimeout(r, 50));
  } else {
    writeFileSync(${JSON.stringify(flag)}, "1");
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, session_id: sessionId, result: "Done." });
});
`, { mode: 0o755 });
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", config: { cli, permissionMode: "bypassPermissions" } } },
  }));
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const hire = async (name: string) => {
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name }) });
    const set = await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, cwd: desk }),
    });
    assert.equal(set.status, 200, await set.clone().text());
    return bot;
  };
  const ada = await hire("Ada");
  const linus = await hire("Linus");

  const cardOf = async (botId: string) => {
    for (let i = 0; i < 300; i++) {
      const { bots } = await h.json("/api/bots");
      const card = bots.find((b: any) => b.id === botId)?.messages.find((m: any) => m.kind === "changes");
      if (card) return card.changes;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail(`no change card for ${botId}: ${h.logs().slice(-800)}`);
  };

  await h.fetch(`/api/bots/${ada.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ADA: tidy the notes" }) });
  // Linus starts only once Ada's turn is under way
  await new Promise((r) => setTimeout(r, 400));
  await h.fetch(`/api/bots/${linus.id}/messages`, { method: "POST", body: JSON.stringify({ text: "LINUS: write the log" }) });

  const adaCard = await cardOf(ada.id);
  assert.deepEqual(adaCard.files.filter((f: any) => !f.shared).map((f: any) => f.path), ["notes.md"]);
  assert.deepEqual(adaCard.files.filter((f: any) => f.shared).map((f: any) => f.path), ["log.md"]);
  assert.deepEqual(adaCard.shared, { total: 1, alongside: [linus.id] });

  const linusCard = await cardOf(linus.id);
  assert.deepEqual(linusCard.files.filter((f: any) => !f.shared).map((f: any) => f.path), ["log.md"]);

  // Undo on Ada's card puts back her file and nobody else's
  const undo = await h.json(`/api/checkpoints/${adaCard.checkpointId}/revert`, { method: "POST" });
  assert.deepEqual(undo.restored, ["notes.md"]);
  assert.equal(readFileSync(join(desk, "notes.md"), "utf8"), "notes\n");
  assert.equal(readFileSync(join(desk, "log.md"), "utf8"), "log, by Linus\n");
  assert.ok(existsSync(flag));
});
