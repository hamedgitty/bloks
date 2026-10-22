// Each agent speaks through its own bot. Only the owner sees this panel.
//
// Setting one up is two things done in Telegram and one here, so the
// panel is those steps in order, and each ticks when the server says it
// happened: a saved token means BotFather's part worked, and an owner
// means the word arrived from the right account. Until then the step
// waits, and says what it is waiting for.
import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ExternalLink } from "@/components/icons";
import { MessageCircle } from "@/components/icons";
import { api, useStore } from "@/state/store";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirm } from "@/components/ui/confirm";
import { cn } from "@/lib/cn";
import {
  Checklist,
  ConnectionError,
  ConnectionHeader,
  CopyRow,
  HealthLine,
  PairedMoment,
  SecretField,
  StepNote,
  useJustHappened,
  type Health,
  type Step,
} from "./ConnectionKit";

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
  people?: Array<{ id: string; name: string; state: "pending" | "allowed" | "declined" | "removed"; userId?: number; username?: string; first?: string; sameName?: boolean; full?: boolean }>;
  upgradeNotices?: Array<{ state: string }>;
  admissionFull?: boolean;
}

/** Telegram's documented shape, digits, a colon, then the secret. Only a
 * hint: the server keeps no opinion on the format, which is Telegram's to
 * change, and getMe is the check that counts. */
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;

const PERSON_STATE: Record<NonNullable<Status["people"]>[number]["state"], string> = {
  allowed: "Let in",
  pending: "Waiting",
  declined: "Not now",
  removed: "Taken out",
};

