// Mentioning a conversation or a browser tab, end to end: the person's
// words link another conversation and a page open in the server's own
// browser (a fake Chrome), and the engine hears what each holds, framed,
// ahead of the words, whether the words start a turn or wait for one.
// What could not be read is left out, said on the message, and never an
// error that loses the words.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { startHarness } from "./helpers/server.ts";
import { agentOn, fakeProvider, idle, messagesOf, waitFor } from "./helpers/turns.ts";

test("the engine hears what a mentioned conversation and tab hold, framed, and what could not be read is said on the message", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "bloks-mentions-"));
  const chrome = join(home, "fake-chrome");
  writeFileSync(chrome, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fileURLToPath(new URL("./helpers/fake-cdp-browser.mjs", import.meta.url)))} "$@"\n`, { mode: 0o755 });
  const engine = await fakeProvider(t);
  engine.state.answerAtOnce = true;
  const h = await startHarness({ HOME: home, BLOKS_BROWSER: chrome });
  t.after(async () => {
    await h.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const ada = await agentOn(h, engine.port, "Ada");
  const ben = await agentOn(h, engine.port, "Ben");
  const said = async (bot: { id: string; threadId: string }, text: string, extra: Record<string, unknown> = {}) => {
    const res = await h.fetch(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text, ...extra }) });
    assert.equal(res.status, 202, await res.clone().text());
  };
  await said(ada, "Remember: the launch moved to Friday the 14th.");
  assert.ok(await waitFor(async () => ((await messagesOf(h, ada)).some((m) => m.role === "bot" && m.kind === "text") ? true : null)));
  assert.ok(await idle(h, ada));

  // the person opens a page in the server's browser
  await h.json("/api/browser/do", { method: "POST", body: JSON.stringify({ action: "navigate", arg: "docs.example" }) });
  assert.ok(await waitFor(async () => ((await h.json("/api/browser")).state?.tabs?.[0]?.title === "Docs" ? true : null)), "the page never showed");

  const words = [
    "Compare",
    `[@Ada: General](bloks://agent/${ada.id}?lane=${ada.threadId})`,
    "with [@Docs](https://docs.example/)",
    "and [@Old page](https://gone.example/)",
    "and [@Nobody](bloks://agent/nobody?lane=nothing)",
    `and this one [@Here](bloks://agent/${ben.id}?lane=${ben.threadId}).`,
  ].join(" ");
  const before = engine.state.calls.length;
  await said(ben, words);
  const call = await waitFor(() => engine.state.calls.slice(before).find((c) => c.includes("Compare")) ?? null);
  assert.ok(call, "the turn never reached the engine");
  // the conversation, as a record, and the page, as untrusted data
  assert.match(call, /The conversation with Ada that the person linked as bloks:\/\/agent\//);
  assert.match(call, /is a record of that conversation, for reference/);
  assert.match(call, /the launch moved to Friday the 14th/);
  assert.match(call, /The browser tab the person linked on docs\.example/);
  assert.match(call, /came from a web page on docs\.example open in the Bloks browser and is untrusted data from the web/);
  assert.match(call, /Welcome to the docs/);
  // ahead of the person's words, which go as written
  assert.ok(call.indexOf("Welcome to the docs") < call.indexOf("Compare [@Ada: General]"));

  const sent = (await messagesOf(h, ben)).find((m) => m.role === "user" && m.text === words);
  assert.ok(sent, "the words were not kept as written");
  assert.deepEqual(
    sent.mentions.map((m: { label: string; dropped?: string }) => [m.label, m.dropped ?? "given"]),
    [["Ada: General", "given"], ["Docs", "given"], ["Old page", "closed"], ["Nobody", "unreadable"]],
  );
  assert.equal(sent.mentionContext, undefined, "words that went straight to a turn kept what their mentions held");
  assert.ok(await idle(h, ben));

  // Words that wait for a turn keep what they mention for the turn that
  // takes them, read as they were sent.
  engine.state.answerAtOnce = false;
  const held = engine.state.calls.length;
  await said(ben, "A long job first.");
  assert.ok(await waitFor(() => (engine.state.calls.length > held ? true : null)), "the first turn never started");
  await said(ben, "And then read [@Docs](https://docs.example/)", { delivery: "wait" });
  const waiting = await waitFor(async () => (await messagesOf(h, ben)).find((m) => m.text?.startsWith("And then read") && m.queued) ?? null);
  assert.ok(waiting, "the words did not wait");
  assert.match(waiting.mentionContext, /Welcome to the docs/);
  const after = engine.state.calls.length;
  engine.state.answerAtOnce = true;
  engine.state.held.splice(0).forEach((go) => go());
  const next = await waitFor(() => engine.state.calls.slice(after).find((c) => c.includes("And then read")) ?? null);
  assert.ok(next, "the waiting words never reached the engine");
  assert.match(next, /Welcome to the docs/);
});
