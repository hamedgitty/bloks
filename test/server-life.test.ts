// The desktop app's server after it has started (electron/server-life.mjs).
//
// A server that died after starting was never started again: the window
// kept calling a port nobody answered on, and one opened from the Dock
// showed "connection refused", until Bloks was quit and opened again.
// And quitting killed it outright, which on Windows runs none of its own
// shutdown: its engines kept running and its lock stayed behind.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { keepServerUp, RESTART_DELAYS, STEADY_MS, stopServer } from "../electron/server-life.mjs";

/** A stand-in for Electron's UtilityProcess: a pid until it exits, a
 * message port, and a kill. `stopsWhenAsked` decides whether a message to
 * stop is heeded. */
class FakeServer extends EventEmitter {
  pid: number | undefined = 4242;
  asked: unknown[] = [];
  killed = 0;
  stopsWhenAsked: boolean;
  constructor(stopsWhenAsked = true) {
    super();
    this.stopsWhenAsked = stopsWhenAsked;
  }
  postMessage(message: unknown) {
    this.asked.push(message);
    if (this.stopsWhenAsked) setImmediate(() => this.die(0));
  }
  kill() {
    this.killed++;
    setImmediate(() => this.die(0));
  }
  die(code = 1) {
    if (this.pid === undefined) return;
    // Electron clears the pid before it says the process exited
    this.pid = undefined;
    this.emit("exit", code);
  }
}

/** A keeper on a clock of its own, whose pauses pass at once. `plan` is
 * whether each try comes up, in order; tries past it come up. */
function keeper(plan: boolean[] = []) {
  let clock = 0;
  let quitting = false;
  const waits: number[] = [];
  const started: FakeServer[] = [];
  const said: string[] = [];
  const k = keepServerUp<FakeServer>({
    quitting: () => quitting,
    start: async () => {
      if (plan.length && !plan.shift()) return null;
      const server = new FakeServer();
      started.push(server);
      return server;
    },
    onBack: (server) => said.push(`back ${started.indexOf(server)}`),
    onGaveUp: () => said.push("gave up"),
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return {
    k,
    waits,
    started,
    said,
    pass: (ms: number) => (clock += ms),
    quit: () => (quitting = true),
    /** Until the keeper has said `count` things, or a while has passed. */
    async heard(count: number) {
      for (let i = 0; i < 200 && said.length < count; i++) await new Promise((r) => setImmediate(r));
      return said;
    },
  };
}

test("a server that dies after starting is started again, and the new one is watched too", async () => {
  const h = keeper();
  const first = new FakeServer();
  h.k.watch(first);
  first.die();
  assert.deepEqual(await h.heard(1), ["back 0"]);
  assert.deepEqual(h.waits, [RESTART_DELAYS[0]]);
  // the one that came back dies as well, soon: the next pause is longer
  h.started[0].die();
  assert.deepEqual(await h.heard(2), ["back 0", "back 1"]);
  assert.deepEqual(h.waits, RESTART_DELAYS.slice(0, 2));
});

test("a server that goes while Bloks quits stays down", async () => {
  const h = keeper();
  const first = new FakeServer();
  h.k.watch(first);
  h.quit();
  first.die(0);
  await h.heard(1);
  assert.deepEqual(h.said, []);
  assert.equal(h.started.length, 0);
  assert.deepEqual(h.waits, []);
});

test("a server that keeps failing to come back is given up on, once, after the last try", async () => {
  const h = keeper(RESTART_DELAYS.map(() => false));
  const first = new FakeServer();
  h.k.watch(first);
  first.die();
  assert.deepEqual(await h.heard(1), ["gave up"]);
  assert.deepEqual(h.waits, RESTART_DELAYS);
  assert.equal(h.started.length, 0);
});

test("a try that does not come up counts, and so does one that comes up and dies", async () => {
  const h = keeper([false, true]);
  const first = new FakeServer();
  h.k.watch(first);
  first.die();
  assert.deepEqual(await h.heard(1), ["back 0"]);
  assert.deepEqual(h.waits, RESTART_DELAYS.slice(0, 2));
  // every try after that comes up and dies at once
  for (let n = 0; n < RESTART_DELAYS.length - 2; n++) {
    h.started.at(-1)!.die();
    await h.heard(n + 2);
  }
  h.started.at(-1)!.die();
  assert.equal((await h.heard(RESTART_DELAYS.length)).at(-1), "gave up");
  assert.deepEqual(h.waits, RESTART_DELAYS);
});

test("a server that ran a good while before it died gets a full set of tries again", async () => {
  const h = keeper();
  const first = new FakeServer();
  h.k.watch(first);
  first.die();
  await h.heard(1);
  h.started[0].die();
  await h.heard(2);
  h.pass(STEADY_MS);
  h.started[1].die();
  await h.heard(3);
  assert.deepEqual(h.waits, [RESTART_DELAYS[0], RESTART_DELAYS[1], RESTART_DELAYS[0]]);
});

test("a server that comes up as Bloks quits is stopped, not adopted", async () => {
  let quitting = false;
  const late = new FakeServer();
  const said: string[] = [];
  const k = keepServerUp<FakeServer>({
    quitting: () => quitting,
    start: async () => {
      quitting = true;
      return late;
    },
    onBack: () => said.push("back"),
    onGaveUp: () => said.push("gave up"),
    wait: async () => {},
  });
  const first = new FakeServer();
  k.watch(first);
  first.die();
  for (let i = 0; i < 50 && late.pid !== undefined; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(late.asked, [{ kind: "stop" }]);
  assert.equal(late.pid, undefined);
  assert.deepEqual(said, []);
});

test("a server is asked to stop first, and one that does is never killed", async () => {
  const server = new FakeServer();
  await stopServer(server, { wait: 5_000 });
  assert.deepEqual(server.asked, [{ kind: "stop" }]);
  assert.equal(server.killed, 0);
  assert.equal(server.pid, undefined);
});

test("a server that does not stop when asked is killed once the wait is over", async () => {
  const server = new FakeServer(false);
  const began = Date.now();
  await stopServer(server, { wait: 50 });
  assert.ok(Date.now() - began >= 40, "it was killed without the wait");
  assert.deepEqual(server.asked, [{ kind: "stop" }]);
  assert.equal(server.killed, 1);
});

test("a server already gone, or never started, is left alone", async () => {
  const gone = new FakeServer();
  gone.die();
  await stopServer(gone);
  assert.deepEqual(gone.asked, []);
  assert.equal(gone.killed, 0);
  await stopServer(null);
});
