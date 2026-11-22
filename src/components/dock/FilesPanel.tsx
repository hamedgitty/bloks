// The Files panel of a conversation's dock: the agent's shared files as a
// tree with a filter box, and the files opened from it, from a card or
// from a path in the conversation, one tab each (GitHub 509, 522). The
// file in front is shown in the same viewer a card opens (Artifacts.tsx),
// every other one kept drawn behind it so its place, and rendered or
// source, are where they were when it comes back to the front. A tab's ×
// closes that file; the dock's own × only hides them all for later.
//
// The tree is the agent's own files folder, as the server lists it
// (src/lib/fileTree.ts): the one place a file is served from. It sits
// beside the open files where the dock is wide, and above them, folded
// away once a file is open, where it is not. A room has no tree: its
// files belong to several agents, and each comes in by its card.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, ListTree, Search, X } from "@/components/icons";
import { ArtifactView, ArtifactViewer } from "@/components/Artifacts";
import { api } from "@/state/store";
import { cn } from "@/lib/cn";
import { fileBase } from "@/lib/sharedFile";
import { dock, useDockFocus, type DockDoc, type DockPlace } from "@/lib/dock";
import { buildTree, countFiles, filterTree, visibleRows, type FileLeaf } from "@/lib/fileTree";
import { t } from "@/lib/i18n";

/** How often the tree asks again while it is shown: files arrive as an
 * agent works, and there is no watcher to say so. */
const TREE_MS = 8_000;

/** The agent's shared files, asked for while the panel is shown. */
export function useSharedFiles(botId: string | undefined, shown: boolean): FileLeaf[] | null {
  const [files, setFiles] = useState<FileLeaf[] | null>(null);
  useEffect(() => {
    if (!botId || !shown) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      api(`/api/bots/${botId}/artifacts`)
        .then((r: { files?: FileLeaf[] }) => live && setFiles(Array.isArray(r.files) ? r.files : []))
        .catch(() => live && setFiles((was) => was ?? []))
        .finally(() => {
          if (live) timer = setTimeout(ask, TREE_MS);
        });
    };
    ask();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [botId, shown]);
  return botId ? files : null;
}

