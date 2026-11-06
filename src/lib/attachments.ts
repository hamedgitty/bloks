// What rides along with the next message.
//
// Three things can ride: a paste too long to read as typing, a file from
// this machine, and an image. Each becomes a chip above the input rather
// than a wall of text inside it, and on send the chips fold back into
// one plain prompt, so every engine receives the same shape whether the
// user attached anything or not.
//
// Files travel as paths, not bytes: every engine here is an agent that
// can open a path itself, and copying a two-gigabyte video into a prompt
// helps nobody. Images are the exception, because a path into a browser
// drag does not exist; those upload once and the prompt carries the
// saved path.
//
// A path only works where the server can open it. When the conversation
// lives on a server elsewhere (this app connected to another computer, or
// a paired device), a path on this Mac names nothing there, so every file
// is sent to that server instead, in parts small enough to cross Bloks
// Cloud, and the prompt carries the path it landed at (GitHub 332). One
// too big to send is refused here, in words, never passed on as a path.
//
// A picture going through Bloks Cloud is made small enough for it first,
// the way the iPhone app sends one: a JPEG that fits, a screenshot left a
// PNG when it already does. A HEIC photo always goes as a JPEG, since no
// server here takes HEIC as a picture (GitHub 333).
//
// The reasons a file is refused are said in the reader's language. What
// a server says back is passed on in its own words.
import { formatNumber, t } from "./i18n.ts";

export type PasteAttachment = {
  kind: "paste";
  id: string;
  text: string;
  bytes: number;
  lines: number;
};

export type FileAttachment = {
  kind: "file";
  id: string;
  path: string;
  name: string;
  bytes: number;
};

export type ImageAttachment = {
  kind: "image";
  id: string;
  path: string;
  name: string;
  bytes: number;
  mime: string;
};

export type Attachment = PasteAttachment | FileAttachment | ImageAttachment;

/** Past either of these, a paste stops being typing and becomes a chip.
 * The line rule catches the narrow-but-endless kind: stack traces, logs. */
export const PASTE_CHARS = 900;
export const PASTE_LINES = 12;

export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_CHARS || text.split("\n").length >= PASTE_LINES;
}

/** Matches the server's cap, checked here so an oversized image is
 * refused before the upload starts rather than partway through it. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The server's cap on a file that has to be sent rather than named:
 * the same as a file sent from Telegram (server/attachments.ts). */
export const FILE_MAX_BYTES = 20 * 1024 * 1024;

/** The most a picture is sent at through Bloks Cloud. An upload is base64
 * three times on its way (the bytes in the request, the request sealed,
 * the envelope for the trip), which makes it about 2.37 times its size on
 * the line, and the relay takes 2,000,000 bytes a request: 843,570 bytes
 * of picture at the very most. This is what the app's stand-in for a
 * server elsewhere forwards in one request (electron/remote.mjs,
 * MAX_REQUEST_BYTES), 1,896,728 on the line, so a picture is one
 * request's worth even where it has to go whole. */
export const CLOUD_IMAGE_BYTES = 800_000;

/** A server older than 3.0 takes a picture in one request only, and reads
 * Bloks Cloud's stream only up to 1,000,000 characters a frame, which an
 * upload of 421,663 bytes already passes. */
export const OLDER_SERVER_IMAGE_BYTES = 400_000;

/** Where the conversation's server is, as it says itself
 * (GET /api/attachments/where), and how a file is sent to it. */
export interface Destination {
  /** A path on this computer is one the server can open. */
  sameComputer: boolean;
  /** This window reaches the server through Bloks Cloud, so a picture is
   * made to fit CLOUD_IMAGE_BYTES before it goes. */
  throughCloud: boolean;
  /** Each part of a file sent in parts, but the last. */
  partBytes: number;
  fileMaxBytes: number;
  imageMaxBytes: number;
  /** The most a shared file can be to open here, when the way there is
   * Bloks Cloud and the server says; null when it does not (on this
   * computer or its network nothing is too large, and a server before
   * parts cannot say). */
  openMaxBytes: number | null;
}

