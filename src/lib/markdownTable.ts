// Tables in a reply, without a markdown library.
//
// The transcript renders line by line, which is right for headings,
// bullets and quotes and wrong for a table: a table is several lines
// that only mean something together. So this walks the text once and
// hands the renderer blocks instead of lines, with table rows already
// parsed and everything else passed through untouched.
//
// The grammar is the GitHub one, because that is what models emit: a
// header row, a delimiter row of dashes with optional colons for
// alignment, then body rows. Outer pipes are optional on every row.

export type Align = "left" | "center" | "right";

export interface TableBlock {
  kind: "table";
  columns: string[];
  aligns: Align[];
  rows: string[][];
}

export interface LinesBlock {
  kind: "lines";
  lines: string[];
  /** Index of the first line in the original text, so React keys and
   * highlight offsets stay stable as blocks are re-split. */
  offset: number;
}

export type Block = TableBlock | LinesBlock;

/** Split one row into cells. Outer pipes are optional; an escaped \| is
 * a literal pipe rather than a cell boundary. */
export function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** The dashes under the header. `---`, `:--`, `:-:` and `--:` all count;
 * a cell that is anything else means this was never a table. */
function alignmentsOf(line: string): Align[] | null {
  if (!line.includes("-")) return null;
  const cells = splitRow(line);
  if (!cells.length) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    const m = cell.match(/^(:?)-{1,}(:?)$/);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? "center" : m[2] ? "right" : m[1] ? "left" : "left");
  }
  return aligns;
}

/** A line that could open a table: it has a pipe that is not escaped. */
const looksLikeRow = (line: string) => /(^|[^\\])\|/.test(line);

/**
 * Text to blocks. A table needs a header, a matching delimiter row, and
 * at least the two of them; body rows continue until a line stops
 * looking like a row. Ragged rows are padded or trimmed to the header's
 * width rather than dropped, because a model that miscounts one cell
 * should still get a table.
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let pending: string[] = [];
  let pendingAt = 0;

  const flush = () => {
    if (pending.length) blocks.push({ kind: "lines", lines: pending, offset: pendingAt });
    pending = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const aligns = i + 1 < lines.length ? alignmentsOf(lines[i + 1]) : null;
    if (!aligns || !looksLikeRow(header)) {
      if (!pending.length) pendingAt = i;
      pending.push(header);
      continue;
    }
    const columns = splitRow(header);
    // A delimiter that does not match the header's width is not this
    // table's delimiter; treat both lines as ordinary text.
    if (columns.length !== aligns.length) {
      if (!pending.length) pendingAt = i;
      pending.push(header);
      continue;
    }
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || !looksLikeRow(line)) break;
      const cells = splitRow(line);
      while (cells.length < columns.length) cells.push("");
      rows.push(cells.slice(0, columns.length));
    }
    flush();
    blocks.push({ kind: "table", columns, aligns, rows });
    i = j - 1;
    pendingAt = j;
  }
  flush();
  return blocks;
}

/** Whether the text holds at least one table, without building blocks. */
export function hasTable(text: string): boolean {
  return splitBlocks(text).some((block) => block.kind === "table");
}
