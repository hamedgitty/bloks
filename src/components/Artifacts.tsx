// Deliverables in the chat: the card and the viewer.
//
// An artifact message renders as a file card; opening it viewers the
// file in place, because "download it and go look" is not a product.
// What renders natively: HTML in a sandboxed frame, PDFs through the
// browser's own viewer, images, video with the browser's own controls
// (seeking rides on the byte ranges the server answers), CSV/TSV and XLSX
// as tables, markdown drawn the way a reply is, text and JSON as text.
// A link in a reply to a shared file, or to the place the agent saved
// one, opens the same viewer (SharedFileLink below). Formats with no
// honest in-browser renderer (pptx, docx, zip) keep the card and a
// download; agents are told to save an HTML companion for decks, so
// the viewable version exists.
//
// The xlsx parser is imported lazily: it is heavier than every other
// viewer combined and most conversations never open a spreadsheet.
import { useEffect, useState, useCallback } from "react";
import { Check } from "@/components/icons";
import { X } from "@/components/icons";
import { Download } from "@/components/icons";
import { FileCode } from "@/components/icons";
import { FileImage } from "@/components/icons";
import { FileSpreadsheet } from "@/components/icons";
import { FileText } from "@/components/icons";
import { FileVideo } from "@/components/icons";
import { Presentation } from "@/components/icons";
import { type Message } from "@/state/store";
import { Markdownish } from "@/components/Markdown";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { modKey } from "@/lib/thisComputer";
import { destination } from "@/lib/attachments";
import { artifactHref, fileBase, fileTarget, openFailure, tooLargeHere, viewerFor, type Viewer } from "@/lib/sharedFile";
import { formatNumber, t } from "@/lib/i18n";

type ArtifactMeta = NonNullable<Message["artifact"]>;

