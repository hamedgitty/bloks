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
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

import { readInside } from "./open-inside.mjs";
import { WAKE_GAVE_UP, createWakeWatch, isWakingAnswer } from "./waking.mjs";

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

/** The window's page and its files, from `staticDir`, and the page for
 * any address that names nothing there. A name is judged as words (no
 * climbing out), then opened as the file it really is inside the folder
 * and sent from that open file, so a link put in the folder, or in place
 * of a file a moment after it was judged, is never followed out of it. */
function serveStaticFrom(staticDir, req, res) {
  const url = new URL(req.url, "http://x");
  const parts = normalize(decodeURIComponent(url.pathname)).split(/[/\\]+/).filter(Boolean);
  let file = parts.join("/");
  let bytes = parts.length && !parts.includes("..") ? readInside(staticDir, parts) : null;
  if (!bytes) {
    file = "index.html";
    bytes = readInside(staticDir, [file]);
  }
  if (!bytes) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", ...PAGE_HEADERS });
  res.end(bytes);
}

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

/** The most a request's body may be. Sealed for one device and wrapped
 * for the trip, a body grows about two and a half times on its way, and
 * the relay carries 2 MB a request. A workspace file goes in parts well
 * under this (server/move-upload.ts). */
export const MAX_REQUEST_BYTES = 800_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= MAX_REQUEST_BYTES) return void chunks.push(c);
      // Refused at once, and the rest read and dropped rather than hung up
      // on: a hang-up takes the answer with it, and the window showed a
      // lost connection instead of why. Only a sender that goes on far past
      // it is cut off.
      chunks.length = 0;
      reject(Object.assign(new Error("too large to send through Bloks Cloud"), { status: 413 }));
      if (size > MAX_REQUEST_BYTES * 4) req.destroy();
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Event streams the window may follow through Bloks Cloud: an agent's
 * terminals, whose output is a live stream rather than an answer. The
 * other computer keeps the same list (server/relay-link.ts, STREAMABLE). */
const STREAMABLE = [/^\/api\/bots\/[\w-]+\/terminals\/stream$/, /^\/api\/bots\/[\w-]+\/terminal\/stream$/];
/** Renewing a followed stream well inside the minute it lapses after. */
const STREAM_RENEW_MS = 20_000;
/** Pieces of a stream that arrived before the answer that named it. */
const EARLY_LIMIT = 2_000_000;

/** Where a page with no event stream yet follows a hosted workspace waking
 * up (src/lib/waking.ts); a page with one hears it there. Answered here,
 * never asked of the other computer: whether it is asleep is this proxy's
 * to know, not the machine's. */
const WAKE_PATH = "/api/remote/wake";

/** A path into a hosted workspace's virtual desktop, by its ticket
 * (server/hosted.ts). */
const DESKTOP_PATH = /^\/hosted\/desktop\/([0-9a-f]{48})(?:\/|$)/;
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Where a hosted workspace's desktop answers from outside, as its answer
 * named it: an https origin, or http on loopback for a test. Null for
 * anything else, which this proxy will not send anybody's desktop to. */
export function doorOf(value) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password) return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin;
  } catch {
    /* not an address */
  }
  return null;
}

/**
 * Serves the UI from `staticDir` and forwards the API to the remote
 * workspace. Resolves with the port and a stop function. `onState` hears
 * whether the other computer is reachable.
 *
 * Two things the relay cannot carry as a request and its answer are done
 * here instead. An event stream the window opens (an agent's terminal) is
 * asked of the other computer as a followed stream, whose events come back
 * on the same sealed line as every frame, for this device alone, and are
 * written to the window as the stream it opened. And a hosted workspace's
 * desktop, which is a page and a live socket, is passed straight to the
 * door that workspace named when it minted the ticket (server/hosted.ts),
 * so the window frames it from its own origin as it would on the machine
 * itself; the ticket is checked there on every request.
 *
 * A hosted workspace that sleeps is woken by the first ask, and an ask
 * Bloks Cloud answers "waking" is asked again until the machine is up or
 * two minutes have gone (waking.mjs), so the window's requests take longer
 * rather than fail. The window hears how the wait stands on its event
 * stream, or on WAKE_PATH before it has one open. `hosted`
 * says the workspace is one that may sleep, so Bloks Cloud's "not
 * connected" means asleep from the first moment; `waking` hands in a
 * clock, for the tests.
 */
