// The next step of a workflow keeps the credential it was given.
//
// When one ask step ended, the next could start in the same lane before
// the ending had finished, and the ending then revoked the credential by
// lane: the new step's agent ran with a dead BLOKS_TOKEN, and every call
// it made back to Bloks was refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startHarness } from "./helpers/server.ts";
import { waitFor } from "./helpers/turns.ts";

test("a workflow's second step can still act with its credential", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-wf-cred-"));
  const out = join(home, "whoami.json");
  const cli = join(home, "fake-claude.mjs");
  // On SECOND-STEP it asks Bloks who it is, with its own credential, and
  // writes down the answer's status; on anything else it just answers.
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let buf = "";
const said = await new Promise((resolve) => {
  process.stdin.on("data", (c) => {
    buf += c;
    for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() && JSON.parse(line).type === "user") resolve(line);
    }
  });
});
if (said.includes("SECOND-STEP")) {
  const res = await fetch(process.env.BLOKS_URL + "/api/agent/whoami", { headers: { authorization: "Bearer " + process.env.BLOKS_TOKEN } });
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: res.status }));
}
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 10, total_cost_usd: 0, result: "Done." }));
setTimeout(() => process.exit(0), 20);
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli } } } }));
  const h = await startHarness({ HOME: home });
  t.after(() => h.stop());
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Stepper" }) });
  await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const { workflow } = await h.json("/api/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Two steps",
      trigger: { kind: "manual" },
      steps: [
        { action: "ask", text: "FIRST-STEP", targetId: bot.id },
        { action: "ask", text: "SECOND-STEP", targetId: bot.id },
      ],
    }),
  });
  await h.fetch(`/api/workflows/${workflow.id}/run`, { method: "POST", body: "{}" });
  assert.ok(await waitFor(() => existsSync(out), 20_000), "the second step never ran");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).status, 200, "the second step's credential was revoked as it started");
});
