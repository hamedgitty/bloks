// The desktop app, working with a Bloks on another computer.
//
// Normally the app starts its own server and the window talks to it on
// loopback. In remote mode there is no local server: the workspace lives
// on an always-on machine (bin/bloks-server.mjs), and this file stands in
// for the server on loopback instead. The window loads the same UI from
// here and calls the same API; every call is sealed for that machine and
// carried by Bloks Cloud, exactly as the phone's are, and the live event
// stream comes back the same way.
//
// So the UI does not know or care which mode it is in, which is the point:
// nothing in the renderer had to change for this to work.
//
// Plain Node on purpose (no Electron imports), so it can be driven and
// tested outside the app.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

// ── crypto: a mirror of server/relay-crypto.ts ─────────────────────────

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");

function key(hashHex, info) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(hashHex, "hex"), Buffer.alloc(0), info, 32));
}

export function deviceKeys(deviceToken) {
  const hash = sha256hex(deviceToken);
  return { seal: key(hash, "bloks-relay-v1:phone-to-mac"), open: key(hash, "bloks-relay-v1:mac-to-phone") };
}

function linkKeys(secret) {
  const hash = sha256hex(secret);
  return { seal: key(hash, "bloks-invite-v1:phone-to-mac"), open: key(hash, "bloks-invite-v1:mac-to-phone") };
}

function seal(k, deviceId, value) {
  const n = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, n);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  const envelope = { d: deviceId, n: n.toString("base64"), c: Buffer.concat([body, cipher.getAuthTag()]).toString("base64") };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function peek(payload) {
  try {
    const e = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return typeof e?.d === "string" && typeof e.n === "string" && typeof e.c === "string" ? e : null;
  } catch {
    return null;
  }
}

