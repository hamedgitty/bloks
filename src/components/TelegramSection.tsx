// Each agent speaks through its own bot. Only the owner sees this panel.
import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { YourComputer } from "@/lib/thisComputer";

interface Status {
  configured: boolean;
  enabled: boolean;
  paired: number;
  legacyPaired: number;
  ownerPaired: boolean;
  needsOwnerPairing: boolean;
  pairing: string | null;
  username: string | null;
  botId: string | null;
  migrationError?: string | null;
  pendingMigration?: boolean;
  bots?: Array<Status & { botId: string }>;
  voiceVendor?: "elevenlabs" | "openai" | null;
  people?: Array<{ id: string; name: string; state: "pending" | "allowed" | "declined" | "removed" }>;
  upgradeNotices?: Array<{ state: string }>;
  admissionFull?: boolean;
}

export function TelegramSection({ botId }: { botId?: string }) {
  const { state, dispatch } = useStore();
  const endpoint = botId ? `/api/bots/${botId}/telegram` : "/api/telegram";
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [editingToken, setEditingToken] = useState(false);
  const [migrationAgent, setMigrationAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(null);
    setToken("");
    setEditingToken(false);
    setError(null);
    api(endpoint).then((next) => active && setStatus(next)).catch((e) => active && setError(e.message));
    return () => { active = false; };
  }, [endpoint]);

  // A pairing completed on the phone changes this screen without a
  // close/reopen. Stop checking when it completes or the panel closes.
  useEffect(() => {
    if (!status?.pairing) return;
    let active = true;
    const timer = setInterval(() => {
      api(endpoint).then((next) => active && setStatus(next)).catch(() => {});
    }, 2_000);
    return () => { active = false; clearInterval(timer); };
  }, [endpoint, status?.pairing]);

  const post = (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    api(endpoint, { method: "POST", body: JSON.stringify(body) })
      .then((next) => {
        if (!botId) return api(endpoint).then(setStatus);
        setStatus(next);
        setToken("");
        setEditingToken(false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const openAgent = (id: string) => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "select", id });
    dispatch({ type: "toggleSettings", open: true });
  };

  if (!botId) return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="text-[13.5px] font-semibold text-foreground">Telegram</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
        Each agent has its own bot in Agent settings. An agent without a bot token is not on Telegram.
      </p>
      {(status?.bots ?? []).map((connected) => (
        <button key={connected.botId} onClick={() => openAgent(connected.botId)} className="mt-2 block text-[12.5px] underline underline-offset-2">
          {state.bots.find((bot) => bot.id === connected.botId)?.name ?? "Agent"}: {connected.username ? `@${connected.username}` : "Telegram settings"}
          {connected.needsOwnerPairing ? " (pair again to identify the owner)" : ""}
        </button>
      ))}
      {status?.migrationError && (
        <div className="mt-3 text-[12.5px] leading-relaxed text-warning">
          <p>{status.migrationError}</p>
          <select aria-label="Agent for previous Telegram bot" value={migrationAgent} onChange={(e) => setMigrationAgent(e.target.value)} className="mt-2 h-8 w-full rounded-lg border bg-background px-2 text-foreground">
            <option value="">Choose an agent</option>
            {state.bots.filter((bot) => !bot.hidden).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
          <Button className="mt-2" size="sm" disabled={busy || !migrationAgent} onClick={() => post({ botId: migrationAgent, migrate: true })}>Use previous bot</Button>
          <Button className="ml-2 mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => post({ discardPending: true })}>Remove previous bot</Button>
        </div>
      )}
      {error && <p className="mt-2 text-[12.5px] text-warning">{error}</p>}
    </div>
  );

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13.5px] font-semibold text-foreground">Telegram bot</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Message this agent as itself. {YourComputer()} asks Telegram for new messages.
          </p>
        </div>
        {status?.configured && <Switch aria-label="Enable Telegram bot" checked={status.enabled} disabled={busy} onCheckedChange={(enabled) => post({ enabled })} />}
      </div>
      {status?.username && (
        <a href={`https://t.me/${encodeURIComponent(status.username)}`} target="_blank" rel="noreferrer" className="mt-2 block text-[12.5px] underline underline-offset-2">@{status.username}</a>
      )}
      {(!status?.configured || editingToken) && (
        <div className="mt-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            In Telegram, message @BotFather, send <code className="rounded bg-muted px-1">/newbot</code>, and paste the token it gives you.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Input type="password" aria-label="BotFather token" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="BotFather token" className="h-8 font-mono text-[12.5px]" />
            <Button size="sm" disabled={busy || !token.trim()} onClick={() => post({ token })}>{busy ? "Checking…" : "Save"}</Button>
          </div>
        </div>
      )}
      {status?.needsOwnerPairing && (
        <div className="mt-3">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Telegram needs the pairing word again to identify its owner. Pair yourself here. Everyone else can message the bot to ask to be let in.
          </p>
          {status.pairing ? (
            <>
              <p className="mt-2 text-[12px] text-muted-foreground">Send this word in a private message to this bot. Do not share it.</p>
              <div className="mt-1.5 rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[14px]">{status.pairing}</div>
            </>
          ) : <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => post({ pair: true })}>Pair owner</Button>}
        </div>
      )}
      {status?.ownerPaired && <p className="mt-3 text-[12.5px] text-muted-foreground">Owner paired. Other people are not admitted by this pairing word.</p>}
      {(status?.people?.length ?? 0) > 0 && <div className="mt-4">
        <div className="text-[12.5px] font-semibold">People on Telegram</div>
        {status!.people!.map((person) => <div key={person.id} className="mt-2 flex items-center justify-between gap-2 text-[12px]">
          <span>{person.name} <span className="text-muted-foreground">({person.state === "allowed" ? "let in" : person.state === "pending" ? "waiting" : person.state === "declined" ? "not now" : "removed"})</span></span>
          <div className="flex gap-2">
            {person.state !== "allowed" && <button disabled={busy} className="underline underline-offset-2" onClick={() => post({ personId: person.id, action: "allow" })}>Let in</button>}
            {person.state === "pending" && <button disabled={busy} className="underline underline-offset-2" onClick={() => post({ personId: person.id, action: "decline" })}>Not now</button>}
            {(person.state === "allowed" || person.state === "pending") && <button disabled={busy} className="underline underline-offset-2" onClick={() => post({ personId: person.id, action: "remove" })}>Take out</button>}
          </div>
        </div>)}
      </div>}
      {status?.admissionFull && <p className="mt-2 text-[12px] text-warning">Admission is full. No new person was let in.</p>}
      {status?.upgradeNotices?.some((n) => ["uncertain", "failed"].includes(n.state)) && <p className="mt-2 text-[12px] text-warning">Some old chats could not be told, or delivery is uncertain. Their old pairing is gone. Tell those people to message the bot and ask to be let in.</p>}
      {status?.configured && (
        <>
          <p className="mt-3 text-[11.5px] leading-relaxed text-muted-foreground">
            {status.voiceVendor ? `Voice messages are sent to ${status.voiceVendor === "openai" ? "OpenAI" : "ElevenLabs"} to be transcribed, using your speech key.` : "Voice messages need an OpenAI or ElevenLabs speech key. Without one, the bot asks for text instead."}
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-[11.5px] text-muted-foreground">
            <button disabled={busy} onClick={() => setEditingToken(!editingToken)} className="underline underline-offset-2">Change token</button>
            {status.paired > 0 && <button disabled={busy} onClick={() => post({ unpair: true, enabled: false })} className="underline underline-offset-2">Unpair chats</button>}
            <button disabled={busy} onClick={() => post({ forget: true })} className="underline underline-offset-2">Remove bot</button>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-[12.5px] text-warning">{error}</p>}
    </div>
  );
}
