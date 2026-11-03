// Send now in a room (GitHub 475).
//
// It used to stop the speaking member, and the round went straight on to
// the next one, so the turn was lost and the words still waited for the
// whole round. Now it stops nobody: the words go into the speaking
// member's turn when its engine takes words mid-turn, and otherwise in
// as that turn ends, before the next member speaks. Everyone who speaks
// after hears them, the words' own turn wakes only those who have not,
// and they go into the room once.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, waitFor } from "./helpers/turns.ts";

const roomMessages = async (h: Harness, roomId: string) =>
  (await h.json(`/api/bloks/${roomId}/messages?limit=200`)).messages as any[];

/** Two members on a provider that answers on cue, which cannot take words
 * mid-turn. Ada speaks first, Ben (more senior) last. */
async function room(t: { after: (fn: () => unknown) => void }, home?: string) {
  const fake = await fakeProvider(t);
  const h = await startHarness(home ? { HOME: home } : {});
  t.after(() => h.stop());
  const ada = await agentOn(h, fake.port, "Ada");
  const ben = await agentOn(h, fake.port, "Ben");
  await h.fetch(`/api/bots/${ben.id}`, { method: "PATCH", body: JSON.stringify({ seniority: 3 }) });
  const { blok } = await h.json("/api/bloks", { method: "POST", body: JSON.stringify({ name: "Plans", memberIds: [ada.id, ben.id] }) });
  const calls = (name: string, marker: string) => fake.state.calls.filter((c) => c.includes(`You are ${name}`) && c.includes(marker));
  const callAt = (name: string, marker: string) => fake.state.calls.findIndex((c) => c.includes(`You are ${name}`) && c.includes(marker));
  return { fake, h, ada, ben, blok, calls, callAt };
}

test("Send now in a room stops nobody: the words go in before the next member speaks", async (t) => {
  const { fake, h, ada, ben, blok, calls, callAt } = await room(t);

  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ROOM-ROUND plan the launch" }) });
  assert.ok(await waitFor(() => callAt("Ada", "ROOM-ROUND") >= 0), "Ada never spoke");
  const waited = await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "NOW-WORDS keep it under budget" }) });
  assert.equal(waited.status, 202, "the words did not wait behind the round");

  const now = await h.json(`/api/bloks/${blok.id}/queued/now`, { method: "POST" });
  assert.equal(now.outcome, "next");
  let list = await roomMessages(h, blok.id);
  const words = () => list.find((m) => m.text === "NOW-WORDS keep it under budget");
  assert.equal(words()?.queued, true, "the words went in while Ada was still speaking");
  assert.equal(words()?.delivery?.line, "Goes in when Ada finishes");
  // Ada was not stopped: her turn is still waiting for its answer
  assert.equal(fake.state.held.length, 1);

  // a second tap while they wait hands nothing in twice
  assert.equal((await h.json(`/api/bloks/${blok.id}/queued/now`, { method: "POST" })).outcome, "next");

  fake.state.held.shift()!();
  assert.ok(await waitFor(() => callAt("Ben", "ROOM-ROUND") >= 0), "Ben never spoke");
  const told = calls("Ben", "ROOM-ROUND")[0];
  assert.match(told, /Said in the room just now/);
  assert.match(told, /NOW-WORDS keep it under budget/);
  list = await roomMessages(h, blok.id);
  assert.equal(words()?.queued, false);
  // in the history after what Ada said, ahead of Ben
  const round = (all: any[]) => all.slice(all.findIndex((m) => m.text?.startsWith("ROOM-ROUND"))).filter((m) => m.kind === "text");
  const order = round(list).map((m) => (m.role === "user" ? m.text.split(" ")[0] : m.from === ada.id ? "Ada" : m.from === ben.id ? "Ben" : "?"));
  assert.deepEqual(order, ["ROOM-ROUND", "Ada", "NOW-WORDS"]);

  // the words' own turn: Ada, who had not heard them, and not Ben again
  fake.state.answerAtOnce = true;
  fake.state.held.splice(0).forEach((finish) => finish());
  assert.ok(await waitFor(() => calls("Ada", "NOW-WORDS").length > 0), "Ada never heard the words");
  assert.ok(await idle(h, ada));
  assert.ok(await idle(h, ben));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(calls("Ben", "NOW-WORDS").length, 1, "Ben was asked about the words twice");
  assert.equal(calls("Ada", "NOW-WORDS").length, 1);
  list = await roomMessages(h, blok.id);
  assert.equal(list.filter((m) => m.text === "NOW-WORDS keep it under budget").length, 1);
  assert.equal(round(list).filter((m) => m.role === "bot").length, 3, "a member's turn was lost");
});

