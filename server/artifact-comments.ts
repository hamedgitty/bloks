// Notes pinned to a place in a deliverable.
//
// An agent hands back a spreadsheet and something in it is wrong. Saying
// so in the chat means describing where: "the number in the fourth row,
// the one under margin, no the other one". Pinning the note to the cell
// removes that whole sentence, and it gives the agent an unambiguous
// address to act on rather than a description to guess at.
//
// Comments live beside the artifacts rather than inside them: rewriting
// somebody's spreadsheet to store a note about the spreadsheet would
// corrupt the thing being discussed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

/** Where in the artifact a note is pinned. */
export interface Anchor {
  /** "cell" for a grid, "line" for text, "page" for paged documents. */
  kind: "cell" | "line" | "page";
  /** Zero-based, and meaningful for the kind: row/column for a cell. */
  row?: number;
  column?: number;
  /** Zero-based line or page index. */
  index?: number;
}

export interface ArtifactComment {
  id: string;
  botId: string;
  /** The artifact's file name, which is unique within an agent. */
  artifact: string;
  anchor: Anchor;
  text: string;
  /** "user" today; an agent could answer a note later. */
  author: string;
  at: number;
  /** Marked done rather than deleted, so a thread keeps its shape. */
  resolved?: boolean;
}

export const MAX_COMMENT_CHARS = 1_000;
/** Per artifact. A deliverable with more notes than this needs a call. */
export const MAX_COMMENTS = 200;

const FILE = join(DATA_DIR, "artifact-comments.json");

/** Spreadsheet talk: column 0 is A, and row 0 is the header row 1. */
export function describeAnchor(anchor: Anchor): string {
  if (anchor.kind === "cell") {
    const column = anchor.column ?? 0;
    let name = "";
    // A..Z, then AA.. the way every spreadsheet has always numbered them
    for (let n = column; ; n = Math.floor(n / 26) - 1) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      if (n < 26) break;
    }
    return `cell ${name}${(anchor.row ?? 0) + 1}`;
  }
  if (anchor.kind === "line") return `line ${(anchor.index ?? 0) + 1}`;
  return `page ${(anchor.index ?? 0) + 1}`;
}

/** A client-supplied anchor, shape-checked. */
export function parseAnchor(raw: unknown): Anchor | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const whole = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_000_000;
  if (a.kind === "cell") {
    if (!whole(a.row) || !whole(a.column)) return null;
    return { kind: "cell", row: a.row as number, column: a.column as number };
  }
  if (a.kind === "line" || a.kind === "page") {
    if (!whole(a.index)) return null;
    return { kind: a.kind, index: a.index as number };
  }
  return null;
}

export class ArtifactCommentStore {
  comments: ArtifactComment[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(readFileSync(FILE, "utf8"));
      this.comments = Array.isArray(raw) ? raw.filter(valid) : [];
    } catch {
      this.comments = [];
    }
  }

  private save() {
    writeFileSync(FILE, JSON.stringify(this.comments, null, 2), { mode: 0o600 });
  }

  for(botId: string, artifact: string): ArtifactComment[] {
    return this.comments
      .filter((c) => c.botId === botId && c.artifact === artifact)
      .sort((a, b) => a.at - b.at);
  }

  add(
    botId: string,
    artifact: string,
    anchor: Anchor,
    text: string,
    author = "user",
  ): ArtifactComment | null {
    if (this.for(botId, artifact).length >= MAX_COMMENTS) return null;
    const comment: ArtifactComment = {
      id: newId(),
      botId,
      artifact,
      anchor,
      text: text.slice(0, MAX_COMMENT_CHARS),
      author,
      at: Date.now(),
    };
    this.comments.push(comment);
    this.save();
    return comment;
  }

  setResolved(id: string, resolved: boolean): ArtifactComment | null {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return null;
    comment.resolved = resolved || undefined;
    this.save();
    return comment;
  }

  /** An agent that is gone takes its notes with it. Its files went with
   * it too, so a comment pinned to one is pinned to nothing. */
  removeForBot(botId: string) {
    const before = this.comments.length;
    this.comments = this.comments.filter((c) => c.botId !== botId);
    if (this.comments.length !== before) this.save();
  }

  remove(id: string): boolean {
    const before = this.comments.length;
    this.comments = this.comments.filter((c) => c.id !== id);
    if (this.comments.length === before) return false;
    this.save();
    return true;
  }

  /** An artifact that no longer exists has no notes worth keeping. */
  removeFor(botId: string, artifact?: string): void {
    const before = this.comments.length;
    this.comments = this.comments.filter(
      (c) => c.botId !== botId || (artifact !== undefined && c.artifact !== artifact),
    );
    if (this.comments.length !== before) this.save();
  }
}

function valid(row: any): row is ArtifactComment {
  return (
    row &&
    typeof row.id === "string" &&
    typeof row.botId === "string" &&
    typeof row.artifact === "string" &&
    typeof row.text === "string" &&
    row.anchor &&
    ["cell", "line", "page"].includes(row.anchor.kind)
  );
}
