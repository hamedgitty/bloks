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
// And so does any file attached in the app when the conversation lives
// on a server elsewhere (GitHub 332). A path on the person's Mac means
// nothing to that server, so the file itself is sent, in parts small
// enough for Bloks Cloud to carry, and the message names where it landed
// here. Each lands in a folder of its own under its own name, which the
// agent reads and the transcript shows; nothing in a folder is served.
//
// Names are minted here and only here: a uuid plus an extension. The
// app's own uploads take theirs from the mime type. A Telegram file may
// take a short one from its own name (server/telegram.ts), letters and
// digits only, so it never names a folder. The serving route answers
// only the image and voice names (SAFE_NAME), so nothing a sender chose
// is ever served back, which is what makes that route safe to expose.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";

import { DATA_DIR } from "./config.ts";
import { PART_BYTES } from "./move-upload.ts";
import { openInside, readHeld, streamHeld } from "./open-inside.ts";

const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Telegram will not hand a bot anything bigger, which is about half an
 * hour of voice. */
export const VOICE_MAX_BYTES = 20 * 1024 * 1024;

/** The most a file attached in the app may be when it has to be sent to
 * the server rather than named by its path: the same as a file sent from
 * Telegram. A file already on this computer goes by its path, and has no
 * limit here. */
export const FILE_MAX_BYTES = VOICE_MAX_BYTES;

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
    if (size <= IMAGE_MAX_BYTES) return void chunks.push(chunk);
    // Said at once, and nothing more kept. The rest is read and dropped
    // rather than hung up on: hanging up first took the answer with the
    // connection, so the sender saw a dropped line instead of why. Only a
    // sender that goes on far past it is cut off.
    chunks.length = 0;
    if (!res.headersSent) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "images top out at 10 MB" }));
    }
    if (size > IMAGE_MAX_BYTES * 4) req.destroy();
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
 * module could have minted are even looked for, and the file is opened
 * once, as a regular file inside the folder, and sent from that open
 * file, so a link put in its place is never followed out. */
export function serveAttachment(name: string, res: ServerResponse): void {
  const held = SAFE_NAME.test(name) ? openInside(ATTACHMENTS_DIR, [name]) : null;
  if (!held) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such attachment" }));
    return;
  }
  res.writeHead(200, {
    "content-type": MIME_FOR[name.split(".").at(-1)!] ?? "application/octet-stream",
    "content-length": held.stat.size,
    // minted names never change contents, so the browser may keep them
    "cache-control": "private, max-age=31536000, immutable",
  });
  pipeline(streamHeld(held), res, () => {});
}

// ── pictures a prompt carries ──────────────────────────────────────────

/** How a picture is named in the words a turn is sent, as the app writes
 * it (composeOutgoing in src/lib/attachments.ts) and Telegram's are. */
const IMAGE_TAG = /<attached-image\s+path="([^"]*)"\s*\/>/g;

/** The most pictures one turn is sent as pictures. Past this the rest
 * still go by name, which is how every engine had them before. */
export const MAX_TURN_IMAGES = 8;

/** A picture as an engine is sent it: what it is, and its bytes in base64. */
export interface TurnImage {
  mime: string;
  data: string;
}

/** Whether these words attach a picture at all. */
export function hasAttachedImage(text: string): boolean {
  return /<attached-image\s+path="/.test(text);
}

/**
 * The pictures these words attach, read back for an engine that is sent
 * pictures rather than paths (GitHub 365). A path in a prompt is somebody's
 * words, so it is only ever a name to look up here: its last part, by
 * either slash, which is the same file whether it was written on Windows,
 * on a Mac or as a file URL. Only a name this module minted is looked for,
 * opened inside the folder the way serveAttachment opens one, and read as
 * what it really is. One that is gone, too big or not a picture is left
 * out, and the words still name it.
 */
