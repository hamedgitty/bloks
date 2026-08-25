// Where pasted images land.
//
// A drag out of a browser or a paste from the clipboard has bytes but no
// path, and agents want paths. So the bytes are written once under
// ~/.bloks/attachments and the message carries the path, the same way it
// would for a file that already lived on disk. The transcript asks for
// the same file back by name when it draws the thumbnail.
//
// Names are minted here and only here: a uuid plus an extension derived
// from the mime type. Nothing the client sends becomes part of the name,
// which is what makes the serving route safe to expose.
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_FOR: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MIME_FOR: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_FOR).map(([mime, ext]) => [ext, mime]),
);

/** A minted name and nothing else: uuid.ext, no separators, no input. */
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

export function extensionFor(contentType: string | undefined): string | null {
  return EXTENSION_FOR[(contentType ?? "").split(";")[0]!.trim().toLowerCase()] ?? null;
}

/** Reads the raw image body and writes it down. Answers with the path
 * the prompt should carry. */
export function saveAttachment(req: IncomingMessage, res: ServerResponse): void {
  const extension = extensionFor(req.headers["content-type"]);
  if (!extension) {
    res.writeHead(415, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "only png, jpeg, gif and webp images upload" }));
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > IMAGE_MAX_BYTES) {
      // hanging up beats buffering a stream nobody will keep
      req.destroy();
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "images top out at 10 MB" }));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    if (!size) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "empty upload" }));
      return;
    }
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const name = `${randomUUID()}.${extension}`;
    const path = join(ATTACHMENTS_DIR, name);
    writeFileSync(path, Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path, mime: MIME_FOR[extension], bytes: size }));
  });
  req.on("error", () => {
    if (!res.writableEnded) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upload failed" }));
    }
  });
}

/** Hands a saved attachment back for the transcript. Only names this
 * module could have minted are even looked for. */
export function serveAttachment(name: string, res: ServerResponse): void {
  if (!SAFE_NAME.test(name)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such attachment" }));
    return;
  }
  const path = join(ATTACHMENTS_DIR, name);
  if (!existsSync(path)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such attachment" }));
    return;
  }
  res.writeHead(200, {
    "content-type": MIME_FOR[name.split(".").at(-1)!] ?? "application/octet-stream",
    "content-length": statSync(path).size,
    // minted names never change contents, so the browser may keep them
    "cache-control": "private, max-age=31536000, immutable",
  });
  createReadStream(path).pipe(res);
}
