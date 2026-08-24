// The secure field an agent plants when a service wants an API key.
//
// The value goes from this input straight to the config file on this
// Mac and reaches the agent's tools as an environment variable on its
// next turn. It never lands in the transcript, never echoes back over
// the API, and the input clears itself the moment the save succeeds.
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type Message } from "@/state/store";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export function SecretCard({ botId, message }: { botId: string; message: Message }) {
  const secret = message.secret;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!secret) return null;
  const { label, status } = secret;

  const save = () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    api(`/api/bots/${botId}/secret-cards/${message.id}/save`, {
      method: "POST",
      body: JSON.stringify({ value }),
    })
      .then(() => setValue(""))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "w-full max-w-[420px] rounded-2xl border bg-card p-3",
          status === "dismissed" && "opacity-55",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-foreground">{label}</div>
            {secret.hint && (
              <div className="mt-0.5 text-[11.5px] text-muted-foreground">{secret.hint}</div>
            )}
          </div>
          {status === "saved" ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-2.5 py-1 text-[12px] font-semibold text-success">
              <Check size={13} strokeWidth={3} />
              Saved
            </span>
          ) : (
            status === "needs-value" && (
              <button
                onClick={() =>
                  void api(`/api/bots/${botId}/secret-cards/${message.id}/dismiss`, {
                    method: "POST",
                  }).catch(() => {})
                }
                title="Dismiss"
                className="shrink-0 rounded-full p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
              >
                <X size={13} />
              </button>
            )
          )}
        </div>

        {status === "needs-value" && (
          <>
            <div className="mt-2.5 flex gap-2">
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder={`Paste your ${label}`}
                autoComplete="off"
                className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring/60"
              />
              <button
                onClick={save}
                disabled={busy || !value.trim()}
                className="shrink-0 rounded-lg bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : "Save securely"}
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/80">
              <ShieldCheck size={11} />
              Stored on this Mac, handed to your agent's tools, never shown in chat.
            </div>
            {error && <div className="mt-1 text-[11.5px] text-destructive">{error}</div>}
          </>
        )}
        {status === "dismissed" && (
          <div className="mt-1 text-[11.5px] text-muted-foreground">Dismissed</div>
        )}
      </div>
    </div>
  );
}
