// Bring your own tools: user-registered MCP servers.
//
// Composio is the managed road; this is the open one. Anything that
// speaks MCP, a local command or a remote URL, can be registered and then
// attached to agents individually, the way skills attach. The list the
// server returns is sanitized: names and shapes, never header or
// environment values, so nothing pasted here ever comes back out.
//
// Two pieces: the window that adds one (from the Plugins page or
// Settings), and the page each one has in Settings, Plugins: how it
// connects, the values it is waiting for, which agents may use it, and
// uninstalling. A server's command or address cannot be changed in place;
// to change how it connects, it is uninstalled and added again.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { ArrowLeft } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { confirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { AgentAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { MCP_SERVERS_EVENT } from "@/lib/mcpServersEvent";
import { t, type MessageKey } from "@/lib/i18n";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export interface McpServerRow {
  id: string;
  name: string;
  transport: "stdio" | "http";
  target: string;
  hasHeaders: boolean;
  /** Environment or header names with no value yet, as a server brought
   * over from another tool arrives. Names only; values never come back. */
  needs?: string[];
  /** A command server's program, without its arguments, when it is not on
   * this computer to run. Its agents work without it until it is. */
  missing?: string;
}

export function useMcpServers(): { servers: McpServerRow[] | null; reload: () => void } {
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const reload = useCallback(() => {
    api("/api/mcp-servers")
      .then(({ servers }) => setServers(servers))
      .catch(() => setServers([]));
  }, []);
  useEffect(reload, [reload]);
  // and again when the server says its commands may be findable now
  useEffect(() => {
    window.addEventListener(MCP_SERVERS_EVENT, reload);
    return () => window.removeEventListener(MCP_SERVERS_EVENT, reload);
  }, [reload]);
  return { servers, reload };
}

/** How a server is reached, in a few words. */
export function mcpTarget(server: McpServerRow): string {
  return server.transport === "http" ? server.target : t("mcpServers.runsCommand", { command: server.target });
}

/** A server's line in a list: how it is reached, or that it cannot start. */
export function McpTargetLine({ server, text }: { server: McpServerRow; text?: string }) {
  return server.missing ? (
    <span className="text-destructive">{t("mcpServers.commandNotFound", { command: server.missing })}</span>
  ) : (
    <>{text ?? mcpTarget(server)}</>
  );
}

const field = "h-10 rounded-xl text-ui";
const label = "mb-1.5 block text-ui font-medium text-foreground";

/**
 * Adding a server, in a window over the page you are on. Its risk is said
 * before anything is saved and has to be acknowledged: a server can see
 * whatever an agent sends it and can ask it to act.
 */
