// Webhooks for one agent: the URLs the outside world can use to wake it.
//
// The list is fetched on open rather than held in the store, the same way
// the computer panel treats box state: it changes rarely, only this panel
// cares, and stale-on-arrival would be worse than a spinner.
import { useCallback, useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Copy from "lucide-react/dist/esm/icons/copy.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface HookRow {
  id: string;
  token: string;
  name: string;
  enabled: boolean;
  lastFiredAt?: number;
}

export function WebhooksSection({ botId }: { botId: string }) {
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api(`/api/webhooks?botId=${botId}`)
      .then(({ webhooks }) => setHooks(webhooks))
      .catch((e) => setError(e.message));
  }, [botId]);

  useEffect(refresh, [refresh]);

  const create = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    api("/api/webhooks", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() || "Webhook", botId }),
    })
      .then(() => {
        setName("");
        refresh();
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const remove = (id: string) => {
    api(`/api/webhooks/${id}`, { method: "DELETE" }).then(refresh).catch((e) => setError(e.message));
  };

  const copy = (hook: HookRow) => {
    // The page knows where the server lives better than the record does:
    // same origin in the packaged app, the proxy target in dev.
    const url = `${location.origin}/hook/${hook.token}`;
    void navigator.clipboard?.writeText(url);
    setCopied(hook.id);
    setTimeout(() => setCopied((current) => (current === hook.id ? null : current)), 1600);
  };

  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">Webhooks</div>
      <div className="mt-0.5 text-[12.5px] text-muted-foreground">
        POST to a URL and this agent picks it up as a message. The link is
        the key, so share it like one.
      </div>

      {error && <div className="mt-2 text-[12.5px] text-destructive">{error}</div>}

      <div className="mt-3 space-y-1.5">
        {hooks === null ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        ) : (
          hooks.map((hook) => (
            <div key={hook.id} className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-foreground">{hook.name}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  /hook/{hook.token.slice(0, 10)}…
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => copy(hook)} title="Copy URL">
                {copied === hook.id ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => remove(hook.id)} title="Delete">
                <Trash2 size={14} />
              </Button>
            </div>
          ))
        )}

        <div className="flex items-center gap-2 pt-1">
          <Input
            value={name}
            placeholder="What fires it, e.g. CI failed"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <Button variant="secondary" size="sm" onClick={create} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
