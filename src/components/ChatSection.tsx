// Slack, Discord and WhatsApp, for carrying shared rooms into a team's
// channels and groups.
//
// Only the connection lives here. Which room goes to which channel is
// chosen in that room's Share panel, next to who is let in, because the
// two decisions are made together.
import { useEffect, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import { api } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type Platform = "slack" | "discord";

interface PlatformStatus {
  configured: boolean;
  enabled: boolean;
  state: "off" | "connecting" | "connected" | "error";
  detail?: string;
}

interface WhatsAppStatus extends PlatformStatus {
  number: string | null;
  webhookUrl: string | null;
  verifyToken: string | null;
}

type Status = Record<Platform, PlatformStatus> & { whatsapp: WhatsAppStatus };

const STATE_LABEL: Record<PlatformStatus["state"], string> = {
  off: "Off",
  connecting: "Connecting",
  connected: "Connected",
  error: "Not connected",
};

export function ChatSection() {
  const [status, setStatus] = useState<Status | null>(null);

  const load = () =>
    api("/api/chat")
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void load();
    // the connection settles a moment after it is saved
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  if (!status) return null;
  return (
    <>
      <PlatformCard platform="slack" status={status.slack} onChange={setStatus} />
      <PlatformCard platform="discord" status={status.discord} onChange={setStatus} />
      <WhatsAppCard status={status.whatsapp} onChange={setStatus} />
    </>
  );
}

function PlatformCard({
  platform,
  status,
  onChange,
}: {
  platform: Platform;
  status: PlatformStatus;
  onChange: (next: Status) => void;
}) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    api("/api/chat", { method: "POST", body: JSON.stringify({ platform, ...body }) })
      .then((next: Status) => {
        onChange(next);
        setBotToken("");
        setAppToken("");
        setToken("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const name = platform === "slack" ? "Slack" : "Discord";
  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 pr-3">
          <div className="text-[13.5px] font-semibold text-foreground">{name}</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Carry a shared room into a {name} channel. People there talk to the room's agents by naming
            them, and you let each person in. This computer connects out to {name}; nothing new listens on
            your network.
          </div>
        </div>
        {status.configured && (
          <Switch checked={status.enabled} disabled={busy} onCheckedChange={(on) => post({ enabled: on })} />
        )}
      </div>

      {!status.configured ? (
        <div className="mt-3 space-y-2">
          {platform === "slack" ? (
            <>
              <div className="text-[12px] leading-relaxed text-muted-foreground">
                Create a Slack app with Socket Mode on, give its bot the scopes channels:history,
                groups:history, channels:read, groups:read, chat:write and users:read, subscribe it to the
                message.channels and message.groups events, and install it. Then paste the bot token and an
                app-level token with connections:write.
              </div>
              <Input
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="Bot token, xoxb-..."
                className="h-8 font-mono text-[12.5px]"
              />
              <Input
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder="App-level token, xapp-..."
                className="h-8 font-mono text-[12.5px]"
              />
              <Button size="sm" disabled={busy || !botToken.trim() || !appToken.trim()} onClick={() => post({ botToken, appToken })}>
                {busy ? "Checking" : "Connect Slack"}
              </Button>
            </>
          ) : (
            <>
              <div className="text-[12px] leading-relaxed text-muted-foreground">
                Create an application in the Discord developer portal, add a bot, switch on Message Content
                Intent under Bot, invite it to your server with permission to read and send messages, and
                paste its token.
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Bot token"
                  className="h-8 font-mono text-[12.5px]"
                />
                <Button size="sm" disabled={busy || !token.trim()} onClick={() => post({ token })}>
                  {busy ? "Checking" : "Connect"}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between border-t pt-3">
          <span className="text-[12px] text-muted-foreground">
            {status.enabled ? STATE_LABEL[status.state] : "Switched off"}
            {status.enabled && status.state === "error" && status.detail ? `: ${status.detail}` : ""}
          </span>
          <button
            onClick={() => post({ forget: true })}
            className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Forget {name}
          </button>
        </div>
      )}

      {error && <div className="mt-2 text-[11.5px] text-warning">{error}</div>}
    </div>
  );
}

/**
 * WhatsApp is the odd one out: Meta will only call an address, so its
 * messages come to this computer through Bloks Cloud, and they arrive
 * readable. That is said before anything is typed, not after.
 */
function WhatsAppCard({ status, onChange }: { status: WhatsAppStatus; onChange: (next: Status) => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    api("/api/chat", { method: "POST", body: JSON.stringify({ platform: "whatsapp", ...body }) })
      .then((next: Status) => {
        onChange(next);
        setPhoneNumberId("");
        setToken("");
        setAppSecret("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 pr-3">
          <div className="text-[13.5px] font-semibold text-foreground">WhatsApp</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Carry a shared room into a WhatsApp group, through a WhatsApp Business number. People there talk to
            the room's agents by mentioning the number or naming an agent, and you let each person in.
          </div>
        </div>
        {status.configured && (
          <Switch checked={status.enabled} disabled={busy} onCheckedChange={(on) => post({ enabled: on })} />
        )}
      </div>

      <div className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
        Needs Bloks Cloud. Meta only delivers messages to a public address, so group messages reach this computer
        through Bloks Cloud, and unlike everything else it carries, they pass through readable: Meta sends them
        that way. Nothing is kept on the way.
      </div>

      {!status.configured ? (
        <div className="mt-3 space-y-2">
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            In Meta for Developers, add WhatsApp to a business app and a phone number. Paste that number's ID (not
            the number), a permanent access token from a system user, and the app secret from App settings, Basic.
          </div>
          <Input
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="Phone number ID"
            className="h-8 font-mono text-[12.5px]"
          />
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Access token"
            className="h-8 font-mono text-[12.5px]"
          />
          <Input
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="App secret"
            className="h-8 font-mono text-[12.5px]"
          />
          <Button
            size="sm"
            disabled={busy || !phoneNumberId.trim() || !token.trim() || !appSecret.trim()}
            onClick={() => post({ phoneNumberId, token, appSecret })}
          >
            {busy ? "Checking" : "Connect WhatsApp"}
          </Button>
        </div>
      ) : (
        <>
          {status.webhookUrl && status.verifyToken && (
            <div className="mt-3 space-y-2">
              <div className="text-[12px] leading-relaxed text-muted-foreground">
                Last step, in your app's WhatsApp settings: under Webhooks, paste these two, then subscribe to{" "}
                <span className="font-mono">messages</span>.
              </div>
              <CopyRow label="Callback URL" value={status.webhookUrl} />
              <CopyRow label="Verify token" value={status.verifyToken} />
            </div>
          )}
          <div className="mt-3 flex items-center justify-between border-t pt-3">
            <span className="text-[12px] text-muted-foreground">
              {status.enabled ? STATE_LABEL[status.state] : "Switched off"}
              {status.number ? ` as ${status.number}` : ""}
            </span>
            <button
              onClick={() => post({ forget: true })}
              className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Forget WhatsApp
            </button>
          </div>
        </>
      )}

      {error && <div className="mt-2 text-[11.5px] text-warning">{error}</div>}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-[92px] shrink-0 text-[11.5px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-[11.5px] text-foreground">
        {value}
      </code>
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Copy ${label}`}
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}
