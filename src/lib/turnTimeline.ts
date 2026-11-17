// The turns of a conversation, as the scrubber beside it reads them
// (GitHub 521).
//
// A turn starts where a person speaks: in a chat, each time you (or a
// routine, a watcher, another agent writing in) said something the agent
// then worked on; in a room, each message from a person. Words sent one
// after another with nothing between them are one turn, the way they are
// one thing to answer. What the agent did until the next one is the turn's
// work, counted for the preview.
//
// The rail is drawn by index, not by where a message sits on the page: a
// long history arrives a page at a time and folds its work away, so the
// page cannot say where turn 3 of 400 is until it is drawn. Even spacing
// can, and the scrubber asks the conversation to draw a turn before it
// scrolls there. With more turns than the rail has room to draw apart, only
// every so many get a tick, and the rail still answers for every turn: a
// pointer anywhere on it means the turn nearest that height.
//
// No React and no page in here, so the tests read it as it is.
import type { Message } from "../state/reducer.ts";
import { splitAttachments } from "./attachments.ts";
import { summarize, type ToolLike } from "./tool-summary.ts";

export interface TurnMark {
  /** The message the turn starts with, which the scrubber lands on. */
  id: string;
  /** Its place in the list it was read from. */
  index: number;
  at: number;
  /** Who started it: you, somebody else in the room, or nobody named. */
  author?: string;
  role: Message["role"];
  /** The first line of what was said, short. */
  line: string;
  /** What the turn's work came to, counted ("Ran 2 commands"), or empty. */
  work: string;
}

/** How long a turn's line is in the preview, in characters. */
export const TURN_LINE_MAX = 80;

/** The first line of a message, as a person would quote it: no file tags,
 * no markdown marks, one line, cut at a word where it can be. */
export function firstLine(text: string | undefined, max = TURN_LINE_MAX): string {
  if (!text) return "";
  const { display } = splitAttachments(text);
  const lines = display.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = (lines[0] ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*>]\s+/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Whether a message starts a turn: something a person (or what speaks
 * for one) said, readable, and not a card or a notice. */
export function startsTurn(m: Message): boolean {
  if (m.deleted || m.quiet || m.queued) return false;
  if (m.role !== "user") return false;
  return (m.kind ?? "text") === "text" && Boolean(m.text?.trim());
}

/**
 * The turns of a conversation, oldest first. `include` narrows which
 * messages count at all (a room's topic, say); the work of a turn is
 * every activity row after it until the next turn starts.
 */
export function turnMarks(messages: readonly Message[], include: (m: Message) => boolean = () => true): TurnMark[] {
  const marks: TurnMark[] = [];
  let tools: ToolLike[] = [];
  let open: TurnMark | null = null;
  // a person's words running on with nothing between them are one turn
  let lastWasStart = false;
  const close = () => {
    if (open) open.work = tools.length ? summarize(tools) : "";
    tools = [];
  };
  messages.forEach((m, index) => {
    if (!include(m)) return;
    if (startsTurn(m)) {
      if (lastWasStart && open && open.author === m.author) return;
      close();
      open = { id: m.id, index, at: typeof m.at === "number" ? m.at : 0, author: m.author, role: m.role, line: firstLine(m.text), work: "" };
      marks.push(open);
      lastWasStart = true;
      return;
    }
    if (m.deleted || m.quiet) return;
    lastWasStart = false;
    if (m.kind === "activity" && m.tool && open) tools.push(m.tool);
  });
  close();
  return marks;
}

/** Room the rail keeps between two ticks, at most and at least, in
 * pixels. Fewer turns sit closer than the most, in a short column in the
 * middle of the rail; more than fit at the least are sampled. */
export const RAIL_GAP = { max: 18, min: 6 } as const;

export interface RailLayout {
  /** Pixels between two turns' places on the rail. */
  gap: number;
  /** Where the first turn sits, from the rail's top. */
  top: number;
  /** Every how many turns a tick is drawn: 1 draws them all. */
  stride: number;
}

/** Where each turn goes on a rail this tall. */
export function railLayout(count: number, height: number): RailLayout {
  if (count <= 1 || height <= 0) return { gap: 0, top: Math.max(0, height / 2), stride: 1 };
  const room = height / (count - 1);
  const gap = Math.min(RAIL_GAP.max, room);
  const stride = room >= RAIL_GAP.min ? 1 : Math.ceil(RAIL_GAP.min / room);
  return { gap, top: (height - gap * (count - 1)) / 2, stride };
}

/** A turn's height on the rail. */
export function placeOf(layout: RailLayout, index: number): number {
  return layout.top + layout.gap * index;
}

/** The turn nearest a height on the rail, for a pointer anywhere on it. */
export function turnAtHeight(layout: RailLayout, count: number, y: number): number {
  if (count <= 1 || layout.gap === 0) return 0;
  const at = Math.round((y - layout.top) / layout.gap);
  return Math.min(count - 1, Math.max(0, at));
}

/** Whether a turn gets a tick of its own: on the stride, the last, and
 * the one being read, so the rail always shows where the reader is. */
export function drawsTick(layout: RailLayout, count: number, index: number, current: number): boolean {
  return index % layout.stride === 0 || index === count - 1 || index === current;
}

/**
 * Which turn is being read: the last one that starts at or above the
 * reading line. `top` gives a turn's start in the scroller's own pixels,
 * or null for one not drawn, which, the page being drawn from its end, is
 * above everything that is. A binary search, so a conversation of a
 * thousand turns asks the page about ten times a frame.
 */
export function readingTurn(count: number, top: (index: number) => number | null, line: number): number {
  if (count === 0) return -1;
  let lo = 0;
  let hi = count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = top(mid);
    if (at === null || at <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, found);
}

/** The next turn for a key on the rail, or null for a key it does not
 * use. Page keys go ten at a time. */
export function stepTurn(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  const at = current < 0 ? count - 1 : current;
  const clamp = (n: number) => Math.min(count - 1, Math.max(0, n));
  switch (key) {
    case "ArrowUp":
    case "ArrowLeft":
      return clamp(at - 1);
    case "ArrowDown":
    case "ArrowRight":
      return clamp(at + 1);
    case "PageUp":
      return clamp(at - 10);
    case "PageDown":
      return clamp(at + 10);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
