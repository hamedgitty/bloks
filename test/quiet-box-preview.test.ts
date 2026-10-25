// The real BoxAgent adapter polls whole messages. Exercise the production
// forwarding/replay path, not a token-stream approximation of that adapter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { codexCommands, waitFor } from "./helpers/codex-commands.ts";
import { foldRuntime } from "../src/lib/memberRules.ts";
import { isQuietReply } from "../server/routines.ts";

test("BoxAgent whole-message progress then marker stays absent from live and replayed previews; real final reports survive", async t => {
  const boxes: unknown[] = [];
  const streams: Array<{ abort: AbortController; reading: Promise<void> }> = [];
  let result = "QUIET", release = false, polls = 0;
  const boat = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url!, "http://localhost").pathname;
      let body: unknown = {};
      if (path.endsWith("/sandboxes")) body = { sandboxes: boxes };
      else if (path.endsWith("/prompt")) { polls = 0; body = { promptId: "fixture-prompt" }; }
      else if (path.endsWith("/events")) {
        polls++;
        body = { events: [{ id: "progress", type: "assistant", text: "Checking the task.\n" }, { id: "result", type: "assistant", text: result }] };
      } else if (path.includes("/prompts/")) body = { promptRun: { status: release ? "finished" : "running" }, result };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(r => boat.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const { abort } of streams) abort.abort();
    await Promise.all(streams.map(s => s.reading));
    boat.closeAllConnections(); boat.close();
  });
  const s = await codexCommands(t, {
    NODE_OPTIONS: `--import=${new URL("./helpers/boat-fetch.mjs", import.meta.url).href}`,
    BLOKS_TEST_BOAT_URL: `http://127.0.0.1:${(boat.address() as { port: number }).port}`,
  });
  await s.h.json("/api/config", { method: "PATCH", body: JSON.stringify({ box: { token: "DUMMY" } }) });
  boxes.push({ id: "fixture-box", name: `bloks-${s.bot.id.slice(0, 8)}-${createHash("sha256").update(s.bot.id).digest("hex").slice(0, 6)}`, state: "ready" });
  await s.h.json(`/api/bots/${s.bot.id}`, { method: "PATCH", body: JSON.stringify({ modelSelection: { instanceId: "computer", model: "sonnet" }, computer: "cloud" }) });

  async function stream(path = "/api/events") {
    const frames: any[] = [], abort = new AbortController();
    const response = await s.h.fetch(path, { signal: abort.signal }); assert.ok(response.ok);
    const reading = (async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = "";
      try { for (;;) {
        const next = await reader.read(); if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true }); let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const data = block.split("\n").find(line => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      } } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    streams.push({ abort, reading });
    await waitFor(() => frames.some(f => f.kind === "hello"));
    return frames;
  }

  function assertPreview(frames: any[]) {
    let member: Record<string, string> = {};
    for (const frame of frames) {
      assert.ok(!isQuietReply(frame.event?.delta), "BoxAgent marker escaped production forwarding");
      member = foldRuntime(member, frame);
      assert.ok(!Object.values(member).some(text => /Checking the task\.\nQUIET$/.test(text)), "marker remained in the member preview");
    }
    return member;
  }

  const live = await stream();
  for (const final of ["QUIET", "The task is complete.", "QUIET is an ordinary word in this report."]) {
    result = final; release = false;
    const at = live.length, since = live.at(-1)._seq;
    await s.say("Inspect the neutral fixture");
    await waitFor(() => polls > 0 && live.slice(at).some(f => f.event?.delta === "Checking the task.\n"), "BoxAgent progress never arrived");
    assert.ok(!live.slice(at).some(f => f.event?.type === "turn.completed"), "fixture did not hold completion");
    assertPreview(live.slice(at));
    if (final.startsWith("The task")) await waitFor(() => live.slice(at).some(f => f.event?.delta === final), "ordinary BoxAgent final report did not preview");
    release = true;
    await waitFor(() => live.slice(at).some(f => f.event?.type === "turn.completed"));
    await s.settled();
    assertPreview(live.slice(at));
    const replay = await stream(`/api/events?since=${since}`);
    await waitFor(() => replay.some(f => f.event?.type === "turn.completed"));
    assert.equal(replay[0].resumed, true, "fixture did not exercise replay");
    assertPreview(replay);
    const rows = await s.messages();
    assert.ok(!rows.some(m => m.role === "bot" && isQuietReply(m.text)), "marker was saved");
    if (final !== "QUIET") assert.ok(rows.some(m => m.role === "bot" && m.text === final), "ordinary final report was lost");
  }
});
