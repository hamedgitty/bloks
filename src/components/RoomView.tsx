// A room: several agents and you, in one transcript. Unlike a solo chat,
// every line is attributed, because who said it is half the meaning.
import { Notice } from "./chat/Bubble";
import { useSettingsObservation } from "@/lib/useSettingsObservation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { AlertTriangle } from "@/components/icons";
import { BookmarkPlus } from "@/components/icons";
import { FolderOpen } from "@/components/icons";
import { CalendarClock } from "@/components/icons";
import { Check } from "@/components/icons";
import { Crown } from "@/components/icons";
import { Rows3 } from "@/components/icons";
import { MessagesSquare } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Download } from "@/components/icons";
import { Trash2 } from "@/components/icons";
import { Users } from "@/components/icons";
import { UserPlus } from "@/components/icons";
import type { RoomPerson } from "@/state/reducer";
import { SharePanel } from "./SharePanel";
import { api, useStore, workingInRoom, type Blok, type Bot, type Message } from "@/state/store";
import { IncidentNotice } from "@/components/chat/IncidentCard";
import { CarryOn } from "@/components/CarryOn";
import { AgentAvatar } from "./Avatar";
import { RoutinesDialog } from "./RoutinesDialog";
import { GroupCallButton } from "./Voice";
import { splitWaiting } from "@/lib/transcript";
import { useHistoryPaging } from "@/lib/useHistoryPaging";
import { ArtifactCard } from "./Artifacts";
import { ForwardDialog, MessageActionBar, Reactions, ReplyContext, useTapToShow, type ReplyDraft } from "./MessageActions";
import { IntentNote, UserText, richText } from "./chat/Bubble";
import { GroupMessage, PersonAvatar, SeenBy } from "./chat/Group";
import { receiptsAt, runs, senderOf } from "@/lib/participants";
import { useNamer, useWorkspaceRoster } from "@/lib/members";
import { seedReads, useReadPosition, useReads } from "@/lib/readReceipts";
import { JumpToLatest } from "./chat/JumpToLatest";
import { HeldSends } from "./chat/HeldSends";
import { heldToShow, isHostedWindow, useHeldSends, useWake } from "@/lib/waking";
import { RoomComposer } from "./room/RoomComposer";
import { OptionCard } from "./OptionCard";
import { Markdownish } from "./Markdown";
import { GenUiHost } from "./genui/host";
import { ChangesCard } from "./ChangesCard";
import { ToolRun } from "./ToolRun";
import { TurnFoldLine } from "./TurnFold";
import { Button } from "@/components/ui/button";
import { BrowseFolderButton } from "@/components/ui/browse-folder";
import { ForumLens } from "./ForumLens";
import { MessageComponent } from "./Gallery";
import { MoreHorizontal } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { replyCounts, replyLabel } from "@/lib/threads";
import { queuedLine } from "@/lib/when";
import { cn } from "@/lib/cn";
import { roomLead } from "@/lib/roomLead";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { usePageVisible } from "@/lib/pageVisible";
import { handoffsIn, namesLine, unsaid, type Handoff, type StreamMark } from "@/lib/roomVoices";
import { BLOK_COLORS, type BlokColor } from "@/lib/mascot";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHoldPlace } from "@/lib/useHoldPlace";
import { foldHolding, foldRoom, lastFoldKey, rowsFrom } from "@/lib/turnFold";
import { confirm } from "@/components/ui/confirm";
import { onAsk, peekRoomAsk, takeAsk } from "@/lib/chatAsk";

/** A reaction in a room is the cheapest thing anyone can say, and often
 * the right thing: agreeing with a plan should not wake six agents. */
