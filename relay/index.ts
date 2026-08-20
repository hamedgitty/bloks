// The relay, over HTTP.
//
// Plain node:http and SSE, the same shapes the harness already speaks, so
// there is no new framing code and no websocket library in a
// security-sensitive path. The Mac dials out and holds one stream open;
// phones POST asks and hold an event stream. See relay/README.md.
//
// This process is a pipe. It holds no transcripts, no provider keys and no
// decryption keys, and every payload below is opaque ciphertext that it
// forwards without inspecting. If you find yourself wanting to parse one,
// that is the moment the privacy claim stops being true.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { apnsFromEnv, ApnsSender, type ApnsEnv } from "./apns.ts";
import { MAX_PAYLOAD_BYTES, SpaceRegistry, type Ask } from "./spaces.ts";

const PORT = Number(process.env.PORT || 8080);

/** Bootstrap tokens for creating spaces. Until accounts exist, a space is
 * minted by presenting this; afterwards the accounts service does it. */
const ADMIN_TOKEN = process.env.RELAY_ADMIN_TOKEN || "";

const registry = new SpaceRegistry();

// ── the buzz ──────────────────────────────────────────────────────────
// APNs device tokens per space, in memory. Each carries the environment
// it was minted in: a dev-signed phone yields a sandbox token, a
// TestFlight or App Store phone a production one, and one relay serves
// both from one .p8 key by choosing the host per token.
interface Device {
  env: ApnsEnv;
  addedAt: number;
}
const apnsTokens = new Map<string, Map<string, Device>>();
const apnsConfig = apnsFromEnv();
// One sender, so the ES256 JWT is cached across sends instead of being
// re-signed per push (which risks Apple's TooManyProviderTokenUpdates).
const apnsSender = apnsConfig ? new ApnsSender(apnsConfig) : null;
let sendPush: (token: string, reason: string, env: ApnsEnv) => Promise<"ok" | "gone" | "failed"> =
  apnsSender ? (t, r, e) => apnsSender.send(t, r, e) : async () => "failed";
// Tests watch the wake path across the process boundary by pointing this
// at a stub. Never set in production; Apple is not an HTTP POST away.
if (process.env.RELAY_PUSH_STUB) {
  const stub = process.env.RELAY_PUSH_STUB;
  sendPush = async (token, reason, env) => {
    await fetch(stub, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, reason, env }),
    }).catch(() => {});
    return "ok";
  };
} else if (!apnsConfig) {
  console.log("[relay] APNS_* not set; wake pushes are off");
}

