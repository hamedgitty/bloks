// The line to Bloks Cloud coming back by itself (GitHub 506).
//
// One workspace's server lost Bloks Cloud for hours: every dial timed out
// connecting, Cloud off and on changed nothing, and a restart of that one
// process brought it straight back, while another workspace on the same
// computer stayed connected all along. What a restart clears is the
// process's own connections to the relay, which the link shared with
// everything else in the process and never let go of. Here those
// connections are made to fail on purpose, and the link has to find its
// way back without one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "bloks-relay-recovery-"));
const SHARED = Symbol.for("undici.globalDispatcher.1");

let RelayLink: typeof import("../server/relay-link.ts").RelayLink;
let ownPool: typeof import("../server/relay-link.ts").ownPool;
let relay: Server;
let url = "";
const streams = new Set<ServerResponse>();
let dials = 0;

type Pool = { close(): Promise<void>; destroy(): Promise<void> };
/** The kind of pool Node's fetch runs on, made to fail every connection
 * the way the reporter's did. */
let Agent: new (options?: unknown) => Pool;
const broken = () =>
  new Agent({
    connect: (_options: unknown, done: (error: Error | null, socket: null) => void) =>
      done(Object.assign(new Error("Connect Timeout Error (attempted address: relay.test:443, timeout: 10000ms)"), { code: "UND_ERR_CONNECT_TIMEOUT" }), null),
  });

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

before(async () => {
  process.env.HOME = home;
  process.env.BLOKS_DATA_DIR = join(home, ".bloks");
  mkdirSync(join(home, ".bloks"), { recursive: true });
  ({ RelayLink, ownPool } = await import("../server/relay-link.ts"));
  // Node makes its shared pool on its first fetch
  await fetch("data:,").then((r) => r.arrayBuffer());
  Agent = (globalThis as unknown as Record<symbol, { constructor: typeof Agent }>)[SHARED].constructor;
  relay = createServer((req, res) => {
    if (req.url === "/space/agent/stream") {
      dials++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "space-506" })}\n\n`);
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
});

after(() => {
  for (const s of streams) s.destroy();
  relay.closeAllConnections();
  relay.close();
  rmSync(home, { recursive: true, force: true });
});

test("this Node gives the link a pool of its own, not the shared one", async () => {
  const pool = await ownPool();
  assert.ok(pool, "no pool of its own: the line would share the process's again");
  assert.notEqual(pool, (globalThis as unknown as Record<symbol, unknown>)[SHARED]);
  await pool.close();
});

test("the link's line does not hang on the rest of the process's connections, and Cloud off and on starts it afresh", async () => {
  const shared = (globalThis as unknown as Record<symbol, unknown>)[SHARED];
  // every connection the process shares now fails, as the reporter's did
  (globalThis as unknown as Record<symbol, unknown>)[SHARED] = broken();
  const link = new RelayLink(1);
  try {
    link.configure({ url, agentToken: "agent-token" });
    const up = await until(() => link.state.connected, 6_000);
    if (!up) {
      // what the reporter tried next
      link.configure(null);
      link.configure({ url, agentToken: "agent-token" });
    }
    assert.ok(up || (await until(() => link.state.connected, 6_000)), `still not connected: ${link.state.problem}`);
    assert.equal(link.state.spaceId, "space-506");
  } finally {
    link.stop();
    (globalThis as unknown as Record<symbol, unknown>)[SHARED] = shared;
  }
});

test("a line whose own connections keep failing is dialled again on new ones, after the same backoff, until it is back", async () => {
  const made: Array<{ broken: boolean; closed: boolean }> = [];
  const link = new RelayLink(1);
  // the first two pools the link makes fail every connection; the third
  // is the fresh start a restart used to be
  link.newPool = async () => {
    const which = { broken: made.length < 2, closed: false };
    made.push(which);
    const pool = which.broken ? broken() : new Agent();
    const close = pool.close.bind(pool);
    pool.close = () => ((which.closed = true), close());
    return pool;
  };
  const before = dials;
  try {
    link.configure({ url, agentToken: "agent-token" });
    const started = Date.now();
    while (!link.state.connected && Date.now() - started < 12_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(link.state.connected, true, `still not connected: ${link.state.problem}`);
    assert.equal(link.state.spaceId, "space-506");
    assert.equal(made.length, 3, "one pool per dial that failed before an answer, and one that worked");
    assert.deepEqual(made.slice(0, 2).map((m) => m.closed), [true, true], "the broken pools are let go");
    // with backoff, not in a storm: the two failed dials took the 2 s
    // and then the longer wait before the third
    assert.ok(Date.now() - started >= 5_000, "retried faster than the backoff allows");
    assert.equal(dials - before, 1, "only the working pool reached the relay");
    // and a line that is up keeps its pool: nothing new is made for an ask
    await link.plan();
    assert.equal(made.length, 3);
  } finally {
    link.stop();
  }
});
