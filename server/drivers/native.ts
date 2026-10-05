// The untranslated copy.
//
// Alongside the normalised event log, each provider's own messages are
// written exactly as they arrived. When a provider changes its wire format
// the two logs disagree, and the disagreement points straight at the line
// that needs updating. It has paid for itself more than once.
//
// Exactly as they arrived, with one exception. Codex answers thread/resume
// with the whole conversation so far, and a Codex lane resumes its thread
// on every turn, so the copy grew by the entire history each time: a busy
// server found 8 GB of its native logs were the same turns written over
// and over (GitHub 157). That history says nothing about the wire format
// that the first copy did not, so it is written as a count instead. Every
// other frame, the token usage ones included, is left as it came.
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { NATIVE_DIR } from "../config.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  try {
    appendFileSync(
      join(NATIVE_DIR, `${threadId}.ndjson`),
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: slimFrame(entry.msg) }) + "\n",
    );
  } catch {
    /* never let logging break a run */
  }
}

/** A frame as the copy keeps it: a thread handed back whole loses its
 * turns and keeps how many there were. A new object when anything is
 * taken out, so the frame the driver is still reading is never touched. */
export function slimFrame(msg: unknown): unknown {
  const result = (msg as { result?: { thread?: { turns?: unknown } } } | null)?.result;
  const turns = result?.thread?.turns;
  if (!Array.isArray(turns)) return msg;
  const { turns: _dropped, ...thread } = result!.thread!;
  return {
    ...(msg as object),
    result: { ...result, thread: { ...thread, turnCount: turns.length } },
  };
}

const THREAD = '"turns":[';

/** Whether a copy holds any thread at all, read without writing: most
 * lanes never resumed a Codex thread and need no second copy made. */
async function holdsThreads(path: string): Promise<boolean> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.includes(THREAD)) {
      lines.close();
      return true;
    }
  }
  return false;
}

/** Marks a folder whose copies were already slimmed, so the pass below
 * runs once per data folder rather than on every start. */
const SLIMMED = ".slimmed-1";

/**
 * The same slimming, once, for copies written before it existed. A file
 * is rewritten beside itself and swapped in only if nothing was appended
 * while it was being read; the size check and the swap run with nothing
 * awaited between them, and only this process writes these files, so an
 * append can never land in the gap. A file that changed is left for the
 * next start. Lines without a thread in them are copied as they are,
 * without being parsed, which is nearly all of them.
 */
export async function slimNativeLogs(dir: string = NATIVE_DIR): Promise<{ files: number; saved: number }> {
  const marker = join(dir, SLIMMED);
  if (!existsSync(dir) || existsSync(marker)) return { files: 0, saved: 0 };
  let files = 0;
  let saved = 0;
  let unfinished = false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson")) continue;
    const path = join(dir, name);
    const temp = `${path}.slimming`;
    let changed = false;
    try {
      const before = statSync(path);
      if (!(await holdsThreads(path))) continue;
      const out = createWriteStream(temp);
      const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of lines) {
        let kept = line;
        if (line.includes(THREAD)) {
          try {
            const entry = JSON.parse(line);
            const slim = slimFrame(entry.msg);
            if (slim !== entry.msg) {
              kept = JSON.stringify({ ...entry, msg: slim });
              changed = true;
            }
          } catch {
            /* a line that is not JSON is kept as it is */
          }
          // a resumed thread can be megabytes; let the server breathe
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (!out.write(kept + "\n")) await new Promise((resolve) => out.once("drain", resolve));
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
      // From here to the swap nothing is awaited, so no append can land
      // between the check and the rename.
      const now = statSync(path);
      if (changed && now.size === before.size && now.mtimeMs === before.mtimeMs) {
        saved += before.size - statSync(temp).size;
        renameSync(temp, path);
        files++;
      } else {
        // nothing to take out, or written to while it was read
        if (changed) unfinished = true;
        unlinkSync(temp);
      }
    } catch {
      // a lane deleted mid-pass, a full disk: leave the file as it was
      unfinished = true;
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
  if (!unfinished) {
    try {
      writeFileSync(marker, new Date().toISOString());
    } catch {}
  }
  return { files, saved };
}
