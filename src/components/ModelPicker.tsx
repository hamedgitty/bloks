// Choosing what an agent thinks with.
//
// Engines on the left, that engine's models on the right. Selection is
// always an exact instance id: two instances can share a driver, and
// guessing from the driver would silently send a turn to the wrong one.
//
// Engines that are not usable stay visible and disabled, carrying the
// reason. Hiding them would leave someone wondering where their engine
// went, when what they need to know is that it is installed but signed
// out. The same goes for an engine with a newer release: a model that is
// not in the list is usually a CLI that is out of date, so the list says
// so, and the corner of it opens the engine settings.
//
// A long list (OpenRouter has hundreds) gets a search box, focused on
// open, matching every word typed against the name or the id. Enter
// takes the first match; Escape clears the search, then closes.
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import SettingsIcon from "lucide-react/dist/esm/icons/settings-2.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useStore, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { EngineUpdateNote } from "./EngineSetup";
import { cn } from "@/lib/cn";

/** Lists this long or shorter are read at a glance, not searched. */
const SEARCH_ABOVE = 8;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((o) => o.id === model)?.label ?? model;
}

/** Engines you can use sort ahead of engines you cannot, ties keeping
 * the fleet's own order. The rail reads at a glance: what is installed
 * is what comes first. */
const byUsable = (a: InstanceInfo, b: InstanceInfo) =>
  Number(b.snapshot.state === "available") - Number(a.snapshot.state === "available");

/** A selection that names no option this instance serves means "whatever
 * the engine defaults to": Pi's catalog follows its own settings, and a
 * bot carried over from before a catalog changed is the general case.
 * The turn behaves that way already (no set_model, engine default), so
 * the picker shows and ticks exactly that. */
function effectiveModel(instance: InstanceInfo | undefined, model: string): string {
  const isKnown = instance?.models.options.some((o) => o.id === model);
  return isKnown ? model : (instance?.models.default ?? model);
}

