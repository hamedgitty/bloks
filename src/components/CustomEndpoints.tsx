// User-added OpenAI-compatible hosts.
//
// The catalog covers the labs Bloks already knows. This is the open
// slot: any /v1 that speaks chat completions, with as many keys as that
// host issued. Keys never come back out; the list is names, URLs, and
// whether a key is the one the live instance is using.
//
// A host is chat only until the person says its model can use tools.
// Whether it can depends on what is loaded there, which only they know,
// so the switch is theirs and the row says plainly which way it is set.
//
// A host whose model list could not be had says why on its row, in the
// provider's own words, with Retry beside it (GitHub 486). An empty
// picker with no reason was the whole of what a person saw before.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { Check } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Plus } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

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
  /** Attached images go to its model as pictures (GitHub 365). */
  vision?: boolean;
  /** Its agents get the effort picker, and their level is sent. */
  effort?: boolean;
  activeKeyId: string | null;
  /** Off is chat only. */
  tools: boolean;
  keys: CustomKeyRow[];
  /** The names of the headers it sends beyond the key. Values never come
   * back: like keys, they are only set. Absent from an older server. */
  headers?: string[];
}

/** As many headers as the server keeps on one host. */
const MAX_HEADERS = 10;

/**
 * The headers a host wants beyond its key, as rows of a name and "Set".
 * Adding one with a name already there replaces its value; the server
 * takes the whole list each time, and a row sent without a value keeps
 * the one it has, so a value never has to travel back to this window.
 */
function EndpointHeaders({ endpoint, onSaved }: { endpoint: CustomEndpointRow; onSaved: (rows: CustomEndpointRow[]) => void }) {
  const names = endpoint.headers ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const put = (rows: Array<{ name: string; value?: string }>) =>
    api(`/api/custom-endpoints/${endpoint.id}/headers`, { method: "PUT", body: JSON.stringify({ headers: rows }) }).then(
      ({ endpoints: next }) => onSaved(next),
    );

  const close = () => {
    setAdding(false);
    setName("");
    setValue("");
    setError(null);
  };

  const add = () => {
    const given = name.trim();
    if (busy || !given || !value.trim()) return;
    setBusy(true);
    setError(null);
    put([...names.filter((kept) => kept.toLowerCase() !== given.toLowerCase()).map((kept) => ({ name: kept })), { name: given, value }])
      .then(close)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const remove = (gone: string) => {
    setError(null);
    put(names.filter((kept) => kept !== gone).map((kept) => ({ name: kept }))).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="mt-2">
      {names.length > 0 && (
        <>
          <div className="mb-1 text-small text-muted-foreground">{t("customEndpoints.headers")}</div>
          <div className="flex flex-col gap-1">
            {names.map((header) => (
              <div key={header} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-small text-foreground">{header}</span>
                <span className="shrink-0 text-caption text-muted-foreground">{t("customEndpoints.headerSet")}</span>
                <button
                  onClick={() => remove(header)}
                  title={t("customEndpoints.removeHeader")}
                  aria-label={t("customEndpoints.removeHeaderNamed", { name: header })}
                  className="shrink-0 rounded-lg p-1 text-muted-foreground/60 transition-colors hover:text-destructive"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {adding ? (
        <div className={cn("flex flex-col gap-2", names.length > 0 && "mt-2")}>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && close()}
              placeholder={t("customEndpoints.headerNamePlaceholder")}
              aria-label={t("customEndpoints.headerName")}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              className="h-8 font-mono text-body placeholder:font-sans sm:w-[44%]"
            />
            <div className="flex min-w-0 flex-1 gap-2">
              <Input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                  if (e.key === "Escape") close();
                }}
                placeholder={t("customEndpoints.headerValue")}
                aria-label={t("customEndpoints.headerValue")}
                autoComplete="off"
                className="h-8 min-w-0 flex-1 text-body"
              />
              <Button variant="secondary" onClick={add} disabled={busy || !name.trim() || !value.trim()} className="w-[72px]">
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {t("common.save")}
              </Button>
            </div>
          </div>
          {error ? (
            <div role="alert" className="text-small text-destructive">{error}</div>
          ) : (
            <div className="text-small text-muted-foreground">{t("customEndpoints.headersHint")}</div>
          )}
        </div>
      ) : (
        <>
          {names.length < MAX_HEADERS && (
            <button
              onClick={() => setAdding(true)}
              className={cn("text-small text-muted-foreground transition-colors hover:text-foreground", names.length > 0 && "mt-2")}
            >
              {t("customEndpoints.addHeader")}
            </button>
          )}
          {error && <div role="alert" className="mt-1 text-small text-destructive">{error}</div>}
        </>
      )}
    </div>
  );
}

function ToolsSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-body text-foreground">
      <span className="min-w-0">
        {t("customEndpoints.thisModelCanUseTools")}
        <span className="block text-small text-muted-foreground">
          {on
            ? t("customEndpoints.agentsCanUseBloksTools")
            : t("customEndpoints.chatOnlyTurnOnIf")}
        </span>
      </span>
      <Switch checked={on} onCheckedChange={onChange} aria-label={t("customEndpoints.thisModelCanUseTools")} />
    </label>
  );
}

/** The person's word that the model behind this URL sees pictures, so a
 * turn's attached images go to it as pictures. Nobody can tell from the
 * outside: llama.cpp sees only with its vision projector loaded. */
function SeesImages({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-body text-foreground">
      <span className="min-w-0">
        {t("customEndpoints.seesImages")}
        <span className="block text-small text-muted-foreground">
          {on
            ? t("customEndpoints.attachedImagesGoToThe")
            : t("customEndpoints.imagesStayOutTurnOn")}
        </span>
      </span>
      <Switch checked={on} onCheckedChange={onChange} aria-label={t("customEndpoints.seesImages")} />
    </label>
  );
}

/** Why the host's model list could not be had, and the way to look again. */
function CatalogProblem({ said, retrying, onRetry }: { said: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 break-words text-body text-foreground">{t("customEndpoints.couldntLoadModels", { reason: said })}</span>
      <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying} className="-my-0.5 shrink-0">
        {retrying && <Loader2 size={13} className="animate-spin" />}
        {t("customEndpoints.retry")}
      </Button>
    </div>
  );
}

