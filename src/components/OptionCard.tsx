// The cards an agent stops on: an approval (may I do this), a question
// (which of these, or say), a workflow gate, and a lead's proposed team.
//
// Approvals are the ones people meet many times a day, so they are built
// to be read in a second and answered in one press: who wants to do what,
// the thing itself in a form a person reads (the command, the file and
// its change, the page), then Allow and Deny. Once answered, a card has
// done its job and gets out of the way, settling into one quiet line
// that opens again if anyone wants to see what was decided.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle } from "@/components/icons";
import { ArrowDown } from "@/components/icons";
import { ArrowUp } from "@/components/icons";
import { Ban } from "@/components/icons";
import { Check } from "@/components/icons";
import { ChevronDown } from "@/components/icons";
import { ChevronRight } from "@/components/icons";
import { Copy } from "@/components/icons";
import { FilePen } from "@/components/icons";
import { FileText } from "@/components/icons";
import { Globe } from "@/components/icons";
import { Minus } from "@/components/icons";
import { Workflow } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, type Message, type TeamPlan } from "@/state/store";
import { AgentAvatar, BlokAvatar } from "@/components/Avatar";
import { AppWatchCard } from "@/components/AppWatch";
import { OpenPlaceCard, SettingsProposalCard } from "@/components/AgentGuideCards";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BLOK_COLOR_NAMES, shapeForBot, type BlokColor } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { isApproval } from "@/lib/cardAnswer";
import {
  readApproval,
  settledAs,
  splitChoices,
  tidyPath,
  type AlwaysScope,
  type ApprovalDetail,
  type ApprovalView,
} from "@/lib/approvalCard";
import { stamp } from "@/lib/when";
import { hasMessage, t, tr, useLanguage, type MessageKey } from "@/lib/i18n";

type OptionCardData = NonNullable<Message["card"]>;

/** Arriving and settling, quick and soft: a card is a pause in the
 * conversation, not an event. */
const ease = [0.23, 1, 0.32, 1] as const;
const enter = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.18, ease } };
const leave = { opacity: 0, scale: 0.985, transition: { duration: 0.1, ease } };

/** What an engine's own question card is titled; the question itself is
 * in the subtitle (server/index.ts). */
const GENERIC_QUESTION = "Your agent has a question";
/** What the server writes when an ask closed with nobody answering. */
const CLOSED_UNANSWERED = "Closed without an answer";

export function OptionCard({
  botId,
  message,
  roomId,
  dock,
}: {
  botId: string;
  message: Message;
  /** Set when the card is being shown inside a room, so an answer goes to
   * the room rather than to the agent alone. */
  roomId?: string;
  /** For a question waiting above the composer (chat/QuestionDock.tsx):
   * "card" is the card there, and "line" is where it was asked, which
   * keeps its place in the conversation and points down to it. */
  dock?: "card" | "line";
}) {
  const { state, dispatch } = useStore();
  const card = message.card;
  const agent = state.bots.find((b) => b.id === botId);
  const messages = roomId ? state.bloks.find((b) => b.id === roomId)?.messages : agent?.messages;

  // Enter and Escape answer only the newest approval still waiting, so a
  // key pressed on an old card scrolled into view cannot answer it by
  // surprise.
  const newest = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
      const m = messages![i];
      if (m.kind === "options" && m.card && isApproval(m.card) && !m.card.answered && !m.card.dismissed) return m.id;
    }
    return null;
  }, [messages]);

  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, roomId, messageId: message.id, answer: text.trim() });
  };
  const dismiss = () => dispatch({ type: "dismissCard", botId, roomId, messageId: message.id });

  if (card.appWatch) return <AppWatchCard plan={card.appWatch} answered={card.answered} />;
  if (card.open) return <OpenPlaceCard plan={card.open} agentName={agent?.name ?? t("optionCard.yourAgent")} />;
  if (card.settingsProposal) return <SettingsProposalCard plan={card.settingsProposal} messageId={message.id} />;

  if (card.team) {
    return (
      <TeamProposal
        plan={card.team}
        leadName={agent?.name ?? t("optionCard.yourAgent")}
        settled={card.answered}
        onHire={() => dispatch({ type: "hireTeam", botId, messageId: message.id })}
        onDecline={() => answer(t("optionCard.declineTeamAnswer"))}
      />
    );
  }

  const name = agent?.name ?? t("optionCard.yourAgent");
  // in a room the speaker's face is already beside the card
  const face = !roomId && agent ? <AgentAvatar bot={agent} size={28} className="mt-px" /> : null;

  if (isApproval(card)) {
    return (
      <ApprovalCard
        messageId={message.id}
        card={card}
        at={message.at}
        agent={{ id: botId, name }}
        face={face}
        active={newest === message.id}
        onAnswer={answer}
        onError={(e) => dispatch({ type: "error", message: e })}
      />
    );
  }
  return (
    <QuestionCard
      messageId={message.id}
      card={card}
      at={message.at}
      name={name}
      face={face}
      dock={dock}
      onAnswer={answer}
      onDismiss={dismiss}
    />
  );
}

