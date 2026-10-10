// Bring your setup: what the person's other agent tools already know,
// offered item by item (server/setup-import.ts).
//
// A review, not a wizard. Everything found is on one list with a preview
// and where it would go, the person ticks what they want, and only that
// is written. The server reads the files again on import and takes from
// here only which items and where, so nothing on this screen can change
// what gets imported.
//
// Used twice: as its own page in Settings, and as an optional step in the
// first-run flow when something was found. The step is the same list in
// a smaller box.
import { useCallback, useEffect, useMemo, useState } from "react";
import Brain from "lucide-react/dist/esm/icons/brain.mjs";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Scale from "lucide-react/dist/esm/icons/scale.mjs";
import Server from "lucide-react/dist/esm/icons/server.mjs";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import UserRound from "lucide-react/dist/esm/icons/user-round.mjs";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { thisComputer } from "@/lib/thisComputer";

type Kind = "instructions" | "memory" | "skill" | "mcp" | "rule" | "fact";
type Destination = "brief" | "memory" | "skills" | "mcp" | "rules" | "about";

export interface SetupItem {
  key: string;
  kind: Kind;
  title: string;
  from: string;
  preview: string;
  chars: number;
  digest: string;
  notes: string[];
  status: "new" | "changed" | "imported";
  destinations: Destination[];
  suggested: { to: Destination; botId?: string };
  picked: boolean;
  skill?: { name: string; description: string };
  mcp?: { name: string; transport: "stdio" | "http"; needs: string[] };
  rule?: { effect: "allow" | "deny"; summary: string };
}

export interface SetupSource {
  id: string;
  name: string;
  folder: string;
  agentName: string;
  items: SetupItem[];
  skipped: Array<{ from: string; why: string }>;
}

export interface SetupReview {
  sources: SetupSource[];
  fresh: number;
}

interface Result {
  key: string;
  ok: boolean;
  did?: "added" | "updated" | "unchanged";
  error?: string;
}

/** What the person has chosen for one item. */
interface Choice {
  on: boolean;
  to: Destination;
  botId?: string;
}

/** The review, looked up once and again on demand. Null while looking. */
export function useSetupReview(): { review: SetupReview | null; error: string | null; reload: () => void; set: (r: SetupReview) => void } {
  const [review, setReview] = useState<SetupReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    api("/api/setup-import")
      .then((r: SetupReview) => setReview(r))
      .catch((e: Error) => {
        setError(e.message);
        setReview({ sources: [], fresh: 0 });
      });
  }, []);
  useEffect(reload, [reload]);
  return { review, error, reload, set: setReview };
}

const KIND: Record<Kind, { label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  instructions: { label: "Instructions", icon: FileText },
  memory: { label: "Memory", icon: Brain },
  skill: { label: "Skill", icon: Sparkles },
  mcp: { label: "MCP server", icon: Server },
  rule: { label: "Rule", icon: Scale },
  fact: { label: "About you", icon: UserRound },
};

function choicesFrom(review: SetupReview): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const source of review.sources) {
    for (const item of source.items) out[item.key] = { on: item.picked, to: item.suggested.to, botId: item.suggested.botId };
  }
  return out;
}

/** The line every version of this screen opens with. */
export function SetupPrivacyLine({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-xl bg-success/10 px-3 py-2.5", className)}>
      <ShieldCheck size={16} className="mt-px shrink-0 text-success" />
      <div className="min-w-0 text-[12.5px] leading-relaxed">
        <div className="font-medium text-foreground">
          Nothing leaves {thisComputer()} and no keys or passwords are copied.
        </div>
        <div className="text-muted-foreground">
          Bloks only reads these files to show you what is there. Nothing is added until you bring it over.
        </div>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: SetupItem["status"] }) {
  if (status === "imported") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        <Check size={11} /> Brought over
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "new" ? "bg-brand-soft text-brand-ink" : "bg-warning/10 text-warning",
      )}
    >
      {status === "new" ? "New" : "Changed"}
    </span>
  );
}

/** Which agent, or a new one named after where this came from. */
function AgentPicker({
  value,
  agentName,
  onChange,
  label,
}: {
  value: string | undefined;
  agentName: string;
  onChange: (botId: string) => void;
  label: string;
}) {
  const { state } = useStore();
  const agents = state.bots.filter((b) => !b.archivedAt);
  return (
    <select
      aria-label={label}
      value={value ?? "new"}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 min-w-0 max-w-full rounded-md border bg-background px-2 text-[12.5px] text-foreground"
    >
      <option value="new">New agent: {agentName}</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </select>
  );
}