test("Send now in a room hands the words to a speaking member whose engine takes them mid-turn", async (t) => {
  // Ada runs on a stand-in Claude Code, which takes words mid-turn, and
  // keeps everything it heard in heard-<n>
  const home = mkdtempSync(join(tmpdir(), "bloks-room-now-"));
  mkdirSync(join(home, ".bloks"), { recursive: true });
  writeFileSync(join(home, ".bloks", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", config: { cli: join(home, "fake-claude.mjs") } } } }));
  writeFileSync(
    join(home, "fake-claude.mjs"),
    `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.299 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const home = ${JSON.stringify(home)};
const n = (existsSync(home + "/spawns") ? Number(readFileSync(home + "/spawns", "utf8")) : 0) + 1;
writeFileSync(home + "/spawns", String(n));
const out = (frame) => console.log(JSON.stringify(frame));
let buf = "";
let first = null;
process.stdin.on("data", (c) => {
  buf += c;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "user") continue;
    appendFileSync(home + "/heard-" + n, String(frame.message?.content ?? "") + "\\n");
    first?.();
  }
});
await new Promise((r) => { first = r; });
out({ type: "system", subtype: "init", session_id: "sess-room", model: "claude-sonnet-5" });
out({ type: "assistant", message: { content: [{ type: "text", text: "Working on it" }] } });
while (!existsSync(home + "/finish-" + n)) await new Promise((r) => setTimeout(r, 50));
out({ type: "result", subtype: "success", is_error: false, num_turns: 1, duration_api_ms: 1, total_cost_usd: 0, session_id: "sess-room", result: "Done" });
`,
    { mode: 0o755 },
  );
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { fake, h, ada, ben, blok, calls } = await room(t, home);
  await h.fetch(`/api/bots/${ada.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }) });
  const heard = (n: number) => (existsSync(join(home, `heard-${n}`)) ? readFileSync(join(home, `heard-${n}`), "utf8") : "");
  const spawns = () => (existsSync(join(home, "spawns")) ? Number(readFileSync(join(home, "spawns"), "utf8")) : 0);

  await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "ROOM-ROUND plan the launch" }) });
  assert.ok(await waitFor(() => heard(1).includes("ROOM-ROUND")), "Ada never spoke");
  assert.equal((await h.fetch(`/api/bloks/${blok.id}/messages`, { method: "POST", body: JSON.stringify({ text: "NOW-WORDS keep it under budget" }) })).status, 202);

  const now = await h.json(`/api/bloks/${blok.id}/queued/now`, { method: "POST" });
  assert.equal(now.outcome, "steered");
  assert.ok(await waitFor(() => heard(1).includes("NOW-WORDS keep it under budget")), "Ada's turn never heard the words");
  assert.match(heard(1), /Said in the room just now/);
  const list = await roomMessages(h, blok.id);
  assert.equal(list.find((m) => m.text === "NOW-WORDS keep it under budget")?.queued, false, "the words still waited after Ada took them");

  // Ada finishes; Ben hears the words as new, and nobody is woken again
  fake.state.answerAtOnce = true;
  writeFileSync(join(home, "finish-1"), "1");
  assert.ok(await waitFor(() => calls("Ben", "ROOM-ROUND").length > 0), "Ben never spoke");
  assert.match(calls("Ben", "ROOM-ROUND")[0], /NOW-WORDS keep it under budget/);
  assert.ok(await idle(h, ben));
  assert.ok(await idle(h, ada));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(spawns(), 1, "Ada was asked about words her turn already took");
  assert.equal(calls("Ben", "NOW-WORDS").length, 1);
});

test("Send now in a room is the owner's, and says when nothing waits", async (t) => {
  const { h, blok } = await room(t);
  assert.equal((await h.json(`/api/bloks/${blok.id}/queued/now`, { method: "POST" })).outcome, "nothing");
  assert.equal((await h.fetch("/api/bloks/no-such-room/queued/now", { method: "POST" })).status, 404);
  // from the network without pairing, it is refused like every owner route
  const remote = await h.fetchRemote(`/api/bloks/${blok.id}/queued/now`, { method: "POST", body: "{}" });
  assert.ok(remote.status === 401 || remote.status === 403, `a stranger reached Send now: ${remote.status}`);
});
