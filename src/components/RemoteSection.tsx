// Where this app's Bloks lives: on this computer, or on another one that
// never sleeps (bloks-server), reached through Bloks Cloud.
//
// Desktop only. In a browser or on a phone there is no "this app" to move.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Status = { mode: "local" } | { mode: "remote"; host: string; connected: boolean; revoked?: boolean };

export function RemoteSection() {
  const bridge = typeof window !== "undefined" ? window.bloks : undefined;
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge?.remoteStatus) return;
    void bridge.remoteStatus().then(setStatus);
    return bridge.onRemoteState?.((state) => setStatus({ mode: "remote", ...state }));
  }, [bridge]);

  if (!bridge?.remoteStatus || !status) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    const result = await bridge.remoteConnect!(link.trim());
    // on success the app restarts, so only a failure lands here
    if (result?.error) setError(result.error);
    setBusy(false);
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">Where your Bloks runs</div>
      {status.mode === "remote" ? (
        <>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            This app is using the Bloks on {status.host}'s always-on computer, through Bloks Cloud. Your agents
            keep working there when this computer sleeps.{" "}
            {status.revoked
              ? "That computer no longer recognises this app; pair it again."
              : status.connected
                ? "Connected."
                : "That computer is not reachable right now."}
          </div>
          <Button size="sm" variant="secondary" className="mt-3" disabled={busy} onClick={() => bridge.remoteDisconnect?.()}>
            Use this computer's own Bloks instead
          </Button>
          <div className="mt-1.5 text-[11.5px] text-muted-foreground">Restarts the app. Nothing on either computer is deleted.</div>
        </>
      ) : (
        <>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            On this computer, so your agents stop when it sleeps. To keep them working, run Bloks on a computer
            that never sleeps (a small rented server, a Mac mini, a home server) with{" "}
            <code className="rounded bg-muted px-1">bloks-server</code>, then run{" "}
            <code className="rounded bg-muted px-1">bloks-server pair</code> there and paste the link here.
          </div>
          <div className="mt-3 flex gap-1.5">
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://bloks.dev/pair#..."
              className="h-8 font-mono text-[12.5px]"
            />
            <Button size="sm" disabled={busy || !link.trim()} onClick={() => void connect()}>
              {busy ? "Pairing" : "Use that Bloks"}
            </Button>
          </div>
          <div className="mt-1.5 text-[11.5px] text-muted-foreground">
            Restarts the app. This computer's own agents stay here, switched off, until you come back to them.
          </div>
        </>
      )}
      {error && <div className="mt-2 text-[11.5px] text-warning">{error}</div>}
    </div>
  );
}
