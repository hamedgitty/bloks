// A small zip reader, for files somebody else's app wrote.
//
// Bringing a setup over can start from a transfer file another agent app
// writes, which is a .zip. Only a few things in it are ever wanted, so
// this reads the format here rather than adding a dependency, the same
// call the TOML and JSON5 readers made: the central directory at the end
// says what is inside, and each entry is read on its own, when asked for,
// from the file on disk rather than from a copy of it in memory.
//
// The file comes from outside, so it is judged before anything in it is
// read, and the judgement is all or nothing. A name that is absolute,
// climbs out with "..", or is a link; an entry that is encrypted, packed
// some other way than stored or deflated, or named twice; more entries,
// or more bytes once unpacked, than the caller allows: any one of those
// and the whole file is refused with the reason, since a file built to
// get one of them past a reader is not one to take anything else from.
//
// An entry is unpacked into exactly the size its directory says and no
// further, so a small entry that would unpack into gigabytes stops at
// its declared size and is refused, and its checksum is checked when the
// running Node can.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import * as zlib from "node:zlib";

export interface ZipEntry {
  /** As written in the file, with forward slashes. A folder ends in "/". */
  name: string;
  /** Unpacked, as the directory says. */
  size: number;
  packed: number;
  crc: number;
  method: 0 | 8;
  /** Where its local header starts. */
  at: number;
}

export interface ZipLimits {
  /** Entries in the file, folders included. */
  entries: number;
  /** Every entry unpacked, together. */
  total: number;
  /** Any one entry unpacked. */
  entry: number;
}

export class ZipRefused extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record, plus the longest comment a zip may carry. */
const TAIL = 22 + 0xffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

function readAt(fd: number, at: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, out, done, length - done, at + done);
    if (n === 0) throw new ZipRefused("it ends sooner than it says");
    done += n;
  }
  return out;
}

/**
 * Why a name is not one to read, or null. The zip format writes forward
 * slashes; a backslash, a drive letter or a leading slash is a name that
 * means a place outside the folder it would be unpacked in, on one
 * system or another.
 */
export function unsafeEntryName(name: string): string | null {
  if (!name || name.length > 512) return "an entry with no name, or one too long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "an entry whose name has control characters in it";
  if (name.includes("\\")) return "an entry named with a backslash";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "an entry with an absolute path";
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return "an entry whose path climbs out of the file";
  return null;
}

/**
 * What is inside a zip, judged whole. Throws ZipRefused, saying why, for
 * anything this will not read; an entry that is a folder is listed too,
 * so a caller can tell an empty folder from a missing one.
 */