/** What to go by when the server cannot say: that a path from here means
 * nothing there, so a file is sent rather than named. Sending one to a
 * server that could have opened it costs a copy; naming one it cannot
 * costs the agent the file. And that the way there is Bloks Cloud, the
 * narrower of the two, for the same reason. */
const ELSEWHERE: Destination = {
  sameComputer: false,
  throughCloud: true,
  partBytes: 384 * 1024,
  fileMaxBytes: FILE_MAX_BYTES,
  imageMaxBytes: IMAGE_MAX_BYTES,
  openMaxBytes: null,
};

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let asked: Promise<Destination> | null = null;

/** Where this window's server is. Asked once a page, and again after a
 * failed ask; a fetcher of a test's own is asked every time. */
export function destination(fetcher?: Fetcher): Promise<Destination> {
  const ask = async (): Promise<Destination> => {
    const response = await (fetcher ?? fetch)("/api/attachments/where");
    if (!response.ok) throw new Error(String(response.status));
    const said = (await response.json()) as Partial<Destination>;
    const size = (value: unknown, fallback: number) => (typeof value === "number" && value > 0 ? value : fallback);
    const sameComputer = said.sameComputer === true;
    return {
      sameComputer,
      // a server that does not say is taken to be reached the narrower way
      throughCloud: !sameComputer && said.throughCloud !== false,
      partBytes: size(said.partBytes, ELSEWHERE.partBytes),
      fileMaxBytes: size(said.fileMaxBytes, ELSEWHERE.fileMaxBytes),
      imageMaxBytes: size(said.imageMaxBytes, ELSEWHERE.imageMaxBytes),
      openMaxBytes: !sameComputer && typeof said.openMaxBytes === "number" && said.openMaxBytes > 0 ? said.openMaxBytes : null,
    };
  };
  if (fetcher) return ask().catch(() => ELSEWHERE);
  asked ??= ask().catch(() => {
    asked = null;
    return ELSEWHERE;
  });
  return asked;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isImage(file: { type: string }): boolean {
  return IMAGE_MIMES.has(file.type.split(";")[0]!.trim().toLowerCase());
}

const HEIC_MIMES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);

/** A HEIC photo, what an iPhone takes pictures in. Not one of the kinds a
 * server keeps as a picture, so it goes as a JPEG made of it. A picked one
 * often comes with no type at all, so its name counts too. */
