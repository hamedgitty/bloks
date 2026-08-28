// User-added OpenAI-compatible hosts.
//
// The catalog covers the labs Bloks already knows. This is the open
// slot: any /v1 that speaks chat completions, with as many keys as that
// host issued. Keys never come back out; the list is names, URLs, and
// whether a key is the one the live instance is using.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

export interface CustomKeyRow {
  id: string;
  label: string;
  active: boolean;
}

export interface CustomEndpointRow {
  id: string;
  name: string;
  url: string;
  instanceId: string;
  activeKeyId: string | null;
  keys: CustomKeyRow[];
}

function refreshInstances(dispatch: ReturnType<typeof useStore>["dispatch"]) {
  api("/api/instances")
    .then(({ instances }) => dispatch({ type: "instances", instances }))
    .catch(() => {});
}

export function CustomEndpoints() {
  const { dispatch } = useStore();
  const [endpoints, setEndpoints] = useState<CustomEndpointRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [extraKey, setExtraKey] = useState("");
  const [extraLabel, setExtraLabel] = useState("");

  const reload = useCallback(() => {
    api("/api/custom-endpoints")
      .then(({ endpoints: rows }) => setEndpoints(rows ?? []))
      .catch(() => setEndpoints([]));
  }, []);

  useEffect(reload, [reload]);

  const apply = (rows: CustomEndpointRow[]) => {
    setEndpoints(rows);
    refreshInstances(dispatch);
  };

  const add = () => {
    if (busy || !name.trim() || !url.trim() || !key.trim()) return;
    setBusy(true);
    setError(null);
    api("/api/custom-endpoints", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        url: url.trim(),
        key: key.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    })
      .then(({ endpoints: rows }) => {
        apply(rows);
        setAdding(false);
        setName("");
        setUrl("");
        setKey("");
        setLabel("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const addKey = (id: string) => {
    if (busy || !extraKey.trim()) return;
    setBusy(true);
    setError(null);
    api(`/api/custom-endpoints/${id}/keys`, {
      method: "POST",
      body: JSON.stringify({
        key: extraKey.trim(),
        ...(extraLabel.trim() ? { label: extraLabel.trim() } : {}),
      }),
    })
      .then(({ endpoints: rows }) => {
        apply(rows);
        setKeyFor(null);
        setExtraKey("");
        setExtraLabel("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-4 overflow-hidden rounded-2xl border bg-card">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[13.5px] font-semibold text-foreground">Your endpoints</div>
            <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Any OpenAI-compatible host. Several keys can share one URL; the marked one is what
              agents use.
            </div>
          </div>
          {!adding && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)} className="shrink-0">
              <Plus size={13} />
              Add
            </Button>
          )}
        </div>
      </div>

      {(endpoints ?? []).map((endpoint) => (
        <div key={endpoint.id} className="border-t px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-foreground">{endpoint.name}</div>
              <div className="truncate text-[12px] text-muted-foreground">{endpoint.url}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void api(`/api/custom-endpoints/${endpoint.id}`, { method: "DELETE" })
                  .then(({ endpoints: rows }) => apply(rows))
                  .catch((e: Error) => setError(e.message))
              }
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              Remove
            </Button>
          </div>

          <div className="mt-2 flex flex-col gap-1">
            {endpoint.keys.map((cred, index) => (
              <div key={cred.id} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
                <span
                  className={cn("size-1.5 rounded-full", cred.active ? "bg-success" : "bg-muted-foreground/30")}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                  {cred.label || (endpoint.keys.length > 1 ? `Key ${index + 1}` : "API key")}
                  {cred.active && (
                    <span className="ml-1.5 text-[11px] font-normal text-success">In use</span>
                  )}
                </span>
                {!cred.active && (
                  <button
                    onClick={() =>
                      void api(`/api/custom-endpoints/${endpoint.id}/keys/${cred.id}/use`, {
                        method: "POST",
                      })
                        .then(({ endpoints: rows }) => apply(rows))
                        .catch((e: Error) => setError(e.message))
                    }
                    className="shrink-0 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Use
                  </button>
                )}
                <button
                  onClick={() =>
                    void api(`/api/custom-endpoints/${endpoint.id}/keys/${cred.id}`, {
                      method: "DELETE",
                    })
                      .then(({ endpoints: rows }) => apply(rows))
                      .catch((e: Error) => setError(e.message))
                  }
                  title="Remove this key"
                  className="shrink-0 rounded-lg p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          {keyFor === endpoint.id ? (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex gap-2">
                <Input
                  autoFocus
                  type="password"
                  value={extraKey}
                  onChange={(e) => setExtraKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addKey(endpoint.id);
                    if (e.key === "Escape") setKeyFor(null);
                  }}
                  placeholder="Another key for this host"
                  autoComplete="off"
                  className="h-8 text-[13px]"
                />
                <Button
                  variant="secondary"
                  onClick={() => addKey(endpoint.id)}
                  disabled={busy || !extraKey.trim()}
                  className="w-[72px]"
                >
                  <Check size={13} />
                  Save
                </Button>
              </div>
              <Input
                value={extraLabel}
                onChange={(e) => setExtraLabel(e.target.value)}
                placeholder="Label (optional), e.g. backup"
                className="h-8 text-[13px]"
              />
            </div>
          ) : (
            <button
              onClick={() => {
                setKeyFor(endpoint.id);
                setError(null);
              }}
              className="mt-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Add another key
            </button>
          )}
        </div>
      ))}

      {endpoints !== null && endpoints.length === 0 && !adding && (
        <div className="border-t px-4 py-3 text-[12.5px] text-muted-foreground">
          Nothing added yet. LiteLLM, vLLM, a proxy, or any host that answers /v1/models.
        </div>
      )}

      {adding && (
        <div className="border-t px-4 py-3">
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. Together"
              className="h-8 text-[13px]"
            />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Base URL, usually ending in /v1"
              className="h-8 text-[13px]"
            />
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="API key"
              autoComplete="off"
              className="h-8 text-[13px]"
            />
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Key label (optional)"
              className="h-8 text-[13px]"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={add}
                disabled={busy || !name.trim() || !url.trim() || !key.trim()}
              >
                <Check size={13} />
                Save
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="border-t px-4 py-2 text-[12px] text-destructive">{error}</div>}
    </div>
  );
}
