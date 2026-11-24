// The terminal panel's event stream is reopened when it fails, including
// when the first answer was not a stream at all, which the browser's own
// EventSource never retries (GitHub 552).
import assert from "node:assert/strict";
import { test } from "node:test";
import { followStream, RETRY_FIRST_MS, RETRY_MAX_MS, type StreamLike } from "../src/lib/followStream.ts";

class FakeStream implements StreamLike {
  onopen: StreamLike["onopen"] = null;
  onmessage: StreamLike["onmessage"] = null;
  onerror: StreamLike["onerror"] = null;
  closed = false;
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
  say(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function harness() {
  const streams: FakeStream[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const said: string[] = [];
  const events: string[] = [];
  const stop = followStream(
    "/api/bots/b1/terminals/stream",
    { opened: () => events.push("opened"), lost: () => events.push("lost"), message: (d) => said.push(d) },
    () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => void (timer.cancelled = true);
    },
  );
  const tick = () => {
    const due = timers.filter((t) => !t.cancelled);
    timers.length = 0;
    for (const t of due) t.run();
    return due.map((t) => t.ms);
  };
  return { streams, timers, said, events, stop, tick };
}

test("a stream refused before it opened is opened again, a little later each time", () => {
  const h = harness();
  assert.equal(h.streams.length, 1);
  h.streams[0]!.fail();
  assert.equal(h.streams[0]!.closed, true, "the refused stream is closed, not left half alive");
  assert.deepEqual(h.events, ["lost"]);
  assert.deepEqual(h.tick(), [RETRY_FIRST_MS]);
  assert.equal(h.streams.length, 2, "a new stream is opened: something really is trying again");
  h.streams[1]!.fail();
  assert.deepEqual(h.tick(), [RETRY_FIRST_MS * 2]);
  for (let i = 0; i < 6; i++) {
    h.streams.at(-1)!.fail();
    h.tick();
  }
  h.streams.at(-1)!.fail();
  assert.deepEqual(h.tick(), [RETRY_MAX_MS], "the wait stops growing at the longest");
});

test("once a stream opens, the next failure waits the shortest time again", () => {
  const h = harness();
  h.streams[0]!.fail();
  h.tick();
  h.streams[1]!.fail();
  h.tick();
  h.streams[2]!.open();
  h.streams[2]!.say('{"list":[]}');
  assert.deepEqual(h.said, ['{"list":[]}']);
  assert.deepEqual(h.events, ["lost", "lost", "opened"]);
  h.streams[2]!.fail();
  assert.deepEqual(h.tick(), [RETRY_FIRST_MS]);
});

test("a stream given up is not heard from, and a stopped follower opens nothing more", () => {
  const h = harness();
  const first = h.streams[0]!;
  first.fail();
  first.say("late");
  assert.deepEqual(h.said, [], "a closed stream's late words are not delivered");
  h.stop();
  assert.equal(h.tick().length, 0, "the pending retry was cancelled");
  assert.equal(h.streams.length, 1);

  const live = harness();
  live.streams[0]!.open();
  live.stop();
  assert.equal(live.streams[0]!.closed, true);
  live.streams[0]!.fail();
  assert.equal(live.timers.length, 0, "an error after stopping schedules nothing");
});

test("a stream that cannot even be made is tried again, not given up on", () => {
  const timers: Array<() => void> = [];
  const events: string[] = [];
  let attempts = 0;
  followStream(
    "/api/bots/b1/terminals/stream",
    { opened: () => events.push("opened"), lost: () => events.push("lost"), message: () => {} },
    () => {
      attempts++;
      if (attempts === 1) throw new Error("no stream right now");
      const s = new FakeStream();
      queueMicrotask(() => s.open());
      return s;
    },
    (run) => {
      timers.push(run);
      return () => {};
    },
  );
  assert.deepEqual(events, ["lost"]);
  assert.equal(timers.length, 1, "a retry is scheduled after the throw");
  timers.shift()!();
  assert.equal(attempts, 2);
});
