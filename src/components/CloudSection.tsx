// Bloks Cloud, from the buyer's side.
//
// Pairing above this makes the phone work on your own wifi. This is what
// makes it work anywhere, and it is the one paid thing in the product, so
// the screen has exactly two jobs: take the key somebody just bought, and
// then never lie about whether it is working.
//
// Three facts, kept apart on purpose. A key that was accepted is not a
// line that is up, and a line that is up is not a space the relay has
// acknowledged. Collapsing them into one green light is how somebody sits
// looking at "connected" while their phone gets nothing.
import { useCallback, useEffect, useState } from "react";
import Cloud from "lucide-react/dist/esm/icons/cloud.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const CLOUD_KEY = /^blok_live_[0-9a-f]{32}$/;

interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  spaceId: string | null;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  // The relay's own words, not ours. It is the thing that knows whether a
  // card failed, and rewriting that into "something went wrong" is how a
  // billing problem arrives as a bug report.
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export function CloudSection() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  /** How many phones are paired. A pitch that names what somebody
   * already has beats one that describes a product they do not. */
  const [phones, setPhones] = useState(0);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api("/api/relay/status")
      .then(setStatus)
      .catch(() => setStatus({ enabled: false, connected: false, spaceId: null }));
    api("/api/pair")
      .then((s) => setPhones(Array.isArray(s?.devices) ? s.devices.length : 0))
      .catch(() => setPhones(0));
  }, []);

  useEffect(() => {
    load();
    // The line comes up a moment after the key is accepted, so the screen
    // has to look again rather than take the activation at its word.
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const activate = () => {
    const trimmed = key.trim();
    if (!CLOUD_KEY.test(trimmed)) {
      setError("That is not a Bloks Cloud key. One starts with blok_live_ and ends in 32 hex characters.");
      return;
    }
    setBusy(true);
    setError(null);
    api("/api/relay/activate", { method: "POST", body: JSON.stringify({ key: trimmed }) })
      .then(() => {
        setKey("");
        load();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const on = status?.enabled ?? false;

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Cloud size={13.5} className="shrink-0 text-brand-ink" />
            <span className="text-[13.5px] font-semibold text-foreground">Bloks Cloud</span>
          </div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Reaches this Mac from your phone anywhere, not just on this network, and pushes
            you the moment an agent needs an answer. Your agents keep running here, and the
            keys never leave this machine.
          </div>
        </div>
        {on && (
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-medium " +
              (status?.connected
                ? "bg-success/10 text-success"
                : "bg-warning/10 text-warning")
            }
          >
            {status?.connected ? "Connected" : "Reconnecting"}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-2.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-destructive">
          {error}
        </div>
      )}

      {status === null ? (
        <Loader2 size={14} className="mt-3 animate-spin text-muted-foreground" />
      ) : on ? (
        <div className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          {status.spaceId ? (
            <>
              Active. Pair a phone above and it will reach this Mac from anywhere.
              <span className="ml-1 font-mono text-[11.5px] text-muted-foreground/70">
                {status.spaceId}
              </span>
            </>
          ) : (
            "Activated. Waiting for the relay to answer."
          )}
          <div className="mt-2">
            Paste a different key to move Cloud to another Mac. The one it was on stops
            reaching your phone when you do.
          </div>
          <div className="mt-2 flex gap-2">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && activate()}
              placeholder="blok_live_..."
              aria-label="Bloks Cloud key"
              spellCheck={false}
              autoComplete="off"
              className="h-8 font-mono text-[12px]"
            />
            <Button size="sm" variant="outline" disabled={busy || !key.trim()} onClick={activate}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : "Replace"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex gap-2">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && activate()}
              placeholder="blok_live_..."
              aria-label="Bloks Cloud key"
              spellCheck={false}
              autoComplete="off"
              className="h-8 font-mono text-[12px]"
            />
            <Button size="sm" variant="brand" disabled={busy || !key.trim()} onClick={activate}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : "Activate"}
            </Button>
          </div>
          <div className="mt-2.5 text-[12px] leading-relaxed text-muted-foreground">
            {phones > 0 ? (
              <>
                {phones === 1 ? "Your phone is paired and works" : `Your ${phones} phones are paired and work`}{" "}
                on this network. Cloud is what lets {phones === 1 ? "it" : "them"} reach this Mac
                from anywhere, and buzz you when an agent needs an answer.
              </>
            ) : (
              <>
                Pair a phone above and it will reach this Mac on this network. Cloud is what
                lets it reach you from anywhere.
              </>
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <a
              href="https://bloks.dev/cloud"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-md bg-brand-ink px-3 text-[12.5px] font-medium text-brand-foreground transition hover:brightness-95"
            >
              Get Bloks Cloud
            </a>
            <span className="text-[12px] text-muted-foreground">$15 a month</span>
          </div>
          <div className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground/80">
            Already bought it? Your key was on the page shown right after paying, and nowhere
            else. Paste it above.
          </div>
        </div>
      )}
    </div>
  );
}
