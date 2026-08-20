// Bring your own tools: user-registered MCP servers.
//
// Composio is the managed road; this is the open one. Anything that
// speaks MCP, a local command or a remote URL, can be registered here
// and attached to agents individually, the way skills attach. The list
// the server returns is sanitized: names and shapes, never header
// values, so nothing pasted here ever comes back out.
import { useCallback, useEffect, useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Server from "lucide-react/dist/esm/icons/server.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

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
}

export function useMcpServers(): { servers: McpServerRow[] | null; reload: () => void } {
  const [servers, setServers] = useState<McpServerRow[] | null>(null);
  const reload = useCallback(() => {
    api("/api/mcp-servers")
      .then(({ servers }) => setServers(servers))
      .catch(() => setServers([]));
  }, []);
  useEffect(reload, [reload]);
  return { servers, reload };
}

export function McpServersCard() {
  const { servers, reload } = useMcpServers();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [headerLine, setHeaderLine] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = () => {
    setBusy(true);
    setError(null);
    const [cmd, ...args] = command.trim().split(/\s+/);
    // one "Name: value" header covers the common bearer-token case
    const colon = headerLine.indexOf(":");
    const headers =
      transport === "http" && colon > 0
        ? { [headerLine.slice(0, colon).trim()]: headerLine.slice(colon + 1).trim() }
        : undefined;
    api("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify(
        transport === "http"
          ? { name, transport, url: url.trim(), ...(headers ? { headers } : {}) }
          : { name, transport, command: cmd, args: args.join(" ") },
      ),
    })
      .then(() => {
        setAdding(false);
        setName("");
        setCommand("");
        setUrl("");
        setHeaderLine("");
        reload();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13.5px] font-semibold text-foreground">MCP servers</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Your own tools, by the open standard. Attach them to agents from each agent's
            settings.
          </div>
        </div>
        {!adding && (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} />
            Add
          </Button>
        )}
      </div>

      {(servers ?? []).length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {servers!.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-2.5 rounded-xl bg-muted/50 px-2.5 py-2"
            >
              <Server size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {server.name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {server.transport === "http" ? server.target : `runs ${server.target}`}
                  {server.hasHeaders && " · with auth header"}
                </span>
              </span>
              <button
                onClick={() =>
                  void api(`/api/mcp-servers/${server.id}`, { method: "DELETE" })
                    .then(reload)
                    .catch(() => {})
                }
                title="Remove"
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground/60 transition-colors hover:text-destructive"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {servers !== null && servers.length === 0 && !adding && (
        <div className="mt-3 text-[12.5px] text-muted-foreground">
          Nothing registered yet. Anything that speaks MCP works: a local command or a remote
          URL.
        </div>
      )}

      {adding && (
        <div className="mt-3 flex flex-col gap-2.5 rounded-xl border p-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name, e.g. Postgres"
              className="h-8 text-[13px]"
            />
            <div className="flex shrink-0 gap-1 rounded-lg bg-muted p-0.5">
              {(["stdio", "http"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setTransport(mode)}
                  className={cn(
                    "rounded-md px-2.5 text-[12px] transition-colors",
                    transport === mode
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "stdio" ? "Command" : "URL"}
                </button>
              ))}
            </div>
          </div>
          {transport === "stdio" ? (
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx -y @example/mcp-server --flag"
              className="h-8 font-mono text-[12.5px]"
            />
          ) : (
            <>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                className="h-8 font-mono text-[12.5px]"
              />
              <Input
                value={headerLine}
                onChange={(e) => setHeaderLine(e.target.value)}
                placeholder="Authorization: Bearer … (optional)"
                autoComplete="off"
                className="h-8 font-mono text-[12.5px]"
              />
            </>
          )}
          {error && <div className="text-[12px] text-destructive">{error}</div>}
          <div className="flex gap-2">
            <Button size="sm" onClick={add} disabled={busy || !name.trim()}>
              Add server
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