export function AddMcpServerDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [auth, setAuth] = useState<"none" | "header">("none");
  const [headerName, setHeaderName] = useState("Authorization");
  const [headerValue, setHeaderValue] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // a closed window starts over next time
  useEffect(() => {
    if (open) return;
    setName("");
    setTransport("http");
    setUrl("");
    setCommand("");
    setAuth("none");
    setHeaderName("Authorization");
    setHeaderValue("");
    setUnderstood(false);
    setError(null);
  }, [open]);

  const target = transport === "http" ? url.trim() : command.trim();
  const ready = Boolean(name.trim() && target && understood && (auth === "none" || (headerName.trim() && headerValue.trim())));

  const add = () => {
    setBusy(true);
    setError(null);
    const headers = transport === "http" && auth === "header" ? { [headerName.trim()]: headerValue.trim() } : undefined;
    api("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify(
        transport === "http"
          ? { name: name.trim(), transport, url: target, ...(headers ? { headers } : {}) }
          : // sent as typed: the server splits it the way a shell would,
            // so a quoted path with a space survives
            { name: name.trim(), transport, commandLine: target },
      ),
    })
      .then(({ id, missing }) => {
        onOpenChange(false);
        onAdded?.(id);
        // saved all the same: it may be installed next, and its page says how
        if (typeof missing === "string") toast.error(t("mcpServers.commandNotFound", { command: missing }));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-[560px] flex-col overflow-y-auto p-7">
        <DialogTitle className="text-heading font-semibold">{t("mcpServers.addCustomMcpServer")}</DialogTitle>

        <div className="mt-6 flex flex-col gap-5">
          <label>
            <span className={label}>{t("common.name")}</span>
            <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("mcpServers.customTool")} className={field} />
          </label>

          <div>
            <span className={label}>{t("mcpServers.connection")}</span>
            <div role="tablist" className="mb-2 flex gap-1">
              {(
                [
                  ["http", "mcpServers.serverUrl"],
                  ["stdio", "mcpServers.command"],
                ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
              ).map(([value, text]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={transport === value}
                  onClick={() => setTransport(value)}
                  className={cn(
                    "h-8 rounded-full px-3.5 text-body font-medium transition-colors duration-150",
                    transport === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(text)}
                </button>
              ))}
            </div>
            {transport === "http" ? (
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className={cn(field, "font-mono text-body")}
              />
            ) : (
              <>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx -y @example/mcp-server --flag"
                  className={cn(field, "font-mono text-body")}
                />
                <p className="mt-1.5 text-body text-muted-foreground">{t("mcpServers.runsOnThisComputer")}</p>
              </>
            )}
          </div>

          {transport === "http" && (
            <div>
              <span className={label}>{t("mcpServers.authentication")}</span>
              <div role="tablist" className="mb-2 flex gap-1">
                {(
                  [
                    ["none", "mcpServers.authNone"],
                    ["header", "mcpServers.authHeader"],
                  ] as const satisfies ReadonlyArray<readonly [string, MessageKey]>
                ).map(([value, text]) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={auth === value}
                    onClick={() => setAuth(value)}
                    className={cn(
                      "h-8 rounded-full px-3.5 text-body font-medium transition-colors duration-150",
                      auth === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(text)}
                  </button>
                ))}
              </div>
              {auth === "header" && (
                <div className="flex gap-2">
                  <Input
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    aria-label={t("mcpServers.headerName")}
                    className={cn(field, "w-[38%] font-mono text-body")}
                  />
                  <Input
                    value={headerValue}
                    onChange={(e) => setHeaderValue(e.target.value)}
                    type="password"
                    autoComplete="off"
                    aria-label={t("mcpServers.headerValue")}
                    placeholder={headerName.trim().toLowerCase() === "authorization" ? "Bearer …" : t("mcpServers.value")}
                    className={cn(field, "flex-1 font-mono text-body")}
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui text-foreground">
            <AlertTriangle size={17} className="shrink-0 text-warning" />
            {t("mcpServers.customMcpServersCanBe")}
          </div>

          <label className="flex cursor-pointer gap-3 rounded-xl border bg-background px-4 py-3.5">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-foreground"
            />
            <span>
              <span className="block text-ui font-medium text-foreground">{t("mcpServers.iUnderstandAndWantTo")}</span>
              <span className="mt-1 block text-pretty text-body leading-relaxed text-muted-foreground">
                {t("mcpServers.onlyAddServersYouTrust")}
              </span>
            </span>
          </label>

          {error && <p className="text-body text-destructive">{error}</p>}
        </div>

        <div className="mt-7 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={add} disabled={!ready || busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t("mcpServers.addServer")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A card of one kind of setting on a server's page. */
function Section({ title, says, children }: { title: string; says?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-5">
      <h3 className="text-lead font-semibold text-foreground">{title}</h3>
      {says && <p className="mt-1 text-pretty text-body text-muted-foreground">{says}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * One server's page in Settings, Plugins: how it connects, the values it
 * still needs, which agents may use it, and uninstalling.
 */
export function McpServerSettings({ id, onBack }: { id: string; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const { servers, reload } = useMcpServers();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const server = servers?.find((s) => s.id === id);

  if (servers === null) {
    return (
      <div className="flex items-center gap-2 py-10 text-body text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> {t("common.loading2")}
      </div>
    );
  }
  if (!server) {
    return (
      <div>
        <BackLink onBack={onBack} />
        <p className="mt-6 text-ui text-muted-foreground">{t("mcpServers.serverNotFound")}</p>
      </div>
    );
  }

  const needs = server.needs ?? [];
  const agents = state.bots.filter((b) => !b.hidden);
  const save = () => {
    setBusy(true);
    setError(null);
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()));
    // the server knows which names are environment and which are headers,
    // so the values go as both and each fills only where its name is
    api(`/api/mcp-servers/${server.id}`, { method: "PATCH", body: JSON.stringify({ env: given, headers: given }) })
      .then(() => {
        setValues({});
        setNote(t("mcpServers.saved"));
        reload();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const uninstall = async () => {
    const yes = await confirm({
      title: t("mcpServers.removeTitle", { server: server.name }),
      body: t("mcpServers.removeBody"),
      confirmLabel: t("common.remove"),
      destructive: true,
    });
    if (!yes) return;
    void api(`/api/mcp-servers/${server.id}`, { method: "DELETE" })
      .then(() => {
        onBack();
        toast(t("mcpServers.removed", { server: server.name }));
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div>
      <BackLink onBack={onBack} />
      <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-display font-semibold text-foreground">{server.name}</h2>
          <p className="mt-1.5 text-ui text-muted-foreground">
            {t("mcpServers.toChangeTheConnectionRemove")}
          </p>
        </div>
        <button
          onClick={uninstall}
          className="flex h-9 items-center gap-1.5 rounded-xl bg-destructive/10 px-3.5 text-ui font-medium text-destructive transition-colors duration-150 hover:bg-destructive/15"
        >
          <Trash2 size={15} />
          {t("common.remove")}
        </button>
      </div>

      <div className="mt-6 flex flex-col gap-4">
        {server.missing && (
          <div role="status" className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui text-foreground">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="block break-words font-medium">{t("mcpServers.commandNotFound", { command: server.missing })}</span>
              <span className="mt-1 block text-pretty text-body text-muted-foreground">{t("mcpServers.commandNotFoundFix", { command: server.missing })}</span>
            </span>
          </div>
        )}
        <Section title={t("mcpServers.connection")}>
          <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-2.5 text-ui">
            <span className="text-muted-foreground">{t("mcpServers.type")}</span>
            <span className="text-foreground">{server.transport === "http" ? t("mcpServers.serverUrl") : t("mcpServers.commandOnThisComputer")}</span>
            <span className="text-muted-foreground">{server.transport === "http" ? t("common.address") : t("mcpServers.runs")}</span>
            <span className="truncate font-mono text-body text-foreground">{server.target}</span>
            {server.hasHeaders && (
              <>
                <span className="text-muted-foreground">{t("mcpServers.authentication")}</span>
                <span className="text-foreground">{t("mcpServers.aHeaderKeptOnThis")}</span>
              </>
            )}
          </div>
        </Section>

        {needs.length > 0 && (
          <Section title={t("mcpServers.finishSetup")} says={t("mcpServers.addTheMissingValuesThey")}>
            <div className="flex flex-col gap-3">
              {needs.map((name) => (
                <label key={name} className="flex flex-col gap-1.5">
                  <span className="font-mono text-body text-muted-foreground">{name}</span>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={values[name] ?? ""}
                    onChange={(e) => setValues((current) => ({ ...current, [name]: e.target.value }))}
                    placeholder={name === "Authorization" ? "Bearer …" : t("mcpServers.pasteTheValue")}
                    className={cn(field, "font-mono text-body")}
                  />
                </label>
              ))}
              <div className="flex justify-end">
                <Button onClick={save} disabled={busy || !Object.values(values).some((v) => v.trim())}>
                  {t("common.save")}
                </Button>
              </div>
            </div>
          </Section>
        )}

        <Section title={t("mcpServers.agentsThatCanUseIt")}>
          {agents.length === 0 ? (
            <p className="text-ui text-muted-foreground">{t("mcpServers.noAgentsYet")}</p>
          ) : (
            <div className="flex flex-col divide-y">
              {agents.map((bot) => {
                const attached = bot.mcpServers ?? [];
                const on = attached.includes(server.id);
                return (
                  <div key={bot.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <AgentAvatar bot={bot} size={26} />
                    <span className="min-w-0 flex-1 truncate text-ui text-foreground">{bot.name}</span>
                    <Switch
                      checked={on}
                      aria-label={t("mcpServers.agentCanUse", { agent: bot.name, server: server.name })}
                      onCheckedChange={(next) =>
                        dispatch({
                          type: "updateBot",
                          botId: bot.id,
                          patch: { mcpServers: next ? [...attached, server.id] : attached.filter((x) => x !== server.id) },
                        })
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </Section>
        {(note || error) && <p className={cn("text-body", error ? "text-destructive" : "text-muted-foreground")}>{error ?? note}</p>}
      </div>
    </div>
  );
}

export function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex items-center gap-1.5 text-ui text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <ArrowLeft size={16} />
      {t("common.back")}
    </button>
  );
}