function health(status: Status | null): { tone: Health; label: string } | null {
  if (!status) return null;
  if (!status.configured) return { tone: "off", label: "Not set up" };
  if (!status.enabled) return { tone: "off", label: "Off" };
  if (status.needsOwnerPairing) return { tone: "wait", label: "Needs pairing" };
  return { tone: "on", label: "Connected" };
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

  // Seen unpaired, then paired: the word arrived while somebody watched.
  const justPaired = useJustHappened(status ? status.ownerPaired : undefined);

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

  // The word is the very next thing anyone needs once a token is in, so
  // it is asked for straight away rather than behind another button. Only
  // when the server says an owner is needed and no word is out, which is
  // exactly when the old "Pair owner" button showed.
  const saveToken = () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    api(endpoint, { method: "POST", body: JSON.stringify({ token: token.trim() }) })
      .then((next: Status) => {
        setStatus(next);
        setToken("");
        setEditingToken(false);
        if (next.needsOwnerPairing && !next.pairing) {
          return api(endpoint, { method: "POST", body: JSON.stringify({ pair: true }) }).then(setStatus);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  // Full access is the owner's grant to one person on this agent's bot
  // (GitHub 320). Said plainly before it is given, because the separate
  // chat makes it look more private than it is.
  const giveFullAccess = async (person: { id: string; name: string }, agent: string) => {
    const yes = await confirm({
      title: `Give ${person.name} full access to ${agent}?`,
      body: [
        `Their messages run the way yours do: with ${agent}'s own tools, engine and permissions, without asking you first. The answers and the cards their turns raise go to their chat.`,
        `They share one conversation and one memory with you. ${agent} can repeat anything from it to them, and its tools reach your files and accounts. Separate chats do not mean separate memory.`,
        "You can take it back here at any time. That stops their running work; what is already done stays done.",
      ].join("\n\n"),
      confirmLabel: "Give full access",
      destructive: true,
    });
    if (yes) post({ personId: person.id, action: "full" });
  };

  const openAgent = (id: string) => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "select", id });
    dispatch({ type: "toggleSettings", open: true });
  };

  if (!botId) {
    const bots = status?.bots ?? [];
    return (
      <div className="mb-9 rounded-2xl border bg-card p-5 last:mb-0">
        <ConnectionHeader
          icon={<MessageCircle size={14} className="shrink-0 text-muted-foreground" />}
          title="Telegram"
          says="Each agent gets its own bot. Set one up in that agent's settings."
        />
        {bots.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {bots.map((connected) => {
              const h = health(connected);
              return (
                <button
                  key={connected.botId}
                  onClick={() => openAgent(connected.botId)}
                  className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-accent/60"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-foreground">
                    {state.bots.find((bot) => bot.id === connected.botId)?.name ?? "Agent"}
                    <span className="ml-1.5 text-muted-foreground">
                      {connected.username ? `@${connected.username}` : "Telegram settings"}
                    </span>
                  </span>
                  {h && <HealthLine tone={h.tone} label={connected.needsOwnerPairing ? "Needs pairing again" : h.label} />}
                </button>
              );
            })}
          </div>
        )}
        {status?.migrationError && (
          <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2.5 text-body leading-relaxed text-foreground">
            <p>{status.migrationError}</p>
            <select
              aria-label="Agent for previous Telegram bot"
              value={migrationAgent}
              onChange={(e) => setMigrationAgent(e.target.value)}
              className="mt-2 h-8 w-full rounded-lg border bg-background px-2 text-body text-foreground"
            >
              <option value="">Choose an agent</option>
              {state.bots.filter((bot) => !bot.hidden).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="brand" size="sm" disabled={busy || !migrationAgent} onClick={() => post({ botId: migrationAgent, migrate: true })}>Use previous bot</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ discardPending: true })}>Remove previous bot</Button>
            </div>
          </div>
        )}
        <ConnectionError>{error}</ConnectionError>
      </div>
    );
  }

  const h = health(status);
  const agentName = state.bots.find((bot) => bot.id === botId)?.name ?? "this agent";
  const handle = status?.username ? `@${status.username}` : "your bot";
  const botLink = status?.username ? `https://t.me/${encodeURIComponent(status.username)}` : null;
  const settingUp = Boolean(status && (!status.configured || status.needsOwnerPairing));
  const tokenLooksRight = BOT_TOKEN.test(token.trim());

  const tokenField = (
    <div className="flex max-w-[460px] items-start gap-1.5">
      <SecretField
        id={`telegram-token-${botId}`}
        label="Bot token"
        value={token}
        onChange={setToken}
        shape={BOT_TOKEN}
        hint="Looks like 123456789:AAH..., from BotFather."
        placeholder="Paste the token"
        onEnter={saveToken}
        quietLabel={!status?.configured}
        className="min-w-0 flex-1"
      />
      <Button variant="brand" size="sm" className={cn("h-8", status?.configured && "mt-[22px]")} disabled={busy || !token.trim()} onClick={saveToken}>
        {busy ? "Checking" : status?.configured ? "Save" : "Connect"}
      </Button>
    </div>
  );

  const steps: Step[] = status
    ? [
        {
          key: "botfather",
          title: "Make a bot with BotFather",
          state: status.configured || tokenLooksRight ? "done" : "now",
          // ticked by the pasted token's shape, while it is still being
          // pasted, so it stays open until the server has the token
          keep: !status.configured,
          body: (
            <>
              <StepNote>
                In Telegram, message @BotFather and send <code className="rounded bg-muted px-1 font-mono">/newbot</code>.
                Pick a name, and it replies with a token.
              </StepNote>
              <Button asChild size="sm" variant="secondary" className="mt-2">
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                  Open BotFather
                  <ExternalLink size={12} />
                </a>
              </Button>
            </>
          ),
        },
        {
          key: "token",
          title: "Paste the token here",
          state: status.configured ? "done" : busy ? "wait" : "now",
          summary: status.username ? `Saved as @${status.username}` : "Saved",
          body: tokenField,
        },
        {
          key: "word",
          title: "Send the bot your pairing word",
          state: !status.configured ? "later" : status.ownerPaired ? "done" : status.pairing ? "wait" : "now",
          summary: "You are the owner",
          body: status.pairing ? (
            <>
              <StepNote>
                {(status.upgradeNotices?.length ?? 0) > 0 ? "Pair yourself again. " : ""}
                Send this word to {handle} in a private chat. Keep it to yourself: whoever sends it first owns the bot.
              </StepNote>
              <div className="mt-2 max-w-[280px]">
                <CopyRow value={status.pairing} big />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {botLink && (
                  <Button asChild size="sm" variant="secondary">
                    <a href={botLink} target="_blank" rel="noreferrer">
                      Open {handle}
                      <ExternalLink size={12} />
                    </a>
                  </Button>
                )}
                <span className="text-small text-muted-foreground">This ticks when it arrives.</span>
              </div>
            </>
          ) : (
            <>
              <StepNote>
                {(status.upgradeNotices?.length ?? 0) > 0
                  ? "Pair yourself as the owner again, so the bot answers you."
                  : "So the bot answers you. Others can message it to ask to be let in."}
              </StepNote>
              <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => post({ pair: true })}>
                Get a pairing word
              </Button>
            </>
          ),
        },
      ]
    : [];

  return (
    <div className="mt-4 rounded-2xl border bg-card p-4">
      <ConnectionHeader
        icon={<MessageCircle size={14} className="shrink-0 text-muted-foreground" />}
        title="Telegram"
        says={`Message ${agentName} on Telegram.`}
        health={h && <HealthLine tone={h.tone} label={h.label} />}
        control={
          status?.configured && (
            <Switch aria-label="Enable Telegram bot" checked={status.enabled} disabled={busy} onCheckedChange={(enabled) => post({ enabled })} />
          )
        }
      />

      <AnimatePresence initial={false}>
        {justPaired && (
          <PairedMoment
            key="paired"
            icon={<MessageCircle size={18} />}
            title={`You own ${handle}`}
            detail={`Messages to it now reach ${agentName}.`}
          />
        )}
      </AnimatePresence>

      {settingUp && !justPaired && <Checklist label="Set up Telegram" steps={steps} />}

      {status?.configured && !settingUp && botLink && (
        <a
          href={botLink}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-body text-foreground underline-offset-2 hover:underline"
        >
          @{status.username}
          <ExternalLink size={12} className="text-muted-foreground" />
        </a>
      )}

      {status?.configured && editingToken && <div className="mt-3">{tokenField}</div>}

      {(status?.people?.length ?? 0) > 0 && (
        <div className="mt-4 border-t pt-3">
          <div className="text-body font-semibold text-foreground">People on Telegram</div>
          <div className="mt-1.5 flex flex-col">
            {status!.people!.map((person) => (
              <div key={person.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-body text-foreground">{person.name}</span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-caption",
                        person.state === "allowed" ? "bg-success/10 text-success" : person.state === "pending" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {person.full ? "Full access" : PERSON_STATE[person.state]}
                    </span>
                  </span>
                  {/* a first name is chosen freely; the id and username are not */}
                  {person.userId !== undefined && (
                    <span className="block text-caption text-muted-foreground">
                      {person.username ? `@${person.username}, ` : ""}Telegram id {person.userId}
                      {person.sameName ? ". Someone else here has the same name" : ""}
                    </span>
                  )}
                  {person.first && <span className="block break-words text-caption text-muted-foreground">They wrote: {person.first}</span>}
                  {person.full && <span className="block text-caption text-muted-foreground">Uses {agentName} with its own tools, in the conversation you share with it.</span>}
                </span>
                <div className="flex shrink-0 gap-1">
                  {person.state !== "allowed" && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ personId: person.id, action: "allow" })}>Let in</Button>
                  )}
                  {person.state === "allowed" && !person.full && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void giveFullAccess(person, agentName)}>Give full access</Button>
                  )}
                  {person.full && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "restricted" })}>Restrict</Button>
                  )}
                  {person.state === "pending" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "decline" })}>Not now</Button>
                  )}
                  {(person.state === "allowed" || person.state === "pending") && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "remove" })}>Take out</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {status?.configured && <p className="mt-3 text-small text-muted-foreground">
        In groups, mention this bot or reply to one of its messages. Mentions need privacy mode off or the bot to be an admin. Group replies are visible to every member, including people you have not let in. Group requests stay restricted; full access applies only in private chats.
      </p>}
      {status?.admissionFull && <p className="mt-2 text-small text-warning">The waiting list is full. Decide on someone waiting, or take someone out, to make room.</p>}
      {status?.upgradeNotices?.some((n) => ["uncertain", "failed"].includes(n.state)) && <p className="mt-2 text-small text-warning">Some old chats may not know their pairing ended. Ask those people to message the bot to be let in again.</p>}

      {status?.configured && (
        <div className="mt-4 border-t pt-3">
          <p className="text-small leading-relaxed text-muted-foreground">
            {status.voiceVendor ? `Voice messages are transcribed by ${status.voiceVendor === "openai" ? "OpenAI" : "ElevenLabs"} with your speech key.` : "Voice messages need an OpenAI or ElevenLabs key. Without one, the bot asks for text."}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground">
            <button disabled={busy} onClick={() => { setToken(""); setEditingToken(!editingToken); }} className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline">
              {editingToken ? "Keep this token" : "Change token"}
            </button>
            {status.paired > 0 && <button disabled={busy} onClick={() => post({ unpair: true, enabled: false })} className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline">Unpair chats</button>}
            <button disabled={busy} onClick={() => post({ forget: true })} className="underline-offset-2 transition-colors duration-150 hover:text-destructive hover:underline">Remove bot</button>
          </div>
        </div>
      )}
      <ConnectionError>{error}</ConnectionError>
    </div>
  );
}
