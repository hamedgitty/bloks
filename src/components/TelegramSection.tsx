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
import { t, tr, type MessageKey } from "@/lib/i18n";

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
  voiceVendor?: "whisper" | "elevenlabs" | "openai" | null;
  people?: Array<{ id: string; name: string; state: "pending" | "allowed" | "declined" | "removed"; userId?: number; username?: string; first?: string; sameName?: boolean; full?: boolean }>;
  upgradeNotices?: Array<{ state: string }>;
  admissionFull?: boolean;
  groups?: boolean;
}

/** Telegram's documented shape, digits, a colon, then the secret. Only a
 * hint: the server keeps no opinion on the format, which is Telegram's to
 * change, and getMe is the check that counts. */
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;

const PERSON_STATE: Record<NonNullable<Status["people"]>[number]["state"], MessageKey> = {
  allowed: "telegramSection.person.allowed",
  pending: "telegramSection.person.pending",
  declined: "common.notNow",
  removed: "telegramSection.person.removed",
};

function health(status: Status | null): { tone: Health; label: string } | null {
  if (!status) return null;
  if (!status.configured) return { tone: "off", label: t("telegramSection.health.notSetUp") };
  if (!status.enabled) return { tone: "off", label: t("common.off") };
  if (status.needsOwnerPairing) return { tone: "wait", label: t("telegramSection.health.needsPairing") };
  return { tone: "on", label: t("common.connected") };
}

/** Who a person is past the name they chose: their id, and their
 * username when they have one. */
