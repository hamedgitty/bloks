// The six shapes an agent can answer with instead of a paragraph.
//
// The server has already checked the shape (server/components.ts), so these are about
// looking right rather than about being defensive, with one exception: a
// chart still has to survive every bar being zero, or the same, or
// negative, because those are real answers and dividing by them is not.
//
// Decision choices are submitted by MessageComponent; the renderers only
// receive the selection and a callback. An answer that arrives as a component
// should read as part of the conversation, not as a dashboard that landed
// in it, so the type sizes and the borders are the ones the chat already
// uses.
import Ban from "lucide-react/dist/esm/icons/ban.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot.mjs";
import Quote from "lucide-react/dist/esm/icons/quote.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { cn } from "@/lib/cn";
import { useRef, useState } from "react";
import { api, useStore, type Message } from "@/state/store";

interface Bar {
  label: string;
  value: number;
}
interface Option {
  label: string;
  detail?: string;
  pick?: boolean;
}
interface Step {
  label: string;
  state: "done" | "doing" | "todo" | "failed";
  detail?: string;
}

export type Component =
  | { kind: "chart"; title?: string; note?: string; bars: Bar[] }
  | { kind: "table"; title?: string; note?: string; columns: string[]; rows: string[][] }
  | { kind: "decision"; question: string; because?: string; options: Option[] }
  | { kind: "steps"; title?: string; steps: Step[] }
  | { kind: "quote"; text: string; from?: string; where?: string }
  | { kind: "refused"; what: string; because?: string };