function WhereItGoes({ item, source, choice, onChange }: { item: SetupItem; source: SetupSource; choice: Choice; onChange: (next: Choice) => void }) {
  if (item.kind === "instructions" || item.kind === "memory") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {item.destinations.length > 1 ? (
          <Segmented
            size="sm"
            aria-label={`Where ${item.title} goes`}
            value={choice.to}
            onChange={(to) => onChange({ ...choice, to })}
            options={[
              { value: "brief" as Destination, label: "Instructions" },
              { value: "memory" as Destination, label: "Memory" },
            ]}
            className="w-auto"
          />
        ) : (
          <span className="text-[12px] text-muted-foreground">Memory of</span>
        )}
        {item.destinations.length > 1 && <span className="text-[12px] text-muted-foreground">for</span>}
        <AgentPicker
          value={choice.botId}
          agentName={source.agentName}
          label={`Which agent ${item.title} goes to`}
          onChange={(botId) => onChange({ ...choice, botId })}
        />
      </div>
    );
  }
  const line =
    item.kind === "skill"
      ? "Goes to your skills library. No agent uses it until you attach it."
      : item.kind === "mcp"
        ? "Goes to your MCP servers, on no agent. Attach it to an agent when you want it used."
        : item.kind === "rule"
          ? `Becomes a rule: ${item.rule?.summary ?? item.preview}.`
          : "Suggested in About you, for you to keep or not.";
  return <div className="text-[12px] leading-relaxed text-muted-foreground">{line}</div>;
}