/** The person's word that the model behind this URL takes a reasoning
 * effort. Like tools and pictures, nobody can tell from the outside, and
 * a model that does not take one may refuse every request that has it. */
function TakesEffort({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-body text-foreground">
      <span className="min-w-0">
        {t("customEndpoints.takesReasoningEffort")}
        <span className="block text-small text-muted-foreground">
          {on ? t("customEndpoints.agentsCanPickEffort") : t("customEndpoints.noEffortIsSent")}
        </span>
      </span>
      <Switch checked={on} onCheckedChange={onChange} aria-label={t("customEndpoints.takesReasoningEffort")} />
    </label>
  );
}

function refreshInstances(dispatch: ReturnType<typeof useStore>["dispatch"]) {
  api("/api/instances")
    .then(({ instances }) => dispatch({ type: "instances", instances }))
    .catch(() => {});
}

export function CustomEndpoints() {
  const { state, dispatch } = useStore();
  const [retrying, setRetrying] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<CustomEndpointRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [newTools, setNewTools] = useState(false);
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
        tools: newTools,
      }),
    })
      .then(({ endpoints: rows }) => {
        apply(rows);
        setAdding(false);
        setName("");
        setUrl("");
        setKey("");
        setLabel("");
        setNewTools(false);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // Moved at once, so the switch answers the hand; put back from the
  // server if the save fails, so it never shows a state that is not saved.
  const switchFlag = (id: string, flag: "tools" | "vision" | "effort", on: boolean) => {
    setError(null);
    setEndpoints((rows) => rows && rows.map((row) => (row.id === id ? { ...row, [flag]: on } : row)));
    api(`/api/custom-endpoints/${id}`, { method: "PATCH", body: JSON.stringify({ [flag]: on }) })
      .then(({ endpoints: rows }) => apply(rows))
      .catch((e: Error) => {
        setError(e.message);
        reload();
      });
  };

  // the answer carries every engine as it now stands, so the row, the
  // picker and the engine list all move together
  const retry = (id: string) => {
    if (retrying) return;
    setRetrying(id);
    setError(null);
    api(`/api/custom-endpoints/${id}/models`, { method: "POST" })
      .then(({ endpoints: rows, instances }) => {
        setEndpoints(rows);
        if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setRetrying(null));
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
    <div className="mb-9 overflow-hidden rounded-2xl border bg-card last:mb-0">
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-ui font-semibold text-foreground">{t("customEndpoints.yourEndpoints")}</div>
            <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
              {t("customEndpoints.anyOpenaiCompatibleHost")}
            </div>
          </div>
          {!adding && (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)} className="shrink-0">
              <Plus size={13} />
              {t("common.add")}
            </Button>
          )}
        </div>
      </div>

      {(endpoints ?? []).map((endpoint) => {
        const problem = state.instances.find((instance) => instance.instanceId === endpoint.instanceId)?.snapshot.catalogError;
        return (
          <div key={endpoint.id} className="border-t px-4 py-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ui font-medium text-foreground">{endpoint.name}</span>
                  {!endpoint.tools && <span className="shrink-0 text-caption text-muted-foreground">{t("customEndpoints.chatOnly")}</span>}
                </div>
                <div className="truncate text-small text-muted-foreground">{endpoint.url}</div>
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
                {t("common.remove")}
              </Button>
            </div>

            {problem && <CatalogProblem said={problem} retrying={retrying === endpoint.id} onRetry={() => retry(endpoint.id)} />}

            <div className="mt-2 space-y-2">
              <ToolsSwitch on={endpoint.tools} onChange={(on) => switchFlag(endpoint.id, "tools", on)} />
              <SeesImages on={endpoint.vision === true} onChange={(on) => switchFlag(endpoint.id, "vision", on)} />
              <TakesEffort on={endpoint.effort === true} onChange={(on) => switchFlag(endpoint.id, "effort", on)} />
            </div>

            <div className="mt-2 flex flex-col gap-1">
              {endpoint.keys.map((cred, index) => (
                <div key={cred.id} className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
                  <span
                    className={cn("size-1.5 rounded-full", cred.active ? "bg-success" : "bg-muted-foreground/30")}
                  />
                  <span className="min-w-0 flex-1 truncate text-body text-foreground">
                    {cred.label || (endpoint.keys.length > 1 ? t("customEndpoints.keyNumber", { number: index + 1 }) : t("customEndpoints.apiKey"))}
                    {cred.active && (
                      <span className="ml-1.5 text-caption font-normal text-success">{t("customEndpoints.inUse")}</span>
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
                      className="shrink-0 text-small text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t("customEndpoints.use")}
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
                    title={t("customEndpoints.removeKey")}
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
                    placeholder={t("customEndpoints.anotherKey")}
                    autoComplete="off"
                    className="h-8 text-body"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => addKey(endpoint.id)}
                    disabled={busy || !extraKey.trim()}
                    className="w-[72px]"
                  >
                    <Check size={13} />
                    {t("common.save")}
                  </Button>
                </div>
                <Input
                  value={extraLabel}
                  onChange={(e) => setExtraLabel(e.target.value)}
                  placeholder={t("customEndpoints.labelOptional")}
                  className="h-8 text-body"
                />
              </div>
            ) : (
              <button
                onClick={() => {
                  setKeyFor(endpoint.id);
                  setError(null);
                }}
                className="mt-2 text-small text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("customEndpoints.addAnotherKey")}
              </button>
            )}

            <EndpointHeaders endpoint={endpoint} onSaved={apply} />
          </div>
        );
      })}

      {endpoints !== null && endpoints.length === 0 && !adding && (
        <div className="border-t px-4 py-3 text-body text-muted-foreground">
          {t("customEndpoints.nothingAddedYetWorksWith")}
        </div>
      )}

      {adding && (
        <div className="border-t px-4 py-3">
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("customEndpoints.nameEGTogether")}
              className="h-8 text-body"
            />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("customEndpoints.baseUrlUsuallyEndingIn")}
              className="h-8 text-body"
            />
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={t("customEndpoints.apiKey")}
              autoComplete="off"
              className="h-8 text-body"
            />
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("customEndpoints.keyLabelOptional")}
              className="h-8 text-body"
            />
            <ToolsSwitch on={newTools} onChange={setNewTools} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setNewTools(false);
                  setError(null);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={add}
                disabled={busy || !name.trim() || !url.trim() || !key.trim()}
              >
                <Check size={13} />
                {t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="border-t px-4 py-2 text-small text-destructive">{error}</div>}
    </div>
  );
}