export function isHeic(file: { type: string; name?: string }): boolean {
  return HEIC_MIMES.has(file.type.split(";")[0]!.trim().toLowerCase()) || /\.hei[cf]$/i.test(file.name ?? "");
}

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}`;

export function pasteAttachment(text: string): PasteAttachment {
  // Measured once here; the chip re-renders on every keystroke and
  // should not re-encode half a megabyte each time.
  return {
    kind: "paste",
    id: newId(),
    text,
    bytes: new TextEncoder().encode(text).length,
    lines: text.split("\n").length,
  };
}

export function fileAttachment(name: string, path: string, bytes: number): FileAttachment {
  return { kind: "file", id: newId(), path, name, bytes };
}

/** Small pathless text drops (a browser drag of a .txt, a snippet) keep
 * their contents inline instead of being refused for having no path. */
export const INLINE_TEXT_LIMIT = 512 * 1024;

type IncomingFile = Pick<File, "name" | "size" | "type" | "text">;

type ImageIntake<T> = {
  pathOf: (file: T) => string;
  uploadImage: (file: T) => Promise<ImageAttachment | null>;
  sameComputer?: boolean | (() => Promise<boolean>);
};

const said = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * One picture, uploaded: what it became, or an Error in the words the
 * user reads. Apart from intakeFiles so a picture can settle on its own
 * chip (src/lib/pendingImages.ts), and be tried again, the same way.
 */
export async function intakeImage<T extends IncomingFile>(file: T, handlers: ImageIntake<T>): Promise<Attachment | null> {
  try {
    return await handlers.uploadImage(file);
  } catch (error) {
    // A HEIC photo this window cannot make a JPEG of still goes by its
    // path to the server that can open it, as it always has. Anywhere
    // else it is said, never passed on as a path.
    let path = "";
    if ((error as { unconverted?: boolean }).unconverted) {
      try {
        const here = handlers.sameComputer ?? true;
        const sameComputer = typeof here === "boolean" ? here : await here().catch(() => false);
        path = sameComputer ? handlers.pathOf(file) : "";
      } catch {
        // no disk path to give
      }
    }
    if (path) return fileAttachment(file.name, path, file.size);
    throw new Error(said(error, t("libAttachments.uploadFailed")));
  }
}

/**
 * The one intake for the picker, the drop and the paste, so a picked
 * file and a dropped one can never sort differently. The caller owns
 * the network (uploadImage, uploadFile) and the disk-path bridge
 * (pathOf); this owns the ordering and the sentence the user reads when
 * something is refused. Nothing is dropped in silence.
 *
 * `sameComputer` says whether the server can open a path from here; left
 * out, it can, which is the app with its own server. When it cannot, a
 * path from here is never used: the file is sent with uploadFile.
 *
 * `onImage` takes every picture at once, before anything is awaited, for
 * a chip of its own that settles by itself; those are not in what this
 * answers with. Without it, pictures upload here, in turn, as before.
 */
export async function intakeFiles<T extends IncomingFile>(
  files: readonly T[],
  handlers: ImageIntake<T> & {
    uploadFile?: (file: T) => Promise<FileAttachment | null>;
    /** Told as a file starts on its way, for a line while it travels. */
    onSending?: (file: T) => void;
    onImage?: (file: T) => void;
  },
): Promise<{ attachments: Attachment[]; refused: string | null }> {
  const attachments: Attachment[] = [];
  const complaints: string[] = [];
  let here: boolean | null = null;
  const sameComputer = async () => {
    if (here !== null) return here;
    const told = handlers.sameComputer ?? true;
    here = typeof told === "boolean" ? told : await told().catch(() => false);
    return here;
  };
  const { onImage } = handlers;
  const rest = onImage
    ? files.filter((file) => {
        if (!isImage(file) && !isHeic(file)) return true;
        onImage(file);
        return false;
      })
    : files;
  // One at a time, so the chips keep the order the files were chosen in.
  for (const file of rest) {
    if (isImage(file) || isHeic(file)) {
      try {
        const uploaded = await intakeImage(file, { ...handlers, sameComputer });
        if (uploaded) attachments.push(uploaded);
      } catch (error) {
        complaints.push(
          t("libAttachments.complaint", { name: file.name || t("libAttachments.image"), reason: said(error, t("libAttachments.uploadFailed")) }),
        );
      }
      continue;
    }
    let path = "";
    let pathless = true;
    try {
      path = handlers.pathOf(file);
      pathless = !path;
    } catch {
      // a plain browser tab has no disk path to give
    }
    // a path on this computer names nothing on a server elsewhere
    if (path && !(await sameComputer())) path = "";
    if (path) {
      attachments.push(fileAttachment(file.name, path, file.size));
      continue;
    }
    // A small text drop with no path anywhere keeps its words inline, as
    // it always has, for the server this app runs.
    const inline = (file.type.startsWith("text/") || file.type === "application/json") && file.size <= INLINE_TEXT_LIMIT;
    if (pathless && inline && (!handlers.uploadFile || (await sameComputer()))) {
      try {
        attachments.push(pasteAttachment(await file.text()));
        continue;
      } catch {
        // unreadable drag; sent instead, or said below
      }
    }
    if (handlers.uploadFile) {
      try {
        handlers.onSending?.(file);
        const sent = await handlers.uploadFile(file);
        if (sent) attachments.push(sent);
      } catch (error) {
        complaints.push(
          t("libAttachments.complaint", { name: file.name || t("libAttachments.thatFile"), reason: said(error, t("libAttachments.couldNotBeSent")) }),
        );
      }
      continue;
    }
    complaints.push(
      file.name ? t("libAttachments.cantAttachHere", { name: file.name }) : t("libAttachments.thatFileCantAttachHere"),
    );
  }
  return { attachments, refused: complaints.length ? complaints.join("; ") : null };
}

type Sendable = Pick<File, "name" | "size" | "type" | "slice">;

/**
 * A file sent to the conversation's server a part at a time, each part
 * its own request, so one of a few megabytes still fits through Bloks
 * Cloud. A part whose answer was lost is sent again; a send that fails
 * is called off so nothing half-sent is left behind. Answers with what
 * the server says it kept.
 *
 * `base` is where the parts go: an attachment's place unless said, or
 * another route that takes a file the same way (a transfer file for
 * Bring your setup), which answers the finish in a shape of its own.
 */
export async function sendInParts<Kept = { kind: "image"; path: string; mime: string; bytes: number } | { kind: "file"; path: string; name: string; bytes: number }>(
  file: Sendable,
  options: { fetcher?: Fetcher; partBytes: number; base?: string; onPart?: (sent: number, parts: number) => void },
): Promise<Kept> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? "/api/attachments/uploads";
  const call = async (path: string, init: RequestInit) => {
    const response = await fetcher(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // a server older than this app has nowhere to put a file
      const older = body?.code === "unknown_route";
      const words = older ? t("libAttachments.serverNeedsUpdate") : (body?.error ?? t("libAttachments.couldNotBeSent"));
      throw Object.assign(new Error(words), { status: response.status, older });
    }
    return body;
  };
  const started = await call(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type }),
  });
  const partSize = typeof started.partSize === "number" && started.partSize > 0 ? started.partSize : options.partBytes;
  try {
    let next = 0;
    let sent = 0;
    // a few at once, as a workspace move does: each is a round trip
    const lane = async () => {
      for (let index = next++; index < started.parts; index = next++) {
        const piece = new Uint8Array(await file.slice(index * partSize, Math.min(file.size, (index + 1) * partSize)).arrayBuffer());
        for (let tries = 1; ; tries++) {
          try {
            await call(`${base}/${started.id}/${index}`, {
              method: "PUT",
              headers: { "content-type": "application/octet-stream" },
              body: piece,
            });
            options.onPart?.(++sent, started.parts);
            break;
          } catch (error) {
            const status = (error as { status?: number }).status ?? 0;
            const again = tries < 4 && (status === 0 || status >= 500 || status === 408 || status === 429);
            if (!again) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400 * tries));
          }
        }
      }
    };
    await Promise.all([lane(), lane(), lane()]);
    return (await call(`${base}/${started.id}/finish`, { method: "POST" })) as Kept;
  } catch (error) {
    void fetcher(`${base}/${started.id}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}

