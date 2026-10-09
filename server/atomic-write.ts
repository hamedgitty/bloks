// Saving a file so that a crash leaves the old one or the new one.
//
// Every store under ~/.bloks writes its whole file back on each change.
// writeFileSync empties the file first and writes it second, so a crash,
// a full disk or a power cut in between leaves it cut short. Here the new
// text goes to a file beside it, is flushed to the disk, and only then is
// renamed over the old one, which the filesystem does in one step.
//
// The other half is what a loader does with a file that will not parse.
// Most of them take it as nothing saved yet, which is right on a first
// run and a disaster after a bad write: the next save puts the empty
// state over the only copy there was. config.json is the worst of them,
// since it holds every key and is rewritten each time the Telegram offset
// moves. setAside moves such a file out of the way first, so what was in
// it is still on disk for somebody to recover by hand.
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

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
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Moves a file that could not be read out of the way, to
 * `<name>.corrupt-<time>` beside it, so the next save starts a new file
 * instead of writing over this one. A file that is simply not there yet
 * is left alone. Returns where the file went, or null. */
export function setAside(file: string, error: unknown): string | null {
  // Only a file that was read and is not JSON. A file that could not be
  // read this once (too many open files, a permission blip) may be fine,
  // and moving it would hide a good conversation behind a bad moment.
  if (!(error instanceof SyntaxError)) return null;
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(file, aside);
  } catch {
    // gone already, or it cannot be moved; there is nothing more to try
    return null;
  }
  // Never the parse error's message: V8 quotes the text around the fault,
  // and in config.json that text can be part of a key.
  console.warn(`[bloks] ${basename(file)} could not be read (it is not valid JSON). It was kept as ${aside}, and a new one starts empty.`);
  return aside;
}