export function FilesPanel({ placeKey, place, shown, botId }: { placeKey: string; place: DockPlace; shown: boolean; botId?: string }) {
  const [larger, setLarger] = useState<DockDoc | null>(null);
  const files = useSharedFiles(botId, shown);
  // the tree is out when no file is open; once one is, it folds away
  // unless asked back, so a narrow dock gives the file its whole height
  const [treeAsked, setTreeAsked] = useState<boolean | null>(null);
  const treeOut = Boolean(botId) && (treeAsked ?? place.docs.length === 0);
  const focus = useDockFocus(placeKey);
  const lineFor = (doc: DockDoc) =>
    focus?.target?.kind === "doc" && focus.target.botId === doc.botId && focus.target.name === doc.name && focus.target.line
      ? { at: focus.target.line, n: focus.n }
      : undefined;

  const open = (file: FileLeaf) => {
    if (!botId) return;
    dock.openDoc(placeKey, { botId, name: file.name, mime: file.mime, size: file.size });
  };
  const ids = place.docs.map((d) => d.id);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = place.doc ? ids.indexOf(place.doc) : -1;
    const by = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!by || at < 0 || ids.length < 2) return;
    e.preventDefault();
    const next = ids[(at + by + ids.length) % ids.length];
    dock.selectDoc(placeKey, next);
    document.getElementById(`dock-doc-${CSS.escape(next)}`)?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col @container">
      <div className="flex h-[38px] shrink-0 items-center gap-0.5 border-b px-1.5">
        {botId && (
          <button
            type="button"
            onClick={() => setTreeAsked(!treeOut)}
            aria-pressed={treeOut}
            aria-label={t("dock.files.tree")}
            title={t("dock.files.tree")}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground",
              treeOut && "bg-accent text-foreground",
            )}
          >
            <ListTree size={15} />
          </button>
        )}
        <div
          role="tablist"
          aria-label={t("dock.docs.tabs")}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        >
          {place.docs.map((doc) => {
            const front = doc.id === place.doc;
            const label = fileBase(doc.name);
            return (
              <div key={doc.id} className="group relative flex shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  id={`dock-doc-${doc.id}`}
                  aria-selected={front}
                  aria-controls={`dock-doc-pane-${doc.id}`}
                  tabIndex={front ? 0 : -1}
                  title={doc.name}
                  onClick={() => dock.selectDoc(placeKey, doc.id)}
                  className={cn(
                    "flex h-7 max-w-[184px] items-center gap-1.5 rounded-md pl-2 pr-7 text-body outline-none transition-colors duration-150",
                    front ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <FileText size={13} className="shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t("dock.docs.close", { name: label })}
                  title={t("dock.docs.close", { name: label })}
                  onClick={() => dock.closeDoc(placeKey, doc.id)}
                  className={cn(
                    "absolute right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-foreground/10 hover:text-foreground",
                    front ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col @[560px]:flex-row">
        {treeOut && (
          <FileTree
            files={files}
            current={place.docs.find((d) => d.id === place.doc)?.name ?? null}
            onOpen={open}
            alone={place.docs.length === 0}
          />
        )}
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", treeOut && place.docs.length === 0 && "hidden @[560px]:flex")}>
          {place.docs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
              <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <FileText size={18} />
              </div>
              <p className="text-ui font-medium text-foreground">{t("dock.docs.empty")}</p>
              <p className="max-w-[36ch] text-pretty text-body text-muted-foreground">{t(botId ? "dock.files.emptyHint" : "dock.docs.emptyHint")}</p>
            </div>
          ) : (
            place.docs.map((doc) => {
              const front = doc.id === place.doc;
              return (
                <div
                  key={doc.id}
                  id={`dock-doc-pane-${doc.id}`}
                  role="tabpanel"
                  aria-labelledby={`dock-doc-${doc.id}`}
                  hidden={!front}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <ArtifactView
                    docked
                    active={shown && front}
                    botId={doc.botId}
                    artifact={{ name: doc.name, mime: doc.mime, size: doc.size }}
                    onClose={() => dock.closeDoc(placeKey, doc.id)}
                    onExpand={() => setLarger(doc)}
                    line={lineFor(doc)}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
      {larger && (
        <ArtifactViewer
          botId={larger.botId}
          artifact={{ name: larger.name, mime: larger.mime, size: larger.size }}
          onClose={() => setLarger(null)}
        />
      )}
    </div>
  );
}

/** The agent's shared files as a tree, with a box that narrows it. */
function FileTree({
  files,
  current,
  onOpen,
  alone,
}: {
  files: FileLeaf[] | null;
  current: string | null;
  onOpen: (file: FileLeaf) => void;
  /** Nothing open beside it: it takes the panel's whole height. */
  alone: boolean;
}) {
  const [query, setQuery] = useState("");
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => new Set());
  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const shown = useMemo(() => filterTree(tree, query), [tree, query]);
  const filtering = query.trim().length > 0;
  const rows = visibleRows(shown, openFolders, filtering);
  const toggle = (path: string) =>
    setOpenFolders((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <nav
      aria-label={t("dock.files.tree")}
      className={cn(
        "flex min-h-0 shrink-0 flex-col border-b @[560px]:w-[220px] @[560px]:border-b-0 @[560px]:border-r",
        alone ? "flex-1 @[560px]:flex-none" : "max-h-[40%] @[560px]:max-h-none",
      )}
    >
      <label className="m-1.5 flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-body focus-within:ring-2 focus-within:ring-ring">
        <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("dock.files.filter")}
          aria-label={t("dock.files.filter")}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
        {files === null ? (
          <p className="px-2 py-1.5 text-small text-muted-foreground">{t("common.loading")}</p>
        ) : countFiles(tree) === 0 ? (
          <p className="px-2 py-1.5 text-small text-muted-foreground">{t("dock.files.none")}</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-1.5 text-small text-muted-foreground">{t("dock.files.noMatch")}</p>
        ) : (
          <ul role="tree" aria-label={t("dock.files.tree")}>
            {rows.map(({ node, depth }) => {
              const expanded = node.folder && (filtering || openFolders.has(node.path));
              return (
                <li key={node.path} role="treeitem" aria-expanded={node.folder ? expanded : undefined} aria-selected={!node.folder && node.path === current}>
                  <button
                    type="button"
                    title={node.path}
                    onClick={() => (node.folder ? toggle(node.path) : node.file && onOpen(node.file))}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    className={cn(
                      "flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-body outline-none transition-colors duration-150 hover:bg-accent/60",
                      !node.folder && node.path === current ? "bg-accent text-foreground" : "text-foreground",
                    )}
                  >
                    {node.folder ? (
                      <>
                        <ChevronRight size={12} className={cn("shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")} aria-hidden />
                        {expanded ? <FolderOpen size={14} className="shrink-0 text-muted-foreground" aria-hidden /> : <Folder size={14} className="shrink-0 text-muted-foreground" aria-hidden />}
                      </>
                    ) : (
                      <FileText size={14} className="ml-[18px] shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate">{node.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
