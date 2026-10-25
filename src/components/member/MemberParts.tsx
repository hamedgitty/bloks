// The pieces a member's app draws its conversations with: faces, a
// transcript, the cards in it, and the composer.
//
// Lean on purpose. The owner's chat (src/components/ChatView.tsx) carries
// everything the owner can do to a conversation, and nearly all of it is
// the owner's alone: redo, rewind, files, the computer. A member reads,
// writes, and answers what is theirs to answer, so that is what is here,
// in the same type, spacing and voice as the owner's chat.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Lock, AlertTriangle, X } from "@/components/icons";
import { BlokAvatar } from "@/components/Avatar";
import { Markdownish } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { shapeForBot, type BlokColor, type BlokShape } from "@/lib/mascot";
import { cardState, speaker, type MemberCard, type MemberMessage } from "@/lib/memberMode";
import { receiptsAt, runs, senderOf, type Said } from "@/lib/participants";
import { useReadPosition, useReads } from "@/lib/readReceipts";
import { GroupMessage, PersonAvatar, SeenBy } from "@/components/chat/Group";
import { QuietCheckIns, richText } from "@/components/chat/Bubble";
import { formatTime } from "@/state/store";
import { quietRunAt } from "@/lib/transcript";

export function AgentFace({ agent, size }: { agent: { id: string; name: string; color: string; shape: string | null }; size: number }) {
  return (
    <BlokAvatar
      color={agent.color as BlokColor}
      shape={shapeForBot({ id: agent.id, name: agent.name, shape: (agent.shape ?? null) as BlokShape | null })}
      size={size}
    />
  );
}