// ── approvals ──────────────────────────────────────────────────────────

/** The rule a press saved, by card, said on the settled line for as long
 * as this window is open. Kept outside the card because a settled card
 * moves into its turn's fold and is drawn afresh there. After a reload,
 * Settings is where rules are read. */
const savedRules = new Map<string, AlwaysScope>();

function ApprovalCard({
  messageId,
  card,
  at,
  agent,
  face,
  active,
  onAnswer,
  onError,
}: {
  messageId: string;
  card: OptionCardData;
  at: number;
  agent: { id: string; name: string };
  face: ReactNode;
  active: boolean;
  onAnswer: (text: string) => void;
  onError: (message: string) => void;
}) {
  // read with askedFor too, which the server sends and the type leaves out;
  // the view carries the card's words, so it is read again in a new language
  const language = useLanguage();
  const view = useMemo(() => readApproval(card, { id: agent.id, name: agent.name }), [card, agent.id, agent.name, language]);
  const [remembered, setRemembered] = useState<AlwaysScope | null>(() => savedRules.get(messageId) ?? null);
  // "Allow" and "Deny" are what an answer says to the server, so they
  // go as they are; only the buttons that stand for them are translated.
  // An agent's own choices are its words and are drawn as written.
  const { allow, deny, others } = splitChoices(card.options.length ? card.options : ["Allow", "Deny"]);
  const ownWords = card.options.length > 0;

  const always = (scope: AlwaysScope) => {
    savedRules.set(messageId, scope);
    setRemembered(scope);
    onAnswer(allow ?? "Allow");
    api("/api/rules", { method: "POST", body: JSON.stringify({ ...scope.rule, enabled: true }) }).catch((e: Error) => {
      savedRules.delete(messageId);
      setRemembered(null);
      onError(t("optionCard.ruleNotSaved", { reason: e.message }));
    });
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {card.answered ? (
        <motion.div key="settled" {...enter} className="w-full max-w-[560px]">
          <SettledApproval card={card} at={at} view={view} name={agent.name} remembered={remembered} />
        </motion.div>
      ) : (
        <motion.div key="open" exit={leave} className="w-full max-w-[560px]">
          <PendingApproval
            view={view}
            at={at}
            name={agent.name}
            face={face}
            active={active}
            allowLabel={ownWords && allow ? allow : t("optionCard.allow")}
            denyLabel={ownWords && deny ? deny : t("optionCard.deny")}
            others={others}
            onAllow={() => onAnswer(allow ?? "Allow")}
            onDeny={() => onAnswer(deny ?? "Deny")}
            onOther={onAnswer}
            onAlways={always}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PendingApproval({
  view,
  at,
  name,
  face,
  active,
  allowLabel,
  denyLabel,
  others,
  onAllow,
  onDeny,
  onOther,
  onAlways,
}: {
  view: ApprovalView;
  at: number;
  name: string;
  face: ReactNode;
  active: boolean;
  allowLabel: string;
  denyLabel: string;
  others: string[];
  onAllow: () => void;
  onDeny: () => void;
  onOther: (text: string) => void;
  onAlways: (scope: AlwaysScope) => void;
}) {
  const risky = Boolean(view.risk);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys from a menu opened off this card arrive here through the
    // portal; they are the menu's, and Escape there closes the menu.
    if (!active || !e.currentTarget.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDeny();
    } else if (e.key === "Enter" && e.target === e.currentTarget && !risky) {
      // Enter on a button presses that button; Enter on the card itself
      // is the yes. Never for a risky one, which takes a deliberate click.
      e.preventDefault();
      onAllow();
    }
  };

  return (
    <div
      role="group"
      aria-label={t(view.ask.key, view.ask.params)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="group/card w-full animate-rise-in rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)] outline-none"
    >
      <div className="flex items-start gap-3 px-4 pt-3.5">
        {face}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-3">
            <p className="min-w-0 flex-1 text-pretty text-ui text-muted-foreground">
              {tr(view.ask.key, { ...view.ask.params, agent: <span className="font-semibold text-foreground">{name}</span> })}
            </p>
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{stamp(at)}</span>
          </div>
          {view.askedBy && <p className="text-small text-muted-foreground">{t("optionCard.askedForBy", { name: view.askedBy })}</p>}
        </div>
      </div>

      {view.detail && (
        <div className="px-4 pt-2.5">
          <Detail detail={view.detail} cut={view.cut} />
        </div>
      )}

      {view.risk && (
        <p className="mx-4 mt-2.5 flex items-center gap-1.5 text-small text-warning">
          <AlertTriangle size={13} className="shrink-0" aria-hidden />
          {view.risk}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3">
        <Button variant={risky ? "destructive" : "brand"} onClick={onAllow} className="min-w-[84px]">
          {allowLabel}
          {active && !risky && <KeyHint>Enter</KeyHint>}
        </Button>
        <Button variant="secondary" onClick={onDeny} className="min-w-[84px]">
          {denyLabel}
          {active && <KeyHint>Esc</KeyHint>}
        </Button>
        {/* an agent's own extra choices, in its own words: what they
            mean is the agent's to keep, not a rule of ours. Its "always"
            is not offered on a risky one, the same as ours is not. */}
        {others.filter((other) => !(risky && /always/i.test(other))).map((other) => (
          <Button key={other} variant="ghost" onClick={() => onOther(other)}>
            {other}
          </Button>
        ))}
        {view.scopes.length > 0 && <AlwaysMenu scopes={view.scopes} onPick={onAlways} />}
      </div>
    </div>
  );
}

/** A key that answers, shown only while it would: on the newest card,
 * once the card has focus. Not on a phone's width, where there is no key
 * to press and the hint would only push the row onto two lines. */
function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="-mr-1 hidden rounded-[5px] bg-current/12 px-1 font-sans text-micro font-medium opacity-70 sm:group-focus-within/card:inline-block">
      {children}
    </kbd>
  );
}

function AlwaysMenu({ scopes, onPick }: { scopes: AlwaysScope[]; onPick: (scope: AlwaysScope) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="ml-auto gap-1 pr-2">
          {t("optionCard.alwaysAllow")}
          <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[300px] max-w-[calc(100vw-32px)]">
        <DropdownMenuLabel>{t("optionCard.allowNowAndFromNow")}</DropdownMenuLabel>
        {scopes.map((scope) => (
          <DropdownMenuItem
            key={scope.id}
            onSelect={() => onPick(scope)}
            className="flex-col items-start gap-0.5 py-2"
          >
            <span className="flex w-full items-center gap-2 text-body font-medium text-foreground">
              <span className="min-w-0 flex-1 truncate">{scope.label}</span>
              {scope.wide && (
                <span className="shrink-0 rounded-full bg-warning/12 px-1.5 text-caption font-medium text-warning">
                  {t("optionCard.allAgents")}
                </span>
              )}
            </span>
            <span className="text-small leading-snug text-muted-foreground">{scope.note}</span>
          </DropdownMenuItem>
        ))}
        <p className="px-2.5 pb-1.5 pt-1 text-small text-muted-foreground">{t("optionCard.savedAsARuleRemove")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettledApproval({
  card,
  at,
  view,
  name,
  remembered,
}: {
  card: OptionCardData;
  at: number;
  view: ApprovalView;
  name: string;
  remembered: AlwaysScope | null;
}) {
  const closed = Boolean(card.cutOff || card.closed) || card.answered === CLOSED_UNANSWERED;
  const outcome = closed ? "closed" : settledAs(card.answered);
  const by = card.answeredBy;
  const label = (() => {
    if (outcome === "closed") return by ? t("optionCard.settled.notAnsweredBy", { name: by }) : t("optionCard.notAnswered");
    if (outcome === "allowed") {
      if (remembered || /always/i.test(card.answered ?? "")) return by ? t("optionCard.settled.alwaysAllowedBy", { name: by }) : t("optionCard.settled.alwaysAllowed");
      return by ? t("optionCard.settled.allowedBy", { name: by }) : t("optionCard.settled.allowed");
    }
    if (outcome === "denied") return by ? t("optionCard.settled.deniedBy", { name: by }) : t("optionCard.settled.denied");
    // the agent's own choice, in its words
    return by ? t("optionCard.settled.answerBy", { answer: card.answered ?? "", name: by }) : (card.answered ?? "");
  })();
  const icon =
    outcome === "allowed" ? (
      <Check size={12} className="text-success" />
    ) : outcome === "denied" ? (
      <Ban size={12} />
    ) : (
      <Minus size={12} />
    );
  // the thing itself when there is one, else what kind of thing it was
  const what = view.short || settledWords(view, "what") || view.verb;
  const why = card.cutOff ? t("optionCard.closedWhenBloksStopped") : card.closed;

  return (
    <SettledLine
      icon={icon}
      at={at}
      summary={
        <>
          <span className="shrink-0 font-medium text-foreground/80">
            {label}
          </span>
          <span className={cn("min-w-0 truncate", view.short && view.detail?.kind !== "text" && "font-mono")}>{what}</span>
        </>
      }
    >
      <p className="text-small text-muted-foreground">
        {settledWords(view, "asked") ?? tr(view.ask.key, { ...view.ask.params, agent: name })}
        {view.askedBy ? ` ${t("optionCard.askedForBySentence", { name: view.askedBy })}` : ""}
      </p>
      {view.detail && <Detail detail={view.detail} cut={view.cut} quiet />}
      {why && <p className="text-small text-muted-foreground">{why}</p>}
      {remembered && (
        <p className="text-small text-muted-foreground">
          {t("optionCard.savedARule", { rule: remembered.label })}
        </p>
      )}
    </SettledLine>
  );
}

/** One quiet line for a card that has been dealt with, in the shape of
 * the tool lines around it (ToolRun.tsx), that opens to say more. */
function SettledLine({
  icon,
  summary,
  at,
  children,
}: {
  icon: ReactNode;
  summary: ReactNode;
  at: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 max-w-full px-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md py-0.5 text-left text-small text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <span className="shrink-0">{icon}</span>
        {summary}
        <span className="shrink-0 tabular-nums opacity-80">{stamp(at)}</span>
        <ChevronRight size={12} className={cn("shrink-0 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {open && (
        <div className="ml-[5px] mt-1 flex min-w-0 max-w-full animate-fade-in flex-col gap-2 border-l pb-1 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/** A settled approval says what was asked in the past ("Juno asked to
 * run a command.") and, with nothing shorter to show, what it was ("Run
 * a command"): one sentence each per kind of ask, found by the name of
 * the card's own sentence (approvalCard.ask.<kind>). Undefined for an ask
 * this file has no words for yet, so the caller can fall back. */
function settledWords(view: ApprovalView, form: "asked" | "what"): string | undefined {
  const kind = view.ask.key.replace(/^approvalCard\.ask\./, "") as AskKind;
  if (!hasMessage(`optionCard.${form}.${kind}`)) return undefined;
  return form === "asked" ? t(`optionCard.asked.${kind}`, view.ask.params) : t(`optionCard.what.${kind}`, view.ask.params);
}

/** The kinds of ask approvalCard has a sentence for. */
type AskKind = MessageKey extends infer K ? (K extends `approvalCard.ask.${infer Kind}` ? Kind : never) : never;

// ── what will run ──────────────────────────────────────────────────────

/** Past this, a block is folded to its first lines until asked for. */
const LONG_LINES = 5;
const LONG_CHARS = 320;

function isLong(text: string) {
  return text.split(/\r?\n/).length > LONG_LINES || text.length > LONG_CHARS;
}

function Detail({ detail, cut, quiet }: { detail: ApprovalDetail; cut: boolean; quiet?: boolean }) {
  const shade = quiet ? "bg-muted/40" : "bg-muted/60";
  switch (detail.kind) {
    case "command":
      return <CodeBlock text={detail.text} cut={cut} prompt shade={shade} />;
    case "text":
      return <Prose text={detail.text} cut={cut} />;
    case "path":
      return <PathRow path={detail.path} shade={shade} />;
    case "url":
      return <UrlRow url={detail.url} cut={cut} shade={shade} />;
    case "diff":
      return <Diff path={detail.path} removed={detail.removed} added={detail.added} />;
    case "content":
      return (
        <div className="flex flex-col gap-1.5">
          {detail.path && <PathRow path={detail.path} shade={shade} icon="new" />}
          <CodeBlock text={detail.text} cut={cut} shade={shade} />
        </div>
      );
    case "fields":
      return <Fields name={detail.name} fields={detail.fields} cut={cut} shade={shade} />;
  }
}

function CodeBlock({ text, cut, prompt, shade }: { text: string; cut: boolean; prompt?: boolean; shade: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(text);
  return (
    <div className={cn("group/code relative rounded-xl px-3 py-2", shade)}>
      <pre
        className={cn(
          "select-text whitespace-pre-wrap pr-6 font-mono text-small leading-relaxed text-foreground [overflow-wrap:anywhere]",
          long && !open && "line-clamp-5",
        )}
      >
        {prompt && <span className="select-none text-muted-foreground">$ </span>}
        {text}
        {cut && <span className="text-muted-foreground" title={t("optionCard.bloksWasOnlySentThis")}>…</span>}
      </pre>
      <CopyButton text={text} />
      {long && <MoreToggle open={open} onToggle={() => setOpen((o) => !o)} />}
    </div>
  );
}

function Prose({ text, cut }: { text: string; cut: boolean }) {
  const [open, setOpen] = useState(false);
  const long = isLong(text);
  return (
    <div>
      <p
        className={cn(
          "whitespace-pre-wrap text-pretty text-body leading-relaxed text-foreground/90 [overflow-wrap:anywhere]",
          long && !open && "line-clamp-4",
        )}
      >
        {text}
        {cut && "…"}
      </p>
      {long && <MoreToggle open={open} onToggle={() => setOpen((o) => !o)} />}
    </div>
  );
}

function PathRow({ path, shade, icon }: { path: string; shade: string; icon?: "new" }) {
  const shown = tidyPath(path);
  const cut = shown.lastIndexOf("/");
  const dir = cut >= 0 ? shown.slice(0, cut + 1) : "";
  const base = cut >= 0 ? shown.slice(cut + 1) : shown;
  const Icon = icon === "new" ? FileText : FilePen;
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 font-mono text-small", shade)} title={path}>
      <Icon size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0">
        <span className="min-w-0 truncate text-muted-foreground">{dir}</span>
        <span className="shrink-0 text-foreground">{base}</span>
      </span>
    </div>
  );
}

function UrlRow({ url, cut, shade }: { url: string; cut: boolean; shade: string }) {
  const match = url.match(/^(https?:\/\/)?([^/?#]+)(.*)$/i);
  const host = match?.[2] ?? url;
  const rest = match?.[3] ?? "";
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 font-mono text-small", shade)} title={url}>
      <Globe size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0">
        <span className="shrink-0 text-foreground">{host}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {rest}
          {cut && "…"}
        </span>
      </span>
    </div>
  );
}

/** A small edit, as a diff: what goes, then what comes, with the lines
 * both sides share kept as plain context rather than shown leaving and
 * arriving again. */
function Diff({ path, removed, added }: { path?: string; removed: string; added: string }) {
  const [open, setOpen] = useState(false);
  const rows = diffRows(removed, added);
  const long = rows.length > 8;
  const shown = long && !open ? rows.slice(0, 8) : rows;
  return (
    <div className="overflow-hidden rounded-xl border">
      {path && (
        <div className="border-b bg-muted/40">
          <PathRow path={path} shade="" />
        </div>
      )}
      <div className="py-1 font-mono text-small leading-relaxed">
        {shown.map(([sign, line], i) => (
          <div
            key={i}
            className={cn(
              "flex gap-2 px-3",
              sign === "-" && "bg-destructive/[0.07]",
              sign === "+" && "bg-success/[0.08]",
            )}
          >
            <span
              className={cn(
                "w-2 shrink-0 select-none",
                sign === "-" ? "text-destructive" : sign === "+" ? "text-success" : "text-muted-foreground",
              )}
            >
              {sign}
            </span>
            <span
              className={cn(
                "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]",
                sign === " " ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {line || " "}
            </span>
          </div>
        ))}
      </div>
      {long && (
        <div className="border-t px-3 pb-1.5">
          <MoreToggle open={open} onToggle={() => setOpen((o) => !o)} />
        </div>
      )}
    </div>
  );
}

/** The lines of an edit, with what both sides start and end with as
 * context. Not a real diff: an edit tool's two strings are small and
 * usually differ in one stretch, which this says exactly. */
function diffRows(removed: string, added: string): Array<["-" | "+" | " ", string]> {
  const a = removed ? removed.split(/\r?\n/) : [];
  const b = added ? added.split(/\r?\n/) : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [
    ...a.slice(0, head).map((line) => [" ", line] as [" ", string]),
    ...a.slice(head, a.length - tail).map((line) => ["-", line] as ["-", string]),
    ...b.slice(head, b.length - tail).map((line) => ["+", line] as ["+", string]),
    ...a.slice(a.length - tail).map((line) => [" ", line] as [" ", string]),
  ];
}

function Fields({
  name,
  fields,
  cut,
  shade,
}: {
  name?: string;
  fields: Array<[string, string]>;
  cut: boolean;
  shade: string;
}) {
  const [open, setOpen] = useState(false);
  const long = fields.length > 5;
  const shown = long && !open ? fields.slice(0, 5) : fields;
  return (
    <div className={cn("rounded-xl px-3 py-2.5", shade)}>
      {name && <div className="mb-1.5 font-mono text-small font-medium text-foreground">{name}</div>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-small">
        {shown.map(([key, value], i) => (
          <div key={`${key}-${i}`} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="line-clamp-3 whitespace-pre-wrap font-mono text-foreground [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {long && <MoreToggle open={open} onToggle={() => setOpen((o) => !o)} more={fields.length - 5} />}
      {/* the fields that were whole are shown; the one the cut fell in,
          and any after it, never reached Bloks */}
      {cut && <p className="mt-1.5 text-small text-muted-foreground">{t("optionCard.theRestWasCutShort")}</p>}
    </div>
  );
}

function MoreToggle({ open, onToggle, more }: { open: boolean; onToggle: () => void; more?: number }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-1 text-small font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      {open ? t("optionCard.showLess") : more ? t("optionCard.showMore", { count: more }) : t("optionCard.showAll")}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <button
      type="button"
      aria-label={copied ? t("common.copied") : t("common.copy")}
      title={copied ? t("common.copied") : t("common.copy")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,color] duration-150 hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
    </button>
  );
}

// ── questions ──────────────────────────────────────────────────────────

/** An answer being typed, by card, for as long as this window is open.
 * Kept outside the card for the same reason as savedRules: the card is
 * drawn afresh when it goes up to wait above the composer, and when its
 * conversation is left and come back to, and a half typed answer should
 * not go with it. */
const drafts = new Map<string, string>();

function QuestionCard({
  messageId,
  card,
  at,
  name,
  face,
  dock,
  onAnswer,
  onDismiss,
}: {
  messageId: string;
  card: OptionCardData;
  at: number;
  name: string;
  face: ReactNode;
  dock?: "card" | "line";
  onAnswer: (text: string) => void;
  onDismiss: () => void;
}) {
  const [custom, setTyped] = useState(() => drafts.get(messageId) ?? "");
  const setCustom = (text: string) => {
    if (text) drafts.set(messageId, text);
    else drafts.delete(messageId);
    setTyped(text);
  };
  const workflow = Boolean(card.runId);
  // An engine's question arrives under a generic title, with the question
  // in the subtitle and, for someone else's turn, who it is for in
  // brackets after it.
  const generic = card.title === GENERIC_QUESTION || card.title === "Approval needed";
  let question = generic ? card.subtitle || card.title : card.title;
  let hint = generic ? "" : card.subtitle;
  let forWhom: string | undefined;
  const bracket = question.match(/\s*\((?:asked for by|for) ([^()]+)\)$/);
  if (bracket) {
    forWhom = bracket[1];
    question = question.slice(0, bracket.index).trim();
  }
  // A workflow's subtitle explains the gate, and once it has been passed
  // that explanation is history.
  if (workflow && card.answered) hint = "";

  // A workflow gate has exactly two answers and each one decides what
  // happens next. Offering a text box beside them would invite an answer
  // nobody can act on, and anything unrecognised has to be read as a
  // decline, which is not what somebody typing a sentence would expect.
  const freeText = !workflow;

  const send = () => {
    if (!custom.trim()) return;
    onAnswer(custom);
    setCustom("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // a number picks that choice, once the card has focus, and not while
    // typing an answer of one's own
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= card.options.length) {
      e.preventDefault();
      onAnswer(card.options[n - 1]);
    }
  };

  // Waiting above the composer, the question keeps its place here as one
  // line, which takes you down to it.
  if (dock === "line" && !card.answered) {
    return <WaitingQuestionLine messageId={messageId} at={at} question={question} />;
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {card.answered ? (
        <motion.div key="settled" {...enter} className="w-full max-w-[560px]">
          <SettledQuestion card={card} at={at} question={question} hint={hint} forWhom={forWhom} name={name} />
        </motion.div>
      ) : (
        // Above the composer it takes the composer's width, edge to edge,
        // so the two read as one column.
        <motion.div key="open" exit={leave} className={cn("w-full", dock !== "card" && "max-w-[560px]")}>
          <div
            role="group"
            aria-label={workflow ? t("optionCard.workflowWaiting") : t("optionCard.asks", { agent: name })}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="group/card w-full animate-rise-in rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)] outline-none"
          >
            <div className="flex items-start gap-3 px-4 pt-3.5">
              {workflow ? (
                <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Workflow size={14} />
                </span>
              ) : (
                face
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <p className="min-w-0 flex-1 truncate text-small text-muted-foreground">
                    {workflow ? (
                      t("optionCard.aWorkflowIsWaitingOn")
                    ) : (
                      tr(forWhom ? "optionCard.asksFor" : "optionCard.asks", {
                        agent: <span className="font-medium text-foreground">{name}</span>,
                        ...(forWhom ? { who: forWhom } : {}),
                      })
                    )}
                  </p>
                  <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{stamp(at)}</span>
                </div>
                {/* anywhere-wrapping so a question that is one long
                    unbroken string folds instead of escaping the card */}
                <p className="mt-0.5 text-pretty text-lead font-semibold text-foreground [overflow-wrap:anywhere]">
                  {question}
                </p>
                {hint && (
                  <p className="mt-0.5 text-pretty text-body leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {hint}
                  </p>
                )}
              </div>
              {!workflow && (
                <button
                  onClick={onDismiss}
                  aria-label={t("optionCard.dismissQuestion")}
                  title={t("common.dismiss")}
                  className="-mr-1.5 -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            {card.options.length > 0 && (
              <div className={cn("flex flex-col gap-0.5 px-2 pt-2.5", !freeText && "pb-2")}>
                {card.options.map((opt, i) => (
                  <button
                    key={opt}
                    onClick={() => onAnswer(opt)}
                    className="group/opt flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-ui text-foreground transition-[background-color,scale] duration-150 ease-out hover:bg-accent active:scale-[0.99]"
                  >
                    <span
                      aria-hidden
                      className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-foreground/20 transition-colors duration-150 group-hover/opt:border-brand-ink"
                    >
                      <span className="size-1.5 rounded-full bg-brand-ink opacity-0 transition-opacity duration-150 group-hover/opt:opacity-100" />
                    </span>
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opt}</span>
                    {i < 9 && (
                      <kbd className="hidden shrink-0 rounded-[5px] border px-1 font-sans text-micro text-muted-foreground sm:group-focus-within/card:inline-block">
                        {i + 1}
                      </kbd>
                    )}
                  </button>
                ))}
              </div>
            )}

            {freeText && (
              <div className="px-4 pb-3.5 pt-2">
                <label className="flex h-9 items-center gap-2 rounded-xl border border-input bg-background pl-3 pr-1 transition-[border-color] duration-150 focus-within:border-ring/60">
                  <input
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) send();
                    }}
                    placeholder={card.options.length ? t("optionCard.orAnswerInYourOwn") : t("optionCard.typeYourAnswer")}
                    aria-label={t("optionCard.yourAnswer")}
                    className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  <Button
                    size="icon-sm"
                    variant={custom.trim() ? "brand" : "ghost"}
                    disabled={!custom.trim()}
                    onClick={send}
                    aria-label={t("optionCard.sendAnswer")}
                    className="size-7 rounded-lg"
                  >
                    <ArrowUp size={14} />
                  </Button>
                </label>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Where a question waiting above the composer was asked. Pressing it
 * brings the card into view and gives it the keyboard. */
function WaitingQuestionLine({ messageId, at, question }: { messageId: string; at: number; question: string }) {
  const toCard = () => {
    const card = document.querySelector<HTMLElement>(`[data-question-dock="${CSS.escape(messageId)}"] [role="group"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    card.focus({ preventScroll: true });
  };
  return (
    <div className="min-w-0 max-w-full px-1.5">
      <button
        type="button"
        onClick={toCard}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-md py-0.5 text-left text-small text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ArrowDown size={12} className="shrink-0 text-brand-ink" />
        <span className="shrink-0 font-medium text-foreground/80">{t("optionCard.waitingBelow")}</span>
        <span className="min-w-0 truncate">{question}</span>
        <span className="shrink-0 tabular-nums opacity-80">{stamp(at)}</span>
      </button>
    </div>
  );
}

function SettledQuestion({
  card,
  at,
  question,
  hint,
  forWhom,
  name,
}: {
  card: OptionCardData;
  at: number;
  question: string;
  hint?: string;
  forWhom?: string;
  name: string;
}) {
  const closed = Boolean(card.cutOff || card.closed) || card.answered === CLOSED_UNANSWERED;
  // A live engine question settles on the server as "answer", the kind
  // of reply rather than its words, so there is nothing more to show.
  const said = closed || card.answered === "answer" ? undefined : card.answered;
  const why = card.cutOff
    ? t("optionCard.closedWhenBloksStopped")
    : card.withdrawn
      ? t("optionCard.withdrawnBy", { agent: name })
      : card.closed;
  return (
    <SettledLine
      icon={closed ? <Minus size={12} /> : <Check size={12} className="text-brand-ink" />}
      at={at}
      summary={
        // the question, then what was said to it, which is the part
        // worth keeping in view when the line is too short for both
        <>
          {(closed || !said) && (
            <span className="shrink-0 font-medium text-foreground/80">
              {closed ? t("optionCard.notAnswered") : card.answeredBy ? t("optionCard.answeredBy", { name: card.answeredBy }) : t("optionCard.answered")}
            </span>
          )}
          <span className="min-w-0 truncate">{question}</span>
          {said && (
            <span className="min-w-0 max-w-[50%] shrink-0 truncate font-medium text-foreground/80">
              {card.answeredBy ? t("optionCard.saidBy", { name: card.answeredBy, answer: said }) : said}
            </span>
          )}
        </>
      }
    >
      <p className="text-pretty text-body font-medium text-foreground [overflow-wrap:anywhere]">{question}</p>
      {hint && <p className="text-small text-muted-foreground">{hint}</p>}
      {forWhom && <p className="text-small text-muted-foreground">{t("optionCard.askedFor", { who: forWhom })}</p>}
      {card.options.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {card.options.map((opt) => (
            <li
              key={opt}
              className={cn(
                "flex items-center gap-2 text-small",
                opt === said ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", opt === said ? "bg-brand-ink" : "bg-foreground/15")} />
              {opt}
            </li>
          ))}
        </ul>
      )}
      {said && !card.options.includes(said) && (
        <p className="whitespace-pre-wrap text-small text-foreground [overflow-wrap:anywhere]">“{said}”</p>
      )}
      {why && <p className="text-small text-muted-foreground">{why}</p>}
    </SettledLine>
  );
}

// ── a proposed team ────────────────────────────────────────────────────

/** Deterministic colour for someone who is not an agent yet, so the roster
 * you approve looks like the roster you get. */
function colorFor(name: string): BlokColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return BLOK_COLOR_NAMES[Math.abs(hash) % BLOK_COLOR_NAMES.length];
}

/**
 * A lead asking to hire. Nothing is created until this is approved, so the
 * card shows the whole roster: who, what they own, and what they can do.
 */
function TeamProposal({
  plan,
  leadName,
  settled,
  onHire,
  onDecline,
}: {
  plan: TeamPlan;
  leadName: string;
  settled?: string;
  onHire: () => void;
  onDecline: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hired = settled === "Hire the team";

  return (
    <div className="w-full max-w-[560px] animate-rise-in overflow-hidden rounded-2xl border bg-card shadow-[0_1px_3px_var(--shadow-color)]">
      <div className="px-4 pt-4">
        <div className="text-caption font-semibold uppercase tracking-[0.1em] text-brand-ink">
          {hired ? t("optionCard.teamHired") : t("optionCard.proposedTeam")}
        </div>
        <div className="mt-1 text-lead font-semibold text-foreground">
          {t("optionCard.teamWants", { lead: leadName, count: plan.members.length, room: plan.room })}
        </div>
        <div className="mt-0.5 text-body leading-relaxed text-muted-foreground">
          {t("optionCard.teamReviewed", { lead: leadName })}
        </div>
      </div>

      <div className="mt-3 flex flex-col divide-y border-t">
        {plan.members.map((member) => (
          <div key={member.name} className="flex gap-3 px-4 py-3">
            <BlokAvatar
              color={colorFor(member.name)}
              shape={shapeForBot({ name: member.name })}
              expression="friendly"
              size={30}
              className="mt-0.5 rounded-[9px]"
            />
            <div className="min-w-0">
              <div className="text-ui font-semibold text-foreground">{member.name}</div>
              {member.title && (
                <div className="text-body leading-snug text-muted-foreground">{member.title}</div>
              )}
              {member.skills.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {member.skills.map((skill) => (
                    <span
                      key={skill}
                      title={skill}
                      className="max-w-[220px] truncate rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground"
                    >
                      {skill.split(":")[0]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {plan.brief && (
        <div className="border-t px-4 py-2.5">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-small font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {open ? t("optionCard.hideBrief") : t("optionCard.showBrief")}
          </button>
          {open && (
            <p className="mt-2 whitespace-pre-wrap text-body leading-relaxed text-muted-foreground">
              {plan.brief}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
        {hired ? (
          <span className="text-body text-muted-foreground">
            {t("optionCard.teamBriefed", { lead: leadName })}
          </span>
        ) : settled ? (
          <span className="text-body text-muted-foreground">{t("optionCard.declined")}</span>
        ) : (
          <>
            <button
              onClick={onHire}
              className="rounded-xl bg-brand-ink px-3.5 py-2 text-ui font-medium text-brand-foreground transition-[transform,filter] duration-150 hover:brightness-95 active:scale-[0.98]"
            >
              {t("optionCard.hireTheTeam")}
            </button>
            <button
              onClick={onDecline}
              className="rounded-xl px-3 py-2 text-ui text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
            >
              {t("common.notNow")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