export async function startRemoteProxy(profile, { staticDir, port = 0, onState = () => {}, client, hosted = false, waking = {} } = {}) {
  const keys = deviceKeys(profile.deviceToken);
  const streams = new Set();
  let stopped = false;
  // The wait for a waking workspace goes to the window on its own event
  // stream, as a frame, rather than on a line of its own: a window has
  // only a few connections to this proxy, and one held open for nothing
  // else would be one fewer for the work. WAKE_PATH says the same for a
  // page that has no event stream open yet.
  const wakeStreams = new Set();
  // with the watermark as it stands, as hello carries it: every frame here
  // says where it falls, and this one is never news, so it moves nothing
  const wakeFrame = (state) => `data: ${JSON.stringify({ kind: "remote.wake", ...state, _seq: frameSeq })}\n\n`;
  const watch = createWakeWatch({
    ...waking,
    onChange: (state) => {
      for (const s of wakeStreams) s.write(`data: ${JSON.stringify(state)}\n\n`);
      const frame = wakeFrame(state);
      for (const s of streams) s.write(frame);
    },
  });
  // the window's followed streams, by the id the other computer gave
  // each, and pieces of any that arrived before the answer naming it
  const followed = new Map();
  const early = new Map();
  let earlyBytes = 0;
  // desktop tickets this window was given, and where each one answers
  const doors = new Map();
  // The relay has no resume sequence. Give this proxy's live stream its
  // own watermark, including hello, rather than disabling renderer freshness.
  // Keep notification identities across relay and renderer reconnects: a
  // replay keeps its original sequence and cannot become fresh attention.
  let frameSeq = 0;
  const noticeSequences = new Map();
  const sequenced = (frame) => {
    const message = frame.message;
    const identity = frame.kind === "reply.settled"
      ? `reply:${frame.threadId}:${frame.botId}:${frame.turnId}`
      : frame.kind === "message" && message?.kind === "options" && (message.card?.requestId || message.card?.runId)
        ? `request:${frame.threadId}:${message.card.requestId ?? message.id}` : null;
    let seq = identity ? noticeSequences.get(identity) : undefined;
    if (seq === undefined) {
      seq = ++frameSeq;
      if (identity) {
        noticeSequences.set(identity, seq);
        if (noticeSequences.size > 512) noticeSequences.delete(noticeSequences.keys().next().value);
      }
    }
    return { ...frame, _seq: seq };
  };

  /** One request through Bloks Cloud, sealed afresh: its own time and
   * nonce each time it is made, so a write asked again while a machine
   * wakes is never taken for a replay. `waking` marks Bloks Cloud's
   * "waking" answer, and `heard` an answer the other computer gave. */
  const askOnce = async (request) => {
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
    if (isWakingAnswer(res.status, outer)) return { status: 503, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: WAKE_GAVE_UP, waking: true })), waking: true };
    if (res.status !== 200) return { status: res.status, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: outer.error ?? "the other computer did not answer" })) };
    const reply = outer.payload ? open(keys.open, outer.payload) : null;
    // the other computer answered without sealing anything: it no longer
    // knows this device, which is what revoking it from there does
    if (!reply && outer.status === 401) {
      onState({ connected: false, revoked: true });
      return { status: 401, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: "this app is no longer paired with that computer" })), heard: true };
    }
    if (!reply) return { status: 502, type: "application/json", bytes: Buffer.from(JSON.stringify({ error: "the answer could not be opened" })), heard: true };
    if (typeof reply.z === "string") return { status: reply.status, type: reply.type, bytes: gunzipSync(Buffer.from(reply.z, "base64")), heard: true };
    return { status: reply.status, type: "application/json", bytes: Buffer.from(JSON.stringify(reply.body ?? null)), heard: true };
  };

  /** A request through Bloks Cloud, waited through a wake: asked again
   * while the answer is "waking", for as long as the window's one wait
   * lasts (waking.mjs). What comes back after the wait ran out says so in
   * words, with `waking: true` for the window to know it by. A read the
   * window stopped waiting for (`gone`) stops being asked; a write is
   * asked until it lands, so words sent before switching away still go. */
  const ask = (request, { gone } = {}) => watch.run(() => askOnce(request), { gone });

  const serveStatic = (req, res) => serveStaticFrom(staticDir, req, res);

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
              // a workspace that sleeps and is not connected is asleep, and
              // the window's next ask is what wakes it
              if (hosted) watch.presume(outer.online !== false);
              // what a followed stream sent while the line was down is
              // gone, so each is ended and the window opens it again,
              // which starts it over from what it holds
              for (const follow of [...followed.values()]) follow.end();
              // the window starts over rather than resuming: frames the
              // relay did not carry cannot be replayed from here
              for (const s of streams) s.write(`data: ${JSON.stringify({ kind: "hello", resumed: false, _seq: frameSeq })}\n\n`);
              continue;
            }
            if (outer.kind !== "frame" || typeof outer.payload !== "string") continue;
            if (peek(outer.payload)?.d !== profile.deviceId) continue;
            const frame = open(keys.open, outer.payload);
            if (!frame) continue;
            if (frame.kind === "stream" && typeof frame.stream === "string") {
              const follow = followed.get(frame.stream);
              if (follow) follow.take(frame);
              else holdEarly(frame);
              continue;
            }
            const text = `data: ${JSON.stringify(sequenced(frame))}\n\n`;
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

  const holdEarly = (frame) => {
    const size = typeof frame.data === "string" ? frame.data.length : 0;
    if (earlyBytes + size > EARLY_LIMIT) return;
    const held = early.get(frame.stream) ?? { frames: [], at: Date.now() };
    held.frames.push(frame);
    early.set(frame.stream, held);
    earlyBytes += size;
    // nothing waits long for an answer that is not coming
    for (const [sid, kept] of early) {
      if (Date.now() - kept.at < 30_000) continue;
      for (const f of kept.frames) earlyBytes -= typeof f.data === "string" ? f.data.length : 0;
      early.delete(sid);
    }
  };

  /** One event stream the window opened, followed on the other computer. */
  const follow = async (req, res, path) => {
    let answer = null;
    // a window that stops waiting for a stream while the machine wakes
    // has no use for it once it is up
    let left = false;
    res.on("close", () => (left = true));
    try {
      answer = await ask(
        { method: "POST", path: "/api/relay/streams", bodyB64: Buffer.from(JSON.stringify({ path })).toString("base64"), type: "application/json" },
        { gone: () => left },
      );
    } catch {
      answer = null;
    }
    let said = null;
    try {
      said = JSON.parse(answer?.bytes?.toString("utf8") ?? "");
    } catch {
      said = null;
    }
    if (!answer || answer.status !== 200 || typeof said?.stream !== "string" || stopped) {
      res.writeHead(answer && answer.status !== 200 ? answer.status : 502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: said?.error ?? "that could not be followed through Bloks Cloud" }));
      return;
    }
    const sid = said.stream;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let line = "";
    let ended = false;
    const write = (text) => {
      try {
        res.write(text);
      } catch {}
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearInterval(renew);
      clearInterval(keepalive);
      if (followed.get(sid)?.end === end) followed.delete(sid);
      try {
        res.end();
      } catch {}
    };
    const take = (frame) => {
      if (frame.end) return end();
      if (typeof frame.data !== "string") return;
      // a long line comes in pieces and goes to the window whole
      line += frame.data;
      if (frame.more === true) return;
      write(`data: ${line}\n\n`);
      line = "";
    };
    // A renewal is not waited through a wake: a machine that has gone to
    // sleep has let the stream go, and the window opens it again, which
    // does wait.
    const renew = setInterval(() => {
      void askOnce({ method: "POST", path: `/api/relay/streams/${sid}` })
        .then((a) => (a.status === 404 || a.waking) && end())
        .catch(() => {});
    }, STREAM_RENEW_MS);
    const keepalive = setInterval(() => write(": keepalive\n\n"), 25_000);
    followed.set(sid, { take, end });
    const held = early.get(sid);
    early.delete(sid);
    for (const frame of held?.frames ?? []) {
      earlyBytes -= typeof frame.data === "string" ? frame.data.length : 0;
      take(frame);
    }
    req.on("close", () => {
      if (!ended) void askOnce({ method: "DELETE", path: `/api/relay/streams/${sid}` }).catch(() => {});
      end();
    });
  };

  /** The minted ticket's door, from the answer that minted it. */
  const noteDoor = (bytes) => {
    try {
      const said = JSON.parse(bytes.toString("utf8"));
      const ticket = typeof said?.url === "string" ? DESKTOP_PATH.exec(said.url)?.[1] : null;
      const door = doorOf(said?.door);
      if (!ticket || !door) return;
      doors.set(ticket, door);
      // each open panel holds one; old ones lapse there anyway
      while (doors.size > 32) doors.delete(doors.keys().next().value);
    } catch {
      /* no door named: the desktop is not reachable from here */
    }
  };

  /** A page or a file of the desktop's viewer, from its door. */
  const passDesktop = (req, res, ticket, url) => {
    const door = doors.get(ticket);
    if (!door || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const target = new URL(url.pathname + url.search, door);
    const headers = {};
    for (const name of ["accept", "accept-language", "user-agent", "if-none-match", "if-modified-since"]) {
      if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
    }
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: req.method, headers }, (answer) => {
      const back = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !HOP_HEADERS.has(name) && name !== "set-cookie") back[name] = value;
      }
      res.writeHead(answer.statusCode ?? 502, { ...back, "referrer-policy": "no-referrer", "cache-control": "no-store" });
      answer.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "The desktop is not answering." }));
      } else res.end();
    });
    upstream.end();
  };

  const server = createServer(async (req, res) => {
    if (!fromThisComputer(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not from this computer" }));
      return;
    }
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/plan" || url.pathname.startsWith("/api/plan/")) res.setHeader("cache-control", "no-store");
    const ticket = DESKTOP_PATH.exec(url.pathname)?.[1];
    if (ticket) return passDesktop(req, res, ticket, url);
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
    if (req.method === "GET" && STREAMABLE.some((route) => route.test(url.pathname))) return follow(req, res, url.pathname);
    // the wait for a waking workspace, as it is now and as it changes
    if (url.pathname === WAKE_PATH) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const stream = { write: (t) => { try { res.write(t); } catch {} } };
      stream.write(`data: ${JSON.stringify(watch.state())}\n\n`);
      wakeStreams.add(stream);
      const keepalive = setInterval(() => stream.write(": keepalive\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        wakeStreams.delete(stream);
      });
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ kind: "hello", resumed: false, _seq: frameSeq })}\n\n`);
      // how the wait stands, waking or not, so a window that lost its
      // line meanwhile does not keep showing one that is over
      res.write(wakeFrame(watch.state()));
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
      const read = req.method === "GET" || req.method === "HEAD";
      const body = read ? null : await readBody(req);
      // a read the window gave up on (it went to another page, say) is not
      // asked again while the machine wakes; a write is, so it still lands
      let left = false;
      res.on("close", () => (left = !res.writableEnded));
      const answer = await ask(
        {
          method: req.method,
          path: url.pathname + url.search,
          ...(body && body.length ? { bodyB64: body.toString("base64"), type: req.headers["content-type"] ?? "application/json" } : {}),
        },
        { gone: () => read && left },
      );
      if (req.method === "POST" && url.pathname === "/api/hosted/desktop" && answer.status === 200) noteDoor(answer.bytes);
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
  // The desktop viewer's socket, passed to the door its ticket names.
  // Anything else asking to upgrade is closed.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    const ticket = DESKTOP_PATH.exec(url.pathname)?.[1];
    const door = ticket ? doors.get(ticket) : null;
    if (!fromThisComputer(req) || !door) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return;
    }
    const target = new URL(url.pathname + url.search, door);
    const headers = { connection: "Upgrade", upgrade: String(req.headers.upgrade ?? "websocket") };
    for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "user-agent"]) {
      if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
    }
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, { method: "GET", headers });
    const fail = () => socket.destroy();
    upstream.on("upgrade", (answer, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`];
      for (const [name, value] of Object.entries(answer.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) lines.push(`${name}: ${one}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const close = () => {
        socket.destroy();
        upSocket.destroy();
      };
      upSocket.on("error", close);
      socket.on("error", close);
      upSocket.on("close", close);
      socket.on("close", close);
    });
    upstream.on("response", (answer) => {
      answer.resume();
      socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} Refused\r\nconnection: close\r\n\r\n`);
    });
    upstream.on("error", fail);
    socket.on("error", () => upstream.destroy());
    upstream.end();
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
      watch.stop();
      for (const follow of [...followed.values()]) follow.end();
      server.close();
    },
  };
}