export function attachedImages(text: string): TurnImage[] {
  const images: TurnImage[] = [];
  const seen = new Set<string>();
  for (const [, path] of text.matchAll(IMAGE_TAG)) {
    if (images.length >= MAX_TURN_IMAGES) break;
    const name = path!.split(/[\\/]/).at(-1) ?? "";
    if (!SAFE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const held = openInside(ATTACHMENTS_DIR, [name]);
    const bytes = held ? readHeld(held, IMAGE_MAX_BYTES) : null;
    const mime = bytes ? sniffImage(bytes) : null;
    if (bytes && mime) images.push({ mime, data: bytes.toString("base64") });
  }
  return images;
}

// ── files sent in parts ────────────────────────────────────────────────

/** Each part but the last: the size a workspace move travels in, which a
 * request through Bloks Cloud carries with room to spare. */
export const UPLOAD_PART_BYTES = PART_BYTES;
/** An upload nobody has added to for this long is given up. */
const UPLOAD_IDLE_MS = 60 * 60_000;
/** A composer sends one file at a time; this is plenty, and a bound. */
const MAX_UPLOADS = 16;

const IMAGE_TYPES = new Set(Object.keys(EXTENSION_FOR));

export class AttachmentError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * A name a file can keep on this computer: its own, less anything that
 * would make it a path (a separator, a leading dot, a control character),
 * and short enough for any disk. Never empty.
 */
export function attachmentFileName(raw: unknown): string {
  const last = String(typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/^\.+/, "").trim();
  if (Buffer.byteLength(name) > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    let stem = name.slice(0, name.length - ext.length);
    while (Buffer.byteLength(stem + ext) > 120) stem = stem.slice(0, -1);
    name = stem.trimEnd() + ext;
  }
  return name || "file";
}

interface Upload {
  id: string;
  image: boolean;
  name: string;
  size: number;
  parts: number;
  have: Set<number>;
  staging: string;
  touched: number;
}

/**
 * Files arriving a part at a time: begun with the name, size and type
 * (start), each part put in its place by number (put), and finished once
 * all are here (finish), when the file is moved to where the agent will
 * read it. A part sent twice lands on the same bytes, so a retry after a
 * lost answer is harmless. Parts gather in a hidden folder, never in
 * memory, and an upload left alone for an hour is cleared away.
 */
export class AttachmentUploads {
  private readonly uploads = new Map<string, Upload>();
  private readonly dir: string;
  private readonly now: () => number;
  /** For a kind of file that is not an attachment, with a size of its
   * own: every upload is a file, whatever type it says it is. */
  private readonly maxBytes?: number;

  constructor(opts: { dir?: string; now?: () => number; maxBytes?: number } = {}) {
    this.dir = opts.dir ?? ATTACHMENTS_DIR;
    this.now = opts.now ?? Date.now;
    this.maxBytes = opts.maxBytes;
  }

  private get incoming() {
    return join(this.dir, ".incoming");
  }

  start(input: { name?: unknown; size?: unknown; type?: unknown }): { id: string; partSize: number; parts: number } {
    this.sweep();
    const size = input.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) throw new AttachmentError("Say how big the file is, in bytes.", 400);
    if (size === 0) throw new AttachmentError("That file is empty.", 400);
    const type = String(input.type ?? "").split(";")[0]!.trim().toLowerCase();
    const image = this.maxBytes === undefined && IMAGE_TYPES.has(type);
    const max = this.maxBytes ?? (image ? IMAGE_MAX_BYTES : FILE_MAX_BYTES);
    if (size > max) {
      throw new AttachmentError(image ? "images top out at 10 MB" : `files sent here top out at ${max / (1024 * 1024)} MB`, 413);
    }
    if (this.uploads.size >= MAX_UPLOADS) throw new AttachmentError("Too many files are on their way at once. Try again when they have arrived.", 429);
    mkdirSync(this.incoming, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const staging = join(this.incoming, id);
    const fd = openSync(staging, "wx", 0o600);
    try {
      // sparse where the disk allows: each part is written into its place
      writeSync(fd, Buffer.alloc(1), 0, 1, size - 1);
    } finally {
      closeSync(fd);
    }
    const parts = Math.ceil(size / UPLOAD_PART_BYTES);
    this.uploads.set(id, { id, image, name: attachmentFileName(input.name), size, parts, have: new Set(), staging, touched: this.now() });
    return { id, partSize: UPLOAD_PART_BYTES, parts };
  }

  put(id: string, index: number, bytes: Buffer): { received: number; parts: number } {
    const upload = this.uploads.get(id);
    if (!upload) throw new AttachmentError("That file is not arriving any more. Attach it again.", 404);
    if (!Number.isInteger(index) || index < 0 || index >= upload.parts) throw new AttachmentError("There is no such part.", 400);
    const want = index === upload.parts - 1 ? upload.size - index * UPLOAD_PART_BYTES : UPLOAD_PART_BYTES;
    if (bytes.length !== want) throw new AttachmentError(`Part ${index} should be ${want} bytes and was ${bytes.length}.`, 400);
    const fd = openSync(upload.staging, "r+");
    try {
      writeSync(fd, bytes, 0, bytes.length, index * UPLOAD_PART_BYTES);
    } finally {
      closeSync(fd);
    }
    upload.have.add(index);
    upload.touched = this.now();
    return { received: upload.have.size, parts: upload.parts };
  }

  /** The file in its place, and where that is: an image the way a pasted
   * one is kept, anything else in a folder of its own under its name. */
  finish(id: string): { kind: "image"; path: string; mime: string; bytes: number } | { kind: "file"; path: string; name: string; bytes: number } {
    const upload = this.uploads.get(id);
    if (!upload) throw new AttachmentError("That file is not arriving any more. Attach it again.", 404);
    const missing = upload.parts - upload.have.size;
    if (missing) throw new AttachmentError(`${missing} of ${upload.parts} parts have not arrived yet.`, 409);
    this.uploads.delete(id);
    try {
      if (upload.image) {
        const bytes = Buffer.alloc(upload.size);
        const fd = openSync(upload.staging, "r");
        try {
          readSync(fd, bytes, 0, upload.size, 0);
        } finally {
          closeSync(fd);
        }
        // named by what it is, not by what it was said to be
        const mime = sniffImage(bytes);
        const extension = extensionFor(mime ?? undefined);
        if (!mime || !extension) throw new AttachmentError("only png, jpeg, gif and webp images upload", 415);
        return { kind: "image", path: saveBytes(bytes, extension), mime, bytes: upload.size };
      }
      const folder = join(this.dir, id);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, upload.name);
      renameSync(upload.staging, path);
      return { kind: "file", path, name: upload.name, bytes: upload.size };
    } finally {
      rmSync(upload.staging, { force: true });
    }
  }

  cancel(id: string): boolean {
    const upload = this.uploads.get(id);
    if (!upload) return false;
    this.uploads.delete(id);
    rmSync(upload.staging, { force: true });
    return true;
  }

  /** Uploads left alone too long, and parts nothing here remembers (a
   * restart forgets every upload in flight), cleared away. */
  sweep(): void {
    const now = this.now();
    for (const upload of [...this.uploads.values()]) {
      if (now - upload.touched > UPLOAD_IDLE_MS) this.cancel(upload.id);
    }
    if (this.uploads.size) return;
    rmSync(this.incoming, { recursive: true, force: true });
  }
}
