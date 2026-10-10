// The Mac's outbound line, against a stand-in relay.
//
// The real relay is a separate service; what matters here is the contract
// between them and, more importantly, that a phone arriving down this line
// gets exactly what a phone on the network gets. Not the local surface.
// Everything drives the real harness process through its own API, the way
// the app would: the test plays the relay on one side and the phone's
// crypto on the other.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, describe, test } from "node:test";

import { deviceKey, open, peek, seal } from "../server/relay-crypto.ts";
import { SeenNonces } from "../server/relay-link.ts";
import { startHarness, type Harness } from "./helpers/server.ts";

/** A relay just real enough: it holds the agent stream, hands over asks,
 * and keeps whatever comes back. */
function stubRelay() {
  let send: ((frame: unknown) => void) | null = null;
  const results = new Map<string, { status: number; payload: string }>();
  /** How the next result posts go wrong, one per post: a status to answer
   * with, or "drop" to cut the socket. Empty means they land. */
  const resultFaults: Array<number | "drop"> = [];
  const resultAttempts = new Map<string, number>();
  const pushed: Array<{ frames: string[]; wake: string | { reason: string; sealed?: Record<string, string> } | null }> = [];
  /** How long each push is held before it is answered, and how many were
   * open at once at most. */
  const events = { delayMs: 0, open: 0, mostOpen: 0 };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/space/agent/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      send = (frame) => res.write(`data: ${JSON.stringify(frame)}\n\n`);
      send({ kind: "hello", spaceId: "space-test" });
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      if (path === "/space/agent/result") {
        const id = String(parsed.id);
        resultAttempts.set(id, (resultAttempts.get(id) ?? 0) + 1);
        const fault = resultFaults.shift();
        if (fault === "drop") return void req.socket.destroy();
        if (fault) {
          res.writeHead(fault, { "content-type": "application/json" });
          return void res.end("{}");
        }
        results.set(id, { status: Number(parsed.status), payload: String(parsed.payload) });
      }
      if (path === "/space/agent/events") {
        pushed.push({ frames: parsed.frames ?? [], wake: parsed.wake ?? null });
        if (events.delayMs) {
          events.open++;
          events.mostOpen = Math.max(events.mostOpen, events.open);
          return void setTimeout(() => {
            events.open--;
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          }, events.delayMs);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  return {
    server,
    ask: (id: string, payload: string) => send?.({ kind: "ask", id, payload }),
    results,
    resultFaults,
    resultAttempts,
    pushed,
    events,
    get connected() {
      return send !== null;
    },
  };
}

let h: Harness;
let relay: ReturnType<typeof stubRelay>;
let sealKey: Buffer;
let openKey: Buffer;
let deviceId = "";

before(async () => {
  h = await startHarness();

  // pair a device the honest way, so the Mac holds a real digest and the
  // test holds the token only a phone would have
  await h.fetch("/api/pair", { method: "PUT", body: JSON.stringify({ enabled: true }) });
  const started = await h.json("/api/pair/start", { method: "POST" });
  const claimed = await h.json("/api/pair/claim", {
    method: "POST",
    body: JSON.stringify({ code: started.code, device: "A phone" }),
  });
  deviceId = claimed.device.id;
  const digest = createHash("sha256").update(claimed.token as string).digest("hex");
  sealKey = deviceKey(digest, "phone-to-mac");
  openKey = deviceKey(digest, "mac-to-phone");

  // stand the relay up and point the harness at it through its own API,
  // exactly as the settings screen would
  relay = stubRelay();
  await new Promise<void>((r) => relay.server.listen(0, "127.0.0.1", () => r()));
  const port = (relay.server.address() as { port: number }).port;
  const set = await h.fetch("/api/relay", {
    method: "PUT",
    body: JSON.stringify({ url: `http://127.0.0.1:${port}`, agentToken: "agent-token", enabled: true }),
  });
  assert.equal(set.status, 200);
});

after(async () => {
  relay?.server.close();
  await h?.stop();
});

async function waitUntil<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = check();
    if (value) return value as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  return undefined;
}

describe("the relay link", () => {
  test("the Mac dials out and holds the line", async () => {
    await waitUntil(() => relay.connected);
    assert.ok(relay.connected, "the harness never dialled the relay");
    const state = await waitUntil(async () => {
      const s = await h.json("/api/relay");
      return s.connected ? s : undefined;
    });
    assert.equal((await state)?.spaceId ?? (state as any)?.spaceId, "space-test");
  });

  test("a phone's sealed request is served, and local-only routes stay local-only", async () => {
    // an ordinary read, the sort a phone makes constantly
    relay.ask("ask-1", seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }));
    const first = await waitUntil(() => relay.results.get("ask-1"));
    assert.equal(first!.status, 200);
    const answer = open(openKey, peek(first!.payload)!) as { status: number; body: any };
    assert.equal(answer.status, 200);
    assert.ok(Array.isArray(answer.body.bots), "the phone got the real answer back");

    // the local-only surface must not open just because the request
    // arrived on loopback: this is the whole point of the relay path. A
    // mutating request needs its freshness stamp to clear the replay gate.
    relay.ask(
      "ask-2",
      seal(sealKey, deviceId, {
        method: "POST",
        path: "/api/pair/start",
        ts: Date.now(),
        nonce: "n-2",
      }),
    );
    const second = await waitUntil(() => relay.results.get("ask-2"));
    const denied = open(openKey, peek(second!.payload)!) as { status: number };
    assert.equal(denied.status, 403, "a relayed phone reached a local-only route");

    // replay: the very same sealed frame, sent twice, is refused the
    // second time. A hostile relay cannot re-run a captured mutation.
    const replayable = seal(sealKey, deviceId, {
      method: "POST",
      path: "/api/bloks",
      body: { name: "x", memberIds: [] },
      ts: Date.now(),
      nonce: "n-replay",
    });
    relay.ask("ask-r1", replayable);
    await waitUntil(() => relay.results.get("ask-r1"));
    relay.ask("ask-r2", replayable);
    const replayed = await waitUntil(() => relay.results.get("ask-r2"));
    const replayBody = open(openKey, peek(replayed!.payload)!) as { status: number };
    assert.equal(replayBody.status, 409, "a replayed mutation was served twice");

    // a stale timestamp is refused even with a fresh nonce
    relay.ask(
      "ask-stale",
      seal(sealKey, deviceId, {
        method: "POST",
        path: "/api/bloks",
        ts: Date.now() - 10 * 60_000,
        nonce: "n-stale",
      }),
    );
    const stale = await waitUntil(() => relay.results.get("ask-stale"));
    assert.equal((open(openKey, peek(stale!.payload)!) as { status: number }).status, 409);

    // a stranger's envelope is answered with nothing at all
    const strangerKey = deviceKey("00".repeat(32), "phone-to-mac");
    relay.ask("ask-3", seal(strangerKey, "not-a-device", { method: "GET", path: "/api/bots" }));
    const third = await waitUntil(() => relay.results.get("ask-3"));
    assert.equal(third!.status, 401);
    assert.equal(third!.payload, "", "an unknown device must not even get ciphertext");

    // a phone's own request reflected back must read as garbage: the
    // directions use different keys, which is the whole defence
    const reflected = open(openKey, peek(seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }))!);
    assert.equal(reflected, null, "a reflected frame decrypted across directions");

    // paths outside the API are refused before anything is dialled
    relay.ask("ask-4", seal(sealKey, deviceId, { method: "GET", path: "/../etc/passwd" }));
    const fourth = await waitUntil(() => relay.results.get("ask-4"));
    assert.equal(fourth!.status, 404);
  });

  test("the build a phone names inside its sealed request shows on the Mac's device list", async () => {
    relay.ask("ask-client", seal(sealKey, deviceId, { method: "GET", path: "/api/bots", client: "iOS 2.1.6 (15)" }));
    await waitUntil(() => relay.results.get("ask-client"));
    const status = await h.json("/api/pair");
    const device = status.devices.find((d: { id: string }) => d.id === deviceId);
    assert.equal(device?.client, "iOS 2.1.6 (15)");
  });

  test("a phone that only ever comes through the relay still has a last seen time", async () => {
    // a second phone, so nothing earlier in this file has spoken for it
    const started = await h.json("/api/pair/start", { method: "POST" });
    const claimed = await h.json("/api/pair/claim", {
      method: "POST",
      body: JSON.stringify({ code: started.code, device: "A relayed phone" }),
    });
    const id = claimed.device.id as string;
    const digest = createHash("sha256").update(claimed.token as string).digest("hex");
    const key = deviceKey(digest, "phone-to-mac");
    const lastSeen = async () =>
      (await h.json("/api/pair")).devices.find((d: { id: string }) => d.id === id)?.lastSeen as number | undefined;
    assert.equal(await lastSeen(), undefined);

    // what does not open, or does not pass the checks, is not the phone
    const wrongKey = deviceKey("11".repeat(32), "phone-to-mac");
    relay.ask("seen-forged", seal(wrongKey, id, { method: "GET", path: "/api/bots" }));
    relay.ask("seen-stale", seal(key, id, { method: "POST", path: "/api/bloks", ts: Date.now() - 10 * 60_000, nonce: "n-seen" }));
    relay.ask("seen-stranger", seal(wrongKey, "not-a-device", { method: "GET", path: "/api/bots" }));
    for (const ask of ["seen-forged", "seen-stale", "seen-stranger"]) await waitUntil(() => relay.results.get(ask));
    assert.equal(await lastSeen(), undefined, "a request that never opened counted as the phone being here");
    const status = await h.json("/api/pair");
    assert.ok(!status.devices.some((d: { id: string }) => d.id === "not-a-device"));

    const before = Date.now();
    relay.ask("seen-ok", seal(key, id, { method: "GET", path: "/api/bots" }));
    await waitUntil(() => relay.results.get("seen-ok"));
    const seen = await lastSeen();
    assert.ok(seen && seen >= before, "a relayed request did not mark the phone seen");
  });

  test("an answer lost on the way is sent again until it lands", async () => {
    // a relay that errors once and then loses the socket: the phone still
    // gets its answer, on the third try
    relay.resultFaults.push(503, "drop");
    relay.ask("ask-retry", seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }));
    const landed = await waitUntil(() => relay.results.get("ask-retry"));
    assert.ok(landed, "a retried answer never landed");
    assert.equal(relay.resultAttempts.get("ask-retry"), 3);
    const answer = open(openKey, peek(landed!.payload)!) as { status: number };
    assert.equal(answer.status, 200);
    const state = await h.json("/api/relay/status");
    assert.equal(state.delivering, true, "an answer that landed in the end is not a failing line");
  });

  test("a line that hears but cannot answer says so, and says so when it recovers", async () => {
    const status = async (want: boolean) => {
      const until = Date.now() + 10_000;
      for (;;) {
        const s = await h.json("/api/relay/status");
        if (s.delivering === want || Date.now() > until) return s;
        await new Promise((r) => setTimeout(r, 40));
      }
    };

    // a refusal is final, so the answer is lost at once rather than after
    // the whole retry budget, and the status must stop claiming all is well
    relay.resultFaults.push(401);
    relay.ask("ask-lost", seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }));
    const failing = await status(false);
    assert.equal(failing.connected, true, "the stream itself is still up");
    assert.equal(failing.delivering, false, "a lost answer left the status green");
    assert.match(failing.problem ?? "", /not getting through/);
    assert.equal(relay.resultAttempts.get("ask-lost"), 1, "a refusal was retried");

    // one landed answer is not enough to call it healthy again; a short
    // run is
    for (const id of ["ok-1", "ok-2", "ok-3"]) {
      relay.ask(id, seal(sealKey, deviceId, { method: "GET", path: "/api/bots" }));
      await waitUntil(() => relay.results.get(id));
    }
    const back = await status(true);
    assert.equal(back.delivering, true, "the status never recovered");
    assert.equal(back.problem, null);
  });

  test("through the relay, long conversations arrive as their newest part, and the rest pages in", async () => {
    // several megabytes of conversation, the size that stopped a phone
    // from loading the list at all
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Talker" }) });
    for (let i = 0; i < 40; i++) {
      await h.fetch(`/api/bots/${bot.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: `message ${i} ` + "x".repeat(90_000) }),
      });
    }
    // each send starts a turn that fails here with a notice; let those land
    let local = await h.json("/api/bots");
    for (let settled = 0; settled < 3; ) {
      await new Promise((r) => setTimeout(r, 150));
      const again = await h.json("/api/bots");
      const count = (x: any) => x.bots.reduce((n: number, b: any) => n + b.messages.length + (b.busy ? 1000 : 0), 0);
      settled = count(again) === count(local) ? settled + 1 : 0;
      local = again;
    }
    const whole = local.bots.find((b: any) => b.id === bot.id);
    const ours = whole.messages.filter((m: any) => m.role === "user");
    assert.equal(ours.length, 40, "on this machine the list stays whole");
    assert.equal(whole.olderMessages ?? 0, 0);

    const ask = async (id: string, path: string) => {
      relay.ask(id, seal(sealKey, deviceId, { method: "GET", path }));
      const got = await waitUntil(() => relay.results.get(id));
      assert.ok(got, `no answer for ${path}`);
      assert.ok(JSON.stringify(got).length < 2_000_000, "an answer bigger than the relay takes");
      return open(openKey, peek(got!.payload)!) as { status: number; body: any };
    };

    const zero = await ask("zero-list", "/api/bots?messages=0");
    assert.equal(zero.status, 200);
    // nothing carried, and every message left behind for a page back
    for (const b of zero.body.bots) {
      assert.deepEqual(b.messages, []);
      assert.equal(b.olderMessages, local.bots.find((l: any) => l.id === b.id).messages.length);
    }
    const metadata = ({ messages: _messages, olderMessages: _older, ...fields }: any) => fields;
    assert.deepEqual(zero.body.bots.map(metadata), local.bots.map(metadata));

    const list = await ask("big-list", "/api/bots");
    assert.equal(list.status, 200);
    const trimmed = list.body.bots.find((b: any) => b.id === bot.id);
    assert.ok(trimmed.olderMessages > 0, "a trimmed transcript did not say what it left behind");
    assert.equal(trimmed.messages.length + trimmed.olderMessages, whole.messages.length);
    assert.deepEqual(
      trimmed.messages.map((m: any) => m.id),
      whole.messages.slice(-trimmed.messages.length).map((m: any) => m.id),
      "the trimmed part is not the newest",
    );
    // every other agent still got its latest words
    for (const b of list.body.bots) {
      const full = local.bots.find((x: any) => x.id === b.id);
      if (full.messages.length) assert.ok(b.messages.length > 0, `${b.name} arrived empty`);
    }

    // walk back to the very first message, a page at a time
    let messages = trimmed.messages;
    let older = trimmed.olderMessages;
    for (let page = 0; older > 0 && page < 20; page++) {
      const q = `before=${messages[0].id}&thread=${trimmed.threadId}`;
      const earlier = await ask(`page-${page}`, `/api/bots/${bot.id}/messages?${q}`);
      assert.equal(earlier.status, 200);
      assert.ok(earlier.body.messages.length > 0, "a page came back empty with more to go");
      messages = [...earlier.body.messages, ...messages];
      older = earlier.body.olderMessages;
    }
    assert.equal(older, 0);
    assert.deepEqual(
      messages.map((m: any) => m.id),
      whole.messages.map((m: any) => m.id),
      "paging back did not rebuild the transcript",
    );

    // a conversation of another agent is not reachable through this one
    const stray = await ask("stray", `/api/bots/${bot.id}/messages?thread=not-a-lane`);
    assert.equal(stray.status, 404);
  });

  test("pushes go out one at a time, in the order they happened", async () => {
    // Sent all at once, a slow relay could deliver a reply's late delta
    // after the turn ended, and the phone showed the reply twice. The
    // relay hands a push's frames on before it answers, so one open push
    // at a time keeps the order all the way to the phone.
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "n-start" }) });
    relay.pushed.length = 0;
    relay.events.delayMs = 60;
    relay.events.mostOpen = 0;
    try {
      for (let i = 0; i < 12; i++) {
        await h.fetch(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ name: `n-${String(i).padStart(2, "0")}` }) });
      }
      const names = () =>
        relay.pushed
          .flatMap((p) => p.frames)
          .map((f) => open(openKey, peek(f)!) as any)
          .filter((f) => f?.kind === "bot" && f.bot?.id === bot.id && /^n-\d+$/.test(f.bot.name ?? ""))
          .map((f) => f.bot.name as string);
      const all = await waitUntil(() => (names().includes("n-11") ? names() : undefined));
      assert.ok(all, "the last rename never reached the relay");
      assert.deepEqual(all, [...all!].sort(), "frames reached the relay out of order");
      assert.equal(relay.events.mostOpen, 1, "more than one push was open at once");
      assert.ok(relay.pushed.some((p) => p.frames.length > 1), "what waited behind a slow push did not go as one batch");
    } finally {
      relay.events.delayMs = 0;
    }
  });

  test("broadcasts go out sealed, and only an approval asks for a buzz, with its words sealed too", async (t) => {
    const { createServer: mkFake } = await import("node:http");

    // a fake engine that asks first, so an approval card exists to wake on
    const fake = mkFake((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "grok-4" }] }));
        }
        const parsed = JSON.parse(body || "{}");
        const toolMsg = (parsed.messages ?? []).find((m: any) => m.role === "tool");
        res.writeHead(200, { "content-type": "application/json" });
        if (!toolMsg) {
          return res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "ask_user", arguments: JSON.stringify({ question: "Go?", choices: ["Yes"] }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          );
        }
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "hello from the engine" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    t.after(() => fake.close());

    await h.fetch("/api/providers/grok/connect", {
      method: "POST",
      body: JSON.stringify({
        key: "xai-test-000000000000",
        url: `http://127.0.0.1:${(fake.address() as any).port}`,
      }),
    });
    const { bot } = await h.json("/api/bots", { method: "POST", body: JSON.stringify({ name: "Buzzer" }) });
    await h.fetch(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ modelSelection: { instanceId: "grok", model: "grok-4" } }),
    });

    relay.pushed.length = 0;
    await h.fetch(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "start something worth approving" }),
    });

    // the approval card lands, and exactly that push carries the wake
    const buzz = await waitUntil(() =>
      relay.pushed.find((p) => typeof p.wake === "object" && p.wake?.reason === "needs-you"),
    );
    assert.ok(buzz, "an approval card never asked the relay to wake the phone");

    // the lock screen's words ride along, sealed for this phone alone:
    // the relay sees a reason and ciphertext, the phone reads the question
    const wake = buzz!.wake as { reason: string; sealed?: Record<string, string> };
    const words = wake.sealed?.[deviceId];
    assert.ok(words, "the wake carried no sealed preview for the paired phone");
    assert.equal(words!.includes("Go?"), false, "the preview crossed the relay in clear");
    const preview = open(openKey, peek(words!)!) as any;
    assert.equal(preview.kind, "preview");
    assert.equal(preview.category, "question");
    assert.equal(preview.title, "Buzzer has a question");
    assert.match(preview.body, /Go\?/);
    assert.ok(preview.threadId, "a preview should say which thread to open");

    // every frame that left is ciphertext for the paired phone: the
    // typed message must not appear in any pushed payload
    const leaked = relay.pushed.some((p) => p.frames.some((f) => f.includes("approving")));
    assert.equal(leaked, false, "a frame crossed the relay in clear");
    const sample = relay.pushed.find((p) => p.frames.length > 0)!.frames[0];
    const opened = open(openKey, peek(sample)!);
    assert.ok(opened, "the paired phone could not read its own frame");

    // and plenty of ordinary chatter went out with no wake at all
    const quiet = relay.pushed.filter((p) => p.wake === null).length;
    assert.ok(quiet > 0, "ordinary frames should not buzz");

    // settle the card so the harness shuts down clean
    const settled = await waitUntil(async () => {
      const { bots } = await h.json("/api/bots");
      const b = bots.find((x: any) => x.id === bot.id);
      const card = b.messages.find((m: any) => m.kind === "options" && m.card?.requestId);
      return card?.card ?? undefined;
    });
    const card = await settled;
    if (card) {
      await h.fetch(`/api/bots/${bot.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ requestId: (card as any).requestId, behavior: "answer", message: "Yes" }),
      });
    }
  });
});

describe("replay protection over time", () => {
  // The freshness check accepts a stamp within two minutes either way, so
  // a nonce has to be remembered for as long as its stamp can pass. The
  // old memory cleared itself every two minutes and forgot nonces that
  // were still inside that window.
  test("a nonce is remembered for as long as its timestamp is fresh", () => {
    const seen = new SeenNonces();
    const t0 = 1_000_000_000_000;
    // the shape of the old hole: a request, another 100s later, and a
    // third at 125s, which used to clear everything seen before it
    seen.remember("first", t0, t0);
    seen.remember("a", t0 + 100_000, t0 + 100_000);
    seen.remember("b", t0 + 125_000, t0 + 125_000);
    // "a" is stamped 100s in and stays fresh until 220s, so a replay at
    // 130s must still be recognised
    assert.equal(seen.has("a"), true, "a nonce still inside its window was forgotten");
    // once its stamp is past the window it is refused on freshness anyway,
    // and the memory lets it go
    seen.remember("c", t0 + 230_000, t0 + 230_000);
    assert.equal(seen.has("a"), false);
    assert.equal(seen.has("first"), false);
  });

  test("a stamp ahead of this clock is kept until it, too, goes stale", () => {
    const seen = new SeenNonces();
    const t0 = 1_000_000_000_000;
    seen.remember("ahead", t0 + 100_000, t0);
    seen.remember("later", t0 + 200_000, t0 + 200_000);
    assert.equal(seen.has("ahead"), true);
    seen.remember("much-later", t0 + 230_000, t0 + 230_000);
    assert.equal(seen.has("ahead"), false);
  });
});
