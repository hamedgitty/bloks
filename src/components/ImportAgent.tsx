// An agent arriving from a file.
//
// Two beats on purpose. The file is read and described first, and nothing
// is written until the person has seen who is arriving, what it will add
// to their skill library and what it will not bring with it. A file from
// someone else is a stranger's document, and the moment before you say
// yes is the only place to say so.
//
// The server does the judging, twice: once for the preview and once for
// the import, with the same parser. This screen only shows what it was
// told and asks.
import { useEffect, useState } from "react";
import AlertTriangle from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Upload from "lucide-react/dist/esm/icons/upload.mjs";
import { api, useStore, type Bot } from "@/state/store";
import { BlokAvatar } from "./Avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { BlokColor, BlokShape } from "@/lib/mascot";

/** What the server says a file would do, before it does it. */
export interface AgentPreview {
  name: string;
  title: string;
  description: string;
  color?: BlokColor;
  shape?: BlokShape;
  capabilities: string[];
  seniority?: number;
  skills: Array<{ id: string; name: string; description: string; alreadyHere: boolean }>;
  memoryBytes: number;
  topics: number;
  hasPhoto: boolean;
  exportedAt: number;
  notes: string[];
}

/** The extension we write, and the only thing worth offering in a picker.
 * A file with a different name is still read: what makes it an agent is
 * what is inside it, which the server checks either way. */
export const AGENT_FILE_ACCEPT = ".json,application/json";

export function isAgentFileName(name: string): boolean {
  return /\.(bloks-agent|agent)\.json$/i.test(name) || name.toLowerCase().endsWith(".json");
}

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

export function ImportAgentDialog({
  text,
  onClose,
}: {
  /** The file's contents, already read. */
  text: string;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let live = true;
    api("/api/agents/import/preview", { method: "POST", body: JSON.stringify({ text }) })
      .then((r) => live && setPreview(r.preview))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [text]);

  const bringItIn = () => {
    if (importing) return;
    setImporting(true);
    setError(null);
    api("/api/agents/import", { method: "POST", body: JSON.stringify({ text }) })
      .then(({ bot }: { bot: Bot }) => {
        // same landing as making one: it is selected and this closes
        dispatch({ type: "botAdded", bot });
        onClose();
      })
      .catch((e: Error) => {
        setError(e.message);
        setImporting(false);
      });
  };

  const fresh = preview?.skills.filter((s) => !s.alreadyHere) ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-[460px] flex-col gap-0 overflow-hidden p-0">
        <div className="flex h-[52px] shrink-0 items-center border-b px-5">
          <DialogTitle className="text-[14.5px]">Bring in an agent</DialogTitle>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!preview && !error && (
            <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
              <Loader2 size={15} className="animate-spin" />
              Reading the file
            </div>
          )}

          {error && !preview && (
            <div className="rounded-xl bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
              {error}
            </div>
          )}

          {preview && (
            <>
              <div className="flex items-start gap-4">
                <BlokAvatar
                  color={preview.color ?? "blue"}
                  shape={preview.shape ?? "star"}
                  expression="friendly"
                  size={52}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-semibold text-foreground">
                    {preview.name}
                  </div>
                  {preview.title && (
                    <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
                      {preview.title}
                    </div>
                  )}
                </div>
              </div>

              {preview.description && (
                <p className="mt-3 line-clamp-4 text-[13px] leading-relaxed text-muted-foreground">
                  {preview.description}
                </p>
              )}

              {/* What it comes with, counted rather than described, so the
                  size of what is about to land is legible at a glance. */}
              <div className="mt-4 flex flex-col gap-1.5 rounded-xl border bg-card p-3">
                <Line label="Skills it carries" value={String(preview.skills.length)} />
                {fresh.length > 0 && (
                  <Line label="New to your library" value={fresh.map((s) => s.name).join(", ")} />
                )}
                {preview.capabilities.length > 0 && (
                  <Line label="What it does" value={preview.capabilities.join(", ")} />
                )}
                <Line
                  label="Memory"
                  value={
                    preview.memoryBytes || preview.topics
                      ? [
                          preview.memoryBytes ? size(preview.memoryBytes) : null,
                          preview.topics ? `${preview.topics} note${preview.topics === 1 ? "" : "s"}` : null,
                        ]
                          .filter(Boolean)
                          .join(", ")
                      : "none"
                  }
                />
                {preview.hasPhoto && <Line label="Photo" value="included" />}
              </div>

              {preview.notes.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {preview.notes.map((note) => (
                    <li
                      key={note}
                      className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground"
                    >
                      <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                      {note}
                    </li>
                  ))}
                </ul>
              )}

              {/* The one thing a preview cannot check for you. */}
              <div className="mt-3 flex gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
                <AlertTriangle size={14} className="mt-[1px] shrink-0" />
                <span>
                  An agent's instructions are written by whoever made it. Bring in
                  agents from people you trust, and read the skills afterwards if
                  you are not sure.
                </span>
              </div>

              {error && (
                <div className="mt-3 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!preview || importing} onClick={bringItIn}>
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {importing ? "Bringing it in" : "Bring it in"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{value}</span>
    </div>
  );
}

/**
 * Reading a dropped or picked file. Capped here as well as on the server,
 * so a giant file is refused before it is read into this process rather
 * than after.
 */
export const MAX_AGENT_FILE_BYTES = 8 * 1024 * 1024;

export async function readAgentFile(file: File): Promise<string> {
  if (file.size > MAX_AGENT_FILE_BYTES) throw new Error("that agent file is too large");
  return await file.text();
}
