// Pairing phones, without typing.
//
// Turning pairing on opens the server to the local network; starting a
// window mints a six digit code and a QR that carries a high-entropy
// token. The QR replaces typing, never consent: the phone still shows
// what it scanned and waits for a tap. Codes last minutes, work once,
// and a handful of wrong guesses closes the window.
import { useCallback, useEffect, useRef, useState } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.mjs";
import Smartphone from "lucide-react/dist/esm/icons/smartphone.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePageVisible } from "@/lib/pageVisible";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

interface PairStatus {
  enabled: boolean;
  pending: boolean;
  addresses: string[];
  devices: Array<{ id: string; name: string; pairedAt: number }>;
}

/** The deep link a phone camera understands. Built defensively: any
 * field that fails its shape check kills the link rather than shipping
 * something malformed to a camera. */
function pairLink(address: string, port: number, token: string, code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (!/^bloks_pair_[A-Za-z0-9_-]{32}$/.test(token)) return null;
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  const name = encodeURIComponent((location.hostname || "This Mac").slice(0, 60));
  return `bloks://pair?address=${encodeURIComponent(`${host}:${port}`)}&token=${token}&code=${code}&name=${name}`;
}

export function DevicesSection() {
  const [status, setStatus] = useState<PairStatus | null>(null);
  const [window_, setWindow] = useState<{
    code: string;
    qr: string | null;
    expiresAt: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    api("/api/pair")
      .then((s) => {
        setStatus(s);
        setError(null);
        // the window closed on the server (used, expired, exhausted)
        if (!s.pending) setWindow(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        inflight.current = false;
      });
  }, []);

  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    load();
    const poll = setInterval(load, 4_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load, visible]);

  const setEnabled = (enabled: boolean) => {
    api("/api/pair", { method: "PUT", body: JSON.stringify({ enabled }) })
      .then(load)
      .catch((e: Error) => setError(e.message));
  };

  const start = () => {
    setError(null);
    api("/api/pair/start", { method: "POST" })
      .then(async (started) => {
        const address =
          (started.addresses as string[] | undefined)?.find((a: string) => a !== "127.0.0.1") ??
          started.addresses?.[0];
        const link = address
          ? pairLink(address, started.port, started.token, started.code)
          : null;
        const qr = link
          ? await QRCode.toDataURL(link, {
              errorCorrectionLevel: "M",
              margin: 1,
              width: 168,
              color: { dark: "#111111", light: "#ffffff" },
            }).catch(() => null)
          : null;
        setWindow({ code: started.code, qr, expiresAt: started.expiresAt });
        load();
      })
      .catch((e: Error) => setError(e.message));
  };

  const cancel = () => {
    api("/api/pair/cancel", { method: "POST" })
      .then(() => {
        setWindow(null);
        load();
      })
      .catch(() => setWindow(null));
  };

  const secondsLeft = window_ ? Math.max(0, Math.round((window_.expiresAt - now) / 1000)) : 0;

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-semibold text-foreground">Phones and devices</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Lets the Bloks app on your phone reach this Mac over your network.
          </div>
        </div>
        <Switch aria-label="Phones and devices" checked={status?.enabled ?? false} onCheckedChange={setEnabled} />
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {status?.enabled && (
        <div className="mt-4">
          {window_ && secondsLeft > 0 ? (
            <div className="flex items-start gap-4">
              {/* the QR always sits on white; a themed QR is an unscannable QR */}
              <div className="shrink-0 rounded-xl bg-white p-2 shadow-sm" aria-label="Pairing QR code">
                {window_.qr ? (
                  <img src={window_.qr} alt="Scan with the Bloks app" className="size-[152px]" />
                ) : (
                  <div className="flex size-[152px] items-center justify-center text-[11px] text-neutral-500">
                    QR unavailable
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-foreground">
                  Scan with the Bloks app
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  Or enter this code by hand:
                </div>
                <div className="mt-1.5 font-mono text-[22px] font-semibold tracking-[0.2em] text-foreground">
                  {window_.code}
                </div>
                <div className="mt-1 text-[11.5px] tabular-nums text-muted-foreground">
                  Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
                  , works once.
                </div>
                <Button variant="ghost" size="sm" className="mt-2 text-muted-foreground" onClick={cancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" size="sm" onClick={start}>
              <Smartphone size={13} />
              Pair a phone
            </Button>
          )}

          {status.devices.length > 0 && (
            <div className="mt-4 flex flex-col gap-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Paired
              </div>
              {status.devices.map((device) => (
                <div key={device.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1">
                  <Smartphone size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {device.name}
                  </span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">
                    {new Date(device.pairedAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                  </span>
                  <button
                    onClick={() =>
                      api(`/api/pair/devices/${device.id}`, { method: "DELETE" })
                        .then(load)
                        .catch((e: Error) => setError(e.message))
                    }
                    title={`Revoke ${device.name}`}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {status === null && <Loader2 size={14} className="mt-3 animate-spin text-muted-foreground" />}
    </div>
  );
}
