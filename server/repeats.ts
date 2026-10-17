// Compatibility/diagnostic signatures for driver events. These are not
// repeat counters and do not establish whether work is making progress.
import { createHash } from "node:crypto";

/** How deep into nested arguments two calls are compared. Arguments are
 * JSON a model wrote, and a recursive walk over something built to be
 * deep would run out of stack. */
const MAX_DEPTH = 32;

/**
 * What a call asked for, as a short name: the tool and its arguments,
 * normalised, then hashed.
 *
 * Normalised so the same request written two ways is one request: object
 * keys in order, strings trimmed and their runs of spaces made one.
 * The digest avoids including raw arguments in this field. It is not
 * encryption and does not make guessable or arbitrary arguments secret.
 */
export function callSignature(tool: string | undefined, args: unknown): string {
  return createHash("sha256")
    .update(`${tool || "tool"}\0${normalised(args, 0)}`)
    .digest("hex")
    .slice(0, 16);
}

function normalised(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return '"..."';
  if (typeof value === "string") return JSON.stringify(value.replace(/\s+/g, " ").trim());
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => normalised(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${normalised(record[key], depth + 1)}`).join(",")}}`;
  }
  return "null";
}
