// Answers that shrink, sent gzipped to a client that takes gzip and is not
// on this machine.
//
// A phone paired over a slow path (a Tailscale relay, a weak cellular
// link) waits on every byte of an agent list, and JSON shrinks four to
// eight times (GitHub 473). On this machine nothing waits on a wire: the
// app's own window, and Bloks Cloud's replay of a phone's request, which
// reads the answer back whole to seal it (server/relay-link.ts), would
// only spend CPU on bytes unsqueezed the next moment.
//
// Never an event stream: those are written frame by frame by their own
// routes and never come through here, and a gzip stream would hold each
// frame back until a block of them had filled.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { gzip, gzipSync } from "node:zlib";

import { fromThisMachine } from "./http-guard.ts";

/** Below this, gzip's own header and the CPU cost more than they save. */
export const GZIP_MIN_BYTES = 1024;

/** Up to this, squeezed in place, well under a millisecond. Above it, on
 * libuv's thread pool: a 700 KB agent list takes tens of milliseconds on
 * a small machine, and every other client's request would wait on it. */
export const GZIP_INLINE_MAX = 64 * 1024;

/** Whether an Accept-Encoding header takes gzip: named with a weight
 * above zero, or not named and covered by a `*` that is. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  let anything = false;
  for (const part of value.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";").map((s) => s.trim());
    const q = params.find((p) => p.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    const takes = Number.isFinite(weight) && weight > 0;
    if (name === "gzip") return takes;
    if (name === "*") anything = takes;
  }
  return anything;
}

/** A file's squeezed bytes, kept while the file is the one they came from
 * (`tag`), so the built interface is compressed once, not per request.
 * The interface is a handful of files; the cap only stops a folder of
 * something else from growing this without end. */
const kept = new Map<string, { tag: string; bytes: Buffer }>();
let keptBytes = 0;
const KEPT_MAX = 32 * 1024 * 1024;

function keep(key: string, tag: string, bytes: Buffer) {
  const before = kept.get(key);
  if (before) {
    kept.delete(key);
    keptBytes -= before.bytes.length;
  }
  if (bytes.length > KEPT_MAX / 4) return;
  kept.set(key, { tag, bytes });
  keptBytes += bytes.length;
  for (const [oldest, entry] of kept) {
    if (keptBytes <= KEPT_MAX) break;
    kept.delete(oldest);
    keptBytes -= entry.bytes.length;
  }
}

/**
 * Writes one whole answer. `compressible` says the type is worth
 * squeezing (text, JSON, SVG; never an image or a font, already as small
 * as it gets); `file` names a file and the version of it the body is, to
 * reuse its squeezed bytes. A response that could have gone either way
 * says Vary either way, so a cache in between never hands the gzipped
 * one to a client that cannot read it.
 */
export function sendBody(
  req: IncomingMessage | undefined,
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: string | Buffer,
  { compressible, file }: { compressible: boolean; file?: { key: string; tag: string } },
): void {
  if (!compressible || body.length < GZIP_MIN_BYTES) {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  const varied = { ...headers, vary: "accept-encoding" };
  if (!req || fromThisMachine(req) || !acceptsGzip(req.headers["accept-encoding"])) {
    res.writeHead(status, varied);
    res.end(body);
    return;
  }
  const whole = (bytes: Buffer) => {
    res.writeHead(status, { ...varied, "content-encoding": "gzip", "content-length": bytes.length });
    res.end(bytes);
  };
  const hit = file ? kept.get(file.key) : undefined;
  if (hit && hit.tag === file!.tag) return whole(hit.bytes);
  if (body.length <= GZIP_INLINE_MAX) {
    const bytes = gzipSync(body);
    if (file) keep(file.key, file.tag, bytes);
    return whole(bytes);
  }
  // The head goes now, so the request reads as answered to anything that
  // asks (headersSent) while the body is squeezed off the event loop.
  res.writeHead(status, { ...varied, "content-encoding": "gzip" });
  gzip(body, (error, bytes) => {
    // the client went, or something ended the answer meanwhile
    if (res.writableEnded || res.destroyed) return;
    if (error) {
      res.destroy();
      return;
    }
    if (file) keep(file.key, file.tag, bytes);
    res.end(bytes);
  });
}
