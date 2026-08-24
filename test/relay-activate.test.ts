// Turning Cloud on, from the Mac that pays for it.
//
// The Mac is the customer here: it holds the licence, it owns the space,
// and a phone only ever pairs into one that already exists. So activation
// is a single exchange with the relay, and what is worth asserting is
// mostly what happens when that exchange goes wrong. A mistyped key must
// cost nothing, a declined card must come back in billing's own words
// rather than as "something went wrong", and the key itself must never
// turn up in a log where a screenshot or a bug report would carry it.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { startHarness, type Harness } from "./helpers/server.ts";

/** The right shape and no value at all: the relay in this file is ours,
 * and bloks.dev has never heard of this one. */
const KEY = `blok_live_${"a1b2c3d4".repeat(4)}`;

/** A relay just real enough to mint a space, refuse one, or hold the
 * line the Mac dials afterwards. */
function stubRelay() {
  const seen: Array<{ method: string; path: string; auth: string | null }> = [];
  let reply: { status: number; body: unknown } = {
    status: 201,
    body: { spaceId: "space-cloud", agentToken: "agent-token", clientToken: "client-token" },
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    seen.push({ method: req.method ?? "", path, auth: req.headers.authorization ?? null });
    if (path === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", spaceId: "space-cloud" })}\n\n`);
      return;
    }
    // drained rather than read: nothing here cares about the body, and an
    // unread request keeps the socket half open
    req.resume();
    req.on("end", () => {
      if (path === "/spaces") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(reply.body));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  return {
    server,
    answerSpacesWith(status: number, body: unknown) {
      reply = { status, body };
    },
    get spaceCalls() {
      return seen.filter((s) => s.path === "/spaces");
    },
  };
}

let h: Harness;
let relay: ReturnType<typeof stubRelay>;
let relayUrl = "";

before(async () => {
  relay = stubRelay();
  await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
  relayUrl = `http://127.0.0.1:${(relay.server.address() as { port: number }).port}`;
  // BLOKS_RELAY_URL stands in for bloks.dev, so an activation in a test
  // reaches our own process and never the real relay
  h = await startHarness({ BLOKS_RELAY_URL: relayUrl });
  // pairing is the master switch for every remote path, and the relay
  // link will not dial without it
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
});

after(async () => {
  relay?.server.close();
  await h?.stop();
});

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 10_000): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await check();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const activate = (key: unknown) =>
  h.fetch("/api/relay/activate", { method: "POST", body: JSON.stringify({ key }) });

describe("activating Cloud", () => {
  test("a key that is not a key is refused before the relay is dialled", async () => {
    const dialled = relay.spaceCalls.length;
    const wrong = [
      "",
      "   ",
      "blok_live_",
      `blok_test_${"a1b2c3d4".repeat(4)}`,
      `blok_live_${"A1B2C3D4".repeat(4)}`, // hex, but upper case
      `blok_live_${"a".repeat(31)}`,
      `blok_live_${"a".repeat(33)}`,
      `blok_live_${"z".repeat(32)}`, // 32 characters, not 32 of hex
      `${KEY} `.repeat(2).trim(), // two keys in one field
      `x${KEY}`,
      42,
      null,
      { key: KEY },
    ];
    for (const key of wrong) {
      const res = await activate(key);
      assert.equal(res.status, 400, `${JSON.stringify(key)} should be refused`);
    }
    // and the missing field, which is what an empty form posts
    assert.equal((await h.fetch("/api/relay/activate", { method: "POST", body: "{}" })).status, 400);

    assert.equal(
      relay.spaceCalls.length,
      dialled,
      "a key that could not possibly work was still sent to the relay",
    );
  });

  test("a card that failed is quoted back in billing's own words", async () => {
    const declined = "Your card was declined on 3 August. Update it at bloks.dev/account.";
    relay.answerSpacesWith(402, { error: declined });

    const res = await activate(KEY);
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, declined, "the person was told nothing they can act on");

    // the key travels as a bearer credential and nowhere else: not in the
    // path, not in a query string, not in the body
    const call = relay.spaceCalls.at(-1)!;
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/spaces");
    assert.equal(call.auth, `Bearer ${KEY}`);

    // nothing is saved on the strength of a refusal
    const status = await h.json("/api/relay/status");
    assert.equal(status.enabled, false);
    assert.equal(status.connected, false);
  });

  test("a relay that quotes the request back does not get to leak the key", async () => {
    relay.answerSpacesWith(500, { error: `no space minted for ${KEY}` });
    const res = await activate(KEY);
    assert.equal(res.status, 502);
    const { error } = await res.json();
    assert.ok(!error.includes(KEY), "the key came back in an error message");
    assert.match(error, /\[redacted\]/);
  });

  test("a minted space is saved, and the line comes up", async () => {
    relay.answerSpacesWith(201, {
      spaceId: "space-cloud",
      agentToken: "agent-token",
      clientToken: "client-token",
    });

    // surrounding whitespace is what a paste from an email looks like
    const res = await activate(`  ${KEY}  `);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.spaceId, "space-cloud");
    assert.equal(body.url, relayUrl);

    const file = readFileSync(join(h.home, ".bloks", "config.json"), "utf8");
    assert.deepEqual(JSON.parse(file).relay, {
      url: relayUrl,
      agentToken: "agent-token",
      clientToken: "client-token",
      enabled: true,
    });
    // the licence is spent, not kept: the two space tokens are all this
    // Mac needs again, so nothing has to hold the thing that buys more
    assert.ok(!file.includes("blok_live_"), "the licence key was written to the config file");

    // and the link actually dials, which is the difference between
    // activated and merely saved
    const up = await waitFor(async () => {
      const state = await h.json("/api/relay/status");
      return state.connected ? state : null;
    });
    assert.ok(up, "the relay link never came up after activation");
    assert.equal(up.spaceId, "space-cloud");
    assert.equal(up.enabled, true);
  });

  test("the key never appears in a log line", async () => {
    const logs = h.logs();
    assert.ok(!logs.includes(KEY), "the licence key was printed");
    // even a fragment: a redacted line keeps neither half
    assert.ok(!logs.includes("blok_live_"), "something printed the shape of a licence key");
    assert.ok(!logs.includes("a1b2c3d4"), "something printed the body of a licence key");
  });

  test("only this machine may activate Cloud", async () => {
    const res = await h.fetchAs("https://evil.example", "/api/relay/activate", {
      method: "POST",
      body: JSON.stringify({ key: KEY }),
    });
    assert.equal(res.status, 403);
    assert.equal((await h.fetchAs("https://evil.example", "/api/relay/status")).status, 403);
  });
});
