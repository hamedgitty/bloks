// The persona carries what the person wrote about themselves, and argv is
// readable by every process on the machine through ps. Since agy 1.1.15 a
// turn goes to it as one stream-json line on stdin; an older agy, which has
// no stdin path, still gets --print.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { startHarness } from "./helpers/server.ts";

const PERSONA = "persona_canary_5e1d";
const MESSAGE = "message_canary_83b0";

async function turnOn(t: TestContext, version: string) {
  const home = mkdtempSync(join(tmpdir(), "bloks-agy-stdin-"));
  const seen = join(home, "seen.json");
  const cli = join(home, "fake-agy.mjs");
  // a stand-in for agy that records how it was started and everything it
  // read on stdin, then answers the way agy's stream-json output does
  writeFileSync(
    cli,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args[0] === "models") process.exit(0);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, input }));
  const out = (frame) => console.log(JSON.stringify(frame));
  out({ event: "init", conversation_id: "conv-1", init: {} });
  out({ event: "result", conversation_id: "conv-1", result: { status: "SUCCESS", response: "Done." } });
});
`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(
    join(home, ".bloks", "config.json"),
    JSON.stringify({ instances: { agy: { driver: "antigravity", config: { cli } } }, profile: { about: PERSONA } }),
  );
  const h = await startHarness({ HOME: home });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Gemma" }) });
  await h.fetch(`/api/bots/${bot.id}`, {
    method: "PATCH",
    body: JSON.stringify({ modelSelection: { instanceId: "agy", model: "gemini-3.1-pro-high" } }),
  });
  await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: MESSAGE }) });
  for (let i = 0; i < 200 && !existsSync(seen); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(seen), `the turn never ran: ${h.logs().slice(-800)}`);
  const said = async () => ((await h.json(`/api/bots/${bot.id}/messages?limit=50`)).messages as any[]).some((m) => m.role === "bot" && m.text === "Done.");
  for (let i = 0; i < 200 && !(await said()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(await said(), "the turn's answer never reached the chat");
  return JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; input: string };
}

test("a current agy gets the persona and the message on stdin, never in its arguments", async (t) => {
  const { args, input } = await turnOn(t, "1.3.2");
  for (const secret of [PERSONA, MESSAGE]) {
    assert.ok(!args.some((arg) => arg.includes(secret)), `${secret} is in argv`);
  }
  assert.ok(!args.includes("--print"), "the prompt is still asked for on the command line");
  assert.deepEqual(args.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
  // one line, as agy's headless docs give it, then the end of input
  const lines = input.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.event, "user");
  assert.ok(line.message.content.includes(PERSONA), "the persona did not arrive on stdin");
  assert.ok(line.message.content.endsWith(MESSAGE), "the message did not arrive on stdin");
});

test("an agy too old to read stdin is still handed the prompt with --print", async (t) => {
  const { args, input } = await turnOn(t, "1.1.14");
  assert.equal(args[0], "--print");
  assert.ok(args[1].endsWith(MESSAGE));
  assert.ok(!args.includes("--input-format"));
  assert.equal(input, "");
});
