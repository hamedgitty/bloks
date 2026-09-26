// Lines added and removed, with a little context, as the server's
// diffLines (server/checkpoints.ts) returns them. Used by the changes
// card's file view and by a suggested change to a skill.
import { cn } from "@/lib/cn";

export interface DiffLine {
  kind: "same" | "add" | "del" | "gap";
  text: string;
}

export function DiffLines({ lines, className }: { lines: DiffLine[]; className?: string }) {
  return (
    <div className={cn("font-mono text-[12px] leading-[1.55]", className)}>
      {lines.map((line, at) =>
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
  );
}
