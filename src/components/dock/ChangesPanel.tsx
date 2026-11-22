// The Changes panel of a conversation's dock (GitHub 522): the files this
// conversation's turns changed, each with the lines it gained and lost and
// a diff from before the first turn that touched it to after the last
// (server/checkpoints.ts, laneChanges). A line of that diff opens the file
// as the conversation left it, at that line. Where the folder is a
// repository, a second view lists everything git says is not committed
// there, whoever wrote it (server/git-changes.ts).
//
// It reads; it never writes. Undo stays on each turn's card in the
// conversation, where it says which turn it takes back.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileMinus, FilePen, FilePlus, GitBranch, RefreshCw } from "@/components/icons";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { formatNumber, t, type MessageKey } from "@/lib/i18n";
import { useDockFocus } from "@/lib/dock";
import { changeTotals, numberedDiff, type ChangedFile, type NumberedLine } from "@/lib/laneChanges";
import { NumberedText } from "./NumberedText";

type Scope = "conversation" | "git";

interface GitState {
  repo: boolean;
  installed?: boolean;
  branch?: string | null;
  head?: string | null;
  ahead?: number;
  behind?: number;
  changes?: Array<{ path: string; status: string; added: number | null; removed: number | null; untracked?: boolean; binary?: boolean; from?: string }>;
  truncated?: boolean;
}

const ICON = { added: FilePlus, modified: FilePen, deleted: FileMinus, renamed: FilePen, conflict: FilePen } as const;
const STATUS_WORDS: Record<string, MessageKey> = {
  added: "dock.changes.status.added",
  modified: "dock.changes.status.modified",
  deleted: "dock.changes.status.deleted",
  renamed: "dock.changes.status.renamed",
  conflict: "dock.changes.status.conflict",
};

/** The conversation's changed files, asked for again whenever `round`
 * moves (a turn's card arrived or was undone) and while the panel shows. */
export function useLaneChanges(threadId: string, round: string, shown: boolean): ChangedFile[] | null {
  const [files, setFiles] = useState<{ threadId: string; files: ChangedFile[] } | null>(null);
  useEffect(() => {
    let live = true;
    api(`/api/threads/${threadId}/changes`)
      .then((r: { changes?: ChangedFile[] }) => live && setFiles({ threadId, files: Array.isArray(r.changes) ? r.changes : [] }))
      .catch(() => live && setFiles({ threadId, files: [] }));
    return () => {
      live = false;
    };
  }, [threadId, round, shown]);
  return files?.threadId === threadId ? files.files : null;
}

function Counts({ added, removed }: { added?: number | null; removed?: number | null }) {
  if (added == null && removed == null) return null;
  return (
    <span className="shrink-0 font-mono text-caption tabular-nums" aria-label={t("dock.changes.lines", { added: added ?? 0, removed: removed ?? 0 })}>
      {added != null && <span className="text-success">+{formatNumber(added)}</span>}
      {removed != null && <span className="ml-1.5 text-destructive">−{formatNumber(removed)}</span>}
    </span>
  );
}

function FileRow({ path, status, added, removed, note, onOpen }: { path: string; status: string; added?: number | null; removed?: number | null; note?: string; onOpen: () => void }) {
  const Icon = ICON[status as keyof typeof ICON] ?? FilePen;
  const at = path.lastIndexOf("/");
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={`${path}, ${t(STATUS_WORDS[status] ?? "dock.changes.status.modified")}`}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon
          size={14}
          aria-hidden
          className={cn("shrink-0", status === "added" ? "text-success" : status === "deleted" ? "text-destructive" : "text-muted-foreground")}
        />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-foreground">{path.slice(at + 1)}</span>
          {at > 0 && <span className="truncate text-caption text-muted-foreground">{path.slice(0, at)}</span>}
          {note && <span className="shrink-0 text-caption text-muted-foreground">{note}</span>}
        </span>
        <Counts added={added} removed={removed} />
      </button>
    </li>
  );
}