/** A file the server cannot open where it lies, sent to it, with the path
 * it landed at. Refused in words, before anything is sent, when it is
 * bigger than the server takes. */
export async function uploadFileAttachment(file: Sendable, fetcher?: Fetcher): Promise<FileAttachment | null> {
  const where = await destination(fetcher);
  if (file.size > where.fileMaxBytes) {
    throw new Error(t("libAttachments.fileTooBig", { size: formatBytes(file.size), max: formatBytes(where.fileMaxBytes) }));
  }
  const kept = await sendInParts(file, { fetcher, partBytes: where.partBytes });
  return { kind: "file", id: newId(), path: kept.path, name: file.name || ("name" in kept ? kept.name : t("libAttachments.file")), bytes: kept.bytes };
}

// ── pictures made to fit ───────────────────────────────────────────────

/** What a picture needs before it goes within `budget` bytes: nothing, a
 * JPEG made of it, or, for a GIF over the budget, to be left as it is,
 * since a JPEG of a GIF stops it moving. A HEIC photo always needs a JPEG. */
export function imageNeeds(file: { type: string; name?: string; size: number }, budget: number): "as-is" | "jpeg" | "too-big" {
  if (isHeic(file)) return "jpeg";
  if (file.size <= budget) return "as-is";
  return file.type.split(";")[0]!.trim().toLowerCase() === "image/gif" ? "too-big" : "jpeg";
}