function ItemRow({
  item,
  source,
  choice,
  result,
  onChange,
}: {
  item: SetupItem;
  source: SetupSource;
  choice: Choice;
  result?: Result;
  onChange: (next: Choice) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = KIND[item.kind];
  const Icon = meta.icon;
  const id = `setup-${item.key}`;
  // a fact's preview is its title, and a rule's is its summary: nothing more to show
  const hasPreview = item.kind !== "fact" && item.kind !== "rule";
  return (
    <li className={cn("flex gap-3 px-3.5 py-3 transition-colors duration-150", choice.on && "bg-brand-soft/30")}>
      <input
        id={id}
        type="checkbox"
        checked={choice.on}
        onChange={(e) => onChange({ ...choice, on: e.target.checked })}
        className="mt-[3px] size-4 shrink-0 accent-(--brand)"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="flex min-w-0 cursor-pointer items-center gap-1.5">
            <Icon size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
          </label>
          <span className="text-[11.5px] text-muted-foreground">{meta.label}</span>
          <StatusChip status={item.status} />
        </div>
        {item.kind === "skill" && item.skill?.description && (
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{item.skill.description}</div>
        )}
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">{item.from}</div>
        <div className="mt-2">
          <WhereItGoes item={item} source={source} choice={choice} onChange={onChange} />
        </div>
        {item.notes.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {item.notes.map((note) => (
              // A rule's note says how it differs from the original, which
              // is worth reading before ticking it; the rest are just facts.
              <li key={note} className={cn("text-[12px] leading-relaxed", item.kind === "rule" ? "text-warning" : "text-muted-foreground")}>
                {note}
              </li>
            ))}
          </ul>
        )}
        {hasPreview && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 flex items-center gap-1 rounded-md text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronRight size={12} className={cn("transition-transform duration-150", open && "rotate-90")} />
            {open ? "Hide preview" : "Preview"}
            {item.chars > item.preview.length && !open && (
              <span className="text-muted-foreground/70">({item.chars.toLocaleString()} characters)</span>
            )}
          </button>
        )}
        {open && (
          <pre className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/60 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
            {item.preview}
          </pre>
        )}
        {result && (
          <div className={cn("mt-1.5 text-[12px]", result.ok ? "text-success" : "text-destructive")} aria-live="polite">
            {result.ok
              ? result.did === "unchanged"
                ? "Already here, nothing to change."
                : result.did === "updated"
                  ? "Updated with what is there now."
                  : "Brought over."
              : `Not brought over: ${result.error}`}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * The review list and the button that imports what is ticked.
 *
 * `compact` is the first-run version: the list scrolls inside a fixed
 * height, the sources are not explained at length, and the parent owns
 * the way out.
 */
export function SetupReviewList({
  review,
  onReview,
  compact = false,
  onImported,
}: {
  review: SetupReview;
  onReview: (next: SetupReview) => void;
  compact?: boolean;
  onImported?: (outcome: { brought: number; created: number }) => void;
}) {
  const { dispatch } = useStore();
  const [choices, setChoices] = useState<Record<string, Choice>>(() => choicesFrom(review));
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  // a new review (after an import, or a look again) starts from its own ticks
  useEffect(() => setChoices(choicesFrom(review)), [review]);

  const picked = useMemo(
    () => review.sources.flatMap((s) => s.items.filter((i) => choices[i.key]?.on)),
    [review, choices],
  );
  // a server that just came over without its keys is the one loose end
  const needsKeys = review.sources.some((s) => s.items.some((i) => i.mcp?.needs.length && results[i.key]?.ok));

  const set = (key: string, next: Choice) => setChoices((current) => ({ ...current, [key]: next }));
  const setAll = (source: SetupSource, on: boolean) =>
    setChoices((current) => {
      const next = { ...current };
      for (const item of source.items) next[item.key] = { ...next[item.key], on };
      return next;
    });

  const bring = async () => {
    setBusy(true);
    setProblem(null);
    setSummary(null);
    try {
      const picks = picked.map((item) => {
        const choice = choices[item.key];
        return { key: item.key, digest: item.digest, to: choice.to, ...(choice.botId ? { botId: choice.botId } : {}) };
      });
      const outcome: { results: Result[]; created: string[]; review: SetupReview } = await api("/api/setup-import", {
        method: "POST",
        body: JSON.stringify({ picks }),
      });
      setResults(Object.fromEntries(outcome.results.map((r) => [r.key, r])));
      const brought = outcome.results.filter((r) => r.ok && r.did !== "unchanged").length;
      const failed = outcome.results.filter((r) => !r.ok).length;
      setSummary(
        [
          brought ? `Brought over ${brought} ${brought === 1 ? "item" : "items"}.` : "Nothing new to bring over.",
          failed ? `${failed} could not be, and ${failed === 1 ? "says" : "each says"} why below.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      onReview(outcome.review);
      onImported?.({ brought, created: outcome.created.length });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col">
      <div className={cn("flex flex-col gap-5", compact && "-mr-1 max-h-[46vh] overflow-y-auto pr-1 sm:max-h-[360px]")}>
        {review.sources.map((source) => {
          const on = source.items.filter((i) => choices[i.key]?.on).length;
          return (
            <section key={source.id} aria-label={source.name}>
              <div className="mb-2 flex items-end justify-between gap-3 px-1">
                <div className="min-w-0">
                  <h2 className="text-[13.5px] font-semibold text-foreground">{source.name}</h2>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{source.folder}</div>
                </div>
                {source.items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setAll(source, on < source.items.length)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {on < source.items.length ? "Select all" : "Select none"}
                  </button>
                )}
              </div>
              {source.items.length > 0 && (
                <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
                  {source.items.map((item) => (
                    <ItemRow
                      key={item.key}
                      item={item}
                      source={source}
                      choice={choices[item.key] ?? { on: false, to: item.suggested.to, botId: item.suggested.botId }}
                      result={results[item.key]}
                      onChange={(next) => set(item.key, next)}
                    />
                  ))}
                </ul>
              )}
              {source.skipped.length > 0 && (
                <details className="group mt-2 px-1">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRight size={12} className="transition-transform duration-150 group-open:rotate-90" />
                    Left out ({source.skipped.length})
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1 pl-4">
                    {source.skipped.map((skip) => (
                      <li key={`${skip.from}:${skip.why}`} className="text-[12px] leading-relaxed text-muted-foreground">
                        <span className="break-all font-mono text-[11px] text-foreground/80">{skip.from}</span>: {skip.why}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          );
        })}
      </div>

      <div className={cn("flex flex-col gap-2", compact ? "mt-4" : "sticky bottom-0 -mx-1 mt-5 bg-background/90 px-1 pb-1 pt-3 backdrop-blur")}>
        {problem && <div className="text-[12px] text-destructive">{problem}</div>}
        {summary && (
          <div className="text-[12.5px] text-foreground" aria-live="polite">
            {summary}
          </div>
        )}
        {needsKeys && !compact && (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            Some servers are waiting for a key.
            <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "toggleAppSettings", open: true, page: "apps" })}>
              Fill them in
            </Button>
          </div>
        )}
        {/* In the first-run step, once something came over and nothing else
            is ticked, the way on is the parent's Continue, not a dead button */}
        {!(compact && summary && picked.length === 0) && (
          <Button
            size={compact ? "lg" : "default"}
            variant={compact ? "default" : "brand"}
            disabled={busy || picked.length === 0}
            onClick={() => void bring()}
            className={cn(compact ? "w-full" : "self-start")}
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Bringing over…
              </>
            ) : picked.length === 0 ? (
              "Nothing ticked"
            ) : (
              `Bring over ${picked.length} ${picked.length === 1 ? "item" : "items"}`
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The Settings page. */
export function BringYourSetupPage() {
  const { review, error, reload, set } = useSetupReview();
  return (
    <div className="flex flex-col gap-5">
      <SetupPrivacyLine />
      {review === null ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
          <Loader2 size={15} className="animate-spin" /> Looking…
        </div>
      ) : error ? (
        <div className="rounded-2xl border bg-card p-4 text-[13px] text-destructive">Couldn't look: {error}</div>
      ) : review.sources.length === 0 ? (
        <div className="rounded-2xl border bg-card p-4">
          <div className="text-[13.5px] font-medium text-foreground">Nothing found to bring over</div>
          <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Bloks looks for Claude Code in <code className="font-mono text-[11.5px]">~/.claude</code>, Codex in{" "}
            <code className="font-mono text-[11.5px]">~/.codex</code>, OpenClaw in{" "}
            <code className="font-mono text-[11.5px]">~/.openclaw/workspace</code> and Hermes in{" "}
            <code className="font-mono text-[11.5px]">~/.hermes</code>.
          </div>
          <Button size="sm" variant="secondary" className="mt-3" onClick={reload}>
            Look again
          </Button>
        </div>
      ) : (
        <SetupReviewList review={review} onReview={set} />
      )}
    </div>
  );
}
