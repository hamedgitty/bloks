// The connected-apps grid.
//
// The server returns either the live catalogue or a shorter shipped list,
// depending on which credential is configured, and this component is
// deliberately indifferent to which it got.
//
// Icons degrade in three steps, because one broken image in a grid of
// otherwise-perfect logos looks worse than no logos at all: official
// artwork, then the service's own favicon, then a letter.
import { useCallback, useEffect, useMemo, useState } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { api, useStore } from "@/state/store";
import { McpAppsCard } from "./McpApps";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  domain: string | null;
}

function ServiceIcon({ card }: { card: ToolkitCard }) {
  // step 0 is the real artwork, 1 the site's favicon, 2 a letter
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return <img src={card.logo} alt="" className="size-8 rounded-lg" onError={() => setStage(1)} />;
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        className="size-8 rounded-lg"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-[13px] font-semibold text-muted-foreground">
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginsPanel() {
  const { dispatch } = useStore();
  const [cards, setCards] = useState<ToolkitCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [status, setStatus] = useState<Record<string, { connected: boolean }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Two kinds of plugin: the managed catalog, and whatever a registered
  // MCP server draws for itself.
  const [view, setView] = useState<"connectors" | "apps">("connectors");

  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve();
    setRefreshing(true);
    return api(`/api/connectors?services=${slugs.join(",")}`)
      .then((r) => setStatus(r.services ?? {}))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    let alive = true;
    api("/api/connectors/catalog")
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        if (r.configured) void refreshStatus((r.cards ?? []).map((c: ToolkitCard) => c.slug).slice(0, 40));
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  const connect = (slug: string) => {
    setBusySlug(slug);
    setError(null);
    api(`/api/connectors/${slug}/authorize`, { method: "POST" })
      .then(({ url }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        const timer = setInterval(() => {
          void refreshStatus([slug]);
          if (++tries >= 6 || status[slug]?.connected) clearInterval(timer);
        }, 5000);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const disconnect = (slug: string) => {
    setBusySlug(slug);
    api(`/api/connectors/${slug}`, { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  // tools the user named during first-run setup surface first, so the
  // panel opens on the things they said they use every day
  const introPicks = useMemo(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem("bloks-intro-plugins") ?? "[]"));
    } catch {
      return new Set<string>();
    }
  }, []);
  const visible = (cards ?? [])
    .filter(
      (c) => !search || `${c.label} ${c.slug} ${c.blurb}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => Number(introPicks.has(b.slug)) - Number(introPicks.has(a.slug)));

  return (
    <div
      className="absolute inset-0 z-20 flex animate-fade-in items-center justify-center bg-black/40 dark:bg-black/60"
      onClick={() => dispatch({ type: "togglePlugins", open: false })}
    >
      <div
        className={cn(
          "flex max-h-[80%] animate-pop-in flex-col rounded-2xl border bg-popover p-5 shadow-2xl shadow-[--shadow-color] transition-[width] duration-200",
          // an app needs room to be an app
          view === "apps" ? "w-[min(760px,92vw)]" : "w-[min(540px,92vw)]",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-[16px] font-semibold text-foreground">Plugins</div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refreshStatus(visible.map((c) => c.slug).slice(0, 40))}
              title="Refresh connection status"
            >
              <RefreshCw size={14} className={cn(refreshing && "animate-spin")} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close plugins"
              onClick={() => dispatch({ type: "togglePlugins", open: false })}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
        <div className="mt-0.5 text-[13px] text-muted-foreground">
          {view === "connectors"
            ? "Apps your agents can use through Composio Connect."
            : "Interfaces your own MCP servers draw, framed inside Bloks."}
        </div>

        <div className="mt-3 flex gap-1 rounded-xl bg-muted p-1">
          {(
            [
              ["connectors", "Connectors"],
              ["apps", "MCP apps"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={cn(
                "flex-1 rounded-lg py-1.5 text-[12.5px] transition-colors duration-150",
                view === key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {view === "apps" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <McpAppsCard />
          </div>
        )}

        {view === "connectors" && !configured && (
          <div className="mt-3 rounded-xl bg-warning/10 px-3 py-2 text-[13px] text-warning">
            No Composio Connect key yet.{" "}
            <button
              className="underline"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              add one in Settings
            </button>{" "}
            to connect apps.
          </div>
        )}
        {view === "connectors" && configured && source === "curated" && (
          <div className="mt-3 text-[12px] text-muted-foreground">
            Showing a curated set.{" "}
            <button
              className="underline hover:text-foreground"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              Add a Composio API key
            </button>{" "}
            (the ak_ one, separate from your Connect key) to browse the full catalog.
          </div>
        )}
        {view === "connectors" && error && (
          <div className="mt-2 text-[12px] text-destructive">{error}</div>
        )}

        {view === "connectors" && (
          <>
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-[7px] transition-colors duration-150 focus-within:bg-accent">
          <Search size={15} className="shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps"
            className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border">
          {cards === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : (
            visible.map((card, i) => {
              const connected = status[card.slug]?.connected;
              const busy = busySlug === card.slug;
              return (
                <div
                  key={card.slug}
                  className={cn("flex items-center gap-3 px-3.5 py-2.5", i > 0 && "border-t")}
                >
                  <ServiceIcon card={card} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13.5px] font-medium text-foreground">
                      {card.label}
                      {connected && <span className="size-1.5 rounded-full bg-success" />}
                    </div>
                    <div className="truncate text-[12px] text-muted-foreground">{card.blurb}</div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!configured || busy}
                    onClick={() => (connected ? disconnect(card.slug) : connect(card.slug))}
                    className={cn("w-[86px]", connected && "text-muted-foreground hover:text-destructive")}
                  >
                    {busy ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : connected ? (
                      "Disconnect"
                    ) : (
                      "Connect"
                    )}
                  </Button>
                </div>
              );
            })
          )}
          {cards !== null && visible.length === 0 && (
            <div className="py-8 text-center text-[13px] text-muted-foreground">No apps match.</div>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
