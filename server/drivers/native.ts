// The untranslated copy.
//
// Alongside the normalised event log, each provider's own messages are
// written exactly as they arrived. When a provider changes its wire format
// the two logs disagree, and the disagreement points straight at the line
// that needs updating. It has paid for itself more than once.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  try {
    appendFileSync(
      join(NATIVE_DIR, `${threadId}.ndjson`),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    /* never let logging break a run */
  }
}
