// Deliverables in the chat: the card and the viewer.
//
// An artifact message renders as a file card; opening it viewers the
// file in place, because "download it and go look" is not a product.
// What renders natively: HTML in a sandboxed frame, PDFs through the
// browser's own viewer, images, CSV/TSV and XLSX as tables, markdown,
// text and JSON as text. Formats with no honest in-browser renderer
// (pptx, docx, zip) keep the card and a download; agents are told to
// save an HTML companion for decks, so the viewable version exists.
//
// The xlsx parser is imported lazily: it is heavier than every other
// viewer combined and most conversations never open a spreadsheet.
import { useEffect, useState, useCallback } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import X from "lucide-react/dist/esm/icons/x.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import FileCode from "lucide-react/dist/esm/icons/file-code.js";
import FileImage from "lucide-react/dist/esm/icons/file-image.js";
import FileSpreadsheet from "lucide-react/dist/esm/icons/file-spreadsheet.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import Presentation from "lucide-react/dist/esm/icons/presentation.js";
import { type Message } from "@/state/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

type ArtifactMeta = NonNullable<Message["artifact"]>;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function kindOf(artifact: ArtifactMeta): {
  label: string;
  icon: React.ReactNode;
  viewer: "iframe" | "pdf" | "image" | "table" | "sheet" | "text" | "none";
} {
  const { mime, name } = artifact;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "text/html") return { label: "Web page", icon: <FileCode size={18} />, viewer: "iframe" };
  if (mime === "application/pdf") return { label: "PDF", icon: <FileText size={18} />, viewer: "pdf" };
  if (mime.startsWith("image/")) return { label: "Image", icon: <FileImage size={18} />, viewer: "image" };
  if (ext === "csv" || ext === "tsv")
    return { label: "Spreadsheet", icon: <FileSpreadsheet size={18} />, viewer: "table" };
  if (ext === "xlsx")
    return { label: "Spreadsheet", icon: <FileSpreadsheet size={18} />, viewer: "sheet" };
  if (ext === "pptx") return { label: "Slides", icon: <Presentation size={18} />, viewer: "none" };
  if (ext === "docx") return { label: "Document", icon: <FileText size={18} />, viewer: "none" };
  if (["md", "txt", "json"].includes(ext))
    return { label: ext === "md" ? "Markdown" : ext === "json" ? "JSON" : "Text", icon: <FileText size={18} />, viewer: "text" };
  return { label: "File", icon: <FileText size={18} />, viewer: "none" };
}

