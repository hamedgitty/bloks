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

/** Engine-reported invocation metadata, never skill or command bodies. */
export const MAX_ENGINE_COMMANDS = 2048;
export const MAX_ENGINE_COMMAND_BYTES = 1024 * 1024;
export const MAX_ENGINE_COMMAND_ID_CHARS = 128;
export const MAX_ENGINE_COMMAND_DESCRIPTION_CHARS = 300;

/** Request bodies. Screen frames are the only large ones. */
export const MAX_BODY_BYTES = 2_000_000;

/** Webhook events waiting on one busy lane, and their total size with
 * framing and separators. Past either, the sender is told to retry. */
export const MAX_WEBHOOK_QUEUE_ITEMS = 20;
export const MAX_WEBHOOK_QUEUE_BYTES = 100_000;

/** How long a message may wait through a restart and still be sent when
 * Bloks starts again. A restart is usually minutes; a message older than
 * this was written for a moment that has passed, so it is marked not
 * sent and left for the person to send again, never run on its own. */
export const MAX_QUEUED_RECOVERY_MS = 12 * 60 * 60_000;

/** Turns remembered as running, on disk until each one ends (server/cut-off.ts).
 * One per lane in practice; the cap is for a file nobody should trust to
 * stay small on its own. A session reference is an engine's id for its
 * session, which is short; anything longer is not one. */
export const MAX_TURNS_IN_FLIGHT = 200;
export const MAX_SESSION_REF_CHARS = 200;

/** Room lines waiting for a busy agent, on disk so a restart does not
 * lose them (server/room-tags.ts): agents, rooms and people waited for at
 * once, and lines joined into one waiting turn. */
export const MAX_WAITING_ROOM_LINES = 200;
export const MAX_LINES_PER_WAIT = 50;

/** Simultaneous event-stream listeners. One app needs one. */
export const MAX_SSE_CLIENTS = 32;

/** User-added OpenAI-compatible hosts, and keys on one host. */
export const MAX_CUSTOM_ENDPOINTS = 16;
export const MAX_CUSTOM_KEYS = 8;
export const MAX_KEY_CHARS = 400;
export const MAX_URL_CHARS = 400;

/** A model id kept in the defaults for new agents. Real ids are short. */
export const MAX_MODEL_ID_CHARS = 200;

/** A lane's goal (server/goals.ts): what done looks like, the one-line
 * command that has to pass for it to count, and how many turns it may
 * take. The goal is said to the agent every turn and the judge reads it,
 * so it stays a paragraph; the turns are a hard cap on what one goal can
 * spend without the person. */
export const MAX_GOAL_CHARS = 2_000;
export const MAX_GOAL_CHECK_CHARS = 500;
export const MAX_GOAL_TURNS = 100;

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
