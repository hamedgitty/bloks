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
//
// Even slimmed, a copy only ever grew: one machine had a single lane's
// file at 9.4 GB (GitHub 159). So a lane's file is moved aside once it
// passes a size, gzipped in the background, and only the newest few of
// those are kept. The live file is never cut short or rewritten for it.
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { NATIVE_DIR } from "../config.ts";

/** Past this, a lane's file is moved aside and a new one started. */
export const NATIVE_CAP = 20 * 1024 * 1024;
/** Gzipped copies kept per lane; older ones are deleted. */
export const NATIVE_KEPT = 3;
/** Inside the native folder, where the moved-aside copies go. */
const ARCHIVE = "archive";

/** Roughly how big each lane's file is, so an append needs no stat: one
 * the first time a lane writes, then a running count. */
const sizes = new Map<string, number>();
/** Moved-aside files being gzipped right now, so a sweep leaves them be. */
const compressing = new Map<string, Promise<void>>();

export function appendNative(
  threadId: string,
  entry: { dir: "in" | "out"; source: string; msg: unknown },
  dir: string = NATIVE_DIR,
) {
  try {
    const path = join(dir, `${threadId}.ndjson`);
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry, msg: slimFrame(entry.msg) }) + "\n";
    let size = sizes.get(path);
    // The count can run high (the slimming pass shrinks files under it),
    // so it is checked against the disk before anything is moved. A file
    // already too big when Bloks started is moved on its first append.
    if (size === undefined || size >= NATIVE_CAP) size = sizeOf(path);
    if (size >= NATIVE_CAP) {
      try {
        void rotateNative(threadId, dir);
        size = 0;
      } catch {
        /* still written below, just not moved aside */
      }
    }
    appendFileSync(path, line);
    sizes.set(path, size + Buffer.byteLength(line));
  } catch {
    /* never let logging break a run */
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** UTC time for an archive name, compact, and sorting in time order. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:.]/g, "");

/**
 * Moves a lane's file aside and starts gzipping it. A rename, so the
 * next append starts a fresh file and nothing written is lost or copied
 * twice. Resolves once the gzip is done.
 */
export function rotateNative(threadId: string, dir: string = NATIVE_DIR): Promise<void> {
  const path = join(dir, `${threadId}.ndjson`);
  const archive = join(dir, ARCHIVE);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  // two in the same millisecond would share a name; the later one moves
  // a millisecond on, which keeps the names in order
  let at = Date.now();
  let moved = join(archive, `${threadId}.${stamp(at)}.ndjson`);
  while (existsSync(moved) || existsSync(`${moved}.gz`)) moved = join(archive, `${threadId}.${stamp(++at)}.ndjson`);
  renameSync(path, moved);
  sizes.set(path, 0);
  return compress(moved).then(() => prune(archive, threadId));
}

/** Gzips a moved-aside file beside itself, streamed, since it can be
 * gigabytes. The plain copy is deleted only once the gzip is whole. */
function compress(path: string): Promise<void> {
  const running = compressing.get(path);
  if (running) return running;
  const partial = `${path}.gz.partial`;
  const done = pipeline(createReadStream(path), createGzip(), createWriteStream(partial, { mode: 0o600 }))
    .then(() => {
      // the lane was deleted while this ran
      if (!existsSync(path)) return unlinkSync(partial);
      renameSync(partial, `${path}.gz`);
      unlinkSync(path);
    })
    .catch(() => {
      // a full disk, say: the plain copy stays for the next start
      try {
        unlinkSync(partial);
      } catch {}
    })
    .finally(() => compressing.delete(path));
  compressing.set(path, done);
  return done;
}

/** Deletes all but a lane's newest gzipped copies. */
function prune(archive: string, threadId: string) {
  try {
    const old = readdirSync(archive)
      .filter((name) => name.startsWith(`${threadId}.`) && name.endsWith(".ndjson.gz"))
      .sort()
      .slice(0, -NATIVE_KEPT);
    for (const name of old) unlinkSync(join(archive, name));
  } catch {}
}

/** Everything a lane left in the native folder, gone with the lane. */
export function forgetNative(threadId: string, dir: string = NATIVE_DIR) {
  const path = join(dir, `${threadId}.ndjson`);
  sizes.delete(path);
  try {
    unlinkSync(path);
  } catch {}
  try {
    const archive = join(dir, ARCHIVE);
    for (const name of readdirSync(archive)) {
      if (!name.startsWith(`${threadId}.`)) continue;
      try {
        unlinkSync(join(archive, name));
      } catch {}
    }
  } catch {}
}

/** Waits for any gzip still running. For the tests. */
export async function nativeSettled() {
  await Promise.all(compressing.values());
}

/**
 * Once per start. Moves aside files that were already too big, which
 * matters for lanes nobody writes to any more, and finishes what a quit
 * or a crash cut short: a half-written gzip is thrown away and its plain
 * copy gzipped again.
 */
export async function tidyNativeLogs(dir: string = NATIVE_DIR): Promise<{ rotated: number }> {
  let rotated = 0;
  if (!existsSync(dir)) return { rotated };
  const work: Promise<void>[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson")) continue;
    try {
      if (statSync(join(dir, name)).size < NATIVE_CAP) continue;
      work.push(rotateNative(name.slice(0, -".ndjson".length), dir));
      rotated++;
    } catch {}
  }
  const archive = join(dir, ARCHIVE);
  if (!existsSync(archive)) return { rotated };
  const lanes = new Set<string>();
  for (const name of readdirSync(archive)) {
    const path = join(archive, name);
    lanes.add(name.split(".")[0]);
    try {
      if (name.endsWith(".gz.partial") && !compressing.has(path.slice(0, -".gz.partial".length))) {
        unlinkSync(path);
      } else if (name.endsWith(".ndjson") && !compressing.has(path)) {
        // gzipped, then stopped before the plain copy was deleted
        if (existsSync(`${path}.gz`)) unlinkSync(path);
        else work.push(compress(path));
      }
    } catch {}
  }
  await Promise.all(work);
  for (const lane of lanes) prune(archive, lane);
  return { rotated };
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
