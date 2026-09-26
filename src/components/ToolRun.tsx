// The tool calls between two things worth reading, as one line.
//
// A single call shows as itself. Two or more fold into a count ("Ran 4
// commands, read 6 files") that opens to the list. While any is still
// running the line says so with a spinner, and names the latest call,
// so a long turn still shows what it is doing right now.
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Minus from "lucide-react/dist/esm/icons/minus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { Message } from "@/state/store";
import { running, summarize } from "@/lib/tool-summary";
import { cn } from "@/lib/cn";

function StateIcon({ tool, size = 12 }: { tool: NonNullable<Message["tool"]>; size?: number }) {
  if (tool.stopped) return <Minus size={size} aria-label="stopped" />;
  if (tool.ok === undefined) return <Loader2 size={size} className="animate-spin" aria-label="running" />;
  if (tool.ok === false) return <X size={size} className="text-destructive" aria-label="failed" />;
  return <Check size={size} className="text-success" aria-label="done" />;
}

function Line({ message }: { message: Message }) {
  const tool = message.tool!;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-0.5 text-[12px]",
        tool.ok === false && !tool.stopped ? "text-destructive" : "text-muted-foreground",
      )}
      title={tool.stopped ? "Stopped before it reported back" : undefined}
    >
      <StateIcon tool={tool} />
      <span className="max-w-[480px] truncate font-mono">{tool.name}</span>
    </div>
  );
}

export function ToolRun({ messages, fresh, className }: { messages: Message[]; fresh?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const tools = messages.filter((m) => m.tool).map((m) => m.tool!);
  if (!tools.length) return null;
  if (messages.length === 1) {
    return (
      <div className={cn("flex justify-start px-1.5", fresh && "animate-receive-in", className)}>
        <Line message={messages[0]} />
      </div>
    );
  }
  const busy = running(tools);
  const latest = messages[messages.length - 1].tool!;
  return (
    <div className={cn("flex flex-col items-start px-1.5", fresh && "animate-receive-in", className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md py-0.5 text-[12px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        {busy ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : tools.every((t) => t.stopped) ? (
          <Minus size={12} className="shrink-0" />
        ) : (
          <Check size={12} className="shrink-0 text-success" />
        )}
        <span className="truncate">
          {summarize(tools)}
          {busy && <span className="font-mono"> · {latest.name}</span>}
        </span>
        <ChevronRight size={12} className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-[5px] mt-0.5 flex animate-fade-in flex-col border-l pl-3">
          {messages.map((m) => (
            <Line key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}
