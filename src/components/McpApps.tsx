// An MCP server's own interface, shown as an app.
//
// A connector is a list of function names until something draws it. A
// server that publishes an interface gets it framed here, and the frame
// is the whole design: the document is somebody else's code, so it runs
// with no origin of its own, under a policy that allows it no network at
// all, and it may only ask for things the app is prepared to do.
//
// Everything it asks for goes through the server, which checks it again.
// Nothing here is a security boundary on its own; this half exists so the
// message is a shape rather than a surprise before it goes anywhere.
//
// The same card works on the owner's devices other than the computer the
// workspace runs on (GitHub 356). The frame's terms travel with the
// document, so nothing here changes for that; only an older server's
// refusal is put in words a person can act on (src/lib/mcpApps.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow } from "@/components/icons";
import { ArrowLeft } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { RotateCw } from "@/components/icons";
import { ShieldCheck } from "@/components/icons";
import { useMcpServers, type McpServerRow } from "./McpServers";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { appsTrouble } from "@/lib/mcpApps";
import { t } from "@/lib/i18n";

interface McpApp {
  uri: string;
  name: string;
  description: string;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(appsTrouble(res.status, body.error, `${res.status} ${res.statusText}`));
  return body;
}

/** The colours a framed app is told about. Read off the page rather than
 * hard-coded, so an app matches whatever the theme is now. */
export function paletteNow(dark: boolean) {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    scheme: dark ? "dark" : "light",
    background: token("--card", dark ? "#17171a" : "#ffffff"),
    foreground: token("--foreground", dark ? "#ededf0" : "#18181b"),
    muted: token("--muted-foreground", dark ? "#8f8f99" : "#6f6f78"),
    border: token("--border", dark ? "#2a2a30" : "#e6e6e9"),
    accent: token("--ring", "#5b6cff"),
  };
}

export function McpAppsCard() {
  const { servers } = useMcpServers();
  const [open, setOpen] = useState<{ server: McpServerRow; app: McpApp } | null>(null);

  if (!servers) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-2xl border bg-card p-4 text-body text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t("mcpApps.lookingForApps")}
      </div>
    );
  }

  if (open) {
    return <AppFrame server={open.server} app={open.app} onBack={() => setOpen(null)} />;
  }

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="text-ui font-semibold text-foreground">{t("mcpApps.apps")}</div>
      <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
        {t("mcpApps.appsFromYourMcpServers")}
      </div>
      {servers.length === 0 ? (
        <div className="mt-3 px-3 py-6 text-center text-small text-muted-foreground">
          {t("mcpApps.noMcpServersYetUse")}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {servers.map((server) => (
            <ServerApps key={server.id} server={server} onOpen={(app) => setOpen({ server, app })} />
          ))}
        </div>
      )}
    </div>
  );
}

function ServerApps({
  server,
  onOpen,
}: {
  server: McpServerRow;
  onOpen: (app: McpApp) => void;
}) {
  const [apps, setApps] = useState<McpApp[] | null>(null);
  const [tools, setTools] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = useCallback(() => {
    setAsking(true);
    setError(null);
    api(`/api/mcp-servers/${server.id}/apps`)
      .then((r) => {
        setApps(r.apps ?? []);
        setTools((r.tools ?? []).length);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setAsking(false));
  }, [server.id]);

  return (
    <div className="rounded-xl border bg-background p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-foreground">{server.name}</span>
          <span className="block truncate text-small text-muted-foreground">
            {apps === null
              ? server.target
              : apps.length === 0
                ? t("mcpApps.toolsNoApp", { count: tools })
                : t("mcpApps.appsAndTools", { count: apps.length, tools })}
          </span>
        </span>
        <Button variant="ghost" size="sm" disabled={asking} onClick={ask}>
          {asking ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          {apps === null ? t("mcpApps.check") : t("common.checkAgain")}
        </Button>
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-small text-destructive">
          {error}
        </div>
      )}

      {apps?.map((app) => (
        <button
          key={app.uri}
          onClick={() => onOpen(app)}
          className="mt-2 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 hover:bg-accent"
        >
          <AppWindow size={15} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium text-foreground">{app.name}</span>
            {app.description && (
              <span className="block truncate text-small text-muted-foreground">{app.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The frame.
 *
 * `sandbox="allow-scripts"` and nothing else. Without allow-same-origin
 * the document has an opaque origin: it cannot reach our storage, our
 * cookies or our DOM, and the two of them can only speak by passing
 * messages. Adding allow-same-origin back alongside allow-scripts would
 * undo the sandbox entirely, which is worth writing down because it looks
 * like a small convenience.
 */
function AppFrame({
  server,
  app,
  onBack,
}: {
  server: McpServerRow;
  app: McpApp;
  onBack: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { resolvedTheme } = useTheme();

  const load = useCallback(() => {
    setHtml(null);
    setError(null);
    fetch(`/api/mcp-servers/${server.id}/apps/view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: app.uri, theme: paletteNow(resolvedTheme === "dark") }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(appsTrouble(res.status, (await res.json().catch(() => ({}))).error, t("mcpApps.couldNotOpen")));
        return res.text();
      })
      .then(setHtml)
      .catch((e: Error) => setError(e.message));
  }, [server.id, app.uri, resolvedTheme]);

  useEffect(load, [load]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only from this frame. An opaque-origin document posts as "null",
      // so the origin is worth nothing here and the source is the check.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      setBusy(true);
      setNote(null);
      api(`/api/mcp-servers/${server.id}/apps/act`, {
        method: "POST",
        body: JSON.stringify({ message: event.data }),
      })
        .then((r) => {
          if (r.text) setNote(r.text);
          // hand the result back so the app can draw it
          frame.current?.contentWindow?.postMessage({ type: "result", payload: r.result ?? null }, "*");
        })
        .catch((e: Error) => setNote(e.message))
        .finally(() => setBusy(false));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [server.id]);

  return (
    <div className="mt-4 flex flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="flex h-[42px] shrink-0 items-center gap-2 border-b px-2.5">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label={t("common.back")}>
          <ArrowLeft size={15} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{app.name}</span>
        <span className="shrink-0 truncate text-small text-muted-foreground">{server.name}</span>
        {busy && <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />}
        <Button variant="ghost" size="icon-sm" onClick={load} aria-label={t("mcpApps.reloadApp")}>
          <RotateCw size={13} />
        </Button>
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</div>
      )}
      {note && (
        <div className="border-b bg-muted/60 px-3 py-2 text-small text-foreground">{note}</div>
      )}

      <div className={cn("min-h-[280px] bg-card", !html && "flex items-center justify-center")}>
        {html === null && !error ? (
          <div className="flex items-center gap-2 py-10 text-body text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t("mcpApps.loadingFrom", { server: server.name })}
          </div>
        ) : (
          html !== null && (
            <iframe
              ref={frame}
              srcDoc={html}
              sandbox="allow-scripts"
              title={app.name}
              className="h-[420px] w-full border-0 bg-card"
            />
          )
        )}
      </div>

      <div className="flex items-start gap-2 border-t px-3 py-2 text-small leading-relaxed text-muted-foreground">
        <ShieldCheck size={13} className="mt-[2px] shrink-0" />
        <span>
          {t("mcpApps.madeBy", { server: server.name })}
        </span>
      </div>
    </div>
  );
}