function buzz(spaceId: string, reason: string) {
  const tokens = apnsTokens.get(spaceId);
  if (!tokens || tokens.size === 0) return;
  for (const [token, device] of [...tokens]) {
    void sendPush(token, reason, device.env).then((result) => {
      // Apple said this token is dead; carrying it further is just spam
      if (result === "gone") tokens.delete(token);
    });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(data);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== "bearer") return null;
  return header.slice(space + 1).trim() || null;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_PAYLOAD_BYTES) {
        // Hang up rather than keep buffering. A shared relay must not let
        // one space push unbounded bytes into its memory.
        req.destroy();
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** Opens an SSE response and returns a writer plus a keepalive canceller. */
function openStream(res: ServerResponse, onClose: () => void, req: IncomingMessage) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Fly and most proxies buffer by default, which turns a live stream
    // into a stream that arrives all at once when it ends.
    "x-accel-buffering": "no",
  });
  const send = (payload: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    onClose();
  };
  const keepalive = setInterval(() => {
    // A write that throws, or backpressure that never drains, is a dead
    // socket the OS has not surfaced. Either way, stop treating this as a
    // live listener now rather than at TCP timeout minutes later, so a
    // wake decision is never suppressed by a zombie.
    let ok = false;
    try {
      ok = res.write(": keepalive\n\n");
    } catch {
      ok = false;
    }
    if (!ok && res.writableNeedDrain !== true) shutdown();
  }, 25_000);
  keepalive.unref?.();
  req.on("close", shutdown);
  req.on("error", shutdown);
  return send;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://relay`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && path === "/health") {
      return json(res, 200, { relay: "bloks", ok: true });
    }

    // Minting a space. Replaced by the accounts service once that exists;
    // until then it is gated on an admin token so the relay is not an open
    // tunnel factory.
    if (method === "POST" && path === "/spaces") {
      if (!ADMIN_TOKEN || bearer(req) !== ADMIN_TOKEN) {
        return json(res, 401, { error: "not allowed" });
      }
      const { space, agentToken, clientToken } = registry.create();
      return json(res, 201, { spaceId: space.id, agentToken, clientToken });
    }

    const auth = registry.authenticate(bearer(req));
    if (!auth) return json(res, 401, { error: "unknown token" });
    const { space, role } = auth;

    // ── the Mac ───────────────────────────────────────────────────────
    // Roles are checked per route rather than once, because an agent
    // token must never be able to read the client stream: a stolen Mac
    // credential would otherwise also be a listening device.

    if (method === "GET" && path === "/space/agent/stream") {
      if (role !== "agent") return json(res, 403, { error: "wrong role" });
      // deliver is this link's identity: only its own close reaps it, so a
      // zombie socket cannot delete the fresh link a reconnect installed
      const deliver = (ask: Ask) => {
        if (!send({ kind: "ask", id: ask.id, payload: ask.payload })) {
          registry.closeLink(space.id, deliver);
        }
      };
      const send = openStream(res, () => registry.closeLink(space.id, deliver), req);
      registry.openLink(space.id, deliver);
      send({ kind: "hello", spaceId: space.id });
      return;
    }

    if (method === "POST" && path === "/space/agent/result") {
      if (role !== "agent") return json(res, 403, { error: "wrong role" });
      registry.touchLink(space.id);
      const body = await readBody(req);
      const accepted = registry.answer(space.id, {
        id: String(body.id ?? ""),
        status: Number(body.status ?? 200),
        payload: String(body.payload ?? ""),
      });
      // A result nobody is waiting for is not an error worth failing on:
      // the caller may simply have timed out.
      return json(res, accepted ? 200 : 202, { ok: accepted });
    }

    if (method === "POST" && path === "/space/agent/events") {
      if (role !== "agent") return json(res, 403, { error: "wrong role" });
      registry.touchLink(space.id);
      const body = await readBody(req);
      const frames: unknown[] = Array.isArray(body.frames) ? body.frames : [];
      for (const frame of frames) {
        if (typeof frame === "string") registry.broadcast(space.id, frame);
      }
      // `wake` carries no content by design: the relay cannot read the
      // frames, so a push can only ever say that something happened.
      // See relay/README.md.
      //
      // The buzz fires on every wake, not only when nobody is streaming:
      // a phone that dropped off the network abruptly can look like a live
      // listener for minutes, and the approval push is exactly the thing
      // that must survive that. A foregrounded phone with a healthy stream
      // suppresses the banner on its own side (see the willPresent
      // delegate); the collapse id keeps repeats to one notification.
      const wake = typeof body.wake === "string" ? body.wake : null;
      const listening = registry.listenerCount(space.id);
      if (wake) buzz(space.id, wake);
      return json(res, 200, {
        delivered: listening,
        wake,
      });
    }

    // ── the phones ────────────────────────────────────────────────────

    if (method === "GET" && path === "/space/client/stream") {
      if (role !== "client") return json(res, 403, { error: "wrong role" });
      let stop = () => {};
      const send = openStream(res, () => stop(), req);
      stop = registry.listen(space.id, (payload) => {
        if (!send({ kind: "frame", payload })) stop();
      });
      send({ kind: "hello", online: registry.isOnline(space.id) });
      return;
    }

    if (method === "POST" && path === "/space/client/ask") {
      if (role !== "client") return json(res, 403, { error: "wrong role" });
      const body = await readBody(req);
      const payload = typeof body.payload === "string" ? body.payload : "";
      if (!payload) return json(res, 400, { error: "payload required" });
      try {
        const answer = await registry.ask(space.id, payload);
        return json(res, 200, { status: answer.status, payload: answer.payload });
      } catch (e) {
        // Distinguish the two failures, because they mean different things
        // to a person: the Mac is asleep, versus the Mac is there and did
        // not answer in time.
        const reason = (e as Error).message;
        return reason === "offline"
          ? json(res, 503, { error: "Your Mac is not connected." })
          : json(res, 504, { error: "Your Mac did not answer in time." });
      }
    }

    if (method === "POST" && path === "/space/client/apns") {
      if (role !== "client") return json(res, 403, { error: "wrong role" });
      const body = await readBody(req);
      const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
      // real device tokens are 32 to 100 bytes of hex, always even length;
      // this rejects the odd-length and half-length junk the old bound let
      // through, which would otherwise live forever (a 400 is not "gone")
      if (!/^(?:[0-9a-f]{2}){32,100}$/.test(token)) {
        return json(res, 400, { error: "that is not a device token" });
      }
      const env: ApnsEnv = body.env === "sandbox" ? "sandbox" : "production";
      let set = apnsTokens.get(space.id);
      if (!set) {
        set = new Map();
        apnsTokens.set(space.id, set);
      }
      // re-registering refreshes recency: delete then set moves an existing
      // token to the newest slot, so a stable device is never the one
      // evicted when the cap is reached
      set.delete(token);
      set.set(token, { env, addedAt: Date.now() });
      while (set.size > 16) set.delete(set.keys().next().value!);
      return json(res, 200, { ok: true });
    }

    if (method === "GET" && path === "/space/client/status") {
      if (role !== "client") return json(res, 403, { error: "wrong role" });
      return json(res, 200, { online: registry.isOnline(space.id) });
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : "relay error" });
  }
});

// 0.0.0.0 on purpose: unlike the harness, this one is meant to be reached
// from the network. Its boundary is the token, not the interface.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`bloks relay on :${PORT}`);
  if (!ADMIN_TOKEN) {
    console.warn("[relay] RELAY_ADMIN_TOKEN is unset, so no spaces can be created");
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[relay] unhandled rejection:", String(reason));
});