// ── a workspace joined on the owner's own network ──────────────────────
// A join that never touched Bloks Cloud still makes a membership: the
// device token the owner's computer knows, and where it answers on the
// network. This stands in for that computer on loopback the same way,
// calling it directly with the member's token, so the window cannot tell
// the difference. It only works while both computers are on that network,
// which the switcher says.

/** Where a joined workspace is reached: Bloks Cloud when the membership
 * has a way through it, which works from anywhere, else the owner's own
 * network, else nowhere this app knows. */
export function reachOf(profile) {
  if (profile?.relayUrl && profile.relayToken) return "relay";
  if (typeof profile?.lan === "string" && /^[0-9a-zA-Z.:[\]-]{3,80}$/.test(profile.lan)) return "lan";
  return null;
}

/**
 * Serves the UI from `staticDir` and forwards the API to the owner's
 * computer on this network, with the member's own token. Resolves with
 * the port and a stop function.
 */
export async function startLanProxy(profile, { staticDir, port = 0, client, fetcher = fetch } = {}) {
  const base = `http://${profile.lan}`;
  const auth = { authorization: `Bearer ${profile.deviceToken}`, ...(client ? { "x-bloks-client": client } : {}) };
  const open = new Set();
  const serveStatic = (req, res) => serveStaticFrom(staticDir, req, res);
  const server = createServer(async (req, res) => {
    if (!fromThisComputer(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not from this computer" }));
      return;
    }
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/plan" || url.pathname.startsWith("/api/plan/")) res.setHeader("cache-control", "no-store");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);
    if (url.pathname === "/api/events") {
      // the owner's computer's own stream, passed through as it comes; the
      // window's EventSource dials again when it ends
      const abort = new AbortController();
      open.add(abort);
      req.on("close", () => {
        abort.abort();
        open.delete(abort);
      });
      try {
        const upstream = await fetcher(`${base}/api/events${url.search}`, { headers: { accept: "text/event-stream", ...auth }, signal: abort.signal });
        if (upstream.status !== 200 || !upstream.body) throw new Error(String(upstream.status));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const reader = upstream.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        /* not on that network right now: the window shows it offline */
      }
      if (!res.headersSent) res.writeHead(503, { "content-type": "application/json" });
      res.end();
      return;
    }
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const answer = await fetcher(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { ...(body && body.length ? { "content-type": req.headers["content-type"] ?? "application/json" } : {}), ...auth },
        ...(body && body.length ? { body } : {}),
        signal: AbortSignal.timeout(75_000),
      });
      const type = answer.headers.get("content-type") ?? "application/octet-stream";
      res.writeHead(answer.status, {
        "content-type": type,
        "x-content-type-options": "nosniff",
        // a file served as itself stays sandboxed off this origin, as the
        // owner's server would have had it
        ...(/^application\/json\b/i.test(type) ? {} : { "content-security-policy": "sandbox allow-scripts" }),
      });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (e) {
      const status = e?.status ?? 503;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: status === 413 ? e.message : "the owner's computer is not reachable on this network" }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    stop: () => {
      for (const abort of open) abort.abort();
      server.close();
    },
  };
}
