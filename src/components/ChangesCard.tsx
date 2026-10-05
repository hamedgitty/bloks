// What a turn did to your files, and the way back.
//
// The server photographs an agent's folder before and after each turn
// (server/checkpoints.ts); this is the card that difference becomes. A
// file opens into its diff. Undo puts every file back as it was before
// the turn, except the ones that changed again since, which it names
// rather than overwrites.
//
// A turn that ran beside another agent in the same folder cannot be sure
// which writes were its own, so the server marks the files its engine did
// not say it edited (GitHub 153). They are listed apart, under who else
// was working there, and Undo leaves them alone.
import { useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import FileDiff from "lucide-react/dist/esm/icons/file-diff.mjs";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical.mjs";
import FileMinus from "lucide-react/dist/esm/icons/file-minus.mjs";
import FilePen from "lucide-react/dist/esm/icons/file-pen.mjs";
import FilePlus from "lucide-react/dist/esm/icons/file-plus.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Undo2 from "lucide-react/dist/esm/icons/undo-2.mjs";
import { api, useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { changedLine } from "@/lib/preview";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DiffLines, type DiffLine } from "./DiffLines";

type Changes = NonNullable<Message["changes"]>;
type Change = Changes["files"][number];

interface FileDiffBody {
  path: string;
  status: Change["status"];
  binary?: boolean;
  big?: boolean;
  tooLong?: boolean;
  lines: DiffLine[];
}

const ICON = { added: FilePlus, modified: FilePen, deleted: FileMinus } as const;

/** "Ada", "Ada and Linus", "Ada, Linus and 2 others". */
function namesOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "another agent";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length === 3 ? "" : "s"}`;
}
const VERB = { added: "Added", modified: "Changed", deleted: "Deleted" } as const;

export function ChangesCard({ message, fresh }: { message: Message; fresh?: boolean }) {
  const { state } = useStore();
  const changes = message.changes;
  const [open, setOpen] = useState<Change | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ path: string; why: string }>>([]);
  if (!changes) return null;

  const ownFiles = changes.files.filter((f) => !f.shared);
  const sharedFiles = changes.files.filter((f) => f.shared);
  const sharedTotal = changes.shared?.total ?? 0;
  const ownTotal = changes.total - sharedTotal;
  const alongside = namesOf([
    ...new Set((changes.shared?.alongside ?? []).map((id) => state.bots.find((b) => b.id === id)?.name ?? "another agent")),
  ]);
  const added = ownFiles.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = ownFiles.reduce((n, f) => n + (f.removed ?? 0), 0);
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
              {pending || discarded
                ? `Would change ${changes.total} file${changes.total === 1 ? "" : "s"}`
                : ownTotal > 0
                  ? changedLine(ownTotal)
                  : changedLine(0, sharedTotal)}
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
          ) : ownTotal === 0 ? null : confirming ? (
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
            {sharedTotal > 0
              ? "This turn's files go back to how they were before it. Anything changed again since, and the files changed while others were working here, are left alone."
              : "Every file below goes back to how it was before this turn. Anything changed again since is left alone."}
          </p>
        )}
        {ownFiles.length > 0 && <FileList files={ownFiles} onOpen={setOpen} />}
        {sharedFiles.length > 0 && (
          <>
            <div className={cn("px-1.5 text-[11.5px] text-muted-foreground", ownFiles.length > 0 ? "mt-2.5" : "mt-2")}>
              Changed while {alongside} {alongside.includes(" and ") ? "were" : "was"} working here. They may not be this
              turn's, so Undo leaves them alone.
            </div>
            <FileList files={sharedFiles} onOpen={setOpen} muted />
          </>
        )}
        {changes.total > changes.files.length && (
          <div className="mt-1 px-1.5 text-[11.5px] text-muted-foreground">
            and {changes.total - changes.files.length} more
          </div>
        )}
        {undone && (
          <div className="mt-2 px-1.5 text-[11.5px] text-muted-foreground">
            Put back {undone.restored} file{undone.restored === 1 ? "" : "s"}
            {undone.skipped - sharedTotal > 0 && `, left ${undone.skipped - sharedTotal} that changed since`}.
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

/** One group of files on the card. A muted one is the files changed
 * while others were working here: there, and openable, but quieter. */
function FileList({ files, onOpen, muted }: { files: Change[]; onOpen: (file: Change) => void; muted?: boolean }) {
  return (
    <ul className={cn("flex flex-col", muted ? "mt-1 opacity-75" : "mt-2")}>
      {files.map((file) => {
        const Icon = ICON[file.status];
        return (
          <li key={file.path}>
            <button
              onClick={() => onOpen(file)}
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
          {diff && !note && <DiffLines lines={diff.lines} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