export function ModelPicker({
  bot,
  className,
  value,
  onPick,
  noneLabel,
  exclude,
}: {
  /** Whose model this is. Optional only with `onPick`, which picks
   * for something that is not an agent yet (the new-agent default). */
  bot?: Bot;
  className?: string;
  /** Pick something other than the agent's own engine (its backup).
   * `value` null shows `noneLabel`, and the list offers it as a choice. */
  value?: ModelSelection | null;
  onPick?: (selection: ModelSelection | null) => void;
  noneLabel?: string;
  /** An engine not to offer, such as the one the backup stands in for. */
  exclude?: string;
}) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [railId, setRailId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const custom = onPick !== undefined;
  const selection: ModelSelection = (custom ? value : bot?.modelSelection) ?? { instanceId: "", model: "" };
  const instances = state.instances.filter((i) => i.instanceId !== exclude);
  const active = instances.find((i) => i.instanceId === selection.instanceId);
  const railInstance =
    instances.find((i) => i.instanceId === (railId ?? selection.instanceId)) ??
    [...instances].sort(byUsable)[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // the search box takes the first Escape to clear itself
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const options = (railInstance?.models.options ?? []).filter((o) => {
    const text = `${o.label} ${o.id}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const searchable = (railInstance?.models.options.length ?? 0) > SEARCH_ABOVE;

  const pick = (instance: InstanceInfo, model: string) => {
    const next = { instanceId: instance.instanceId, model };
    if (custom) onPick(next);
    else if (bot) dispatch({ type: "setModel", botId: bot.id, selection: next });
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        onClick={() => {
          setRailId(selection.instanceId);
          setQuery("");
          setOpen((o) => !o);
        }}
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-[0.98]"
        title={active ? `${active.displayName} · ${modelLabel(active, effectiveModel(active, selection.model))}` : selection.model}
      >
        {active && (
          <span className="relative flex">
            <ProviderMark driverKind={active.driverKind} size={13} />
            {state.engineUpdates[active.driverKind] && (
              <span
                className="absolute -right-1 -top-1 size-1.5 rounded-full bg-brand ring-2 ring-background"
                aria-label="update available"
              />
            )}
          </span>
        )}
        <span className="max-w-[140px] truncate">
          {active || !custom ? modelLabel(active, effectiveModel(active, selection.model)) : (noneLabel ?? "None")}
        </span>
        <ChevronDown size={13} className="opacity-60" />
      </button>

      {open && (
        <div
          data-model-picker-content
          className="absolute right-0 top-full z-30 mt-1.5 flex w-[300px] max-w-[92vw] origin-top-right animate-pop-in flex-col overflow-hidden rounded-xl border bg-popover shadow-lg shadow-(color:--shadow-color)"
        >
          <div className="flex min-h-0">
          {/* instance rail */}
          <div className="flex flex-col gap-0.5 border-r bg-muted/40 p-1.5">
            {[...instances].sort(byUsable).map((instance) => {
              const unavailable = instance.snapshot.state !== "available";
              const onRail = instance.instanceId === railInstance?.instanceId;
              return (
                <button
                  key={instance.instanceId}
                  onClick={() => setRailId(instance.instanceId)}
                  title={
                    unavailable
                      ? `${instance.displayName}: ${instance.snapshot.reason ?? "unavailable"}`
                      : instance.displayName
                  }
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg transition-colors duration-150",
                    onRail ? "bg-accent" : "hover:bg-accent/60",
                    unavailable && "opacity-40",
                  )}
                >
                  <span className="relative flex">
                    <ProviderMark driverKind={instance.driverKind} size={16} />
                    {state.engineUpdates[instance.driverKind] && (
                      <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-brand ring-2 ring-muted" />
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* model list for the rail-selected instance */}
          <div className="min-w-0 flex-1 p-1.5">
            {custom && active && (
              <button
                onClick={() => {
                  onPick(null);
                  setOpen(false);
                }}
                className="mb-1 flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                {noneLabel ?? "None"}
              </button>
            )}
            {railInstance ? (
              <>
                <div className="px-2 pb-1 pt-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold text-foreground">
                      {railInstance.displayName}
                    </span>
                    {/* an agent on a chat-only engine cannot run commands
                        or touch files, and that is worth knowing here */}
                    {state.providers.find((p) => p.kind === railInstance.driverKind)?.agentic && (
                      <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                        tools
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {railInstance.snapshot.state === "available"
                      ? (railInstance.snapshot.version ?? "ready")
                      : (railInstance.snapshot.reason ?? "unavailable")}
                  </div>
                  <EngineUpdateNote kind={railInstance.driverKind} name={railInstance.displayName} className="mt-1.5" />
                </div>
                {searchable && (
                  <div className="sticky -top-1.5 z-10 -mt-1.5 bg-popover pb-1 pt-1.5">
                    <div className="flex items-center gap-1.5 rounded-lg bg-accent/70 px-2 py-[5px] transition-colors duration-150 focus-within:bg-accent">
                      <Search size={13} className="shrink-0 text-muted-foreground" />
                      <input
                        autoFocus
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape" && query) {
                            e.preventDefault();
                            setQuery("");
                          } else if (e.key === "Enter" && options[0] && railInstance.snapshot.state === "available") {
                            pick(railInstance, options[0].id);
                          }
                        }}
                        placeholder="Search models"
                        aria-label="Search models"
                        className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
                      />
                    </div>
                  </div>
                )}
                {options.length === 0 && (
                  <div className="px-2 py-3 text-[13px] text-muted-foreground">No models match.</div>
                )}
                {options.map((option) => {
                  const current =
                    selection.instanceId === railInstance.instanceId &&
                    effectiveModel(railInstance, selection.model) === option.id;
                  const disabled = railInstance.snapshot.state !== "available";
                  return (
                    <button
                      key={option.id}
                      disabled={disabled}
                      onClick={() => pick(railInstance, option.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors duration-150",
                        disabled
                          ? "cursor-not-allowed text-muted-foreground/50"
                          : "text-foreground hover:bg-accent",
                        current && "bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{option.label}</span>
                        {option.id === railInstance.models.default && (
                          <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                            default
                          </span>
                        )}
                      </span>
                      {current && <Check size={14} className="shrink-0 text-brand-ink" />}
                    </button>
                  );
                })}
              </>
            ) : (
              <div className="px-2 py-3 text-[13px] text-muted-foreground">
                No providers. Is the server running?
              </div>
            )}
          </div>
          </div>
          {/* the way to everything this list cannot do: connect an engine,
              sign in, update, add a key */}
          {!custom && (
            <div className="flex justify-end border-t px-1.5 py-1">
              <button
                onClick={() => {
                  setOpen(false);
                  dispatch({ type: "toggleAppSettings", open: true, page: "engines" });
                }}
                title="Engine settings"
                aria-label="Engine settings"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground active:scale-95"
              >
                <SettingsIcon size={13} />
                Engines
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
