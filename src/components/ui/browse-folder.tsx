// The Browse button that sits beside every folder field.
//
// Typing a path stays possible for the people who think in paths; this
// is for everyone else, who should get the same Finder window every
// other Mac app gives them. In a plain browser tab there is no picker
// to offer, so the button simply is not there and the field stands on
// its own.
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import { cn } from "@/lib/cn";

export function BrowseFolderButton({
  onPick,
  className,
}: {
  /** Called with the chosen absolute path; not called on cancel. */
  onPick: (path: string) => void;
  className?: string;
}) {
  if (!window.bloks?.pickFolder) return null;
  return (
    <button
      type="button"
      title="Choose a folder"
      aria-label="Choose a folder"
      onClick={() => {
        void window.bloks?.pickFolder?.().then((path) => {
          if (path) onPick(path);
        });
      }}
      className={cn(
        "flex h-8 shrink-0 items-center justify-center rounded-lg border border-input px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <FolderOpen size={15} />
    </button>
  );
}
