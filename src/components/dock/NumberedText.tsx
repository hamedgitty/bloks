// A text file with its line numbers, opened at one line: what an agent's
// `bloks dock show` names with --line, and a line picked in a diff of the
// Changes panel. The line is brought to the middle of the view and marked
// for a moment; nothing takes the keyboard.
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/** Lines past this are not drawn: a log of a million lines is not a page. */
export const MAX_LINES = 20_000;

export function NumberedText({ text, line, nonce = 0, className }: { text: string; line?: number; nonce?: number; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const shown = lines.slice(0, MAX_LINES);
  const at = line && line >= 1 && line <= shown.length ? line : null;

  useLayoutEffect(() => {
    if (!at) return;
    const row = box.current?.querySelector<HTMLElement>(`[data-line="${at}"]`);
    row?.scrollIntoView({ block: "center" });
  }, [at, nonce]);

  return (
    <div ref={box} className={cn("size-full overflow-auto bg-background py-3 font-mono text-small leading-relaxed", className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((text, i) => (
            <tr
              key={i}
              data-line={i + 1}
              className={cn(i + 1 === at && "bg-brand-soft motion-safe:animate-fade-in")}
              aria-current={i + 1 === at ? "location" : undefined}
            >
              <td className="w-px select-none whitespace-nowrap pl-3 pr-3 text-right align-top tabular-nums text-muted-foreground">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all pr-4 text-foreground">{text || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
