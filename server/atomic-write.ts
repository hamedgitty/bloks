// Saving a file so that a crash leaves the old one or the new one.
//
// Every store under ~/.bloks writes its whole file back on each change.
// writeFileSync empties the file first and writes it second, so a crash,
// a full disk or a power cut in between leaves it cut short. Here the new
// text goes to a file beside it, is flushed to the disk, and only then is
// renamed over the old one, which the filesystem does in one step.
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Replaces `file` with `data` in one step. With a mode, the new file has
 * exactly that mode from the moment it exists, so a key in it is never
 * readable by anyone else, not even between a write and a chmod. Throws
 * when the new one cannot be written, and the old one is left as it was. */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode?: number): void {
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
    fsyncSync(fd);
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
