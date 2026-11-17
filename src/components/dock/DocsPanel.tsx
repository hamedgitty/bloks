// The documents open in a conversation's dock: one tab each, the file in
// front shown in the same viewer a card opens (Artifacts.tsx), every other
// one kept drawn behind it so its place, and rendered or source, are where
// they were when it comes back to the front (GitHub 509). A tab's × closes
// that file; the dock's own × only hides them all for later.
import { useState, type KeyboardEvent } from "react";
import { FileText, X } from "@/components/icons";
import { ArtifactView, ArtifactViewer } from "@/components/Artifacts";
import { cn } from "@/lib/cn";
import { fileBase } from "@/lib/sharedFile";
import { dock, type DockDoc, type DockPlace } from "@/lib/dock";
import { t } from "@/lib/i18n";

export function DocsPanel({ placeKey, place, shown }: { placeKey: string; place: DockPlace; shown: boolean }) {
  const [larger, setLarger] = useState<DockDoc | null>(null);
  if (!place.docs.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <div className="mb-1 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <FileText size={18} />
        </div>
        <p className="text-ui font-medium text-foreground">{t("dock.docs.empty")}</p>
        <p className="max-w-[36ch] text-pretty text-body text-muted-foreground">{t("dock.docs.emptyHint")}</p>
      </div>
    );
  }
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
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t("dock.docs.tabs")}
        onKeyDown={onKeyDown}
        className="flex h-[38px] shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 [scrollbar-width:none]"
      >
        {place.docs.map((doc) => {
          const open = doc.id === place.doc;
          const label = fileBase(doc.name);
          return (
            <div key={doc.id} className="group relative flex shrink-0 items-center">
              <button
                type="button"
                role="tab"
                id={`dock-doc-${doc.id}`}
                aria-selected={open}
                aria-controls={`dock-doc-pane-${doc.id}`}
                tabIndex={open ? 0 : -1}
                title={doc.name}
                onClick={() => dock.selectDoc(placeKey, doc.id)}
                className={cn(
                  "flex h-7 max-w-[184px] items-center gap-1.5 rounded-md pl-2 pr-7 text-body outline-none transition-colors duration-150",
                  open ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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
                  open ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {place.docs.map((doc) => {
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
            />
          </div>
        );
      })}
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
