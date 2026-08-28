// Every bound the harness enforces, in one place.
//
// The API listens on loopback and checks Origin, so this is not a public
// endpoint. It is still the front door for anything running on the same
// machine, and an unbounded field is an unbounded file on disk, an
// unbounded system prompt, and an unbounded row in the UI. Nothing here
// should ever be hit by a person typing.

/** A single message. Long enough to paste a stack trace or a document. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Names, titles and other one-liners that render in a list. */
export const MAX_NAME_CHARS = 80;
export const MAX_TITLE_CHARS = 160;

/** Descriptions and greetings, which become part of the system prompt. */
export const MAX_DESCRIPTION_CHARS = 4_000;

/** Freeform skill lines on an agent. */
export const MAX_SKILL_CHARS = 400;
export const MAX_SKILLS = 12;

/** Request bodies. Screen frames are the only large ones. */
export const MAX_BODY_BYTES = 2_000_000;

/** Simultaneous event-stream listeners. One app needs one. */
export const MAX_SSE_CLIENTS = 32;

/** User-added OpenAI-compatible hosts, and keys on one host. */
export const MAX_CUSTOM_ENDPOINTS = 16;
export const MAX_CUSTOM_KEYS = 8;
export const MAX_KEY_CHARS = 400;
export const MAX_URL_CHARS = 400;

/** Trims a value to a cap, returning undefined when there is nothing
 * left. Callers decide whether absent means "skip" or "reject". */
export function clamp(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Same, for a list of short strings. */
export function clampList(value: unknown, max: number, count: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => clamp(item, max))
    .filter((item): item is string => Boolean(item))
    .slice(0, count);
  return out.length ? out : undefined;
}
