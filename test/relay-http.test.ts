// The relay over real HTTP.
//
// spaces.test.ts covers the routing table. This boots the actual process
// and makes the requests a Mac and a phone would, because the interesting
// mistakes at this layer are about roles and status codes rather than
// data structures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = "test-admin-token";

let relay: ChildProcess;
let base: string;
/** Every buzz the relay tried to send, captured by a stand-in APNs. */
const buzzes: Array<{ token: string; reason: string; env?: string }> = [];
let pushStub: ReturnType<typeof import("node:http").createServer>;

before(async () => {
  const { createServer } = await import("node:http");
  pushStub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        buzzes.push(JSON.parse(body));
      } catch {}
      res.writeHead(200).end("{}");
    });
  });
  await new Promise<void>((r) => pushStub.listen(0, "127.0.0.1", () => r()));
  const stubPort = (pushStub.address() as { port: number }).port;

  const port = 9000 + Math.floor(Math.random() * 900);
  base = `http://127.0.0.1:${port}`;
  relay = spawn("node", [join(root, "relay", "index.ts")], {
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_ADMIN_TOKEN: ADMIN,
      RELAY_PUSH_STUB: `http://127.0.0.1:${stubPort}/push`,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
});

after(() => {
  relay?.kill();
  pushStub?.close();
});

const post = (path: string, token: string | null, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const get = (path: string, token: string | null) =>
  fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

async function makeSpace() {
  const res = await post("/spaces", ADMIN, {});
  assert.equal(res.status, 201);
  return (await res.json()) as { spaceId: string; agentToken: string; clientToken: string };
}

test("a space cannot be minted without the admin token", async () => {
  // Otherwise the relay is a free tunnel factory for anyone who finds it.
  assert.equal((await post("/spaces", null, {})).status, 401);
  assert.equal((await post("/spaces", "guessed", {})).status, 401);
});

test("an unknown token gets nowhere", async () => {
  assert.equal((await get("/space/client/status", "nonsense")).status, 401);
  assert.equal((await get("/space/agent/stream", null)).status, 401);
});

test("an agent token cannot read the client stream", async () => {
  // The single most important check here. A stolen Mac credential must not
  // double as a listening device on that Mac's own events.
  const { agentToken } = await makeSpace();
  assert.equal((await get("/space/client/status", agentToken)).status, 403);
  assert.equal((await post("/space/client/ask", agentToken, { payload: "x" })).status, 403);
});

test("a client token cannot pose as the Mac", async () => {
  const { clientToken } = await makeSpace();
  assert.equal((await post("/space/agent/events", clientToken, { frames: [] })).status, 403);
  assert.equal((await post("/space/agent/result", clientToken, { id: "x" })).status, 403);
});

test("asking with no Mac connected says so, rather than hanging", async () => {
  const { clientToken } = await makeSpace();
  const res = await post("/space/client/ask", clientToken, { payload: "cipher" });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not connected/i);
});

test("a full round trip: phone asks, Mac answers, phone gets the ciphertext back", async () => {
  const { agentToken, clientToken } = await makeSpace();

  // The Mac holds its command stream open and answers whatever arrives.
  const stream = await fetch(`${base}/space/agent/stream`, {
    headers: { authorization: `Bearer ${agentToken}` },
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();

  const pump = (async () => {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const frame = JSON.parse(line.slice(5).trim());
        if (frame.kind !== "ask") continue;
        await post("/space/agent/result", agentToken, {
          id: frame.id,
          status: 202,
          // The relay never sees inside this; it is echoed to prove the
          // blob survives the trip unmodified.
          payload: `answered:${frame.payload}`,
        });
      }
    }
  })();

  await new Promise((r) => setTimeout(r, 150));

  const res = await post("/space/client/ask", clientToken, { payload: "SEALED" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: number; payload: string };
  assert.equal(body.status, 202);
  assert.equal(body.payload, "answered:SEALED", "the payload crossed unaltered");

  await reader.cancel().catch(() => {});
  await pump.catch(() => {});
});

test("events reach the phone's stream and never another space's", async () => {
  const mine = await makeSpace();
  const theirs = await makeSpace();

  const stream = await fetch(`${base}/space/client/stream`, {
    headers: { authorization: `Bearer ${mine.clientToken}` },
  });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();

  await new Promise((r) => setTimeout(r, 100));
  await post("/space/agent/events", theirs.agentToken, { frames: ["NOT-FOR-YOU"] });
  await post("/space/agent/events", mine.agentToken, { frames: ["FOR-ME"] });

  const seen: string[] = [];
  const deadline = Date.now() + 2_000;
  let buffer = "";
  while (Date.now() < deadline && !seen.includes("FOR-ME")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const frame = JSON.parse(line.slice(5).trim());
      if (frame.kind === "frame") seen.push(frame.payload);
    }
  }

  assert.ok(seen.includes("FOR-ME"));
  assert.ok(!seen.includes("NOT-FOR-YOU"), "another space's events never arrive");

  await reader.cancel().catch(() => {});
});