/** The longest side a picture made smaller goes at: more than an agent
 * looks at (they scale one down themselves), and enough to read a
 * screenshot's text by. */
export const LONG_EDGE = 2560;
/** Smaller than this on its long side, a picture is not worth sending. */
const SMALLEST_EDGE = 640;

/** One JPEG to try making. */
export interface JpegTry {
  width: number;
  height: number;
  quality: number;
}

/** The first JPEG to try: the picture's own size, no longer than LONG_EDGE. */
export function firstTry(width: number, height: number): JpegTry {
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 0.85 };
}

/** The next try after one came out `bytes` long, aimed under `budget`. A
 * JPEG's size follows its pixel count closely enough to aim by, with a
 * little held back, and each try is a tenth smaller at least, so this
 * ends. Null once smaller would not be worth sending. */
export function nextTry(last: JpegTry, bytes: number, budget: number): JpegTry | null {
  const scale = Math.min(0.9, Math.sqrt(budget / bytes) * 0.95);
  const width = Math.round(last.width * scale);
  const height = Math.round(last.height * scale);
  if (Math.max(width, height) < SMALLEST_EDGE) return null;
  return { width, height, quality: Math.max(0.6, Math.round((last.quality - 0.1) * 100) / 100) };
}

/** A picture opened to be made smaller. */
export interface OpenedImage {
  width: number;
  height: number;
  jpeg(at: JpegTry): Promise<Blob>;
  close(): void;
}

/** What makes a picture smaller: the page's own canvas, which reads every
 * kind a browser shows, and for a HEIC photo, which only Safari's reads,
 * the desktop app's converter (electron/main.mjs). Tests bring their own. */
export interface ImageTools {
  /** Null for a picture this page cannot read. */
  open(image: Blob): Promise<OpenedImage | null>;
  /** Null where there is no converter, or it could not read this one. */
  heicAsJpeg(image: Blob): Promise<Blob | null>;
}

export const pageImageTools: ImageTools = {
  async open(image) {
    if (typeof createImageBitmap !== "function") return null;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(image);
    } catch {
      return null;
    }
    return { width: bitmap.width, height: bitmap.height, jpeg: (at) => drawJpeg(bitmap, at), close: () => bitmap.close() };
  },
  async heicAsJpeg(image) {
    const convert = typeof window === "undefined" ? undefined : window.bloks?.heicAsJpeg;
    if (!convert) return null;
    const bytes = await convert(new Uint8Array(await image.arrayBuffer())).catch(() => null);
    return bytes?.length ? new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }) : null;
  },
};

async function drawJpeg(bitmap: ImageBitmap, at: JpegTry): Promise<Blob> {
  const paint = (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
    // a JPEG has no see-through, and a screenshot's clear corners would
    // otherwise come out black
    context.fillStyle = "#fff";
    context.fillRect(0, 0, at.width, at.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, at.width, at.height);
  };
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(at.width, at.height);
    paint(canvas.getContext("2d")!);
    return canvas.convertToBlob({ type: "image/jpeg", quality: at.quality });
  }
  const canvas = document.createElement("canvas");
  canvas.width = at.width;
  canvas.height = at.height;
  paint(canvas.getContext("2d")!);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("libAttachments.couldNotShrink")))), "image/jpeg", at.quality),
  );
}

