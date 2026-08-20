// The sign-in card an agent plants when it needs an app.
//
// Most people do not know what an API or an MCP is, and they should not
// have to: the agent asks, a card appears, one tap opens the sign-in,
// and the task picks itself up when the connection lands. While the
// sign-in tab is open the card quietly polls, so coming back to the
// chat usually means coming back to "Connected".
import { useEffect, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type Message } from "@/state/store";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export function ConnectorCard({ botId, message }: { botId: string; message: Message }) {
  const connector = message.connector;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef(false);

  const call = (verb: "authorize" | "refresh" | "dismiss") =>
    api(`/api/bots/${botId}/connector-cards/${message.id}/${verb}`, { method: "POST" });

  // while the sign-in tab is open, look for the landing every few
  // seconds; the message.patch frame flips the card the moment it lands
  useEffect(() => {
    if (connector?.status !== "authorizing") return;
    const t = setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      call("refresh")
        .catch(() => {})
        .finally(() => {
          polling.current = false;
        });
    }, 4_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector?.status, message.id]);

  if (!connector) return null;
  const { label, status } = connector;

  const connect = () => {
    setBusy(true);
    setError(null);
    call("authorize")
      .then((r) => {
        if (r.url) window.open(r.url, "_blank", "noopener");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex w-full max-w-[420px] items-center gap-3 rounded-2xl border bg-card p-3",
          status === "dismissed" && "opacity-55",
        )}
      >
        {/* the app's monogram; a logo can come later, a letter never lies */}
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-[15px] font-bold text-muted-foreground">
          {label.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-foreground">{label}</div>
          <div className="truncate text-[11.5px] text-muted-foreground">
            {status === "connected"
              ? connector.resumed
                ? "Connected. Task resumed."
                : "Connected"
              : status === "authorizing"
                ? "Waiting for your sign-in…"
                : status === "failed"
                  ? (connector.error ?? "The connection failed.")
                  : status === "dismissed"
                    ? "Dismissed"
                    : "Sign in so your agent can use it"}
          </div>
        </div>
        {status === "connected" ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-[12px] font-semibold text-success">
            <Check size={13} strokeWidth={3} />
            Added
          </span>
        ) : status === "dismissed" ? null : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={connect}
              disabled={busy}
              className="rounded-full bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : status === "authorizing" ? (
                "Reopen"
              ) : status === "failed" ? (
                "Retry"
              ) : (
                "Connect"
              )}
            </button>
            <button
              onClick={() => void call("dismiss").catch(() => {})}
              title="Dismiss"
              className="rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {error && <div className="mt-1 text-[11.5px] text-destructive">{error}</div>}
    </div>
  );
}
