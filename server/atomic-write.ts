// Saving a file so that a crash leaves the old one or the new one.
//
// Every store under ~/.bloks writes its whole file back on each change.
// writeFileSync empties the file first and writes it second, so a crash,
// a full disk or a power cut in between leaves it cut short. Here the new
// text goes to a file beside it, is flushed to the disk, and only then is
// renamed over the old one, which the filesystem does in one step.
//
// A missing saved file starts empty. A file that cannot be read must
// never do so: the next save would overwrite the only copy there was.
// Invalid saved data is kept aside before starting a new file.
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

/** Replaces `file` with `data` in one step. With a mode, the new file has
 * exactly that mode from the moment it exists, so a key in it is never
 * readable by anyone else, not even between a write and a chmod. Throws
 * when the new one cannot be written, and the old one is left as it was. */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  mode?: number,
  { flush = true }: { flush?: boolean } = {},
): void {
  // Beside the file, so the rename stays on one filesystem and is atomic.
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", mode ?? 0o666);
  try {
    // A temp left by a crash is reused here, and it keeps the mode it was
    // made with unless told otherwise.
    if (mode !== undefined) {
      try {
        fchmodSync(fd, mode);
      } catch {
        /* a filesystem without modes; best effort, as chmod always was */
      }
    }
    writeFileSync(fd, data);
    // The rename can reach the disk before the text does, so without
    // this a power cut soon after a save can still leave the file empty.
    // A file rewritten on every message (a transcript, the agents) skips
    // it: the flush would sit on the server's only thread each time, and
    // the rename alone already survives a crash of Bloks itself.
    if (flush) fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  // On Windows a rename over a file fails for a moment while an antivirus
  // scanner, the indexer or a backup tool has it open. It is tried again
  // a few times, briefly, and then the file is written in place, which is
  // what these saves did before they were atomic: a save that is merely
  // not atomic beats one that throws after memory has already changed.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (busy && attempt < RENAME_TRIES) {
        Atomics.wait(PAUSE, 0, 0, 20 * (attempt + 1));
        continue;
      }
      rmSync(temp, { force: true });
      if (!busy) throw error;
      writeFileSync(file, data, mode === undefined ? undefined : { mode });
      return;
    }
  }
}

/** How many times a busy rename is tried again, 20 ms further apart each. */
const RENAME_TRIES = 5;
/** Something to wait on, for a short synchronous pause between tries. */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Reads replacement state only after a successful read and top-level
 * check. Per-entry filtering remains with the store. A failed read is
 * never an empty value, and a later call can retry the original file.
 * The decoder also covers saved keys, which are PEM rather than JSON. */
export function readSaved<T>(
  file: string,
  empty: T,
  valid: (value: T) => boolean,
  decode: (text: string) => T = JSON.parse,
): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw savedFileError(file, "read", error);
  }
  let value: T;
  try {
    value = decode(text);
    if (!valid(value)) throw new Error("invalid saved shape");
  } catch {
    // Decode errors may quote secrets. Neither the error nor the text
    // goes into a warning, a cause, or the refusal if preservation fails.
    setAside(file);
    return empty;
  }
  return value;
}

/** The top level of object stores, excluding null and arrays. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function savedFileError(file: string, operation: string, error: unknown): Error {
  const raw = (error as NodeJS.ErrnoException)?.code;
  const code = typeof raw === "string" && /^[A-Z0-9_]+$/.test(raw) ? raw : "IO_ERROR";
  return Object.assign(new Error(
    `[bloks] Cannot ${operation} ${basename(file)} (${code}). Restore file access and retry; saved data was left unchanged.`,
  ), { code });
}

/** Called only after a successful read rejected the saved data. If the
 * move fails, no caller may install empty state over the original. */
function setAside(file: string): void {
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  try {
    renameSync(file, aside);
  } catch (error) {
    throw savedFileError(file, "preserve invalid data in", error);
  }
  // Never the parse error's message: V8 quotes the text around the fault,
  // and in config.json that text can be part of a key.
  console.warn(`[bloks] ${basename(file)} could not be read (invalid saved data). It was kept as ${aside}, and a new one starts empty.`);
}
