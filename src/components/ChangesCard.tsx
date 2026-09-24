// What a turn did to your files, and the way back.
//
// The server photographs an agent's folder before and after each turn
// (server/checkpoints.ts); this is the card that difference becomes. A
// file opens into its diff. Undo puts every file back as it was before
// the turn, except the ones that changed again since, which it names
// rather than overwrites.
import { useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import FileDiff from "lucide-react/dist/esm/icons/file-diff.mjs";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical.mjs";
import FileMinus from "lucide-react/dist/esm/icons/file-minus.mjs";
import FilePen from "lucide-react/dist/esm/icons/file-pen.mjs";
import FilePlus from "lucide-react/dist/esm/icons/file-plus.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Undo2 from "lucide-react/dist/esm/icons/undo-2.mjs";
import { api, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { changedLine } from "@/lib/preview";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

type Changes = NonNullable<Message["changes"]>;
type Change = Changes["files"][number];

interface DiffLine {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}
interface FileDiffBody {
  path: string;
  status: Change["status"];
  binary?: boolean;
  big?: boolean;
  tooLong?: boolean;
  lines: DiffLine[];
}

const ICON = { added: FilePlus, modified: FilePen, deleted: FileMinus } as const;
const VERB = { added: "Added", modified: "Changed", deleted: "Deleted" } as const;

export function ChangesCard({ message, fresh }: { message: Message; fresh?: boolean }) {
  const changes = message.changes;
  const [open, setOpen] = useState<Change | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ path: string; why: string }>>([]);
  if (!changes) return null;

  const added = changes.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = changes.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const undone = changes.reverted;
  const rehearsal = changes.rehearsal?.state;
  const pending = rehearsal === "pending";
  const discarded = rehearsal === "discarded";

  /** Apply or discard a rehearsal. */
  const decide = (what: "apply" | "discard") => {
    setBusy(true);
    setError(null);
    api(`/api/checkpoints/${changes.checkpointId}/${what}`, { method: "POST" })
      .then((result: { skipped?: Array<{ path: string; why: string }> }) => setSkipped(result.skipped ?? []))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const undo = () => {
    setBusy(true);
    setError(null);
    api(`/api/checkpoints/${changes.checkpointId}/revert`, { method: "POST" })
      .then((result: { skipped: Array<{ path: string; why: string }> }) => {
        setSkipped(result.skipped ?? []);
        setConfirming(false);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className={cn("flex justify-start", fresh && "animate-receive-in")} data-changes-card>
      <div className={cn("w-full max-w-[520px] rounded-2xl border bg-card p-3", undone && "opacity-70")}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {rehearsal ? (
              <FlaskConical size={15} className="shrink-0 text-muted-foreground" />
            ) : (
              <FileDiff size={15} className="shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-[13.5px] font-semibold text-foreground">
              {pending || discarded ? `Would change ${changes.total} file${changes.total === 1 ? "" : "s"}` : changedLine(changes.total)}
            </span>
            {(added > 0 || removed > 0) && (
              <span className="shrink-0 font-mono text-[11.5px]">
                <span className="text-success">+{added}</span> <span className="text-destructive">-{removed}</span>
              </span>
            )}
          </div>
          {discarded ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
              Discarded
            </span>
          ) : pending ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => decide("discard")}
                disabled={busy}
                className="rounded-full px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Discard
              </button>
              <button
                onClick={() => decide("apply")}
                disabled={busy}
                className="flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                Apply
              </button>
            </div>
          ) : undone ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
              Undone
            </span>
          ) : confirming ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-full px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Keep
              </button>
              <button
                onClick={undo}
                disabled={busy}
                className="flex items-center gap-1 rounded-full bg-destructive px-2.5 py-1 text-[12px] font-semibold text-destructive-foreground transition-opacity hover:opacity-90"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                Put them back
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:border-foreground/30"
            >
              <Undo2 size={12} />
              Undo
            </button>
          )}
        </div>
        {pending && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            A rehearsal: made on a copy of the folder, not in it. Apply writes these into the real folder, except any file
            that changed there since.
          </p>
        )}
        {rehearsal === "applied" && !undone && (
          <p className="mt-2 text-[12px] text-muted-foreground">Applied from a rehearsal.</p>
        )}
        {confirming && !undone && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Every file below goes back to how it was before this turn. Anything changed again since is left alone.
          </p>
        )}
        <ul className="mt-2 flex flex-col">
          {changes.files.map((file) => {
            const Icon = ICON[file.status];
            return (
              <li key={file.path}>
                <button
                  onClick={() => setOpen(file)}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-accent"
                  title={`${VERB[file.status]} ${file.path}`}
                >
                  <Icon
                    size={13}
                    className={cn(
                      "shrink-0",
                      file.status === "added" && "text-success",
                      file.status === "deleted" && "text-destructive",
                      file.status === "modified" && "text-muted-foreground",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{file.path}</span>
                  {file.big ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">large file</span>
                  ) : (
                    (file.added !== undefined || file.removed !== undefined) && (
                      <span className="shrink-0 font-mono text-[11px]">
                        <span className="text-success">+{file.added ?? 0}</span>{" "}
                        <span className="text-destructive">-{file.removed ?? 0}</span>
                      </span>
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {changes.total > changes.files.length && (
          <div className="mt-1 px-1.5 text-[11.5px] text-muted-foreground">
            and {changes.total - changes.files.length} more
          </div>
        )}
        {undone && (
          <div className="mt-2 px-1.5 text-[11.5px] text-muted-foreground">
            Put back {undone.restored} file{undone.restored === 1 ? "" : "s"}
            {undone.skipped > 0 && `, left ${undone.skipped} that changed since`}.
          </div>
        )}
        {skipped.length > 0 && (
          <ul className="mt-1 px-1.5 text-[11.5px] text-muted-foreground">
            {skipped.slice(0, 8).map((s) => (
              <li key={s.path} className="truncate">
                <span className="font-mono">{s.path}</span>: {s.why}
              </li>
            ))}
          </ul>
        )}
        {error && <div className="mt-2 px-1.5 text-[12px] text-destructive">{error}</div>}
      </div>
      {open && <DiffDialog checkpointId={changes.checkpointId} file={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DiffDialog({ checkpointId, file, onClose }: { checkpointId: string; file: Change; onClose: () => void }) {
  const [diff, setDiff] = useState<FileDiffBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api(`/api/checkpoints/${checkpointId}/diff?path=${encodeURIComponent(file.path)}`)
      .then((body: { diff: FileDiffBody }) => live && setDiff(body.diff))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [checkpointId, file.path]);
  const note = diff?.big
    ? "This file is too large to have been kept, so there is no diff to show."
    : diff?.binary
      ? "This is not a text file, so there is no diff to show."
      : diff?.tooLong
        ? "This change is too long to show here."
        : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[760px] flex-col gap-0 overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <DialogTitle className="truncate font-mono text-[13px]">{file.path}</DialogTitle>
          <div className="mt-0.5 text-[12px] text-muted-foreground">{VERB[file.status]} in this turn</div>
        </div>
        <div className="flex-1 overflow-auto bg-muted/30 py-2 font-mono text-[12px] leading-[1.55]">
          {error && <div className="px-4 text-destructive">{error}</div>}
          {!diff && !error && (
            <div className="flex items-center gap-2 px-4 text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading
            </div>
          )}
          {note && <div className="px-4 font-sans text-muted-foreground">{note}</div>}
          {diff &&
            !note &&
            diff.lines.map((line, at) =>
              line.kind === "gap" ? (
                <div key={at} className="my-1 px-4 font-sans text-[11px] text-muted-foreground">
                  {line.text}
                </div>
              ) : (
                <div
                  key={at}
                  className={cn(
                    "whitespace-pre-wrap break-all px-4",
                    line.kind === "add" && "bg-success/12 text-foreground",
                    line.kind === "del" && "bg-destructive/12 text-foreground",
                    line.kind === "same" && "text-muted-foreground",
                  )}
                >
                  <span className="mr-3 select-none opacity-60">
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                  </span>
                  {line.text || " "}
                </div>
              ),
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