/** A person's face, the same one every group conversation draws. */
export function PersonFace({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  return <PersonAvatar id={id} name={name} size={size} />;
}

/** "Only you": the mark a solo agent wears wherever it is listed. */
export function OnlyYou({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-px text-caption font-medium text-muted-foreground", className)}>
      <Lock size={10} strokeWidth={2.2} aria-hidden />
      Only you
    </span>
  );
}

// ── the transcript ─────────────────────────────────────────────────────

export interface TranscriptProps {
  messages: MemberMessage[];
  /** Who is reading: their own lines sit on their side. */
  me: string;
  people: Record<string, string>;
  owner: string;
  /** Whether other people write here, so lines carry their names. */
  shared: boolean;
  agentName: (id: string | undefined) => string;
  streaming: string;
  busy: boolean;
  /** Words above the first message, such as the privacy line. */
  header?: React.ReactNode;
  empty?: React.ReactNode;
  onAnswer?: (messageId: string, answer: string) => Promise<void>;
  /** The conversation's id, for "Seen by" and for saying how far this
   * person has read. */
  threadId?: string | null;
  /** An agent's face by id, for its bubbles in a group. */
  agentFace?: (id: string | undefined) => React.ReactNode;
  /** Anybody's name by id, readers who never wrote here included. */
  nameOf?: (id: string) => string;
  /** Says this person's place (src/lib/readReceipts.ts). */
  onRead?: (threadId: string, messageId: string) => Promise<unknown>;
}

export function Transcript({ messages, me, people, owner, shared, agentName, streaming, busy, header, empty, onAnswer, threadId = null, agentFace, nameOf, onRead }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const seen = useRef(new Set<string>());
  const first = useRef(true);

  // kept at the bottom while the reader is there; left alone once they
  // scroll up to read something
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, busy]);
  useEffect(() => {
    // what was there when the conversation opened is not news
    for (const m of messages) seen.current.add(m.id);
    first.current = false;
  }, [messages]);

  const shown = messages.filter((m) => !m.deleted);
  // Shared with other people (a room, a team conversation): every
  // message a bubble, a run as one, and "Seen by" under where each other
  // person has read to (src/lib/participants.ts).
  const isBubble = (m: MemberMessage) => m.kind === "text" && !m.deleted && !m.quiet;
  const said = shown as unknown as Array<MemberMessage & Said>;
  const place = shared ? runs(said, isBubble) : null;
  const reads = useReads(shared ? threadId : null);
  useReadPosition({
    threadId: shared ? threadId : null,
    scroller,
    enabled: shared && Boolean(onRead),
    post: (thread, messageId) => onRead?.(thread, messageId) ?? Promise.resolve(),
    tick: messages.length,
  });
  const seenRows = place ? receiptsAt(said.map((m) => m.id), new Set(place.keys()), reads, me, new Map(said.map((m) => [m.id, senderOf(m)]))) : null;
  const nameFor = (id: string) => (id === "owner" ? owner : (nameOf?.(id) ?? people[id] ?? "Someone"));
  const receiptsFor = (id: string) => {
    const who = seenRows?.get(id);
    return who?.length ? <SeenBy people={who.map((p) => ({ id: p, name: nameFor(p) }))} /> : undefined;
  };
  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-6 pb-6 pt-6">
        {header}
        {!shown.length && !streaming && empty}
        {shown.map((m, i) => {
          if (m.quiet) {
            const run = quietRunAt(shown, i);
            return run ? <QuietCheckIns key={m.id} messages={run} /> : null;
          }
          const fresh = !first.current && !seen.current.has(m.id);
          const prev = shown[i - 1];
          const sameSpeaker = prev && !prev.quiet && prev.role === "user" && m.role === "user" && prev.author === m.author && m.at - prev.at < 5 * 60_000;
          return (
            <Line
              key={m.id}
              message={m}
              fresh={fresh}
              me={me}
              people={people}
              owner={owner}
              shared={shared}
              agentName={agentName}
              compact={Boolean(sameSpeaker)}
              onAnswer={onAnswer}
              place={place?.get(m.id)}
              receipts={receiptsFor(m.id)}
              agentFace={agentFace}
            />
          );
        })}
        {streaming && shared ? (
          <div aria-live="polite">
            <GroupMessage
              mine={false}
              first
              last={false}
              face={agentFace?.(undefined)}
              name={agentName(undefined)}
              at={Date.now()}
              rich={streaming.length > 400 || richText(streaming)}
              bubble={<Markdownish text={streaming} streaming />}
            />
          </div>
        ) : streaming ? (
          <div className="text-lead text-foreground" aria-live="polite">
            <Markdownish text={streaming} streaming />
          </div>
        ) : busy ? (
          <div className="flex items-center gap-2 text-body text-muted-foreground" role="status">
            <Loader2 size={14} className="animate-spin" />
            Working on it
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Line({
  message: m,
  fresh,
  me,
  people,
  owner,
  shared,
  agentName,
  compact,
  onAnswer,
  place,
  receipts,
  agentFace,
}: {
  message: MemberMessage;
  fresh: boolean;
  me: string;
  people: Record<string, string>;
  owner: string;
  shared: boolean;
  agentName: (id: string | undefined) => string;
  compact: boolean;
  onAnswer?: (messageId: string, answer: string) => Promise<void>;
  place?: { first: boolean; last: boolean };
  receipts?: React.ReactNode;
  agentFace?: (id: string | undefined) => React.ReactNode;
}) {
  // several people here: every message a bubble, as the owner's own app
  // draws a room (src/components/chat/Group.tsx)
  if (shared && place && m.kind === "text") {
    const human = m.role === "user";
    const mine = human && m.author === me;
    const who = human ? speaker(m, me, people, owner) : agentName(m.from);
    return (
      <GroupMessage
        mine={mine}
        first={place.first}
        last={place.last}
        face={human ? <PersonAvatar id={m.author ?? "owner"} name={who} /> : agentFace?.(m.from)}
        name={who}
        at={m.at}
        rich={!human && richText(m.text ?? "")}
        readId={m.id}
        // a run from one sender sits close together
        className={cn(fresh && (mine ? "animate-send-in" : human ? "animate-receive-in" : "animate-fade-in"), !place.first && "-mt-4")}
        bubbleClassName={human ? "whitespace-pre-wrap" : undefined}
        bubble={
          <>
            {m.onBehalf && <div className="mb-1 text-caption text-muted-foreground">Sent on {m.onBehalf.name}'s behalf</div>}
            {human ? m.text : <Markdownish text={m.text ?? ""} />}
          </>
        }
        under={mine && m.queued ? <span className="mt-1 px-1 text-caption text-muted-foreground">Waiting for the reply before it</span> : undefined}
        receipts={receipts}
      />
    );
  }
  if (m.role === "user" && m.kind === "text") {
    const mine = m.author === me;
    const who = speaker(m, me, people, owner);
    if (mine || !shared) {
      return (
        <div className={cn("flex flex-col items-end", fresh && "animate-send-in")}>
          <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-lead text-foreground [overflow-wrap:anywhere] sm:max-w-[68%]">
            {m.text}
          </div>
          {m.queued && <span className="mt-1 px-1 text-caption text-muted-foreground">Waiting for the reply before it</span>}
        </div>
      );
    }
    // somebody else in a conversation several people share: their face,
    // their name, then their words, on the other side from yours
    return (
      <div className={cn("flex gap-2.5", fresh && "animate-receive-in", compact && "-mt-3")}>
        <span className="w-7 shrink-0">{!compact && <PersonFace id={m.author ?? "owner"} name={who} />}</span>
        <div className="flex min-w-0 max-w-[82%] flex-col items-start sm:max-w-[68%]">
          {!compact && (
            <span className="mb-1 flex items-baseline gap-2 px-1">
              <span className="text-body font-medium text-foreground">{who}</span>
              <span className="text-caption tabular-nums text-muted-foreground">{formatTime(m.at)}</span>
            </span>
          )}
          <div className="whitespace-pre-wrap rounded-2xl border bg-card px-4 py-2.5 text-lead text-foreground [overflow-wrap:anywhere]">{m.text}</div>
        </div>
      </div>
    );
  }
  if (m.kind === "text") {
    return (
      <div className={cn("flex flex-col items-start", fresh && "animate-fade-in")}>
        {m.onBehalf && (
          <span className="mb-1.5 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
            Sent on {m.onBehalf.name}'s behalf
          </span>
        )}
        <div className="w-full min-w-0 text-lead text-foreground">
          <Markdownish text={m.text ?? ""} />
        </div>
      </div>
    );
  }
  if (m.kind === "activity" && m.tool) {
    return (
      <div className="-my-2 flex items-center gap-2 text-small text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", m.tool.ok === false ? "bg-destructive" : "bg-muted-foreground/40")} aria-hidden />
        {m.tool.name}
      </div>
    );
  }
  if (m.kind === "options" && m.card) {
    return <CardLine messageId={m.id} card={m.card} from={agentName(m.from)} people={people} me={me} owner={owner} onAnswer={onAnswer} fresh={fresh} />;
  }
  if (m.kind === "secret" && m.secret) {
    return <Quiet>{agentName(m.from)} asked {owner} for {m.secret.label}. Keys are saved on {owner}'s computer, by {owner}.</Quiet>;
  }
  if (m.kind === "artifact" && m.artifact) {
    return <Quiet>{agentName(m.from)} made {m.artifact.name}. It is kept on {owner}'s computer.</Quiet>;
  }
  if (m.kind === "notice" && m.text) {
    if (m.event) return <div className="py-1 text-center text-small text-muted-foreground">{m.text}</div>;
    return (
      <div className={cn("flex", fresh && "animate-receive-in")}>
        <div className="flex max-w-[560px] gap-2.5 rounded-2xl border border-warning/30 bg-warning/5 px-3.5 py-2.5">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
          <div className="whitespace-pre-wrap text-pretty text-ui leading-relaxed text-foreground">{m.text}</div>
        </div>
      </div>
    );
  }
  return null;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <div className="text-pretty text-body text-muted-foreground">{children}</div>;
}

function CardLine({
  messageId,
  card,
  from,
  people,
  me,
  owner,
  onAnswer,
  fresh,
}: {
  messageId: string;
  card: MemberCard;
  from: string;
  people: Record<string, string>;
  me: string;
  owner: string;
  onAnswer?: (messageId: string, answer: string) => Promise<void>;
  fresh: boolean;
}) {
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = cardState(card);
  const asker = card.askedFor ? (card.askedFor === me ? "you" : (people[card.askedFor] ?? "a member")) : null;
  const answer = async (option: string) => {
    if (!onAnswer || sending) return;
    setSending(option);
    setError(null);
    try {
      await onAnswer(messageId, option);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };
  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl border bg-card px-4 py-3.5", fresh && "animate-receive-in")}>
      <div className="flex flex-col gap-0.5">
        <span className="text-caption text-muted-foreground">{from}{asker ? `, for ${asker}` : ""}</span>
        <span className="text-pretty text-ui font-medium text-foreground">{card.title}</span>
        {card.subtitle && <span className="text-pretty text-body text-muted-foreground">{card.subtitle}</span>}
      </div>
      {state === "open" && (
        <div className="flex flex-wrap gap-2">
          {card.options.map((option, i) => (
            <Button key={option} size="sm" variant={i === 0 ? "default" : "secondary"} disabled={Boolean(sending)} onClick={() => void answer(option)}>
              {sending === option && <Loader2 size={13} className="animate-spin" />}
              {option}
            </Button>
          ))}
        </div>
      )}
      {state === "waiting-on-others" && (
        <span className="text-body text-muted-foreground">Waiting on {asker && asker !== "you" ? `${asker}, ` : ""}{owner} or an admin.</span>
      )}
      {state === "done" && (
        <span className="text-body text-muted-foreground">
          {card.answered ? `${card.answeredBy ? `${card.answeredBy}: ` : ""}${card.answered}` : card.closed ?? "Closed"}
        </span>
      )}
      {error && <span role="alert" className="text-small text-destructive">{error}</span>}
    </div>
  );
}

// ── the composer ───────────────────────────────────────────────────────

export function MemberComposer({
  placeholder,
  disabled,
  notice,
  onSend,
  autoFocusKey,
}: {
  placeholder: string;
  /** Why nothing can be sent here, said in place of the box. */
  disabled?: string | null;
  notice?: { level: "stop" | "warn"; text: string } | null;
  onSend: (text: string) => Promise<void>;
  /** Changes when the conversation does, so the box takes the keys. */
  autoFocusKey?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
    setError(null);
  }, [autoFocusKey]);
  // the box grows with the words, measured again whenever its width
  // changes too: measured before it has a width, every word is a line
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${Math.min(220, el.scrollHeight)}px`;
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, placeholder]);

  const stopped = notice?.level === "stop";
  const send = async () => {
    const words = text.trim();
    if (!words || sending || stopped || disabled) return;
    setSending(true);
    setError(null);
    try {
      await onSend(words);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  if (disabled) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-6 pb-5">
        <div className="rounded-2xl border border-dashed px-4 py-3 text-center text-body text-muted-foreground">{disabled}</div>
      </div>
    );
  }
  const showNotice = notice && notice.text !== hidden;
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-5">
      <div className="rounded-2xl border bg-background shadow-xs transition-[border-color] duration-150 focus-within:border-ring/50">
        {showNotice && (
          <div className="px-2 pt-2">
            <div role={stopped ? "alert" : "status"} className="flex items-start gap-2 rounded-xl bg-muted px-3 py-2.5 text-body text-foreground">
              <AlertTriangle size={14} className={cn("mt-0.5 shrink-0", stopped ? "text-destructive" : "text-warning")} />
              <span className="flex-1 text-pretty">{notice.text}</span>
              {!stopped && (
                <button type="button" aria-label="Put this away" onClick={() => setHidden(notice.text)} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2 py-2 pl-4 pr-2">
          <textarea
            ref={box}
            rows={1}
            value={text}
            disabled={stopped}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={stopped ? "Your requests here are stopped for now" : placeholder}
            aria-label={placeholder}
            className="max-h-[220px] min-h-6 flex-1 resize-none bg-transparent py-1.5 text-lead text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          <Button
            size="icon"
            aria-label="Send"
            disabled={!text.trim() || sending || stopped}
            onClick={() => void send()}
            className="size-8 shrink-0 rounded-full"
          >
            {sending ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.2} />}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 px-1 text-small text-destructive">{error}</p>}
    </div>
  );
}
