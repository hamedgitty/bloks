// The first load of the agent list is asked again until it comes.
//
// It was asked once. A server that answered the event stream but failed
// that one request left the app on "Loading your agents" for good, since
// a stream that stays up never reloads anything.
import { test } from "node:test";
import assert from "node:assert/strict";

import { keepTrying, RETRY_WAITS } from "../src/lib/retry.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a failed load is tried again, waiting longer each time, until it comes", async () => {
  const waits: number[] = [];
  let calls = 0;
  keepTrying(
    async () => {
      calls++;
      if (calls < 4) throw new Error("not yet");
    },
    (run, ms) => {
      waits.push(ms);
      setImmediate(run);
    },
  );
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(calls, 4);
  assert.deepEqual(waits, RETRY_WAITS.slice(0, 3));
});

test("the wait stops growing at the last step", async () => {
  const waits: number[] = [];
  let calls = 0;
  const stop = keepTrying(
    async () => {
      if (++calls < 9) throw new Error("not yet");
    },
    (run, ms) => {
      waits.push(ms);
      setImmediate(run);
    },
  );
  for (let i = 0; i < 30; i++) await settle();
  stop();
  assert.equal(calls, 9);
  assert.deepEqual(waits.slice(-3), [15_000, 15_000, 15_000]);
});

test("stopping it cancels the next try", async () => {
  const pending: Array<() => void> = [];
  const cancelled: unknown[] = [];
  let calls = 0;
  const stop = keepTrying(
    async () => {
      calls++;
      throw new Error("down");
    },
    (run) => (pending.push(run), "timer"),
    (timer) => cancelled.push(timer),
  );
  await settle();
  assert.equal(pending.length, 1);
  stop();
  assert.deepEqual(cancelled, ["timer"]);
  assert.equal(calls, 1);
});