test("the wake signal carries no content", async () => {
  // A push cannot describe what happened, because the sender cannot read
  // what happened either. This asserts the shape stays that way.
  const { agentToken } = await makeSpace();
  const res = await post("/space/agent/events", agentToken, {
    frames: ["cipher"],
    wake: "approval",
  });
  const body = (await res.json()) as { wake: string; delivered: number };
  assert.equal(body.wake, "approval");
  assert.equal(
    Object.keys(body).some((k) => k === "text" || k === "body" || k === "preview"),
    false,
    "nothing content-shaped comes back",
  );
});

test("a phone registers for the buzz, and only real wakes buzz it", async () => {
  const space = await makeSpace();

  // only a client may register, and only a real device token counts. The
  // old odd-length and half-length junk is now refused, because a 400
  // token would live forever (only "gone" prunes).
  const realToken = "ab".repeat(32); // 64 hex, an actual token length
  const asAgent = await post("/space/client/apns", space.agentToken, { token: realToken });
  assert.equal(asAgent.status, 403);
  const junk = await post("/space/client/apns", space.clientToken, { token: "not hex!" });
  assert.equal(junk.status, 400);
  const odd = await post("/space/client/apns", space.clientToken, { token: "abc" });
  assert.equal(odd.status, 400, "odd-length junk must be refused");
  const ok = await post("/space/client/apns", space.clientToken, {
    token: realToken,
    env: "sandbox",
  });
  assert.equal(ok.status, 200);

  // the Mac holds its stream open, as it would in life
  const agentStream = await fetch(`${base}/space/agent/stream`, {
    headers: { authorization: `Bearer ${space.agentToken}` },
  });
  assert.equal(agentStream.status, 200);

  // an event with no wake stays silent
  buzzes.length = 0;
  await post("/space/agent/events", space.agentToken, { frames: ["ciphertext"] });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(buzzes.length, 0, "an ordinary frame must not buzz anybody");

  // a wake buzzes the registered token, carrying the environment it was
  // minted in so one relay can serve sandbox and production side by side
  await post("/space/agent/events", space.agentToken, { frames: ["ciphertext"], wake: "needs-you" });
  for (let i = 0; i < 40 && buzzes.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(buzzes.length, 1, "the wake never reached the push path");
  assert.equal(buzzes[0].token, realToken);
  assert.equal(buzzes[0].reason, "needs-you");
  assert.equal(buzzes[0].env, "sandbox", "the token's environment rode along");

  // a wake fires EVEN with a phone streaming: an abruptly-dropped phone
  // looks like a live listener for minutes, and the approval buzz is the
  // one thing that must survive that. The foregrounded phone suppresses
  // its own banner (willPresent), so the double is harmless.
  const controller = new AbortController();
  const clientStream = await fetch(`${base}/space/client/stream`, {
    headers: { authorization: `Bearer ${space.clientToken}` },
    signal: controller.signal,
  });
  assert.equal(clientStream.status, 200);
  void clientStream.body?.getReader().read().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  buzzes.length = 0;
  await post("/space/agent/events", space.agentToken, { frames: ["ciphertext"], wake: "needs-you" });
  for (let i = 0; i < 40 && buzzes.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(buzzes.length, 1, "a wake must buzz even when a phone is nominally streaming");
  controller.abort();
});
