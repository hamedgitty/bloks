// Where pasted images land.
//
// A drag out of a browser or a paste from the clipboard has bytes but no
// path, and agents want paths. So the bytes are written once under
// ~/.bloks/attachments and the message carries the path, the same way it
// would for a file that already lived on disk. The transcript asks for
// the same file back by name when it draws the thumbnail.
//
// Voice messages from Telegram land here too, so the transcript of one
// can be played back next to what it was heard as, and so do the videos,
// audio and documents sent there, for the agent to open by path.
//
// Names are minted here and only here: a uuid plus an extension. The
// app's own uploads take theirs from the mime type. A Telegram file may
// take a short one from its own name (server/telegram.ts), letters and
// digits only, so it never names a folder. The serving route answers
// only the image and voice names (SAFE_NAME), so nothing a sender chose
// is ever served back, which is what makes that route safe to expose.
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Telegram will not hand a bot anything bigger, which is about half an
 * hour of voice. */
export const VOICE_MAX_BYTES = 20 * 1024 * 1024;

const EXTENSION_FOR: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MIME_FOR: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXTENSION_FOR).map(([mime, ext]) => [ext, mime])),
  // never uploaded from the app, only kept from a voice message
  ogg: "audio/ogg",
};

/** A minted name and nothing else: uuid.ext, no separators, no input. */
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpg|gif|webp|ogg)$/;

export function extensionFor(contentType: string | undefined): string | null {
  return EXTENSION_FOR[(contentType ?? "").split(";")[0]!.trim().toLowerCase()] ?? null;
}

/** What an image really is, from its first bytes. A file that arrives
 * from somewhere else carries a type somebody else wrote, and the name
 * this module mints should not depend on it. */
export function sniffImage(bytes: Uint8Array): string | null {
  const starts = (...head: number[]) => head.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Writes bytes under a fresh name and answers with the path. */
export function saveBytes(bytes: Uint8Array, extension: string): string {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const path = join(ATTACHMENTS_DIR, `${randomUUID()}.${extension}`);
  writeFileSync(path, bytes);
  return path;
}

/** An image that came from somewhere other than the app, kept the way a
 * pasted one is: the same formats and the same 10 MB. */
export function saveImage(bytes: Uint8Array): string {
  if (bytes.length > IMAGE_MAX_BYTES) throw new Error("images top out at 10 MB");
  const extension = extensionFor(sniffImage(bytes) ?? undefined);
  if (!extension) throw new Error("only png, jpeg, gif and webp images are taken");
  return saveBytes(bytes, extension);
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
    const path = saveBytes(Buffer.concat(chunks), extension);
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
