// A skill's supporting files (server/skill-files.ts): the references and
// scripts it keeps beside its instructions, which agents read only when
// the instructions send them there. Listed by name and size, and each one
// opens in place, so the person can read exactly what an agent would,
// on the Skills page and on the card that asks to add one.
import { useState } from "react";
import { ChevronRight, FileText, Loader2 } from "@/components/icons";
import type { SkillFileInfo } from "@/state/store";
import { formatBytes } from "@/lib/attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function SkillFiles({
  files,
  read,
  className,
}: {
  files: SkillFileInfo[];
  /** One file's text, by its path. */
  read: (path: string) => Promise<string>;
  className?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<{ path: string; message: string } | null>(null);
  if (!files.length) return null;

  const toggle = (path: string) => {
    if (open === path) return setOpen(null);
    setOpen(path);
    setError(null);
    if (texts[path] !== undefined) return;
    setLoading(path);
    read(path)
      .then((text) => setTexts((had) => ({ ...had, [path]: text })))
      .catch((e: Error) => setError({ path, message: e.message }))
      .finally(() => setLoading((now) => (now === path ? null : now)));
  };

  return (
    <div className={className}>
      <div className="mb-1.5 text-body font-medium text-muted-foreground">
        {t("skillFiles.title", { count: String(files.length) })}
      </div>
      <ul className="overflow-hidden rounded-xl border">
        {files.map((file) => {
          const expanded = open === file.path;
          return (
            <li key={file.path} className="border-b last:border-b-0">
              <button
                type="button"
                onClick={() => toggle(file.path)}
                aria-expanded={expanded}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 hover:bg-accent/50"
              >
                <ChevronRight
                  size={13}
                  className={cn("shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-90")}
                />
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-small text-foreground">{file.path}</span>
                <span className="shrink-0 text-small tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
              </button>
              {expanded && (
                <div className="border-t bg-muted/40">
                  {loading === file.path ? (
                    <div className="flex items-center gap-2 px-3 py-2.5 text-small text-muted-foreground">
                      <Loader2 size={13} className="animate-spin" />
                      {t("skillFiles.loading")}
                    </div>
                  ) : error?.path === file.path ? (
                    <div className="px-3 py-2.5 text-small text-destructive">{error.message}</div>
                  ) : (
                    <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap p-3 font-mono text-small leading-relaxed text-foreground">
                      {texts[file.path]}
                    </pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