/**
 * A picture as it should travel within `budget` bytes. Itself when it fits
 * and is a kind a server keeps, so a screenshot that fits stays a PNG;
 * otherwise a JPEG of it, as large as fits, no longer than LONG_EDGE. Null
 * for one over the budget that cannot be made smaller here (a GIF, or a
 * picture this page cannot read), for the caller to send as it is where
 * that still works, or to refuse in words. A HEIC photo is always a JPEG,
 * and one this window cannot make a JPEG of throws, marked `unconverted`.
 */
export async function fitImage(image: Blob & { name?: string }, budget: number, tools: ImageTools = pageImageTools): Promise<Blob | null> {
  const need = imageNeeds(image, budget);
  if (need === "as-is") return image;
  if (need === "too-big") return null;
  const opened = await tools.open(image);
  if (!opened) {
    if (!isHeic(image)) return null;
    const jpeg = await tools.heicAsJpeg(image);
    if (!jpeg) throw Object.assign(new Error(t("libAttachments.heicUnconverted")), { unconverted: true });
    return fitImage(jpeg, budget, tools);
  }
  try {
    for (let at: JpegTry | null = firstTry(opened.width, opened.height); at; ) {
      const jpeg = await opened.jpeg(at);
      if (jpeg.size <= budget) return jpeg;
      at = nextTry(at, jpeg.size, budget);
    }
    return null;
  } finally {
    opened.close();
  }
}

/** A picture made from another, as a file named for what it now is. */
function asSent(image: Blob, original: File): File {
  if (image === original) return original;
  // a file name the server keeps, so the same in every language
  const name = (original.name || "pasted image").replace(/\.[^./\\]{1,8}$/, "");
  return new File([image], `${name}.${image.type === "image/png" ? "png" : "jpg"}`, { type: image.type || "image/jpeg" });
}

const tooLargeForCloud = (image: Blob) =>
  new Error(
    image.type === "image/gif"
      ? t("libAttachments.gifTooLargeForCloud", { size: formatBytes(image.size) })
      : t("libAttachments.tooLargeForCloud", { size: formatBytes(image.size) }),
  );

/** Persist an image server-side; the prompt will carry the saved path.
 * To a server elsewhere it goes in parts, the way any file does, since
 * one request through Bloks Cloud carries well under 10 MB, and through
 * Bloks Cloud it is made to fit CLOUD_IMAGE_BYTES first. */
export async function uploadImageAttachment(
  file: File,
  fetcher?: Fetcher,
  tools: ImageTools = pageImageTools,
  /** Told once the picture is ready and starts going up, for its chip. */
  onUploading?: () => void,
): Promise<ImageAttachment | null> {
  if (!isImage(file) && !isHeic(file)) return null;
  const where = await destination(fetcher);
  let ready: File;
  if (!where.sameComputer) {
    // one that cannot be made smaller still goes as it is, in parts, which
    // carry a picture as big as the server takes
    ready = asSent((await fitImage(file, where.throughCloud ? CLOUD_IMAGE_BYTES : where.imageMaxBytes, tools)) ?? file, file);
    if (ready.size > where.imageMaxBytes) {
      throw new Error(t("libAttachments.imageTooBig", { size: formatBytes(ready.size), max: formatBytes(where.imageMaxBytes) }));
    }
    try {
      onUploading?.();
      const kept = await sendInParts(ready, { fetcher, partBytes: where.partBytes });
      if (kept.kind !== "image") throw new Error(t("libAttachments.notAnImage"));
      return { kind: "image", id: newId(), path: kept.path, name: ready.name || t("libAttachments.pastedImage"), bytes: kept.bytes, mime: kept.mime };
    } catch (error) {
      // a server older than this app still takes an image in one piece
      if (!(error as { older?: boolean }).older) throw error;
    }
    // in one request, which such a server reads off Bloks Cloud's stream
    // only up to OLDER_SERVER_IMAGE_BYTES of picture
    if (ready.size > OLDER_SERVER_IMAGE_BYTES) {
      const smaller = await fitImage(file, OLDER_SERVER_IMAGE_BYTES, tools);
      if (!smaller) throw tooLargeForCloud(ready);
      ready = asSent(smaller, file);
    }
  } else {
    // the app's own server: as it is up to its cap, and made to fit that
    const fitted = await fitImage(file, IMAGE_MAX_BYTES, tools);
    if (!fitted) throw new Error(t("libAttachments.over10Mb", { name: file.name || t("libAttachments.image") }));
    ready = asSent(fitted, file);
    onUploading?.();
  }
  const response = await (fetcher ?? fetch)("/api/attachments", {
    method: "POST",
    headers: { "content-type": ready.type },
    body: new Uint8Array(await ready.arrayBuffer()),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? t("libAttachments.uploadFailed"));
  }
  const saved = await response.json();
  return {
    kind: "image",
    id: newId(),
    path: saved.path,
    name: ready.name || t("libAttachments.pastedImage"),
    bytes: saved.bytes,
    mime: saved.mime,
  };
}

