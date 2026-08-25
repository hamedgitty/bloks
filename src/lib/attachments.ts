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

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isImage(file: { type: string }): boolean {
  return IMAGE_MIMES.has(file.type.split(";")[0]!.trim().toLowerCase());
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

/**
 * The one intake for the picker, the drop and the paste, so a picked
 * file and a dropped one can never sort differently. The caller owns
 * the network (uploadImage) and the disk-path bridge (pathOf); this
 * owns the ordering and the sentence the user reads when something is
 * refused. Nothing is dropped in silence.
 */
export async function intakeFiles<T extends IncomingFile>(
  files: readonly T[],
  handlers: {
    pathOf: (file: T) => string;
    uploadImage: (file: T) => Promise<ImageAttachment | null>;
  },
): Promise<{ attachments: Attachment[]; refused: string | null }> {
  const attachments: Attachment[] = [];
  const complaints: string[] = [];
  // One at a time, so the chips keep the order the files were chosen in.
  for (const file of files) {
    if (isImage(file)) {
      try {
        const uploaded = await handlers.uploadImage(file);
        if (uploaded) attachments.push(uploaded);
      } catch (error) {
        complaints.push(`${file.name || "image"}: ${error instanceof Error ? error.message : "upload failed"}`);
      }
      continue;
    }
    let path = "";
    try {
      path = handlers.pathOf(file);
    } catch {
      // a plain browser tab has no disk path to give
    }
    if (path) {
      attachments.push(fileAttachment(file.name, path, file.size));
      continue;
    }
    if ((file.type.startsWith("text/") || file.type === "application/json") && file.size <= INLINE_TEXT_LIMIT) {
      try {
        attachments.push(pasteAttachment(await file.text()));
        continue;
      } catch {
        // unreadable drag; falls through to the complaint
      }
    }
    complaints.push(`${file.name || "that file"} has no path Bloks can hand to an agent`);
  }
  return { attachments, refused: complaints.length ? complaints.join("; ") : null };
}

/** Persist an image server-side; the prompt will carry the saved path. */
export async function uploadImageAttachment(file: File): Promise<ImageAttachment | null> {
  if (!isImage(file)) return null;
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`${file.name || "image"} is over 10 MB`);
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { "content-type": file.type },
    body: new Uint8Array(await file.arrayBuffer()),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? "upload failed");
  }
  const saved = await response.json();
  return {
    kind: "image",
    id: newId(),
    path: saved.path,
    name: file.name || "pasted image",
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
 * the tags would have been. Pasted text stays put; it is real content. */
export function splitAttachments(text: string): {
  display: string;
  images: string[];
  files: string[];
} {
  const images: string[] = [];
  const files: string[] = [];
  const display = text
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
  return { display: display.trim(), images, files };
}

/** The bare filename a saved path ends in, which is what the serving
 * route wants. Both slash directions, for transcripts that crossed OSes. */
export function attachmentBasename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