/** One frame, so every component sits in the conversation the same way. */
function Frame({ title, note, children }: { title?: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[560px] animate-rise-in rounded-2xl border bg-card p-3.5 shadow-[0_1px_3px_var(--shadow-color)]">
      {title && <div className="text-[13.5px] font-semibold text-foreground">{title}</div>}
      <div className={cn(title && "mt-2.5")}>{children}</div>
      {note && <div className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">{note}</div>}
    </div>
  );
}

export function MessageComponent({ message, threadId }: { message: Message; threadId: string }) {
  const { dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const choose = async (choice: number) => {
    if (sending.current || message.decisionChoice !== undefined) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api(`/api/threads/${threadId}/messages/${message.id}/choose`, {
        method: "POST", body: JSON.stringify({ choice }),
      });
      dispatch({ type: "messagePatched", threadId, message: result.message });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The answer could not be sent.");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  if (!message.component) return null;
  return (
    <div className="min-w-0">
      <GalleryComponent
        component={message.component as Component}
        onChoose={choose}
        chosen={message.decisionChoice}
        pending={pending}
      />
      {error && <p role="alert" className="mt-1 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

export function GalleryComponent({ component, onChoose, chosen, pending }: {
  component: Component;
  onChoose?: (index: number) => void;
  chosen?: number;
  pending?: boolean;
}) {
  switch (component.kind) {
    case "chart":
      return <Chart component={component} />;
    case "table":
      return <Table component={component} />;
    case "decision":
      return <Decision component={component} onChoose={onChoose} chosen={chosen} pending={pending} />;
    case "steps":
      return <Steps component={component} />;
    case "quote":
      return <Pulled component={component} />;
    case "refused":
      return <Refused component={component} />;
    default:
      return null;
  }
}

function Chart({ component }: { component: Extract<Component, { kind: "chart" }> }) {
  const values = component.bars.map((b) => b.value);
  const top = Math.max(...values, 0);
  const bottom = Math.min(...values, 0);
  // Every bar the same, or every bar zero, are real answers. A span of
  // nothing would divide by zero and draw nothing at all, which reads as
  // a broken chart rather than as a flat one.
  const span = top - bottom || 1;
  const width = (value: number) => `${Math.max(2, (Math.abs(value) / span) * 100)}%`;

  return (
    <Frame title={component.title} note={component.note}>
      <div className="flex flex-col gap-1.5">
        {component.bars.map((bar, i) => (
          <div key={`${bar.label}-${i}`} className="flex items-center gap-2.5">
            <span className="w-[34%] shrink-0 truncate text-[12.5px] text-muted-foreground" title={bar.label}>
              {bar.label}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className={cn("h-[14px] rounded-md", bar.value < 0 ? "bg-destructive/60" : "bg-brand")}
                style={{ width: width(bar.value) }}
              />
              <span className="shrink-0 text-[12px] tabular-nums text-foreground">
                {bar.value.toLocaleString()}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Table({ component }: { component: Extract<Component, { kind: "table" }> }) {
  return (
    <Frame title={component.title} note={component.note}>
      {/* A wide table scrolls inside its own card rather than pushing the
          conversation sideways. No negative margin: it makes the scroller
          wider than the box it sits in, which is its own small overflow. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              {component.columns.map((column, i) => (
                <th
                  key={`${column}-${i}`}
                  className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {component.rows.map((row, r) => (
              <tr key={r} className="border-b last:border-b-0">
                {row.map((cell, c) => (
                  <td key={c} className="px-2 py-1.5 align-top text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function Decision({ component, onChoose, chosen, pending }: {
  component: Extract<Component, { kind: "decision" }>;
  onChoose?: (index: number) => void;
  chosen?: number;
  pending?: boolean;
}) {
  return (
    <Frame title={component.question}>
      <div className="flex flex-col gap-1.5" aria-busy={pending}>
        {component.options.map((option, i) => (
          <button
            type="button"
            key={`${option.label}-${i}`}
            onClick={() => onChoose?.(i)}
            disabled={!onChoose || pending || chosen !== undefined}
            aria-pressed={chosen === i}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors enabled:hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
              chosen === i ? "border-brand/40 bg-brand-soft/40" : "bg-background",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                chosen === i ? "border-brand-ink bg-brand-ink text-brand-foreground" : "border-muted-foreground/40",
              )}
            >
              {chosen === i && <Check size={10} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-[13px] text-foreground [overflow-wrap:anywhere]">
                {option.label}
                {option.pick && <span className="ml-2 text-[11px] text-brand-ink">Recommended</span>}
              </span>
              {option.detail && (
                <span className="mt-0.5 block break-words text-[12px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                  {option.detail}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      {component.because && (
        <div className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">{component.because}</div>
      )}
    </Frame>
  );
}

function Steps({ component }: { component: Extract<Component, { kind: "steps" }> }) {
  return (
    <Frame title={component.title}>
      <div className="flex flex-col gap-1.5">
        {component.steps.map((step, i) => (
          <div key={`${step.label}-${i}`} className="flex items-start gap-2.5">
            <span className="mt-[3px] shrink-0">
              {step.state === "done" ? (
                <Check size={12} className="text-success" />
              ) : step.state === "failed" ? (
                <X size={12} className="text-destructive" />
              ) : step.state === "doing" ? (
                <CircleDot size={12} className="text-brand-ink" />
              ) : (
                <span className="block size-[10px] rounded-full border border-muted-foreground/40" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-[12.5px]",
                  step.state === "todo" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {step.label}
              </span>
              {step.detail && (
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                  {step.detail}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

function Pulled({ component }: { component: Extract<Component, { kind: "quote" }> }) {
  return (
    <div className="w-full max-w-[560px] animate-rise-in rounded-2xl border-l-2 border-l-brand bg-card px-3.5 py-3">
      <Quote size={13} className="text-muted-foreground/50" />
      <div className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
        {component.text}
      </div>
      {(component.from || component.where) && (
        <div className="mt-2 text-[11.5px] text-muted-foreground">
          {[component.from, component.where].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

function Refused({ component }: { component: Extract<Component, { kind: "refused" }> }) {
  return (
    <div className="flex w-full max-w-[560px] animate-rise-in items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/5 px-3.5 py-3">
      <Ban size={14} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="text-[13px] text-foreground">{component.what}</div>
        {component.because && (
          <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{component.because}</div>
        )}
      </div>
    </div>
  );
}