export function ArtifactCard({ botId, artifact }: { botId: string; artifact: ArtifactMeta }) {
  const [viewing, setViewing] = useState(false);
  const kind = kindOf(artifact);
  const href = `/api/bots/${botId}/artifacts/${encodeURIComponent(artifact.name)}`;

  return (
    <>
      <div className="flex w-fit max-w-[min(420px,100%)] items-center gap-3 rounded-2xl border bg-card py-2.5 pl-3 pr-2 shadow-[0_1px_3px_var(--shadow-color)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
          {kind.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">
            {artifact.name}
          </span>
          <span className="block text-[11.5px] text-muted-foreground">
            {kind.label} · {humanSize(artifact.size)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {kind.viewer !== "none" && (
            <Button size="sm" variant="secondary" onClick={() => setViewing(true)}>
              View
            </Button>
          )}
          <a
            href={`${href}?download`}
            download={artifact.name}
            title="Download"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download size={15} />
          </a>
        </span>
      </div>
      {viewing && <ArtifactViewer botId={botId} artifact={artifact} onClose={() => setViewing(false)} />}
    </>
  );
}

/** Tiny CSV parse, quotes and escaped quotes included. Enough for the
 * files agents actually produce; a malformed row degrades to one cell. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const MAX_ROWS = 500;

export interface ArtifactNote {
  id: string;
  anchor: { kind: "cell" | "line" | "page"; row?: number; column?: number; index?: number };
  text: string;
  author: string;
  at: number;
  resolved?: boolean;
}

/** Spreadsheet talk, matching the server's own naming exactly. */
function anchorLabel(anchor: ArtifactNote["anchor"]): string {
  if (anchor.kind === "cell") {
    let name = "";
    for (let n = anchor.column ?? 0; ; n = Math.floor(n / 26) - 1) {
      name = String.fromCharCode(65 + (n % 26)) + name;
      if (n < 26) break;
    }
    return `${name}${(anchor.row ?? 0) + 1}`;
  }
  return anchor.kind === "line" ? `L${(anchor.index ?? 0) + 1}` : `p${(anchor.index ?? 0) + 1}`;
}

function GridTable({
  rows,
  notes,
  onPin,
  pinning,
}: {
  rows: string[][];
  notes: ArtifactNote[];
  onPin: (row: number, column: number) => void;
  pinning: { row: number; column: number } | null;
}) {
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {shown.map((row, r) => (
            <tr key={r} className={cn("border-b", r === 0 && "bg-muted/50")}>
              {row.map((cell, c) => {
                const pinned = notes.filter(
                  (n) => n.anchor.kind === "cell" && n.anchor.row === r && n.anchor.column === c,
                );
                const open = pinned.some((n) => !n.resolved);
                const active = pinning?.row === r && pinning?.column === c;
                return (
                  <td
                    key={c}
                    onClick={() => onPin(r, c)}
                    title="Leave a note on this cell"
                    className={cn(
                      "relative max-w-[320px] cursor-text truncate border-r px-2.5 py-1.5 tabular-nums last:border-r-0",
                      r === 0 ? "font-medium text-foreground" : "text-foreground/90",
                      "hover:bg-accent/60",
                      open && "bg-warning/10",
                      active && "ring-2 ring-inset ring-brand",
                    )}
                  >
                    {cell}
                    {pinned.length > 0 && (
                      <span
                        className={cn(
                          "absolute right-0.5 top-0.5 size-1.5 rounded-full",
                          open ? "bg-warning" : "bg-muted-foreground/40",
                        )}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <div className="px-3 py-2 text-[12px] text-muted-foreground">
          Showing the first {MAX_ROWS} of {rows.length} rows; download for the rest.
        </div>
      )}
    </div>
  );
}

export function ArtifactViewer({
  botId,
  artifact,
  onClose,
}: {
  botId: string;
  artifact: ArtifactMeta;
  onClose: () => void;
}) {
  const kind = kindOf(artifact);
  const href = `/api/bots/${botId}/artifacts/${encodeURIComponent(artifact.name)}`;
  const [rows, setRows] = useState<string[][] | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Notes pinned to places in this file. They live beside the artifact
  // rather than inside it: writing a note into somebody's spreadsheet
  // would corrupt the thing being discussed.
  const [notes, setNotes] = useState<ArtifactNote[]>([]);
  const [pinning, setPinning] = useState<{ row: number; column: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const notesUrl = `${`/api/bots/${botId}/artifacts/${encodeURIComponent(artifact.name)}`}/comments`;

  const loadNotes = useCallback(() => {
    void fetch(notesUrl)
      .then((r) => r.json())
      .then((d) => setNotes(d.comments ?? []))
      .catch(() => {});
  }, [notesUrl]);
  useEffect(loadNotes, [loadNotes]);

  useEffect(() => {
    let alive = true;
    if (kind.viewer === "iframe") {
      // fetched and inlined rather than framed by URL: the sandboxed
      // srcdoc keeps a hostile page scriptless-by-origin, and it renders
      // in embedded webviews that refuse subframe navigations
      fetch(href)
        .then((r) => r.text())
        .then((t) => alive && setHtml(t))
        .catch((e) => alive && setError(String(e)));
    } else if (kind.viewer === "table") {
      fetch(href)
        .then((r) => r.text())
        .then((t) => alive && setRows(parseCsv(t, artifact.name.endsWith(".tsv") ? "\t" : ",")))
        .catch((e) => alive && setError(String(e)));
    } else if (kind.viewer === "sheet") {
      Promise.all([fetch(href).then((r) => r.arrayBuffer()), import("xlsx")])
        .then(([buffer, XLSX]) => {
          if (!alive) return;
          const book = XLSX.read(buffer, { type: "array" });
          const sheet = book.Sheets[book.SheetNames[0]];
          const grid: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
          setRows(grid);
        })
        .catch((e) => alive && setError(String(e)));
    } else if (kind.viewer === "text") {
      fetch(href)
        .then((r) => r.text())
        .then((t) => alive && setText(t.slice(0, 200_000)))
        .catch((e) => alive && setError(String(e)));
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] w-full max-w-[900px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b px-5">
          <span className="text-brand-ink">{kind.icon}</span>
          <DialogTitle className="min-w-0 flex-1 truncate text-[14px]">{artifact.name}</DialogTitle>
          <a
            href={`${href}?download`}
            download={artifact.name}
            className="mr-6 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download size={14} />
            Download
          </a>
        </div>

        <div className="min-h-0 flex-1 bg-muted/30">
          {error && (
            <div className="p-6 text-[13px] text-destructive">Could not load the file: {error}</div>
          )}
          {kind.viewer === "iframe" &&
            (html !== null ? (
              <iframe
                srcDoc={html}
                sandbox="allow-scripts"
                title={artifact.name}
                className="size-full border-0 bg-white"
              />
            ) : (
              !error && <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>
            ))}
          {kind.viewer === "pdf" && (
            <iframe src={href} title={artifact.name} className="size-full border-0" />
          )}
          {kind.viewer === "image" && (
            <div className="flex size-full items-center justify-center overflow-auto p-4">
              <img src={href} alt={artifact.name} className="max-h-full max-w-full object-contain" />
            </div>
          )}
          {(kind.viewer === "table" || kind.viewer === "sheet") &&
            (rows ? (
              <div className="flex size-full min-h-0 flex-col sm:flex-row">
                <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
                  <GridTable
                    rows={rows}
                    notes={notes}
                    pinning={pinning}
                    onPin={(row, column) => {
                      setPinning({ row, column });
                      setDraft("");
                    }}
                  />
                </div>
                {/* Side by side when there is room, stacked when there is
                    not: 260px of notes beside a table on a phone leaves
                    about a hundred pixels of spreadsheet, which is neither
                    a table nor a comment thread. */}
                <div className="flex max-h-[45%] w-full shrink-0 flex-col border-t bg-card sm:max-h-none sm:w-[260px] sm:border-l sm:border-t-0">
                  <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="text-[12px] font-semibold text-foreground">Notes</span>
                    {notes.some((n) => !n.resolved) && (
                      <button
                        disabled={sending}
                        onClick={() => {
                          setSending(true);
                          void fetch(`${notesUrl}/send`, { method: "POST" })
                            .then(() => onClose())
                            .catch(() => {})
                            .finally(() => setSending(false));
                        }}
                        className="rounded-lg bg-primary px-2 py-1 text-[11.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                      >
                        {sending ? "Sending…" : "Send to agent"}
                      </button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {pinning && (
                      <div className="mb-2 rounded-xl border border-brand/40 bg-brand-soft p-2">
                        <div className="mb-1 text-[11px] font-semibold text-foreground">
                          {anchorLabel({ kind: "cell", row: pinning.row, column: pinning.column })}
                        </div>
                        <textarea
                          autoFocus
                          rows={3}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setPinning(null);
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.currentTarget.blur();
                              if (!draft.trim()) return;
                              void fetch(notesUrl, {
                                method: "POST",
                                headers: { "content-type": "application/json" },
                                body: JSON.stringify({
                                  text: draft.trim(),
                                  anchor: { kind: "cell", row: pinning.row, column: pinning.column },
                                }),
                              })
                                .then(loadNotes)
                                .catch(() => {});
                              setPinning(null);
                              setDraft("");
                            }
                          }}
                          placeholder="What is wrong here?"
                          className="w-full resize-none rounded-lg border border-input bg-background px-2 py-1.5 text-[12px] outline-none"
                        />
                        <div className="mt-1 text-[10.5px] text-muted-foreground">
                          Cmd-Enter saves, Escape cancels
                        </div>
                      </div>
                    )}
                    {notes.length === 0 && !pinning && (
                      <div className="px-1 py-3 text-[11.5px] leading-relaxed text-muted-foreground">
                        Click any cell to pin a note to it. The agent gets the address, not a
                        description of where you meant.
                      </div>
                    )}
                    {notes.map((note) => (
                      <div
                        key={note.id}
                        className={cn(
                          "mb-1.5 rounded-xl border p-2",
                          note.resolved ? "opacity-50" : "bg-background",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span className="rounded bg-muted px-1 text-[10.5px] font-semibold tabular-nums text-muted-foreground">
                            {anchorLabel(note.anchor)}
                          </span>
                          <div className="flex gap-0.5">
                            <button
                              title={note.resolved ? "Reopen" : "Mark done"}
                              onClick={() =>
                                void fetch(`${notesUrl}/${note.id}`, {
                                  method: "PATCH",
                                  headers: { "content-type": "application/json" },
                                  body: JSON.stringify({ resolved: !note.resolved }),
                                })
                                  .then(loadNotes)
                                  .catch(() => {})
                              }
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                            >
                              <Check size={12} />
                            </button>
                            <button
                              title="Remove"
                              onClick={() =>
                                void fetch(`${notesUrl}/${note.id}`, { method: "DELETE" })
                                  .then(loadNotes)
                                  .catch(() => {})
                              }
                              className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="mt-1 text-[12px] leading-relaxed text-foreground">
                          {note.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              !error && <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>
            ))}
          {kind.viewer === "text" &&
            (text !== null ? (
              <pre className="size-full overflow-auto whitespace-pre-wrap bg-background p-5 font-mono text-[12.5px] leading-relaxed text-foreground">
                {text}
              </pre>
            ) : (
              !error && <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>
            ))}
          {/* the notes rail */}
          {kind.viewer === "none" && (
            <div className="flex size-full flex-col items-center justify-center gap-3 text-center">
              <span className="text-muted-foreground">{kind.icon}</span>
              <div className="text-[13.5px] text-muted-foreground">
                No in-app preview for this format yet.
              </div>
              <Button asChild size="sm" variant="secondary">
                <a href={`${href}?download`} download={artifact.name}>
                  <Download size={13} />
                  Download {artifact.name}
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