function deleteRoomMessage(roomId: string, messageId: string) {
  void api(`/api/threads/${roomId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
}

function reactTo(roomId: string, messageId: string, emoji: string) {
  void api(`/api/threads/${roomId}/messages/${messageId}/react`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  }).catch(() => {});
}

/** Where a room message said in a linked chat came from, for the strip. */
const CHANNEL_NAMES: Partial<Record<NonNullable<Message["via"]>, string>> = {
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
};

/** A member's last words in the room, which its stream is cut after. */
function lastWordsOf(said: readonly Message[], botId: string): { id: string; text: string } | undefined {
  for (let i = said.length - 1; i >= 0; i--) {
    const m = said[i];
    if (m.role === "bot" && m.from === botId && m.kind === "text" && !m.deleted && m.text) return { id: m.id, text: m.text };
  }
  return undefined;
}

/** The lead, then everyone else in the room's own order: the chart the
 * room was made from, read left to right. */
function byLead(members: readonly Bot[], lead: Bot | null): Bot[] {
  return lead ? [lead, ...members.filter((m) => m.id !== lead.id)] : [...members];
}

/** A face's own corners, for the ring drawn just outside them: a photo
 * is round, a blok is a square with soft corners. */
function ringShape(bot: Bot) {
  return bot.avatarAt ? "rounded-full" : "rounded-[9px]";
}

const SETTLE = [0.23, 1, 0.32, 1] as const;
/** The brief wash behind a message you were sent to, the chat's own: a
 * little wider than its row, behind the words, faded in and out rather
 * than painted, so it costs no layout. */
function LandMark({ on }: { on: boolean }) {
  return (
    <AnimatePresence>
      {on && (
        <motion.span
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.15, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: 0.28, ease: "easeOut" } }}
          className="pointer-events-none absolute -inset-x-2 -inset-y-1 -z-10 rounded-xl bg-warning/12"
        />
      )}
    </AnimatePresence>
  );
}

/** How many faces the header shows before it counts the rest. */
const FACES = 6;

/**
 * Who is in the room, in the header, and who is speaking right now.
 *
 * A member taking its turn here wears a soft ring in its own colour that
 * breathes while it works. It loops for as long as the turn runs, so
 * it stops when nobody can see it: the window is
 * hidden, the header is out of view, or motion is turned down, which
 * leaves the ring still and lit. The lead wears a small crown, and what
 * that means is in its tooltip.
 */
function RoomPresence({
  members,
  lead,
  working,
  leadOnly,
}: {
  members: Bot[];
  lead: Bot | null;
  working: Bot[];
  leadOnly: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const visible = usePageVisible();
  const reduced = useReducedMotion();
  const breathe = inView && visible && !reduced;
  const ordered = byLead(members, lead);
  const shown = ordered.slice(0, ordered.length > FACES ? FACES - 1 : FACES);
  const more = ordered.length - shown.length;
  return (
    <TooltipProvider delayDuration={300}>
      <div ref={ref} role="group" aria-label="Members" className="mr-1 hidden items-center gap-1.5 sm:flex">
        {shown.map((m) => {
          const crowned = m.id === lead?.id && members.length > 1;
          const live = working.some((w) => w.id === m.id);
          const tint = BLOK_COLORS[m.color as BlokColor] ?? "var(--brand)";
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={`${m.name}${crowned ? ", lead" : ""}${live ? ", working" : ""}`}
                  className="relative flex shrink-0"
                >
                  <AnimatePresence initial={false}>
                    {live && (
                      <motion.span
                        key="ring"
                        aria-hidden
                        className={cn("pointer-events-none absolute -inset-[3px]", ringShape(m))}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.2, ease: SETTLE }}
                      >
                        <motion.span
                          className={cn("absolute inset-0 border-2", ringShape(m))}
                          style={{ borderColor: tint }}
                          animate={breathe ? { opacity: [0.9, 0.35, 0.9], scale: [1, 1.08, 1] } : { opacity: 0.8, scale: 1 }}
                          transition={breathe ? { duration: 2.2, ease: "easeInOut", repeat: Infinity } : { duration: 0.2 }}
                        />
                      </motion.span>
                    )}
                  </AnimatePresence>
                  <AgentAvatar bot={m} size={26} />
                  {crowned && (
                    <span
                      aria-hidden
                      className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-brand-ink text-brand-foreground ring-2 ring-background"
                    >
                      <Crown size={8} strokeWidth={2.4} />
                    </span>
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px] text-center">
                {crowned ? `${m.name} leads and has the final call` : m.name}
                {crowned && leadOnly && (
                  <span className="block font-normal opacity-75">Answers unless you @name someone</span>
                )}
                {live && <span className="block font-normal opacity-75">Working now</span>}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {more > 0 && (
          <span
            title={ordered.slice(shown.length).map((m) => m.name).join(", ")}
            className="flex h-[26px] min-w-[26px] items-center justify-center rounded-[9px] bg-muted px-1 text-caption font-medium tabular-nums text-muted-foreground"
          >
            +{more}
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}

/** One member passing the turn to another, where the other's answer
 * begins. Pressed, it brings back the message that did it. */
function HandoffLine({ from, to, ask, onOpen }: { from: string; to: string; ask: string; onOpen: () => void }) {
  return (
    // a little more room above than below: it opens what follows rather
    // than closing what came before
    <div className="mt-1.5 flex pl-9">
      <button
        onClick={onOpen}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-small text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <span className="shrink-0 font-medium text-foreground/80">{from}</span>
        <span aria-hidden className="shrink-0">→</span>
        <span className="sr-only">to</span>
        <span className="shrink-0 font-medium text-foreground/80">
          {to}
          {ask && ":"}
        </span>
        {ask && <span className="truncate">{ask}</span>}
      </button>
    </div>
  );
}

/** A member's reply while it is still arriving, where it will land and
 * drawn as it will be, so the finished message takes its place without
 * a jump. The caret is the stream's own (styles.css, .streaming-text). */
function LiveWords({ bot, text, showSpeaker, mentions }: { bot: Bot; text: string; showSpeaker: boolean; mentions: string[] }) {
  return (
    <GroupMessage
      mine={false}
      first={showSpeaker}
      last={false}
      face={<AgentAvatar bot={bot} size={28} />}
      name={bot.name}
      at={Date.now()}
      rich={text.length > 400 || richText(text)}
      bubble={
        <div className="streaming-text min-w-0">
          <Markdownish text={text} mentions={mentions} streaming />
        </div>
      }
    />
  );
}

/** Everyone at work with nothing to read yet, said once: "Ada and Ben
 * are working". Their faces sit where a speaker's face does, so the line
 * reads as theirs. */
function WorkingLine({ bots }: { bots: Bot[] }) {
  return (
    <div role="status" className="flex animate-fade-in items-center gap-2.5 text-small text-muted-foreground">
      <span className="flex w-7 shrink-0 justify-end -space-x-1">
        {bots.slice(0, 3).map((b) => (
          <AgentAvatar key={b.id} bot={b} size={16} className="rounded-[5px] ring-2 ring-background" />
        ))}
      </span>
      <span className="min-w-0 truncate">
        {namesLine(bots.map((b) => b.name))} {bots.length === 1 ? "is" : "are"} working
      </span>
    </div>
  );
}

/**
 * A room nobody has spoken in yet. The opening line the server writes
 * ("Room opened with ...") says who is here and how to reach them; this
 * says the same with faces, and each face is a way to name that member.
 */
function RoomWelcome({
  name,
  members,
  lead,
  leadOnly,
  onMention,
}: {
  name: string;
  members: Bot[];
  lead: Bot | null;
  leadOnly: boolean;
  onMention: (name: string) => void;
}) {
  const others = members.filter((m) => m.id !== lead?.id).map((m) => m.name);
  return (
    <div className="mx-auto flex min-h-full max-w-[var(--transcript-width,760px)] flex-col items-center justify-center px-2 py-12 text-center">
      <div className="flex items-end gap-2">
        {members.map((m, i) => (
          <motion.span
            key={m.id}
            className="relative"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: Math.min(i, 4) * 0.025, ease: SETTLE }}
          >
            <AgentAvatar bot={m} size={m.id === lead?.id ? 44 : 36} />
            {m.id === lead?.id && (
              <span
                aria-hidden
                className="absolute -right-1.5 -top-1.5 flex size-[18px] items-center justify-center rounded-full bg-brand-ink text-brand-foreground ring-2 ring-background"
              >
                <Crown size={10} />
              </span>
            )}
          </motion.span>
        ))}
      </div>
      <h2 className="mt-5 text-title font-semibold text-foreground">{name}</h2>
      <p className="mt-1 max-w-[360px] text-pretty text-body leading-relaxed text-muted-foreground">
        {lead
          ? `${lead.name} leads, with ${namesLine(others)}.`
          : `${namesLine(members.map((m) => m.name))} ${members.length === 1 ? "is" : "are"} here.`}
      </p>
      <div className="mt-5 flex max-w-[420px] flex-wrap justify-center gap-1.5">
        {members.map((m) => (
          <button
            key={m.id}
            onClick={() => onMention(m.name)}
            className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pl-1 pr-2.5 text-small text-foreground transition-[background-color,border-color,scale] duration-150 ease-out hover:border-foreground/20 hover:bg-accent active:scale-[0.97]"
          >
            <AgentAvatar bot={m} size={18} className={m.avatarAt ? undefined : "rounded-[5px]"} />@{m.name}
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-[360px] text-pretty text-caption text-muted-foreground">
        {leadOnly && lead
          ? `${lead.name} answers unless you name someone with @.`
          : "Everyone can answer. Name someone with @ to ask just them."}
      </p>
    </div>
  );
}


function RoomMessage({
  message,
  members,
  people,
  ownerName,
  showSpeaker,
  place,
  receipts,
  fresh,
  memberName,
  roomId,
  onReply,
  onForward,
}: {
  message: Message;
  members: Bot[];
  people: RoomPerson[];
  ownerName?: string;
  showSpeaker: boolean;
  /** Where it sits in its sender's run: a room is always a group, so
   * every message is a bubble (src/lib/participants.ts). */
  place: { first: boolean; last: boolean };
  receipts?: React.ReactNode;
  fresh?: boolean;
  /** A workspace member's name: in a room open to everyone, members are
   * in it without a membership of their own, so the room's list alone
   * does not name them. */
  memberName?: (id: string) => string;
  roomId: string;
  onReply: (draft: ReplyDraft) => void;
  onForward: (message: Message, author: string) => void;
}) {
  const names = [...members.map((m) => m.name), ...people.map((p) => p.name), ...(ownerName ? [ownerName] : [])];
  const speaker = message.from ? members.find((m) => m.id === message.from) : null;
  const nameOfReactor = (id: string) =>
    id === "user" ? "You" : (members.find((m) => m.id === id)?.name ?? "An agent");
  // where nothing hovers, a tap on the words shows the row
  const tap = useTapToShow();

  // The verbs float on the bubble's top edge on hover, with its time,
  // so a hover moves nothing and a run stays close together.
  const verbs = (author: string) => (
    <MessageActionBar
      look="pill"
      at={message.at}
      open={tap.open}
      message={message}
      author={author}
      onReply={onReply}
      onForward={onForward}
      onReact={(emoji) => reactTo(roomId, message.id, emoji)}
      onDelete={() => deleteRoomMessage(roomId, message.id)}
    />
  );
  const reactions = (
    <Reactions
      reactions={message.reactions}
      onToggle={(emoji: string) => reactTo(roomId, message.id, emoji)}
      nameOf={nameOfReactor}
    />
  );

  if (message.deleted) {
    return (
      <div className={cn("flex", message.role === "user" ? "justify-end" : "justify-start pl-9")}>
        <div className="rounded-2xl border border-dashed px-3 py-1.5 text-body italic text-muted-foreground">
          Message taken back
        </div>
      </div>
    );
  }

  // somebody else in the room: on the left, named, with their face
  if (message.role === "user" && message.author) {
    const who = memberName?.(message.author) ?? people.find((p) => p.id === message.author)?.name ?? "A former member";
    return (
      <GroupMessage
        mine={false}
        first={place.first}
        last={place.last}
        face={<PersonAvatar id={message.author} name={who} />}
        name={who}
        at={message.at}
        readId={message.id}
        rowRef={tap.row}
        onPointerUp={tap.onPointerUp}
        className={cn(fresh && "animate-receive-in")}
        bubble={
          <>
            {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
            <Markdownish text={message.text ?? ""} mentions={names} />
          </>
        }
        under={reactions}
        actions={verbs(who)}
        receipts={receipts}
      />
    );
  }

  // your own words: on your side, in your accent
  if (message.role === "user") {
    return (
      <GroupMessage
        mine
        first={place.first}
        last={place.last}
        at={message.at}
        readId={message.id}
        rowRef={tap.row}
        onPointerUp={tap.onPointerUp}
        className={cn(fresh && "animate-send-in")}
        bubbleClassName="whitespace-pre-wrap"
        bubble={
          <>
            {message.replyTo && <ReplyContext replyTo={message.replyTo} onAccent />}
            <UserText text={message.text ?? ""} />
          </>
        }
        under={
          <>
            {reactions}
            {message.deliveredAt && (
              <div className="mt-0.5 px-1 text-caption leading-4 tabular-nums text-muted-foreground">
                {queuedLine(message.queuedAt ?? message.at, message.deliveredAt)}
              </div>
            )}
          </>
        }
        actions={verbs("You")}
        receipts={receipts}
      />
    );
  }

  if (message.kind === "notice" && message.sessionReset) return <Notice message={message} />;

  if (message.kind === "notice" && (message.event || message.compaction)) {
    return <div className="py-1 text-center text-small text-muted-foreground">{message.text}</div>;
  }

  if (message.kind === "notice" && message.intent) {
    return (
      <div className="pl-9">
        <IntentNote message={message} />
      </div>
    );
  }

  // what failed in the room, put to the person (server/incidents.ts)
  if (message.kind === "notice" && message.incident && message.incident.kind !== "note") {
    return (
      <div className="pl-9">
        <IncidentNotice message={message} />
      </div>
    );
  }

  if (message.kind === "notice") {
    return (
      <div className="flex gap-2.5 pl-9">
        <div className="flex max-w-[560px] gap-2 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="whitespace-pre-wrap text-body leading-relaxed text-foreground">
            {message.text}
            <CarryOn message={message} />
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "artifact" && message.artifact) {
    return (
      <div className="pl-9">
        <ArtifactCard botId={message.from ?? ""} artifact={message.artifact} />
      </div>
    );
  }


  // the room's own opening line has no speaker
  if (!speaker) {
    return (
      <div className="py-1 text-center text-small text-muted-foreground">{message.text}</div>
    );
  }

  // a card asks or reports rather than says: it keeps its own shape,
  // lined up with the bubbles, under the agent's name
  if (message.kind === "changes" || message.kind === "options") {
    return (
      <div className="flex gap-2">
        <div className="w-7 shrink-0 pt-0.5">{showSpeaker && <AgentAvatar bot={speaker} size={28} />}</div>
        <div className="min-w-0 flex-1">
          {showSpeaker && <div className="mb-1 px-1 text-small font-medium text-muted-foreground">{speaker.name}</div>}
          {message.kind === "changes" ? (
            <ChangesCard message={message} />
          ) : (
            // an agent can need you mid-room; the ask has to be answerable here
            <OptionCard botId={speaker.id} roomId={roomId} message={message} />
          )}
        </div>
      </div>
    );
  }

  const ui = message.kind === "component" && message.component;
  return (
    <GroupMessage
      mine={false}
      first={place.first}
      last={place.last}
      face={<AgentAvatar bot={speaker} size={28} />}
      name={speaker.name}
      at={message.at}
      rich={Boolean(ui) || richText(message.text ?? "")}
      readId={message.id}
      rowRef={ui ? undefined : tap.row}
      onPointerUp={ui ? undefined : tap.onPointerUp}
      className={cn(fresh && "animate-fade-in")}
      bubble={
        ui ? (
          <MessageComponent message={message} threadId={roomId} />
        ) : (
          <>
            {message.replyTo && <ReplyContext replyTo={message.replyTo} />}
            {/* a click in the answer goes back to this agent, in this room */}
            <GenUiHost target={{ kind: "room", roomId, agentName: speaker.name }}>
              <Markdownish text={message.text ?? ""} mentions={names} />
            </GenUiHost>
          </>
        )
      }
      under={ui ? undefined : reactions}
      actions={ui ? undefined : verbs(speaker.name)}
      receipts={receipts}
    />
  );
}

export function RoomView({ blok }: { blok: Blok }) {
  const { state, dispatch } = useStore();
  // One view per room (App keys it). The box (room/RoomComposer.tsx)
  // keeps its own words and files for the room; the view keeps the
  // reply being written, since a message's own row starts it.
  const [closing, setClosing] = useState(false);
  // Two ways to read the same transcript. A device preference rather than
  // a room setting: which one helps depends on what you are doing, not on
  // which room you are in.
  const [lens, setLens] = useState<"stream" | "forum">(
    () => (localStorage.getItem("bloks-room-lens") === "forum" ? "forum" : "stream"),
  );
  useSettingsObservation({ "room.lens": { status: "observed", value: lens } });
  const setLensAnd = (next: "stream" | "forum") => {
    setLens(next);
    try {
      localStorage.setItem("bloks-room-lens", next);
    } catch {
      /* private mode: the choice still holds for this session */
    }
  };
  const [highlightId, setHighlightId] = useState<string | null>(null);

  const [sharingOpen, setSharingOpen] = useState(false);
  const [ownerName, setOwnerName] = useState<string | undefined>(undefined);
  const roomPeople = state.roomPeople[blok.id] ?? [];
  const knocking = state.joinRequests[blok.id] ?? 0;
  // the last person seen typing, for a few seconds
  const typing = state.roomTyping[blok.id];
  const [, tick] = useState(0);
  const typingNow = typing && Date.now() - typing.at < 6_000 ? typing.name : null;
  useEffect(() => {
    if (!typing) return;
    const timer = setTimeout(() => tick((n) => n + 1), 6_100);
    return () => clearTimeout(timer);
  }, [typing]);

  // Who is in a shared room, fetched once here and kept current by the
  // room.people frames the server sends when it changes.
  useEffect(() => {
    if (!blok.sharing) return;
    api(`/api/bloks/${blok.id}/people`)
      .then((next: { people: RoomPerson[]; hostName: string; invites: Array<{ claim?: unknown }> }) => {
        dispatch({ type: "roomPeople", roomId: blok.id, people: next.people });
        setOwnerName(next.hostName);
        dispatch({ type: "joinRequest", roomId: blok.id, pending: next.invites.filter((i) => i.claim).length });
      })
      .catch(() => {});
  }, [blok.id, blok.sharing, dispatch]);

  const members = blok.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter(Boolean) as Bot[];
  // Who is in the room and who can answer are two different lists. An
  // archived member keeps its place, so an old transcript still names
  // somebody, but the roster and the crown and the mention list all
  // describe the present.
  const answering = members.filter((m) => !m.archivedAt);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [forwarding, setForwarding] = useState<{ message: Message; author: string } | null>(null);
  const [showRoutines, setShowRoutines] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // The crown goes to whoever the server would actually route to: the
  // member crowned for this room, or the most senior, of those who can
  // answer.
  const lead = roomLead(answering, blok.leadId);
  // thinking here, not just busy: a member at work in another
  // conversation is not about to answer this room
  const working = members.filter((m) => workingInRoom(m, blok.id));

  // The room's conversation, and what waits behind the round it is in,
  // above the composer until it goes (GitHub 170).
  const { said, waiting } = useMemo(() => splitWaiting(blok.messages), [blok.messages]);
  const earlier = useHistoryPaging("room", { ...blok, threadId: blok.id }, said, scrollRef, pinned, lens === "stream" && !highlightId);
  const start = earlier.start;
  // which messages have answers hanging off them, for the stream's hint
  const counts = replyCounts(said);

  // A room is a group: every message a bubble, a run from one sender as
  // one, and with people in it, who has read how far
  // (src/lib/participants.ts, src/lib/readReceipts.ts).
  const roster = useWorkspaceRoster();
  // everyone by the name the room calls them, guests included, told apart
  // where two share a first name (src/lib/names.ts)
  const nameOf = useNamer(roomPeople);
  const personName = (id: string) => nameOf(id, "A former member");
  const isBubble = (m: Message) =>
    !m.deleted && (m.role === "user" || (Boolean(m.from) && (m.kind === "text" || m.kind === "component")));
  const roomRuns = useMemo(() => runs(said, isBubble), [said]); // eslint-disable-line react-hooks/exhaustive-deps
  const withPeople = roomPeople.length > 0 || roster.members.length > 0;
  const reads = useReads(withPeople ? blok.id : null);
  useEffect(() => {
    if (!withPeople) return;
    api(`/api/threads/${blok.id}/reads`)
      .then((r: { reads?: unknown }) => seedReads(blok.id, r.reads))
      .catch(() => {});
  }, [withPeople, blok.id]);
  useReadPosition({
    threadId: withPeople ? blok.id : null,
    scroller: scrollRef,
    enabled: withPeople && lens === "stream",
    post: (threadId, messageId) => api(`/api/threads/${threadId}/read`, { method: "POST", body: JSON.stringify({ messageId }) }),
    tick: said.length,
  });
  const receiptRows = useMemo(
    () => (withPeople ? receiptsAt(said.map((m) => m.id), new Set(roomRuns.keys()), reads, "owner", new Map(said.map((m) => [m.id, senderOf(m)]))) : new Map<string, string[]>()),
    [withPeople, said, roomRuns, reads],
  );
  const readerName = (id: string) =>
    id === "owner" ? (ownerName ?? roster.owner ?? "You") : personName(id);
  const receiptsFor = (id: string) => {
    const who = receiptRows.get(id);
    return who?.length ? <SeenBy people={who.map((p) => ({ id: p, name: readerName(p) }))} /> : undefined;
  };
  // Each agent's finished turn is one line above its reply
  // (src/lib/turnFold.ts). A room's transcript does not say where a turn
  // began, so where one seen starting began is kept here: nothing of it
  // folds while it runs, whoever else speaks meanwhile. One already
  // running when the room was opened has no such place (null).
  const liveFrom = useRef<Map<string, number | null> | null>(null);
  const seen = liveFrom.current;
  const live = new Map<string, number | null>();
  for (const m of working) live.set(m.id, seen ? (seen.has(m.id) ? (seen.get(m.id) ?? null) : said.length) : null);
  // Room history can arrive before the initial agent list. Those workers
  // were not observed starting here, so keep their boundary unknown.
  liveFrom.current = state.hydrated ? live : null;
  const liveKey = [...live].map(([id, since]) => `${id}:${since}`).join(" ");
  const folded = useMemo(() => foldRoom(said, live, !blok.olderMessages), [said, liveKey, blok.olderMessages]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleRows = useMemo(() => rowsFrom(folded.rows, start), [folded, start]);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());

  // Who handed what to whom, read the way the server reads a mention
  // (src/lib/roomVoices.ts). Everyone ever in the room counts, so a
  // handoff to a member since archived still reads as one.
  const memberKey = members.map((m) => `${m.id}:${m.name}`).join(" ");
  const handoffs = useMemo(() => handoffsIn(said, members), [said, memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each member's words as they arrive, under its name. The stream is
  // kept per lane, and a lane says which room its turn speaks in while it
  // runs; the part that already landed here is cut off the front
  // (unsaid). Where each lane was cut is kept between renders.
  const streamMarks = useRef(new Map<string, StreamMark>());
  const voices: Array<{ bot: Bot; text: string }> = [];
  const streamingLanes = new Set<string>();
  for (const m of working) {
    const lane = m.tasks?.find((t) => t.room === blok.id)?.id;
    const stream = lane ? state.streaming[lane] : undefined;
    if (!lane || !stream) continue;
    streamingLanes.add(lane);
    const next = unsaid(stream, lastWordsOf(said, m.id), streamMarks.current.get(lane));
    streamMarks.current.set(lane, next.mark);
    if (next.text) voices.push({ bot: m, text: next.text });
  }
  for (const lane of [...streamMarks.current.keys()]) if (!streamingLanes.has(lane)) streamMarks.current.delete(lane);
  const mentionNames = [
    ...members.map((m) => m.name),
    ...roomPeople.map((p) => p.name),
    ...(blok.sharing && ownerName ? [ownerName] : []),
  ];
  // at work with nothing to read yet: one line says who
  const quiet = working.filter((m) => !voices.some((v) => v.bot.id === m.id));

  // ── landing on a message ──
  // A handoff line pressed, a topic found in the stream, or a message
  // picked in the palette: the message is drawn (the whole room when it
  // is above what is drawn, its fold opened when it is under one), then
  // brought into view once it is on the page, and lit for a moment so
  // the eye knows which line it was sent to.
  const [landing, setLanding] = useState<{ id: string; nonce: number } | null>(null);
  const landed = useRef<number | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const land = (messageId: string, whole: boolean) => {
    const index = said.findIndex((m) => m.id === messageId);
    pinned.current = false;
    if (whole || (index !== -1 && index < start)) earlier.showAll();
    const fold = foldHolding(folded.rows, index);
    if (fold) setOpenFolds((open) => new Set(open).add(fold));
    setLanding({ id: messageId, nonce: Date.now() });
  };
  useEffect(() => {
    if (!landing || landed.current === landing.nonce) return;
    const el = scrollRef.current;
    const row = el?.querySelector(`[data-room-msg="${landing.id}"]`);
    if (!el || !row) return;
    landed.current = landing.nonce;
    pinned.current = false;
    // From far away at once, since a long glide is only waiting. From
    // the very end at once too: the first steps of a glide up from there
    // are still close enough to the end to read as following it, and the
    // room would be taken straight back down.
    const far = Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top) > el.clientHeight * 2;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    row.scrollIntoView({ block: "center", behavior: far || atEnd || reduced ? "auto" : "smooth" });
    setFlashId(landing.id);
  });
  // the light is a moment, not a state
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId, landing]);
  const openHandoff = (handoff: Handoff) => land(handoff.sourceId, false);

  // Asks from outside, the palette's (src/lib/chatAsk.ts): taken once
  // the message is in hand, and one further back than what has arrived
  // is paged in until it is.
  const [askTick, setAskTick] = useState(0);
  useEffect(() => onAsk(() => setAskTick((n) => n + 1)), []);
  useEffect(() => {
    const ask = peekRoomAsk(blok.id);
    if (!ask) return;
    if (said.some((m) => m.id === ask.messageId)) {
      takeAsk(ask);
      // a message is found in the stream, where it can be answered
      if (lens === "forum") setLensAnd("stream");
      land(ask.messageId, false);
    } else if (earlier.remaining > 0 && !earlier.loading) {
      earlier.showEarlier();
    }
  }, [askTick, blok.id, said, earlier.remaining, earlier.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const handoffLine = (handoff: Handoff) => (
    <HandoffLine
      key={`handoff:${handoff.sourceId}:${handoff.toId}`}
      from={members.find((b) => b.id === handoff.fromId)?.name ?? "An agent"}
      to={members.find((b) => b.id === handoff.toId)?.name ?? "an agent"}
      ask={handoff.ask}
      onOpen={() => openHandoff(handoff)}
    />
  );

  // A room with nothing in it yet but its opening line: a welcome, with
  // the members and how to reach one of them. A first message waiting for
  // your hosted workspace to wake is something in it already.
  const wake = useWake();
  const held = heldToShow(useHeldSends(`room:${blok.id}`), { waking: wake.waking, hosted: isHostedWindow() }, said, waiting);
  const fresh =
    lens === "stream" &&
    !blok.olderMessages &&
    !working.length &&
    !waiting.length &&
    !held.length &&
    said.every((m) => m.role === "bot" && !m.from && m.kind === "text");
  /** Puts @name in the box, for a member picked on the welcome. */
  const [mentionAsk, setMentionAsk] = useState<{ name: string; nonce: number } | null>(null);
  const mention = (name: string) => setMentionAsk({ name, nonce: Date.now() });

  const { away, toLatest } = useStickToBottom(scrollRef, pinned);
  // What stood at the end the last time the reader was following it.
  // What anyone else says after that, while they read further up, is
  // what the way back counts as new: a member's words, or a person's in
  // a shared room, and never a tool call or a notice.
  const seenThrough = useRef<string | undefined>(undefined);
  if (pinned.current) seenThrough.current = said[said.length - 1]?.id;
  const seenAt = seenThrough.current ? said.findIndex((m) => m.id === seenThrough.current) : -1;
  const freshBelow =
    !away || seenAt < 0
      ? 0
      : said
          .slice(seenAt + 1)
          .filter((m) => !m.deleted && (m.role === "bot" ? Boolean(m.from) && (m.kind === "text" || m.kind === "options") : Boolean(m.author)))
          .length;

  // When a turn ends its work folds, and the reply stays where it is on
  // screen for a reader who is not at the end. After the effect above:
  // that one adds to where the reader is, and this one then finds the
  // reply already in place.
  useHoldPlace(
    scrollRef,
    pinned,
    blok.id,
    lastFoldKey(folded.rows),
    folded.hold ? `[data-room-msg="${folded.hold.message.id}"]` : null,
  );
  // Opening a fold leaves its line where it was pressed. At the end of
  // the room, following the end would scroll the line away instead.
  const toggleFold = (key: string) => {
    pinned.current = false;
    setOpenFolds((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  useEffect(() => {
    if (!pinned.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blok.id, said.length, waiting.length, working.length, voices.length]);

  // Named rather than inline, because the header shows them as buttons on
  // a desktop and as menu items on a phone, and the two must not drift.
  const saveToLibrary = () => {
    // Banking the room in the library makes it repeatable: the same roles
    // can be hired again as a fresh team later.
    if (justSaved) return;
    api(`/api/bloks/${blok.id}/manifest`)
      .then((manifest) =>
        api("/api/team-library", {
          method: "POST",
          body: JSON.stringify({ name: blok.name, members: manifest.members }),
        }),
      )
      .then(() => {
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 1600);
      })
      .catch(() => {});
  };

  const exportManifest = () => {
    // The manifest is the room's roles as a file, for handing to someone
    // else. It downloads rather than opens: the point is to leave with it.
    // A Markdown team file (server/team-file.ts): readable, editable, and
    // what the gallery on bloks.dev is made of.
    fetch(`/api/bloks/${blok.id}/team.md`)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => {
        const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${blok.name.replace(/[^\w-]+/g, "-").toLowerCase() || "team"}.team.md`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => {});
  };

  // Seniority is the agent's in every room; the crown is this room's own.
  // The header follows the server's frame, so nothing moves until it lands.
  const makeLead = (id: string | null) => {
    api(`/api/bloks/${blok.id}`, {
      method: "PATCH",
      body: JSON.stringify({ leadId: id }),
    }).catch((e: Error) => dispatch({ type: "error", message: e.message }));
  };

  const toggleLeadOnly = () => {
    api(`/api/bloks/${blok.id}`, {
      method: "PATCH",
      body: JSON.stringify({ leadOnly: !blok.leadOnly }),
    }).catch(() => {});
  };

  // One stretch of the room as its rows: what stays in the open, or a
  // fold's work once it is opened. Who spoke last and a run of tool calls
  // are read within the stretch, since rows with a fold between them are
  // not next to each other on the page.
  //
  // A handoff line goes in front of the first row at or past where its
  // member's answer begins. Each is placed once a render, so a fold that
  // opens does not draw again the one already drawn above its line.
  const handoffAt = [...handoffs.placed.keys()].filter((i) => i >= start).sort((a, b) => a - b);
  const handoffsDrawn = new Set<number>();
  const handoffsBefore = (index: number) => {
    const lines = [];
    for (const at of handoffAt) {
      if (at > index) break;
      if (handoffsDrawn.has(at)) continue;
      handoffsDrawn.add(at);
      lines.push(...(handoffs.placed.get(at) ?? []).map(handoffLine));
    }
    return lines;
  };
  const rowsOf = (list: readonly Message[], indices: readonly number[]) =>
    list.flatMap((m, i) => {
      const prev = list[i - 1];
      // one member's run of tool calls reads as one line
      if (m.kind === "activity" && m.tool) {
        if (prev?.kind === "activity" && prev.from === m.from && !prev.deleted) return [];
        const run: Message[] = [];
        for (let j = i; j < list.length; j++) {
          const next = list[j];
          if (next.kind !== "activity" || next.from !== m.from || next.deleted || !next.tool) break;
          run.push(next);
        }
        return [...handoffsBefore(indices[i]), <ToolRun key={m.id} messages={run} className="pl-9" />];
      }
      const showSpeaker = !prev || prev.from !== m.from || prev.role !== m.role;
      const answers = replyLabel(counts.get(m.id) ?? 0);
      const lit = flashId === m.id;
      return [
        ...handoffsBefore(indices[i]),
        <div key={m.id} data-room-msg={m.id} className={cn("relative isolate", roomRuns.get(m.id)?.first === false && "-mt-1.5")}>
          <LandMark on={lit} />
          <RoomMessage
            message={m}
            members={members}
            people={roomPeople}
            ownerName={blok.sharing ? ownerName : undefined}
            showSpeaker={showSpeaker}
            place={roomRuns.get(m.id) ?? { first: showSpeaker, last: true }}
            receipts={receiptsFor(m.id)}
            memberName={personName}
            roomId={blok.id}
            onReply={setReplyTo}
            onForward={(message, author) => setForwarding({ message, author })}
          />
          {answers && (
            <button
              onClick={() => setLensAnd("forum")}
              className="ml-9 mt-0.5 rounded-md px-1.5 py-0.5 text-small text-brand-ink transition-colors duration-150 hover:bg-accent"
            >
              {answers}
            </button>
          )}
        </div>,
      ];
    });

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="titlebar-drag flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-3 max-md:pl-16 md:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Users size={15} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-ui font-semibold text-foreground">{blok.name}</span>
            {/* the lead first, crowned, so a phone without the faces on
                the right still says who has the final call */}
            <span className="flex min-w-0 items-center gap-1 text-small text-muted-foreground">
              {lead && answering.length > 1 && <Crown size={11} className="shrink-0 text-brand-ink" aria-label="Lead" />}
              <span className="truncate">
                {byLead(answering, lead).map((m) => m.name).join(", ")}
                {answering.length < members.length &&
                  ` · ${members.length - answering.length} archived`}
              </span>
            </span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RoomPresence members={answering} lead={lead} working={working} leadOnly={Boolean(blok.leadOnly)} />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSharingOpen(true)}
            className={cn("relative", blok.sharing && "text-foreground")}
            title={blok.sharing ? `Shared with ${roomPeople.length} ${roomPeople.length === 1 ? "person" : "people"}` : "Share room"}
            aria-label={blok.sharing ? `Shared with ${roomPeople.length} ${roomPeople.length === 1 ? "person" : "people"}` : "Share room"}
          >
            <UserPlus size={16} />
            {knocking > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-brand-ink px-1 text-micro font-semibold leading-4 text-brand-foreground">
                {knocking}
              </span>
            )}
          </Button>
          <RoomFolderButton blok={blok} />
          <GroupCallButton blok={blok} members={answering} />
          {/* What you reach for while reading stays in the header: people,
              the folder, a call and how to read it. Tidying the room
              (routines, saving or exporting the team, lead-only, closing
              it) is a menu, at every width, so the header never becomes a
              toolbar of look-alike icons. */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLensAnd(lens === "stream" ? "forum" : "stream")}
            className={cn(lens === "forum" && "bg-accent text-foreground")}
            title={
              lens === "stream"
                ? "View as topics"
                : "View in order"
            }
          >
            {lens === "stream" ? <MessagesSquare size={16} /> : <Rows3 size={16} />}
          </Button>
          <RoomMenu
            blok={blok}
            justSaved={justSaved}
            onRoutines={() => setShowRoutines(true)}
            onSave={saveToLibrary}
            onExport={exportManifest}
            onLeadOnly={toggleLeadOnly}
            members={answering}
            lead={lead}
            onLead={makeLead}
            onClose={() => setClosing(true)}
          />
        </div>
      </div>

      <SharePanel blok={blok} open={sharingOpen} onOpenChange={setSharingOpen} />

      {closing && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setClosing(false)}
        >
          <div
            className="w-[400px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-4 shadow-2xl sm:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lead font-semibold text-foreground">
              Close {blok.name}?
            </div>
            <p className="mt-1 text-body leading-relaxed text-muted-foreground">
              Archiving keeps everything, and you can restore it later. Deleting cannot be undone.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                onClick={() => {
                  dispatch({ type: "patchRoom", blokId: blok.id, patch: { archived: true } });
                  setClosing(false);
                }}
              >
                Archive room
              </Button>
              <Button
                variant="secondary"
                className="text-destructive"
                onClick={() => {
                  // the second decision, in its own words, naming the room
                  void confirm({
                    title: `Delete ${blok.name} and its whole transcript?`,
                    body: "This cannot be undone. Archive it instead to keep it.",
                    confirmLabel: "Delete",
                    destructive: true,
                  }).then((yes) => yes && dispatch({ type: "deleteRoom", blokId: blok.id }));
                }}
              >
                Delete permanently
              </Button>
              <Button variant="ghost" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={earlier.onScroll}
        className="flex-1 overflow-y-auto px-4 md:px-6 [overflow-anchor:none]"
      >
        {lens === "forum" ? (
          <ForumLens
            messages={said}
            members={members}
            people={roomPeople}
            onOpenInStream={(messageId) => {
              setLensAnd("stream");
              setHighlightId(messageId);
              // the stream may be windowed to its tail, so the whole of
              // it is drawn rather than scrolling to something not there
              land(messageId, true);
            }}
          />
        ) : fresh ? (
          <RoomWelcome
            name={blok.name}
            members={byLead(answering, lead)}
            lead={answering.length > 1 ? lead : null}
            leadOnly={Boolean(blok.leadOnly)}
            onMention={mention}
          />
        ) : (
        <div className="mx-auto flex max-w-[var(--transcript-width,760px)] flex-col gap-2 pb-4 pt-3">
          {(start > 0 || earlier.remaining > 0) && (
            <button
              onClick={earlier.showEarlier}
              disabled={earlier.loading}
              className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-small text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:opacity-60"
            >
              {earlier.loading && <Loader2 size={12} className="animate-spin" />}
              Show earlier messages ({start + earlier.remaining} more)
            </button>
          )}
          {visibleRows.flatMap((row) =>
            row.kind === "said"
              ? rowsOf(
                  row.items.map((item) => item.message),
                  row.items.map((item) => item.index),
                )
              : [
                  ...handoffsBefore(Math.min(...row.fold.indices)),
                  <TurnFoldLine
                    key={`fold:${row.fold.key}`}
                    fold={row.fold}
                    open={openFolds.has(row.fold.key)}
                    onToggle={() => toggleFold(row.fold.key)}
                    className="pl-9"
                  >
                    {openFolds.has(row.fold.key) && rowsOf(row.fold.messages, row.fold.indices)}
                  </TurnFoldLine>,
                ],
          )}
          {/* sent while your hosted workspace wakes, faded until it goes */}
          <HeldSends conversation={`room:${blok.id}`} said={said} queued={waiting} group />
          {/* what members are saying right now, each under its own
              name, after the handoff that started it when one did */}
          {voices.flatMap(({ bot, text: words }, i) => {
            const handoff = handoffs.pending.get(bot.id);
            const last = said[said.length - 1];
            const continues = i === 0 && !handoff && last?.role === "bot" && last.from === bot.id;
            return [
              ...(handoff ? [handoffLine(handoff)] : []),
              <LiveWords key={`live:${bot.id}`} bot={bot} text={words} showSpeaker={!continues} mentions={mentionNames} />,
            ];
          })}
          {quiet.flatMap((m) => {
            const handoff = handoffs.pending.get(m.id);
            return handoff ? [handoffLine(handoff)] : [];
          })}
          {quiet.length > 0 && <WorkingLine bots={quiet} />}
          {typingNow && (
            <div className="flex items-center gap-2.5 pl-9 text-small text-muted-foreground">
              <span className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse" />
              {typingNow} is typing
            </div>
          )}
        </div>
        )}
      </div>

      <JumpToLatest show={away && lens === "stream" && !fresh} fresh={freshBelow} onJump={toLatest} />
      </div>

      <RoomComposer
        blok={blok}
        members={members}
        answering={byLead(answering, lead)}
        lead={answering.length > 1 ? lead : null}
        working={working}
        people={roomPeople}
        ownerName={blok.sharing ? ownerName : undefined}
        nameOf={personName}
        waiting={waiting}
        senderOf={(m) =>
          m.role === "bot"
            ? (members.find((b) => b.id === m.from)?.name ?? "An agent")
            : m.author
              ? personName(m.author)
              : m.via
                ? (CHANNEL_NAMES[m.via] ?? "the linked chat")
                : null
        }
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        mentionAsk={mentionAsk}
        // what you send is followed to the end, wherever you were reading:
        // the answers you are now waiting for arrive down there
        onSent={() => {
          if (!pinned.current) toLatest();
        }}
      />
      {forwarding && (
        <ForwardDialog
          message={forwarding.message}
          author={forwarding.author}
          onClose={() => setForwarding(null)}
        />
      )}
      {showRoutines && (
        <RoutinesDialog
          initialTarget={{ id: blok.id, kind: "room" }}
          onClose={() => setShowRoutines(false)}
        />
      )}
    </main>
  );
}