function idLine(userId: number, username?: string): string {
  return username ? t("telegramSection.idWithUsername", { username, id: String(userId) }) : t("telegramSection.id", { id: String(userId) });
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
      title: t("telegramSection.full.title", { person: person.name, agent }),
      body: [t("telegramSection.full.runs", { agent }), t("telegramSection.full.memory", { agent }), t("telegramSection.full.takeBack")].join("\n\n"),
      confirmLabel: t("telegramSection.giveFullAccess"),
      destructive: true,
    });
    if (yes) post({ personId: person.id, action: "full" });
  };

  // Groups are off until the owner turns them on. Said before, because a
  // group reply is public to that group in a way a private chat is not.
  const answerInGroups = async (agent: string, bot: string) => {
    const yes = await confirm({
      title: t("telegramSection.groups.title", { agent }),
      body: [t("telegramSection.groups.mentions", { bot, agent }), t("telegramSection.groups.public", { agent }), t("telegramSection.groups.others")].join("\n\n"),
      confirmLabel: t("telegramSection.answerInGroups"),
    });
    if (yes) post({ groups: true });
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
          says={t("telegramSection.eachAgentGetsItsOwn")}
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
                    {state.bots.find((bot) => bot.id === connected.botId)?.name ?? t("common.agent")}
                    <span className="ml-1.5 text-muted-foreground">
                      {connected.username ? `@${connected.username}` : t("telegramSection.telegramSettings")}
                    </span>
                  </span>
                  {h && <HealthLine tone={h.tone} label={connected.needsOwnerPairing ? t("telegramSection.needsPairingAgain") : h.label} />}
                </button>
              );
            })}
          </div>
        )}
        {status?.migrationError && (
          <div className="mt-3 rounded-lg bg-warning/10 px-3 py-2.5 text-body leading-relaxed text-foreground">
            <p>{status.migrationError}</p>
            <select
              aria-label={t("telegramSection.agentForPreviousTelegramBot")}
              value={migrationAgent}
              onChange={(e) => setMigrationAgent(e.target.value)}
              className="mt-2 h-8 w-full rounded-lg border bg-background px-2 text-body text-foreground"
            >
              <option value="">{t("telegramSection.chooseAnAgent")}</option>
              {state.bots.filter((bot) => !bot.hidden).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="brand" size="sm" disabled={busy || !migrationAgent} onClick={() => post({ botId: migrationAgent, migrate: true })}>{t("telegramSection.usePreviousBot")}</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ discardPending: true })}>{t("telegramSection.removePreviousBot")}</Button>
            </div>
          </div>
        )}
        <ConnectionError>{error}</ConnectionError>
      </div>
    );
  }

  const h = health(status);
  const agentName = state.bots.find((bot) => bot.id === botId)?.name ?? t("telegramSection.thisAgent");
  const handle = status?.username ? `@${status.username}` : t("telegramSection.yourBot");
  const botLink = status?.username ? `https://t.me/${encodeURIComponent(status.username)}` : null;
  const settingUp = Boolean(status && (!status.configured || status.needsOwnerPairing));
  const tokenLooksRight = BOT_TOKEN.test(token.trim());

  const tokenField = (
    <div className="flex max-w-[460px] items-start gap-1.5">
      <SecretField
        id={`telegram-token-${botId}`}
        label={t("telegramSection.botToken")}
        value={token}
        onChange={setToken}
        shape={BOT_TOKEN}
        hint={t("telegramSection.looksLike123456789AahFrom")}
        placeholder={t("common.pasteTheToken")}
        onEnter={saveToken}
        quietLabel={!status?.configured}
        className="min-w-0 flex-1"
      />
      <Button variant="brand" size="sm" className={cn("h-8", status?.configured && "mt-[22px]")} disabled={busy || !token.trim()} onClick={saveToken}>
        {busy ? t("telegramSection.checking") : status?.configured ? t("common.save") : t("common.connect")}
      </Button>
    </div>
  );

  const steps: Step[] = status
    ? [
        {
          key: "botfather",
          title: t("telegramSection.step.makeBot"),
          state: status.configured || tokenLooksRight ? "done" : "now",
          // ticked by the pasted token's shape, while it is still being
          // pasted, so it stays open until the server has the token
          keep: !status.configured,
          body: (
            <>
              <StepNote>
                {tr("telegramSection.step.makeBotNote", { command: <code className="rounded bg-muted px-1 font-mono">/newbot</code> })}
              </StepNote>
              <Button asChild size="sm" variant="secondary" className="mt-2">
                <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                  {t("telegramSection.openBotfather")}
                  <ExternalLink size={12} />
                </a>
              </Button>
            </>
          ),
        },
        {
          key: "token",
          title: t("telegramSection.step.pasteToken"),
          state: status.configured ? "done" : busy ? "wait" : "now",
          summary: status.username ? t("telegramSection.step.savedAs", { username: status.username }) : t("common.saved"),
          body: tokenField,
        },
        {
          key: "word",
          title: t("telegramSection.step.sendWord"),
          state: !status.configured ? "later" : status.ownerPaired ? "done" : status.pairing ? "wait" : "now",
          summary: t("telegramSection.step.youAreOwner"),
          body: status.pairing ? (
            <>
              <StepNote>
                {(status.upgradeNotices?.length ?? 0) > 0
                  ? t("telegramSection.step.sendWordAgainNote", { handle })
                  : t("telegramSection.step.sendWordNote", { handle })}
              </StepNote>
              <div className="mt-2 max-w-[280px]">
                <CopyRow value={status.pairing} big />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {botLink && (
                  <Button asChild size="sm" variant="secondary">
                    <a href={botLink} target="_blank" rel="noreferrer">
                      {t("telegramSection.openHandle", { handle })}
                      <ExternalLink size={12} />
                    </a>
                  </Button>
                )}
                <span className="text-small text-muted-foreground">{t("telegramSection.thisTicksWhenItArrives")}</span>
              </div>
            </>
          ) : (
            <>
              <StepNote>
                {(status.upgradeNotices?.length ?? 0) > 0
                  ? t("telegramSection.pairYourselfAsTheOwner")
                  : t("telegramSection.soTheBotAnswersYou")}
              </StepNote>
              <Button className="mt-2" size="sm" variant="secondary" disabled={busy} onClick={() => post({ pair: true })}>
                {t("telegramSection.getAPairingWord")}
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
        says={t("telegramSection.messageOnTelegram", { agent: agentName })}
        health={h && <HealthLine tone={h.tone} label={h.label} />}
        control={
          status?.configured && (
            <Switch aria-label={t("telegramSection.enableTelegramBot")} checked={status.enabled} disabled={busy} onCheckedChange={(enabled) => post({ enabled })} />
          )
        }
      />

      <AnimatePresence initial={false}>
        {justPaired && (
          <PairedMoment
            key="paired"
            icon={<MessageCircle size={18} />}
            title={t("telegramSection.youOwn", { handle })}
            detail={t("telegramSection.messagesReach", { agent: agentName })}
          />
        )}
      </AnimatePresence>

      {settingUp && !justPaired && <Checklist label={t("telegramSection.setUpTelegram")} steps={steps} />}

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
          <div className="text-body font-semibold text-foreground">{t("telegramSection.peopleOnTelegram")}</div>
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
                      {person.full ? t("telegramSection.fullAccess") : t(PERSON_STATE[person.state])}
                    </span>
                  </span>
                  {/* a first name is chosen freely; the id and username are not */}
                  {person.userId !== undefined && (
                    <span className="block text-caption text-muted-foreground">
                      {person.sameName
                        ? t("telegramSection.sameName", { line: idLine(person.userId, person.username) })
                        : idLine(person.userId, person.username)}
                    </span>
                  )}
                  {person.first && <span className="block break-words text-caption text-muted-foreground">{t("telegramSection.theyWrote", { message: person.first })}</span>}
                  {person.full && <span className="block text-caption text-muted-foreground">{t("telegramSection.usesWithTools", { agent: agentName })}</span>}
                </span>
                <div className="flex shrink-0 gap-1">
                  {person.state !== "allowed" && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => post({ personId: person.id, action: "allow" })}>{t("telegramSection.letIn")}</Button>
                  )}
                  {person.state === "allowed" && !person.full && (
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void giveFullAccess(person, agentName)}>{t("telegramSection.giveFullAccess")}</Button>
                  )}
                  {person.full && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "restricted" })}>{t("telegramSection.restrict")}</Button>
                  )}
                  {person.state === "pending" && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "decline" })}>{t("common.notNow")}</Button>
                  )}
                  {(person.state === "allowed" || person.state === "pending") && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => post({ personId: person.id, action: "remove" })}>{t("telegramSection.takeOut")}</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {status?.configured && status.ownerPaired && (
        <div className="mt-4 flex items-start justify-between gap-3 border-t pt-3">
          <span className="min-w-0">
            <span className="block text-body font-semibold text-foreground">{t("telegramSection.answerInGroups")}</span>
            <span className="mt-0.5 block text-small leading-relaxed text-muted-foreground">
              {status.groups
                ? t("telegramSection.inGroupsMentionThisBot")
                : t("telegramSection.groupsOff", { handle })}
            </span>
          </span>
          <Switch
            aria-label={t("telegramSection.answerInTelegramGroups")}
            checked={status.groups === true}
            disabled={busy}
            onCheckedChange={(on) => (on ? void answerInGroups(agentName, handle) : post({ groups: false }))}
          />
        </div>
      )}
      {status?.admissionFull && <p className="mt-2 text-small text-warning">{t("telegramSection.theWaitingListIsFull")}</p>}
      {status?.upgradeNotices?.some((n) => ["uncertain", "failed"].includes(n.state)) && <p className="mt-2 text-small text-warning">{t("telegramSection.someOldChatsMayNot")}</p>}

      {status?.configured && (
        <div className="mt-4 border-t pt-3">
          <p className="text-small leading-relaxed text-muted-foreground">
            {status.voiceVendor === "whisper" ? t("telegramSection.voiceTranscribedByWhisper") : status.voiceVendor ? t("telegramSection.voiceTranscribedBy", { vendor: status.voiceVendor === "openai" ? "OpenAI" : "ElevenLabs" }) : t("telegramSection.voiceMessagesNeedAnOpenai")}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-small text-muted-foreground">
            <button disabled={busy} onClick={() => { setToken(""); setEditingToken(!editingToken); }} className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline">
              {editingToken ? t("telegramSection.keepThisToken") : t("telegramSection.changeToken")}
            </button>
            {status.paired > 0 && <button disabled={busy} onClick={() => post({ unpair: true, enabled: false })} className="underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline">{t("telegramSection.unpairChats")}</button>}
            <button disabled={busy} onClick={() => post({ forget: true })} className="underline-offset-2 transition-colors duration-150 hover:text-destructive hover:underline">{t("telegramSection.removeBot")}</button>
          </div>
        </div>
      )}
      <ConnectionError>{error}</ConnectionError>
    </div>
  );
}
