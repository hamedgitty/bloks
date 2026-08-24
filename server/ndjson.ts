// Newline-delimited JSON off a stream.
//
// Every stdio protocol in this codebase is one JSON document per line, and
// every one of them has the same two hazards: a chunk boundary can land
// mid-line, and not every line is protocol (CLIs log to stdout too). One
// implementation, so neither is re-solved per file.
import type { Readable } from "node:stream";

/** Calls `each` with every well-formed JSON line. Anything unparseable is
 * skipped rather than thrown: a stray log line should not end a turn. */
export function readJsonLines(stream: Readable, each: (value: any) => void) {
  let buffered = "";

  stream.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const cut = buffered.indexOf("\n");
      if (cut === -1) break;

      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      if (!line.trim()) continue;

      try {
        each(JSON.parse(line));
      } catch {
        /* not protocol */
      }
    }
  });
}
