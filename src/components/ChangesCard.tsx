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
import { Check } from "@/components/icons";
import { FileDiff } from "@/components/icons";
import { FlaskConical } from "@/components/icons";
import { FileMinus } from "@/components/icons";
import { FilePen } from "@/components/icons";
import { FilePlus } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Undo2 } from "@/components/icons";
import { api, useStore, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { changedLine } from "@/lib/preview";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DiffLines, type DiffLine } from "./DiffLines";
import { t, type MessageKey } from "@/lib/i18n";

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

/** "Changed while Ada was working here", "while Ada and Linus were",
 * "while Ada, Linus and 2 others were": one sentence for each, since
 * the verb agrees with how many there were. */
function changedWhile(names: string[]): string {
  if (names.length <= 1) return t("changesCard.changedWhile.one", { name: names[0] ?? t("changesCard.anotherAgent") });
  if (names.length === 2) return t("changesCard.changedWhile.two", { first: names[0], second: names[1] });
  return t("changesCard.changedWhile.more", { first: names[0], second: names[1], count: names.length - 2 });
}
const VERB: Record<Change["status"], MessageKey> = {
  added: "changesCard.verb.added",
  modified: "changesCard.verb.modified",
  deleted: "changesCard.verb.deleted",
};
const VERB_PATH: Record<Change["status"], MessageKey> = {
  added: "changesCard.verbPath.added",
  modified: "changesCard.verbPath.modified",
  deleted: "changesCard.verbPath.deleted",
};

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
  const alongside = changedWhile([
    ...new Set((changes.shared?.alongside ?? []).map((id) => state.bots.find((b) => b.id === id)?.name ?? t("changesCard.anotherAgent"))),
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
            <span className="truncate text-ui font-semibold text-foreground">
              {pending || discarded
                ? t("changesCard.wouldChange", { count: changes.total })
                : ownTotal > 0
                  ? changedLine(ownTotal)
                  : changedLine(0, sharedTotal)}
            </span>
            {(added > 0 || removed > 0) && (
              <span className="shrink-0 font-mono text-small">
                <span className="text-success">+{added}</span> <span className="text-destructive">-{removed}</span>
              </span>
            )}
          </div>
          {discarded ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-small font-medium text-muted-foreground">
              {t("changesCard.discarded")}
            </span>
          ) : pending ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => decide("discard")}
                disabled={busy}
                className="rounded-full px-2.5 py-1 text-small text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("common.discard")}
              </button>
              <button
                onClick={() => decide("apply")}
                disabled={busy}
                className="flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-small font-semibold text-primary-foreground transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96]"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {t("changesCard.apply")}
              </button>
            </div>
          ) : undone ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-small font-medium text-muted-foreground">
              {t("changesCard.undone")}
            </span>
          ) : ownTotal === 0 || changes.copied ? null : confirming ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="rounded-full px-2.5 py-1 text-small text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("common.keep")}
              </button>
              <button
                onClick={undo}
                disabled={busy}
                className="flex items-center gap-1 rounded-full bg-destructive px-2.5 py-1 text-small font-semibold text-destructive-foreground transition-opacity hover:opacity-90"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
                {t("changesCard.putThemBack")}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-small font-medium text-foreground transition-colors hover:border-foreground/30"
            >
              <Undo2 size={12} />
              {t("changesCard.undo")}
            </button>
          )}
        </div>
        {pending && (
          <p className="mt-2 text-small text-muted-foreground">
            {t("changesCard.madeOnACopyApply")}
          </p>
        )}
        {rehearsal === "applied" && !undone && (
          <p className="mt-2 text-small text-muted-foreground">{t("changesCard.appliedFromARehearsal")}</p>
        )}
        {/* a copy in a branch: the files are the workspace's, and undoing
            them is the original card's, which knows when it has been */}
        {changes.copied && !undone && ownTotal > 0 && (
          <p className="mt-2 text-small text-muted-foreground">{t("changesCard.undoInOriginal")}</p>
        )}
        {confirming && !undone && (
          <p className="mt-2 text-small text-muted-foreground">
            {sharedTotal > 0
              ? t("changesCard.theseFilesGoBackTo")
              : t("changesCard.everyFileBelowGoesBack")}
          </p>
        )}
        {ownFiles.length > 0 && <FileList files={ownFiles} onOpen={setOpen} />}
        {sharedFiles.length > 0 && (
          <>
            <div className={cn("px-1.5 text-small text-muted-foreground", ownFiles.length > 0 ? "mt-2.5" : "mt-2")}>
              {alongside}
            </div>
            <FileList files={sharedFiles} onOpen={setOpen} muted />
          </>
        )}
        {changes.total > changes.files.length && (
          <div className="mt-1 px-1.5 text-small text-muted-foreground">
            {t("changesCard.andMore", { count: changes.total - changes.files.length })}
          </div>
        )}
        {undone && (
          <div className="mt-2 px-1.5 text-small text-muted-foreground">
            {undone.skipped - sharedTotal > 0
              ? t("changesCard.putBackLeft", { count: undone.restored, left: undone.skipped - sharedTotal })
              : t("changesCard.putBack", { count: undone.restored })}
          </div>
        )}
        {skipped.length > 0 && (
          <ul className="mt-1 px-1.5 text-small text-muted-foreground">
            {skipped.slice(0, 8).map((s) => (
              <li key={s.path} className="truncate">
                <span className="font-mono">{s.path}</span>: {s.why}
              </li>
            ))}
          </ul>
        )}
        {error && <div className="mt-2 px-1.5 text-small text-destructive">{error}</div>}
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
              title={t(VERB_PATH[file.status], { path: file.path })}
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
              <span className="min-w-0 flex-1 truncate font-mono text-small text-foreground">{file.path}</span>
              {file.big ? (
                <span className="shrink-0 text-caption text-muted-foreground">{t("changesCard.largeFile")}</span>
              ) : (
                (file.added !== undefined || file.removed !== undefined) && (
                  <span className="shrink-0 font-mono text-caption">
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
    ? t("changesCard.tooLarge")
    : diff?.binary
      ? t("changesCard.notText")
      : diff?.tooLong
        ? t("changesCard.tooLong")
        : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[760px] flex-col gap-0 overflow-hidden p-0">
        <div className="border-b px-4 py-3">
          <DialogTitle className="truncate font-mono text-body">{file.path}</DialogTitle>
          <div className="mt-0.5 text-small text-muted-foreground">{t(VERB[file.status])}</div>
        </div>
        <div className="flex-1 overflow-auto bg-muted/30 py-2 font-mono text-small leading-[1.55]">
          {error && <div className="px-4 text-destructive">{error}</div>}
          {!diff && !error && (
            <div className="flex items-center gap-2 px-4 text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> {t("common.loading2")}
            </div>
          )}
          {note && <div className="px-4 font-sans text-muted-foreground">{note}</div>}
          {diff && !note && <DiffLines lines={diff.lines} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
