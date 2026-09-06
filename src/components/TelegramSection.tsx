// Reaching your agents from a phone you have not installed anything on.
//
// The iPhone app is the better answer when there is an app. This is for
// the borrowed phone, the Android, the laptop in somebody else's
// kitchen: message a bot, an agent answers.
//
// The screen is a sequence rather than a form, because the setup has an
// order to it and a form would let somebody turn it on before there is
// anything to turn on. Token, pair, choose who answers, then the switch.
import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface Status {
  configured: boolean;
  enabled: boolean;
  paired: number;
  pairing: string | null;
  botId: string | null;
}

export function TelegramSection() {
  const { state } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api("/api/telegram")
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void load();
  }, []);

  const post = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    api("/api/telegram", { method: "POST", body: JSON.stringify(body) })
      .then((next) => {
        setStatus(next);
        setToken("");
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const agents = state.bots.filter((bot) => !bot.hidden);

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0 pr-3">
          <div className="text-[13.5px] font-semibold text-foreground">Telegram</div>
          <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Message an agent from any phone. Your Mac asks Telegram for new messages; nothing new
            listens on your network.
          </div>
        </div>
        {status?.configured && status.paired > 0 && (
          <Switch
            checked={status.enabled}
            disabled={busy}
            onCheckedChange={(on) => post({ enabled: on })}
          />
        )}
      </div>

      {/* 1. the token */}
      {!status?.configured && (
        <div className="mt-3">
          <div className="text-[12px] leading-relaxed text-muted-foreground">
            In Telegram, message @BotFather, send <code className="rounded bg-muted px-1">/newbot</code>,
            and paste the token it gives you.
          </div>
          <div className="mt-2 flex gap-1.5">
            <Input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456:ABC-DEF…"
              className="h-8 font-mono text-[12.5px]"
            />
            <Button size="sm" disabled={busy || !token.trim()} onClick={() => post({ token })}>
              {busy ? "Checking…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* 2. pairing: the bot answers nobody until somebody claims it */}
      {status?.configured && status.paired === 0 && (
        <div className="mt-3">
          {status.pairing ? (
            <div className="text-[12.5px] leading-relaxed text-muted-foreground">
              Message your bot with this word to claim it:
              <div className="mt-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[14px] text-foreground">
                {status.pairing}
              </div>
              <div className="mt-1.5 text-[11.5px]">
                Until then it answers nobody. Turn the switch on first if it is off.
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ pair: true, enabled: true })}>
                Pair a phone
              </Button>
              <span className="text-[11.5px] text-muted-foreground">
                Gives you a word to send the bot, so it knows which chat is yours.
              </span>
            </div>
          )}
        </div>
      )}

      {/* 3. who answers */}
      {status?.configured && status.paired > 0 && (
        <div className="mt-3 border-t pt-3">
          <div className="text-[12.5px] font-medium text-foreground">Who answers</div>
          <select
            value={status.botId ?? ""}
            disabled={busy}
            onChange={(e) => post({ botId: e.target.value })}
            className="mt-1.5 h-8 w-full rounded-lg border bg-background px-2 text-[13px] text-foreground outline-none focus:border-ring/50"
          >
            <option value="">First agent in the list</option>
            {agents.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11.5px] text-muted-foreground">
              {status.paired} chat{status.paired === 1 ? "" : "s"} paired.
            </span>
            <button
              onClick={() => post({ unpair: true, enabled: false })}
              className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Unpair everything
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-[11.5px] text-warning">{error}</div>}
    </div>
  );
}
