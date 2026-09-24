// Slack and Discord, for carrying shared rooms into a team's channels.
//
// Only the connection lives here. Which room goes to which channel is
// chosen in that room's Share panel, next to who is let in, because the
// two decisions are made together.
import { useEffect, useState } from "react";
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

type Status = Record<Platform, PlatformStatus>;

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