export function ChangesPanel({ placeKey, threadId, files, shown }: { placeKey: string; threadId: string; files: ChangedFile[] | null; shown: boolean }) {
  const [scope, setScope] = useState<Scope>("conversation");
  const [git, setGit] = useState<GitState | null>(null);
  const [gitRound, setGitRound] = useState(0);
  const [open, setOpen] = useState<{ scope: Scope; path: string; status: string } | null>(null);
  const [atLine, setAtLine] = useState<{ path: string; line: number; n: number } | null>(null);
  const focus = useDockFocus(placeKey);

  // whether the folder is a repository, asked once the panel is shown,
  // and again when the person asks
  useEffect(() => {
    if (!shown) return;
    let live = true;
    api(`/api/threads/${threadId}/changes/git`)
      .then((r: { git?: GitState }) => live && setGit(r.git ?? { repo: false }))
      .catch(() => live && setGit({ repo: false }));
    return () => {
      live = false;
    };
  }, [threadId, shown, gitRound]);

  // another conversation is another list: what was open goes
  const seenThread = useRef(threadId);
  useEffect(() => {
    if (seenThread.current === threadId) return;
    seenThread.current = threadId;
    setOpen(null);
    setAtLine(null);
  }, [threadId]);

  // an agent's `bloks dock show changes <file> --line`
  useEffect(() => {
    if (focus?.panel !== "changes" || focus.target?.kind !== "change") return;
    const target = focus.target;
    const file = files?.find((f) => f.path === target.path);
    setScope("conversation");
    setOpen({ scope: "conversation", path: target.path, status: file?.status ?? "modified" });
    setAtLine(target.line ? { path: target.path, line: target.line, n: focus.n } : null);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps


  const totals = changeTotals(files ?? []);
  const gitHere = git?.repo === true;

  if (atLine && open) {
    return <FileAtLine threadId={threadId} path={atLine.path} line={atLine.line} nonce={atLine.n} onBack={() => setAtLine(null)} />;
  }
  if (open) {
    return (
      <DiffView
        threadId={threadId}
        scope={open.scope}
        path={open.path}
        status={open.status}
        onBack={() => setOpen(null)}
        onLine={open.scope === "conversation" && open.status !== "deleted" ? (line) => setAtLine({ path: open.path, line, n: Date.now() }) : undefined}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[38px] shrink-0 items-center gap-1 border-b px-1.5">
        <div role="radiogroup" aria-label={t("dock.changes.scope")} className="flex min-w-0 items-center gap-0.5">
          {(["conversation", "git"] as const)
            .filter((s) => s === "conversation" || gitHere)
            .map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                onClick={() => setScope(s)}
                className={cn(
                  "h-7 truncate rounded-md px-2 text-body outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                  scope === s ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {s === "conversation" ? t("dock.changes.thisConversation") : t("dock.changes.uncommitted")}
              </button>
            ))}
        </div>
        <span className="flex-1" />
        {scope === "git" && gitHere && (git.branch || git.head) && (
          <span className="flex min-w-0 items-center gap-1 truncate text-caption text-muted-foreground" title={git.branch ?? git.head ?? ""}>
            <GitBranch size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{git.branch ?? t("dock.changes.detached", { commit: git.head ?? "" })}</span>
          </span>
        )}
        {scope === "git" && (
          <button
            type="button"
            onClick={() => setGitRound((n) => n + 1)}
            aria-label={t("dock.changes.refresh")}
            title={t("dock.changes.refresh")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {scope === "conversation" ? (
          files === null ? (
            <p className="px-2 py-1.5 text-small text-muted-foreground">{t("common.loading")}</p>
          ) : files.length === 0 ? (
            <Empty title={t("dock.changes.none")} hint={t("dock.changes.noneHint")} />
          ) : (
            <>
              <p className="px-2 pb-1.5 pt-0.5 text-caption text-muted-foreground">
                {t("dock.changes.summary", { count: files.length })}
                <span className="ml-2 font-mono tabular-nums">
                  <span className="text-success">+{formatNumber(totals.added)}</span>
                  <span className="ml-1.5 text-destructive">−{formatNumber(totals.removed)}</span>
                </span>
              </p>
              <ul aria-label={t("dock.changes.files")}>
                {files.map((f) => (
                  <FileRow
                    key={f.path}
                    path={f.path}
                    status={f.status}
                    added={f.added}
                    removed={f.removed}
                    note={f.turns > 1 ? t("dock.changes.turns", { count: f.turns }) : undefined}
                    onOpen={() => setOpen({ scope: "conversation", path: f.path, status: f.status })}
                  />
                ))}
              </ul>
            </>
          )
        ) : !git?.changes?.length ? (
          <Empty title={t("dock.changes.clean")} hint={t("dock.changes.cleanHint")} />
        ) : (
          <>
            {(git.ahead ?? 0) + (git.behind ?? 0) > 0 && (
              <p className="px-2 pb-1.5 pt-0.5 text-caption text-muted-foreground">{t("dock.changes.aheadBehind", { ahead: git.ahead ?? 0, behind: git.behind ?? 0 })}</p>
            )}
            <ul aria-label={t("dock.changes.files")}>
              {git.changes.map((f) => (
                <FileRow
                  key={f.path}
                  path={f.path}
                  status={f.status}
                  added={f.added}
                  removed={f.removed}
                  note={f.untracked ? t("dock.changes.new") : undefined}
                  onOpen={() => setOpen({ scope: "git", path: f.path, status: f.status })}
                />
              ))}
            </ul>
            {git.truncated && <p className="px-2 py-1.5 text-caption text-muted-foreground">{t("dock.changes.truncated")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
      <p className="text-ui font-medium text-foreground">{title}</p>
      <p className="max-w-[36ch] text-pretty text-body text-muted-foreground">{hint}</p>
    </div>
  );
}

function BackBar({ path, onBack, children }: { path: string; onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b px-1.5">
      <button
        type="button"
        onClick={onBack}
        aria-label={t("dock.changes.back")}
        title={t("dock.changes.back")}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft size={15} />
      </button>
      <span className="min-w-0 flex-1 truncate text-body text-foreground" title={path}>
        {path}
      </span>
      {children}
    </div>
  );
}

interface DiffAnswer {
  binary?: boolean;
  big?: boolean;
  tooLong?: boolean;
  tooLarge?: boolean;
  link?: boolean;
  truncated?: boolean;
  lines?: Array<{ kind: "same" | "add" | "del" | "gap"; text: string; old?: number; new?: number; skipped?: number }>;
  hunks?: Array<{ header: string; lines: Array<{ kind: "same" | "add" | "del"; text: string; old?: number; new?: number }> }>;
}

function DiffView({ threadId, scope, path, status, onBack, onLine }: { threadId: string; scope: Scope; path: string; status: string; onBack: () => void; onLine?: (line: number) => void }) {
  const [diff, setDiff] = useState<DiffAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDiff(null);
    setError(null);
    api(`/api/threads/${threadId}/changes/${scope === "git" ? "git-diff" : "diff"}?path=${encodeURIComponent(path)}`)
      .then((r: { diff: DiffAnswer }) => live && setDiff(r.diff))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [threadId, scope, path]);
  const rows: NumberedLine[] = diff ? numberedDiff(diff) : [];
  const said = diff?.binary
    ? t("dock.changes.binary")
    : diff?.big || diff?.tooLarge
      ? t("dock.changes.tooLarge")
      : diff?.tooLong
        ? t("dock.changes.tooLong")
        : diff?.link
          ? t("dock.changes.link")
          : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BackBar path={path} onBack={onBack}>
        <span className="shrink-0 text-caption text-muted-foreground">{t(STATUS_WORDS[status] ?? "dock.changes.status.modified")}</span>
      </BackBar>
      <div className="min-h-0 flex-1 overflow-auto bg-background py-2 font-mono text-small leading-[1.55]" aria-label={t("dock.changes.diffOf", { path })}>
        {error ? (
          <p className="px-4 py-2 font-sans text-body text-muted-foreground">{error}</p>
        ) : !diff ? (
          <p className="px-4 py-2 font-sans text-body text-muted-foreground">{t("common.loading")}</p>
        ) : said ? (
          <p className="px-4 py-2 font-sans text-body text-muted-foreground">{said}</p>
        ) : (
          <>
            {rows.map((row, at) =>
              row.kind === "gap" ? (
                <div key={at} className="my-1 px-4 font-sans text-caption text-muted-foreground">
                  {row.skipped ? t("dock.changes.unchanged", { count: row.skipped }) : "…"}
                </div>
              ) : (
                <div
                  key={at}
                  className={cn(
                    "group flex",
                    row.kind === "add" && "bg-success/12",
                    row.kind === "del" && "bg-destructive/12",
                  )}
                >
                  <span className="w-10 shrink-0 select-none pr-1 text-right tabular-nums text-muted-foreground/70">{row.old ?? ""}</span>
                  {onLine && row.new ? (
                    <button
                      type="button"
                      onClick={() => onLine(row.new!)}
                      title={t("dock.changes.openAt", { line: row.new })}
                      aria-label={t("dock.changes.openAt", { line: row.new })}
                      className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/70 outline-none hover:text-foreground hover:underline focus-visible:text-foreground"
                    >
                      {row.new}
                    </button>
                  ) : (
                    <span className="w-10 shrink-0 select-none pr-2 text-right tabular-nums text-muted-foreground/70">{row.new ?? ""}</span>
                  )}
                  <span className="mr-2 w-3 shrink-0 select-none text-muted-foreground">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
                  <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-all pr-4", row.kind === "same" ? "text-muted-foreground" : "text-foreground")}>
                    {row.text || " "}
                  </span>
                </div>
              ),
            )}
            {diff.truncated && <p className="px-4 py-2 font-sans text-caption text-muted-foreground">{t("dock.changes.truncatedDiff")}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function FileAtLine({ threadId, path, line, nonce, onBack }: { threadId: string; path: string; line: number; nonce: number; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    api(`/api/threads/${threadId}/changes/file?path=${encodeURIComponent(path)}`)
      .then((r: { text: string }) => live && setText(r.text))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [threadId, path]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BackBar path={path} onBack={onBack}>
        <span className="shrink-0 text-caption text-muted-foreground">{t("dock.changes.line", { line })}</span>
      </BackBar>
      {error ? (
        <p className="px-4 py-2 text-body text-muted-foreground">{error}</p>
      ) : text === null ? (
        <p className="px-4 py-2 text-body text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <NumberedText text={text} line={line} nonce={nonce} />
      )}
    </div>
  );
}