/**
 * The prompt the agent receives: what was typed, then one block per
 * chip. Tagged blocks rather than fences, because pasted code carries
 * fences of its own and nesting them loses the boundary.
 */
export function composeOutgoing(text: string, attachments: Attachment[]): string {
  const parts = [text.trim()];
  for (const a of attachments) {
    if (a.kind === "paste") parts.push(`<pasted-text>\n${a.text}\n</pasted-text>`);
    else if (a.kind === "image") parts.push(`<attached-image path="${escapeAttr(a.path)}" />`);
    else parts.push(`<attached-file path="${escapeAttr(a.path)}" />`);
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Paths are untrusted prompt content; a filename full of quotes must
 * stay inside its attribute. */
function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

const unescapeAttr = (raw: string) =>
  raw
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#10;", "\n")
    .replaceAll("&#13;", "\r")
    .replaceAll("&amp;", "&");

/** Transcript rendering: the display text with the attachment machinery
 * lifted out, so the bubble shows a thumbnail or a filename chip where
 * the tags would have been. Pasted text stays put; it is real content.
 *
 * A voice message (from Telegram, written by the server) comes back as
 * the path of its audio, and what remains is what it was heard as. */
export function splitAttachments(text: string): {
  display: string;
  images: string[];
  files: string[];
  voice: string[];
} {
  const images: string[] = [];
  const files: string[] = [];
  const voice: string[] = [];
  const display = text
    .replace(/<voice-message\s+path="([^"]*)"(?:\s+note="[^"]*")?\s*\/>\s*/g, (_whole, raw: string) => {
      const path = unescapeAttr(raw);
      if (path) voice.push(path);
      return "";
    })
    .replace(/<attached-image\s+path="([^"]*)"\s*\/>(?:\s*\n)?/g, (_whole, raw: string) => {
      const path = unescapeAttr(raw);
      if (path) images.push(path);
      return "";
    })
    .replace(/<attached-file\s+path="([^"]*)"\s*\/>(?:\s*\n)?/g, (_whole, raw: string) => {
      const path = unescapeAttr(raw);
      if (path) files.push(path);
      return "";
    });
  return { display: display.trim(), images, files, voice };
}

/** The bare filename a saved path ends in, which is what the serving
 * route wants. Both slash directions, for transcripts that crossed OSes. */
export function attachmentBasename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? "";
}

const ONE_PLACE = { minimumFractionDigits: 1, maximumFractionDigits: 1 } as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return t("libAttachments.bytes", { size: formatNumber(bytes) });
  if (bytes < 1024 * 1024) return t("libAttachments.kilobytes", { size: formatNumber(bytes / 1024, ONE_PLACE) });
  return t("libAttachments.megabytes", { size: formatNumber(bytes / (1024 * 1024), ONE_PLACE) });
}