/** The room's shared desk: one folder every member's room turns run in.
 * Settable until the first turn pins it; a chip afterwards. */
function RoomFolderButton({ blok }: { blok: Blok }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(blok.cwd ?? "");
  const [error, setError] = useState<string | null>(null);
  const pinned = blok.pinnedCwd !== undefined;
  const shown = blok.pinnedCwd ?? blok.cwd;

  const save = () => {
    setError(null);
    // straight fetch: a rejected path must not stick in local state
    api(`/api/bloks/${blok.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cwd: draft.trim() || null }),
    })
      .then(() => setOpen(false))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        title={shown ? `Shared folder: ${shown}` : "Shared working folder"}
      >
        <FolderOpen size={16} className={shown ? "text-brand-ink" : undefined} />
      </Button>
      {open && (
        <div className="absolute right-0 top-11 z-30 w-[320px] max-w-[92vw] animate-pop-in rounded-2xl border bg-popover p-3.5 shadow-xl shadow-(color:--shadow-color)">
          <div className="text-body font-semibold text-foreground">Shared working folder</div>
          {pinned ? (
            <>
              <div className="mt-1 break-all text-body text-muted-foreground">
                {blok.pinnedCwd ?? "Each member uses its own folder."}
              </div>
              <div className="mt-1.5 text-small text-muted-foreground/70">
                Set when the room started. Make a new room to use another folder.
              </div>
            </>
          ) : (
            <>
              <div className="mt-1 text-small text-muted-foreground">
                Where members work in this room. Set it before the first task.
              </div>
              <div className="mt-2 flex gap-1.5">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && save()}
                  placeholder="/Users/you/Projects/launch  (empty = own folders)"
                  className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-body text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-ring/60"
                />
                <BrowseFolderButton onPick={setDraft} />
              </div>
              {error && <div className="mt-1.5 text-small text-destructive">{error}</div>}
              <div className="mt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={save}>
                  Save
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The room's management actions, for a window too narrow to show them.
 *
 * Only below sm: a desktop header has room for the buttons and they are
 * quicker there. The same handlers either way, so what the menu does and
 * what the buttons do cannot come apart.
 */
function RoomMenu({
  blok,
  justSaved,
  onRoutines,
  onSave,
  onExport,
  onLeadOnly,
  members,
  lead,
  onLead,
  onClose,
}: {
  blok: Blok;
  justSaved: boolean;
  onRoutines: () => void;
  onSave: () => void;
  onExport: () => void;
  onLeadOnly: () => void;
  /** Those who can answer, the only ones a crown means anything on. */
  members: Bot[];
  lead: Bot | null;
  /** An id crowns that member; null hands the room back to seniority. */
  onLead: (id: string | null) => void;
  onClose: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="More" aria-label="More room actions">
          <MoreHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[210px]">
        <DropdownMenuItem onClick={onRoutines}>
          <CalendarClock size={15} />
          Routines
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSave}>
          {justSaved ? <Check size={15} className="text-success" /> : <BookmarkPlus size={15} />}
          Save this team
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onExport}>
          <Download size={15} />
          Export team file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onLeadOnly}>
          <Crown size={15} />
          {blok.leadOnly ? "Let everyone answer" : "Only the lead answers"}
        </DropdownMenuItem>
        {members.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Lead</DropdownMenuLabel>
            {members.map((m) => (
              <DropdownMenuItem
                key={m.id}
                // choosing the one already crowned by name changes nothing
                onClick={() => m.id !== blok.leadId && onLead(m.id)}
              >
                <AgentAvatar bot={m} size={18} />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {m.id === lead?.id ? (
                  <Crown size={13} className="shrink-0 text-brand-ink" />
                ) : (
                  <span className="shrink-0 text-small text-muted-foreground">Make lead</span>
                )}
              </DropdownMenuItem>
            ))}
            {blok.leadId && lead?.id === blok.leadId && (
              <DropdownMenuItem onClick={() => onLead(null)} className="text-muted-foreground">
                Most senior leads
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onClose} className="text-destructive focus:text-destructive">
          <Trash2 size={15} />
          Archive or delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