function open(k, payload) {
  const e = peek(payload);
  if (!e) return null;
  try {
    const n = Buffer.from(e.n, "base64");
    const blob = Buffer.from(e.c, "base64");
    if (n.length !== 12 || blob.length <= 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", k, n);
    decipher.setAuthTag(blob.subarray(blob.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(blob.subarray(0, blob.length - 16)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

// ── pairing from a link ────────────────────────────────────────────────

/** A pairing link's fragment, or null when it is not one. */
export function parsePairLink(link) {
  try {
    const fragment = String(link).trim().split("#")[1] ?? "";
    const raw = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8"));
    if (raw.v !== 1 || raw.k !== "pair") return null;
    const relay = typeof raw.r === "string" ? raw.r.replace(/\/+$/, "") : "";
    if (!(relay.startsWith("https://") || relay.startsWith("http://127.0.0.1"))) return null;
    if (typeof raw.t !== "string" || typeof raw.s !== "string" || typeof raw.i !== "string" || !raw.i.startsWith("pair_")) return null;
    return { relayUrl: relay, relayToken: raw.t, linkId: raw.i, secret: raw.s, host: typeof raw.host === "string" ? raw.host.slice(0, 60) : "" };
  } catch {
    return null;
  }
}

/**
 * Spends a pairing link on this app. Makes a device token here, sends
 * only its digest, and returns the profile to keep: where the relay is,
 * the pass, this device's id, and the token its keys come from.
 */
export async function claimPairLink(link, name) {
  const parsed = parsePairLink(link);
  if (!parsed) throw new Error("That is not a Bloks pairing link. Run bloks-server pair on the other computer for a fresh one.");
  const deviceToken = randomBytes(32).toString("base64url");
  const keys = linkKeys(parsed.secret);
  const payload = seal(keys.seal, parsed.linkId, {
    method: "POST",
    path: "/api/pair/link/claim",
    body: { name, tokenHash: sha256hex(deviceToken) },
    ts: Date.now(),
    nonce: randomUUID(),
  });
  let res;
  try {
    res = await fetch(`${parsed.relayUrl}/space/client/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${parsed.relayToken}` },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Bloks Cloud could not be reached.");
  }
  const outer = await res.json().catch(() => ({}));
  if (res.status === 503 || res.status === 504) throw new Error("The other computer is not connected to Bloks Cloud right now.");
  // the relay refusing the link's own token is not a used link: the space
  // it named is gone, usually because Cloud was activated again
  if (res.status === 401) throw new Error("Bloks Cloud does not recognise the other computer any more. Cloud was probably activated again; make a fresh link there once it shows Connected.");
  const reply = outer.payload ? open(keys.open, outer.payload) : null;
  if (!reply || reply.status !== 200 || !reply.body?.deviceId) {
    throw new Error(reply?.body?.error ?? "That pairing link was already used or has expired. Run bloks-server pair again.");
  }
  return { relayUrl: parsed.relayUrl, relayToken: parsed.relayToken, deviceId: reply.body.deviceId, deviceToken, host: reply.body.host || parsed.host || "Bloks" };
}

// ── the stand-in server ────────────────────────────────────────────────

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// The same rules the server holds its own page to (server/index.ts,
// SECURITY_HEADERS and http-guard.ts). This proxy stands in for that
// server, so the window should get the same page, and loopback is no
// more a boundary here than there: any site open in a browser can send
// requests to 127.0.0.1, and this proxy signs every one it forwards as
// this device.
const PAGE_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(value) {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return "";
  }
}

/** Only the window on this computer: a Host that names loopback (a
 * hostile name that resolves to 127.0.0.1 still carries its own), and no
 * Origin, or this proxy's own. A page on another loopback port (an
 * agent's dev server, say) is not the window. */
export function fromThisComputer(req) {
  const host = req.headers.host ?? "";
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const from = new URL(origin);
    return LOOPBACK_HOSTS.has(from.hostname) && from.host === host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // the relay carries 2 MB a request, base64 and all
      if (size > 1_400_000) {
        reject(Object.assign(new Error("too large to send through Bloks Cloud"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Serves the UI from `staticDir` and forwards the API to the remote
 * workspace. Resolves with the port and a stop function. `onState` hears
 * whether the other computer is reachable.
 */
export async function startRemoteProxy(profile, { staticDir, port = 0, onState = () => {}, client } = {}) {
  const keys = deviceKeys(profile.deviceToken);
  const streams = new Set();
  let stopped = false;

  const ask = async (request) => {
    const payload = seal(keys.seal, profile.deviceId, {
      ...request,
      raw: true,
      // the other computer lists this app by the build it names here
      ...(client ? { client } : {}),
      ...(request.method !== "GET" && request.method !== "HEAD" ? { ts: Date.now(), nonce: randomUUID() } : {}),
    });
    const res = await fetch(`${profile.relayUrl}/space/client/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${profile.relayToken}` },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(75_000),
    });
    const outer = await res.json().catch(() => ({}));
    if (res.status === 401) return { status: 401, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: "this app is no longer paired with that computer" })) };
    if (res.status !== 200) return { status: res.status, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: outer.error ?? "the other computer did not answer" })) };
    const reply = outer.payload ? open(keys.open, outer.payload) : null;
    // the other computer answered without sealing anything: it no longer
    // knows this device, which is what revoking it from there does
    if (!reply && outer.status === 401) {
      onState({ connected: false, revoked: true });
      return { status: 401, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: "this app is no longer paired with that computer" })) };
    }
    if (!reply) return { status: 502, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: "the answer could not be opened" })) };
    if (typeof reply.z === "string") return { status: reply.status, type: reply.type, bytes: gunzipSync(Buffer.from(reply.z, "base64")) };
    return { status: reply.status, type: "application/json", bytes: Buffer.from(JSON.stringify(reply.body ?? null)) };
  };

  const serveStatic = (req, res) => {
    const url = new URL(req.url, "http://x");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    let file = join(staticDir, path);
    if (!file.startsWith(staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(staticDir, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...PAGE_HEADERS });
    res.end(readFileSync(file));
  };

  // One live line to the relay, fanned out to every open event stream in
  // the window. Frames are sealed for this device alone and opened here.
  const listen = async () => {
    let delay = 1_000;
    while (!stopped) {
      try {
        const res = await fetch(`${profile.relayUrl}/space/client/stream`, {
          headers: { accept: "text/event-stream", authorization: `Bearer ${profile.relayToken}` },
        });
        if (res.status === 401) {
          onState({ connected: false, revoked: true });
          return;
        }
        if (res.status !== 200 || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          buffer += dec.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            if (!line.startsWith("data:")) continue;
            let outer;
            try {
              outer = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (outer.kind === "hello") {
              // The wait between tries starts over only once the relay has
              // said hello, as server/relay-link.ts does: a relay that
              // answers and drops the line at once would otherwise be
              // dialled every second, forever.
              delay = 1_000;
              onState({ connected: outer.online !== false });
              // the window starts over rather than resuming: frames the
              // relay did not carry cannot be replayed from here
              for (const s of streams) s.write(`data: ${JSON.stringify({ kind: "hello", resumed: false })}\n\n`);
              continue;
            }
            if (outer.kind !== "frame" || typeof outer.payload !== "string") continue;
            if (peek(outer.payload)?.d !== profile.deviceId) continue;
            const frame = open(keys.open, outer.payload);
            if (!frame) continue;
            const text = `data: ${JSON.stringify(frame)}\n\n`;
            for (const s of streams) s.write(text);
          }
        }
        if (stopped) return;
        // a line the relay ended cleanly is gone all the same, and the
        // window should not say connected while this dials it again
        throw new Error("the relay closed the line");
      } catch {
        onState({ connected: false });
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  };

  const server = createServer(async (req, res) => {
    if (!fromThisComputer(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not from this computer" }));
      return;
    }
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ kind: "hello", resumed: false })}\n\n`);
      const stream = { write: (t) => { try { res.write(t); } catch {} } };
      streams.add(stream);
      const keepalive = setInterval(() => stream.write(": keepalive\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        streams.delete(stream);
      });
      return;
    }
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
      const answer = await ask({
        method: req.method,
        path: url.pathname + url.search,
        ...(body && body.length ? { bodyB64: body.toString("base64"), type: req.headers["content-type"] ?? "application/json" } : {}),
      });
      const type = answer.type ?? "application/octet-stream";
      res.writeHead(answer.status, {
        "content-type": type,
        "x-content-type-options": "nosniff",
        // A file the API returns as itself (an agent's HTML artifact, an
        // app's page) is sandboxed by the server so it cannot run as this
        // origin; that header does not survive the trip, so it is put
        // back for anything that is not the API's own JSON.
        ...(/^application\/json\b/i.test(type) ? {} : { "content-security-policy": "sandbox allow-scripts" }),
      });
      res.end(answer.bytes);
    } catch (e) {
      const status = e?.status ?? 502;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 413 ? e.message : "the other computer could not be reached" }));
    }
  });
  // a port that is taken says so, rather than leaving this waiting forever
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  void listen();
  return {
    port: server.address().port,
    stop: () => {
      stopped = true;
      server.close();
    },
  };
}
