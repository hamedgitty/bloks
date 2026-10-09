// An ACP compaction before a turn that runs past the limit.
//
// The words then go to a new session, but the /compact goes on in the
// old one on the same process. What it said when it finished was taken
// for the reply, since nothing checked which session an update was
// about, and its usage replaced the new session's reading.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { RuntimeEvent } from "../server/contracts.ts";
import { ACP_SPECS, acpDriver } from "../server/drivers/acp.ts";

const update = (sessionId: string, u: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId, update: u },
});
const said = (sessionId: string, text: string) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

/** A pi-acp that can compact, whose prompts wait for the test to answer
 * them, as a slow /compact does. */
async function setup(t: TestContext) {
  const frames: any[] = [];
  let stdout = new PassThrough();
  t.mock.method(childProcess, "spawn", () => {
    const out = new PassThrough();
    stdout = out;
    const send = (msg: unknown) => out.write(JSON.stringify(msg) + "\n");
    return Object.assign(new EventEmitter(), {
      stdout: out,
      stderr: new PassThrough(),
      pid: undefined,
      kill() {},
      stdin: new Writable({
        write(chunk, _encoding, done) {
          const frame = JSON.parse(String(chunk));
          frames.push(frame);
          if (frame.method && frame.id !== undefined && frame.method !== "session/prompt") {
            queueMicrotask(() => {
              if (frame.method === "initialize") return send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } });
              if (frame.method === "session/new") return send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "new-session" } });
              if (frame.method === "session/load") {
                send(update(frame.params.sessionId, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }));
                return send({ jsonrpc: "2.0", id: frame.id, result: {} });
              }
              send({ jsonrpc: "2.0", id: frame.id, result: {} });
            });
          }
          done();
        },
      }),
    });
  });
  t.mock.method(fs, "appendFileSync", () => {});
  syncBuiltinESMExports();
  const spec = ACP_SPECS.find((s) => s.kind === "pi")!;
  const instance = await acpDriver(spec).create({
    instanceId: "pi", displayName: "Pi", enabled: true, environment: {},
    config: { cli: "fake-pi-acp", fullAuto: false },
  });
  await instance.catalogReady;
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event: RuntimeEvent) => events.push(event));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(async () => {
    await instance.dispose();
    t.mock.timers.reset();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const send = (msg: unknown) => stdout.write(JSON.stringify(msg) + "\n");
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await setImmediate();
  };
  const prompt = (session: string) => frames.find((f) => f.method === "session/prompt" && f.params?.sessionId === session);
  return { instance, frames, events, send, until, prompt };
}

test("a compaction that finishes after the limit is not the new session's reply", async (t) => {
  const h = await setup(t);
  await h.instance.adapter.sendTurn({
    threadId: "lane", text: "do the work", resumeCursor: "old-session", compactFirst: true, handoff: "HANDOFF do the work",
  });
  await h.until(() => Boolean(h.prompt("old-session")));
  assert.equal(h.prompt("old-session")?.params?.prompt?.[0]?.text, "/compact");

  // the limit passes with the compaction still running
  t.mock.timers.tick(10 * 60_000);
  await h.until(() => Boolean(h.prompt("new-session")));
  const asked = h.prompt("new-session");
  assert.ok(asked, "the words never went to a new session");
  assert.equal(asked.params.prompt[0].text, "HANDOFF do the work");
  // the old compaction is asked to stop
  const cancel = h.frames.find((f) => f.method === "session/cancel");
  assert.deepEqual(cancel?.params, { sessionId: "old-session" });

  // the old compaction finishes late, and says so, on the same process
  const switched = h.events.length;
  h.send(said("old-session", "Compacted. Summary of the old conversation."));
  h.send(update("old-session", { sessionUpdate: "usage_update", used: 210_000, size: 258_000 }));
  h.send({ jsonrpc: "2.0", id: h.prompt("old-session").id, result: { stopReason: "end_turn" } });
  // then the new session answers
  h.send(update("new-session", { sessionUpdate: "usage_update", used: 30_000, size: 258_000 }));
  h.send(said("new-session", "finished the real work"));
  h.send({ jsonrpc: "2.0", id: asked.id, result: { stopReason: "end_turn" } });
  await h.until(() => h.events.some((e) => e.type === "turn.completed"));

  const ended = h.events.find((e) => e.type === "turn.completed") as any;
  assert.equal(ended?.ok, true);
  const deltas = h.events.filter((e) => e.type === "content.delta").map((e: any) => e.delta).join("");
  assert.equal(deltas, "finished the real work", "the old compaction's words streamed as the reply");
  const reply = h.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text") as any;
  assert.equal(reply?.text, "finished the real work");
  const readings = h.events.slice(switched).filter((e) => e.type === "context.reading").map((e: any) => e.used);
  assert.deepEqual(readings, [30_000], "the old session's usage was read as the new one's");
});