export function listZip(path: string, limits: ZipLimits): ZipEntry[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new ZipRefused("it is not a zip file");
    const tailLength = Math.min(size, TAIL);
    const tail = readAt(fd, size - tailLength, tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new ZipRefused("it is not a zip file");
    const disk = tail.readUInt16LE(end + 4);
    const startDisk = tail.readUInt16LE(end + 6);
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirAt = tail.readUInt32LE(end + 16);
    if (disk !== 0 || startDisk !== 0) throw new ZipRefused("it is one part of a zip split over several files");
    // the 64-bit form says so by filling these with ones
    if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) throw new ZipRefused("it is larger than Bloks reads a zip file");
    if (count > limits.entries) throw new ZipRefused(`it holds more than ${limits.entries.toLocaleString("en-US")} entries`);
    if (dirAt + dirSize > size) throw new ZipRefused("its directory points past its end");
    const dir = readAt(fd, dirAt, dirSize);

    const entries: ZipEntry[] = [];
    const spans: Array<{ at: number; end: number }> = [];
    const seen = new Set<string>();
    let total = 0;
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw new ZipRefused("its directory cannot be read");
      const madeBy = dir.readUInt16LE(p + 4);
      const flags = dir.readUInt16LE(p + 8);
      const method = dir.readUInt16LE(p + 10);
      const crc = dir.readUInt32LE(p + 16);
      const packed = dir.readUInt32LE(p + 20);
      const unpacked = dir.readUInt32LE(p + 24);
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      const external = dir.readUInt32LE(p + 38);
      const at = dir.readUInt32LE(p + 42);
      const next = p + 46 + nameLength + extraLength + commentLength;
      if (next > dir.length) throw new ZipRefused("its directory cannot be read");
      // flag 11 says UTF-8; the older code page agrees with it for every
      // name worth reading here, which is plain ASCII
      const name = dir.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
      p = next;

      const unsafe = unsafeEntryName(name);
      if (unsafe) throw new ZipRefused(`it holds ${unsafe}`);
      if (packed === 0xffffffff || unpacked === 0xffffffff || at === 0xffffffff) throw new ZipRefused("it is larger than Bloks reads a zip file");
      if (flags & 0x1) throw new ZipRefused("it holds an encrypted entry");
      // made on a Unix system, the top half of the attributes is the mode
      if (madeBy >> 8 === 3 && ((external >>> 16) & S_IFMT) === S_IFLNK) throw new ZipRefused("it holds a link");
      if (method !== 0 && method !== 8) throw new ZipRefused("it holds an entry packed in a way Bloks does not read");
      if (method === 0 && packed !== unpacked) throw new ZipRefused("its directory cannot be read");
      if (unpacked > limits.entry) throw new ZipRefused(`it holds an entry larger than ${Math.round(limits.entry / (1024 * 1024))} MB`);
      total += unpacked;
      if (total > limits.total) throw new ZipRefused(`it unpacks to more than ${Math.round(limits.total / (1024 * 1024))} MB`);
      const key = name.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) throw new ZipRefused("it names one entry twice");
      seen.add(key);
      if (at + 30 + packed > size) throw new ZipRefused("an entry points past its end");
      // Deflate never grows what it packs by more than a few bytes a
      // block, so packed bytes far past the unpacked size are a file that
      // makes every read of a tiny entry load most of the file.
      if (method === 8 && packed > unpacked + Math.ceil(unpacked / 16_000) * 5 + 128) throw new ZipRefused("its directory cannot be read");
      entries.push({ name, size: unpacked, packed, crc, method, at });
      spans.push({ at, end: at + 30 + nameLength + packed });
    }
    // each entry's bytes are its own: entries that share them are the same
    // blob read again and again under different names
    spans.sort((a, b) => a.at - b.at);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i]!.at < spans[i - 1]!.end) throw new ZipRefused("its entries overlap");
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * One entry's bytes, unpacked to the size its directory says. Throws
 * ZipRefused when the bytes are not what the directory promised: a
 * local header that names something else, more or fewer bytes than
 * declared, or the wrong checksum.
 */
export function readZipEntry(path: string, entry: ZipEntry): Buffer {
  const fd = openSync(path, "r");
  try {
    const head = readAt(fd, entry.at, 30);
    if (head.readUInt32LE(0) !== LOCAL) throw new ZipRefused(`${entry.name} cannot be read`);
    const nameLength = head.readUInt16LE(26);
    const extraLength = head.readUInt16LE(28);
    const raw = readAt(fd, entry.at + 30, nameLength);
    if (raw.toString("utf8") !== entry.name && raw.toString("latin1") !== entry.name) throw new ZipRefused(`${entry.name} is named differently inside the file`);
    const packed = readAt(fd, entry.at + 30 + nameLength + extraLength, entry.packed);
    let bytes: Buffer;
    if (entry.method === 0) bytes = packed;
    else {
      try {
        // one byte of room, so an entry that would run past its size is
        // caught rather than quietly cut to fit
        bytes = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size + 1) });
      } catch {
        throw new ZipRefused(`${entry.name} does not unpack to what the file says`);
      }
    }
    if (bytes.length !== entry.size) throw new ZipRefused(`${entry.name} does not unpack to what the file says`);
    if (typeof zlib.crc32 === "function" && zlib.crc32(bytes) >>> 0 !== entry.crc >>> 0) {
      throw new ZipRefused(`${entry.name} is damaged`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