function humanSize(bytes: number): string {
  if (bytes < 1024) return t("artifacts.size.bytes", { n: bytes });
  if (bytes < 1024 * 1024) return t("artifacts.size.kb", { n: formatNumber(bytes / 1024, { maximumFractionDigits: 0 }) });
  return t("artifacts.size.mb", { n: formatNumber(bytes / 1024 / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
}

function kindOf(artifact: ArtifactMeta): { label: string; icon: React.ReactNode; viewer: Viewer } {
  const { mime, name } = artifact;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const viewer = viewerFor(mime, name);
  switch (viewer) {
    case "iframe":
      return { label: t("artifacts.kind.webPage"), icon: <FileCode size={18} />, viewer };
    case "pdf":
      return { label: "PDF", icon: <FileText size={18} />, viewer };
    case "image":
      return { label: t("artifacts.kind.image"), icon: <FileImage size={18} />, viewer };
    case "video":
      return { label: t("artifacts.kind.video"), icon: <FileVideo size={18} />, viewer };
    case "table":
    case "sheet":
      return { label: t("artifacts.kind.spreadsheet"), icon: <FileSpreadsheet size={18} />, viewer };
    case "markdown":
      return { label: t("artifacts.kind.markdown"), icon: <FileText size={18} />, viewer };
    case "text":
      return { label: ext === "json" ? "JSON" : t("artifacts.kind.text"), icon: <FileText size={18} />, viewer };
  }
  if (ext === "pptx") return { label: t("artifacts.kind.slides"), icon: <Presentation size={18} />, viewer };
  if (ext === "docx") return { label: t("artifacts.kind.document"), icon: <FileText size={18} />, viewer };
  return { label: t("artifacts.kind.file"), icon: <FileText size={18} />, viewer };
}

/** The file's bytes as text, or a sentence saying why not: a missing file
 * answers JSON with a reason, which is not the file. */
async function fetchText(href: string): Promise<string> {
  const res = await fetch(href);
  if (!res.ok) {
    const said = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(openFailure(res.status, said.error === "no such file" ? undefined : said.error));
  }
  return res.text();
}

async function fetchBytes(href: string): Promise<ArrayBuffer> {
  const res = await fetch(href);
  if (!res.ok) throw new Error(openFailure(res.status));
  return res.arrayBuffer();
}

/** The most a shared file can be to open in this window, when it reaches
 * its server through Bloks Cloud and the server says; null otherwise.
 * Asked once a page (destination), so a long conversation of cards asks
 * nothing more. */
function useOpenLimit(): number | null {
  const [limit, setLimit] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void destination().then((where) => {
      if (live) setLimit(where.throughCloud ? where.openMaxBytes : null);
    });
    return () => {
      live = false;
    };
  }, []);
  return limit;
}

export function ArtifactCard({ botId, artifact }: { botId: string; artifact: ArtifactMeta }) {
  const [viewing, setViewing] = useState(false);
  const kind = kindOf(artifact);
  const href = artifactHref(botId, artifact.name);
  // said on the card rather than after a click on View or Download, both
  // of which would only fail (GitHub 366)
  const tooLarge = tooLargeHere(artifact.size, useOpenLimit());

  return (
    <>
      <div className="flex w-fit max-w-[min(420px,100%)] items-center gap-3 rounded-2xl border bg-card py-2.5 pl-3 pr-2 shadow-[0_1px_3px_var(--shadow-color)]">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
          {kind.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-foreground" title={artifact.name}>
            {fileBase(artifact.name)}
          </span>
          <span className="block text-small text-muted-foreground">
            {kind.label} · {humanSize(artifact.size)}
          </span>
          {tooLarge && <span className="block text-small text-muted-foreground">{tooLarge}</span>}
        </span>
        {!tooLarge && (
          <span className="flex shrink-0 items-center gap-1">
            {kind.viewer !== "none" && (
              <Button size="sm" variant="secondary" onClick={() => setViewing(true)}>
                {t("artifacts.view")}
              </Button>
            )}
            <a
              href={`${href}?download`}
              download={fileBase(artifact.name)}
              title={t("artifacts.download")}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Download size={15} />
            </a>
          </span>
        )}
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
  const n = String((anchor.index ?? 0) + 1);
  return anchor.kind === "line" ? t("artifacts.anchor.line", { n }) : t("artifacts.anchor.page", { n });
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
      <table className="w-full border-collapse text-body">
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
                    title={t("artifacts.leaveANoteOnThis")}
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
        <div className="px-3 py-2 text-small text-muted-foreground">
          {t("artifacts.showingFirstRows", { shown: MAX_ROWS, total: rows.length })}
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
  const href = artifactHref(botId, artifact.name);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A report reads rendered; the source is one click away for copying
  // a section out exactly as the agent wrote it.
  const [source, setSource] = useState(false);
  // Notes pinned to places in this file. They live beside the artifact
  // rather than inside it: writing a note into somebody's spreadsheet
  // would corrupt the thing being discussed.
  const [notes, setNotes] = useState<ArtifactNote[]>([]);
  const [pinning, setPinning] = useState<{ row: number; column: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const notesUrl = `${href}/comments`;
  // a video this browser cannot play, said rather than left as a black box
  const [unplayable, setUnplayable] = useState(false);
  // asking again for the file, never for the agent: nothing here starts a turn
  const [attempt, setAttempt] = useState(0);

  const loadNotes = useCallback(() => {
    void fetch(notesUrl)
      .then((r) => r.json())
      .then((d) => setNotes(d.comments ?? []))
      .catch(() => {});
  }, [notesUrl]);
  useEffect(loadNotes, [loadNotes]);

  useEffect(() => {
    let alive = true;
    const failed = (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e));
    setError(null);
    if (kind.viewer === "iframe") {
      // fetched and inlined rather than framed by URL: the sandboxed
      // srcdoc keeps a hostile page scriptless-by-origin, and it renders
      // in embedded webviews that refuse subframe navigations
      fetchText(href)
        .then((t) => alive && setHtml(t))
        .catch(failed);
    } else if (kind.viewer === "table") {
      fetchText(href)
        .then((t) => alive && setRows(parseCsv(t, artifact.name.endsWith(".tsv") ? "\t" : ",")))
        .catch(failed);
    } else if (kind.viewer === "sheet") {
      Promise.all([fetchBytes(href), import("xlsx")])
        .then(([buffer, XLSX]) => {
          if (!alive) return;
          const book = XLSX.read(buffer, { type: "array" });
          const sheet = book.Sheets[book.SheetNames[0]];
          const grid: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
          setRows(grid);
        })
        .catch(failed);
    } else if (kind.viewer === "text" || kind.viewer === "markdown") {
      fetchText(href)
        .then((t) => alive && setText(t.slice(0, 200_000)))
        .catch(failed);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [href, attempt]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[85vh] w-full max-w-[900px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center gap-3 border-b px-5">
          <span className="text-brand-ink">{kind.icon}</span>
          <DialogTitle className="min-w-0 flex-1 truncate text-ui" title={artifact.name}>
            {fileBase(artifact.name)}
          </DialogTitle>
          {kind.viewer === "markdown" && (
            <button
              onClick={() => setSource((s) => !s)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-body text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {source ? t("artifacts.showRendered") : t("artifacts.showSource")}
            </button>
          )}
          <a
            href={`${href}?download`}
            download={fileBase(artifact.name)}
            className="mr-6 flex items-center gap-1.5 rounded-lg px-2 py-1 text-body text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download size={14} />
            {t("artifacts.download")}
          </a>
        </div>

        <div className="min-h-0 flex-1 bg-muted/30">
          {error && (
            <div className="flex flex-col items-start gap-3 p-6">
              <div className="text-body text-destructive">{error}</div>
              <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                {t("common.tryAgain")}
              </Button>
            </div>
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
              !error && <div className="p-6 text-body text-muted-foreground">{t("common.loading")}</div>
            ))}
          {kind.viewer === "pdf" && (
            <iframe src={href} title={artifact.name} className="size-full border-0" />
          )}
          {kind.viewer === "image" && !error && (
            <div className="flex size-full items-center justify-center overflow-auto p-4">
              <img
                key={attempt}
                src={href}
                alt={artifact.name}
                onError={() => setError(openFailure(404))}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
          {kind.viewer === "video" &&
            (unplayable ? (
              <div className="flex size-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="text-muted-foreground">{kind.icon}</span>
                <div className="max-w-[420px] text-ui text-muted-foreground">
                  {t("artifacts.thisVideoCantPlayHere")}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setUnplayable(false);
                      setAttempt((n) => n + 1);
                    }}
                  >
                    {t("common.tryAgain")}
                  </Button>
                  <Button asChild size="sm" variant="secondary">
                    <a href={`${href}?download`} download={fileBase(artifact.name)}>
                      <Download size={13} />
                      {t("artifacts.download")}
                    </a>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex size-full items-center justify-center bg-black">
                {/* no autoplay: a video starts when the person presses play */}
                <video
                  key={attempt}
                  src={href}
                  controls
                  playsInline
                  preload="metadata"
                  onError={() => setUnplayable(true)}
                  className="max-h-full max-w-full"
                />
              </div>
            ))}
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
                    <span className="text-small font-semibold text-foreground">{t("artifacts.notes")}</span>
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
                        className="rounded-lg bg-primary px-2 py-1 text-small font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                      >
                        {sending ? t("artifacts.sending") : t("artifacts.sendToAgent")}
                      </button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {pinning && (
                      <div className="mb-2 rounded-xl border border-brand/40 bg-brand-soft p-2">
                        <div className="mb-1 text-caption font-semibold text-foreground">
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
                          placeholder={t("artifacts.whatIsWrongHere")}
                          className="w-full resize-none rounded-lg border border-input bg-background px-2 py-1.5 text-small outline-none"
                        />
                        <div className="mt-1 text-caption text-muted-foreground">
                          {t("artifacts.enterSavesEscapeCancels", { mod: modKey() })}
                        </div>
                      </div>
                    )}
                    {notes.length === 0 && !pinning && (
                      <div className="px-1 py-3 text-small leading-relaxed text-muted-foreground">
                        {t("artifacts.clickACellToLeave")}
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
                          <span className="rounded bg-muted px-1 text-caption font-semibold tabular-nums text-muted-foreground">
                            {anchorLabel(note.anchor)}
                          </span>
                          <div className="flex gap-0.5">
                            <button
                              title={note.resolved ? t("artifacts.reopen") : t("artifacts.markDone")}
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
                              title={t("common.remove")}
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
                        <div className="mt-1 text-small leading-relaxed text-foreground">
                          {note.text}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              !error && <div className="p-6 text-body text-muted-foreground">{t("common.loading")}</div>
            ))}
          {kind.viewer === "markdown" &&
            (text !== null ? (
              source ? (
                <pre className="size-full overflow-auto whitespace-pre-wrap bg-background p-5 font-mono text-body leading-relaxed text-foreground">
                  {text}
                </pre>
              ) : (
                <div className="size-full overflow-auto bg-background">
                  <div className="mx-auto max-w-[720px] px-6 py-6 text-ui leading-relaxed text-foreground">
                    <Markdownish text={text} />
                  </div>
                </div>
              )
            ) : (
              !error && <div className="p-6 text-body text-muted-foreground">{t("common.loading")}</div>
            ))}
          {kind.viewer === "text" &&
            (text !== null ? (
              <pre className="size-full overflow-auto whitespace-pre-wrap bg-background p-5 font-mono text-body leading-relaxed text-foreground">
                {text}
              </pre>
            ) : (
              !error && <div className="p-6 text-body text-muted-foreground">{t("common.loading")}</div>
            ))}
          {/* the notes rail */}
          {kind.viewer === "none" && (
            <div className="flex size-full flex-col items-center justify-center gap-3 text-center">
              <span className="text-muted-foreground">{kind.icon}</span>
              <div className="text-ui text-muted-foreground">
                {t("artifacts.noPreviewForThisFile")}
              </div>
              <Button asChild size="sm" variant="secondary">
                <a href={`${href}?download`} download={fileBase(artifact.name)}>
                  <Download size={13} />
                  {t("artifacts.downloadName", { name: fileBase(artifact.name) })}
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Opening =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "open"; botId: string; artifact: ArtifactMeta }
  | { phase: "failed"; message: string };

/**
 * A link in a reply that is a file rather than a page: the route a shared
 * file is served at, or the path the agent saved it to. Either way the
 * server says what it is (GET /api/artifacts/resolve), and it opens in the
 * same viewer as the file's card. A path that is not a shared file says
 * so and how to get it shared, instead of being a link that does nothing.
 */
export function SharedFileLink({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [opening, setOpening] = useState<Opening>({ phase: "idle" });
  const target = fileTarget(href);
  const open = useCallback(async () => {
    setOpening({ phase: "opening" });
    try {
      const res = await fetch(`/api/artifacts/resolve?path=${encodeURIComponent(href)}`);
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok || !body.artifact) {
        setOpening({
          phase: "failed",
          message: openFailure(res.status, typeof body.error === "string" ? body.error : undefined),
        });
        return;
      }
      setOpening({ phase: "open", botId: String(body.botId), artifact: body.artifact as ArtifactMeta });
    } catch {
      setOpening({ phase: "failed", message: openFailure(0) });
    }
  }, [href]);

  return (
    <>
      <button
        type="button"
        // words of the reply drawn as a button, so a copy keeps them
        data-copy="keep"
        onClick={() => void open()}
        disabled={opening.phase === "opening"}
        title={t("artifacts.openName", { name: target?.kind === "artifact" ? fileBase(target.name) : href })}
        className={cn(
          "inline cursor-pointer text-left underline decoration-dotted underline-offset-2 [overflow-wrap:anywhere] hover:opacity-80 disabled:cursor-progress disabled:opacity-60",
          className,
        )}
      >
        {children}
      </button>
      {opening.phase === "open" && (
        <ArtifactViewer botId={opening.botId} artifact={opening.artifact} onClose={() => setOpening({ phase: "idle" })} />
      )}
      {opening.phase === "failed" && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setOpening({ phase: "idle" })}>
          <DialogContent className="max-w-[420px] gap-3 p-5">
            <DialogTitle className="text-ui">{t("artifacts.couldntOpenThisFile")}</DialogTitle>
            <div className="text-body leading-relaxed text-muted-foreground">{opening.message}</div>
            <div className="break-all font-mono text-small text-muted-foreground/80">{href}</div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => void open()}>
                {t("common.tryAgain")}
              </Button>
              <Button size="sm" onClick={() => setOpening({ phase: "idle" })}>
                {t("common.close")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
