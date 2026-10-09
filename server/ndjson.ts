// Newline-delimited JSON off a stream.
//
// Every stdio protocol in this codebase is one JSON document per line, and
// every one of them has the same two hazards: a chunk boundary can land
// mid-line, and not every line is protocol (CLIs log to stdout too). One
// implementation, so neither is re-solved per file.
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * A line splitter for a stream, fed one chunk at a time, that calls
 * `each` with every complete line, newline taken off.
 *
 * It looks for newlines only in the chunk that just came, and joins a
 * line's pieces once, when its newline arrives. The obvious version
 * (append to one string, search it from the start) reads a line in time
 * quadratic in its length: a Codex resume answered with a 40 MB history
 * took over half a minute to read, longer than the bound on the whole
 * handshake, and held up every other lane on the server's one thread
 * meanwhile (GitHub 230). Bytes are decoded as a stream, so a character
 * split across two chunks arrives whole.
 */
export function lineSplitter(each: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder("utf8");
  let pieces: string[] = [];
  return (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (let cut = text.indexOf("\n", start); cut !== -1; cut = text.indexOf("\n", start)) {
      pieces.push(text.slice(start, cut));
      const line = pieces.length === 1 ? pieces[0] : pieces.join("");
      pieces = [];
      start = cut + 1;
      each(line);
    }
    if (start < text.length) pieces.push(text.slice(start));
  };
}

/** Calls `each` with every well-formed JSON line. Anything unparseable is
 * skipped rather than thrown: a stray log line should not end a turn. */
export function readJsonLines(stream: Readable, each: (value: any) => void) {
  stream.on(
    "data",
    lineSplitter((line) => {
      if (!line.trim()) return;
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        return; /* not protocol */
      }
      each(value);
    }),
  );
}
