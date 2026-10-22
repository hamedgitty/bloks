import { useSettingsObservation } from "@/lib/useSettingsObservation";
import { useNamer, useWorkspaceRoster } from "@/lib/members";
import { isGroup, otherHumans, receiptsAt, runs, senderOf, speakers, teamHumans } from "@/lib/participants";
import { seedReads, useReadPosition, useReads } from "@/lib/readReceipts";
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { Search } from "@/components/icons";
import { ChevronUp } from "@/components/icons";
import { ChevronDown } from "@/components/icons";
import { Loader2 } from "@/components/icons";
import { Monitor } from "@/components/icons";
import { SquareTerminal } from "@/components/icons";
import { X } from "@/components/icons";
import { api, useStore, laneHasMessages, openLaneWorking, type Bot, type Message } from "@/state/store";
import { AgentAvatar } from "./Avatar";
import { OptionCard } from "./OptionCard";
import { MessageComponent } from "./Gallery";
import { GenUiHost } from "./genui/host";
import { Composer } from "./Composer";
import { useTerminalDock } from "./terminal/TerminalDock";
import { terminalChord } from "@/lib/terminalTabs";
import { lastEditable, quietRunAt, splitWaiting } from "@/lib/transcript";
import { useHistoryPaging } from "@/lib/useHistoryPaging";
import { useLanesInSidebar } from "@/lib/conversationsView";
import { findHits, stepHit } from "@/lib/find";
import { isApproval } from "@/lib/cardAnswer";
import { AnimatePresence, motion } from "motion/react";
import { dayLine, timeSaidBelow } from "@/lib/when";
import { TaskStrip } from "./TaskStrip";
import { GoalDialog } from "./Goal";
import { AfterAgentLink, AgentExchangeDialog, AgentExchangeRow } from "./AgentExchange";
import { CallButton } from "./Voice";
import { ArtifactCard } from "./Artifacts";
import { ConnectorCard } from "./ConnectorCard";
import { SecretCard } from "./SecretCard";
import { ChangesCard } from "./ChangesCard";
import { ToolRun } from "./ToolRun";
import { TurnFoldLine } from "./TurnFold";
import { MeetingPanel } from "./MeetingPanel";
import { AudioLines } from "@/components/icons";
import { ForwardDialog, type ReplyDraft } from "./MessageActions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useStickToBottom } from "@/lib/useStickToBottom";
import { useHoldPlace } from "@/lib/useHoldPlace";
import { foldHolding, foldTurns, lastFoldKey, rowsFrom, turnRunning } from "@/lib/turnFold";
import { type RedoPreview } from "@/lib/redo";

import { Bubble, Notice, QuietCheckIns, Rewound, TakenBack } from "./chat/Bubble";
import { GroupMessage, PersonAvatar, SeenBy } from "./chat/Group";
import { Markdownish } from "./Markdown";
import { LiveBrowser, ScreenFrame, StreamingBubble, WorkingClock, WorkingLine } from "./chat/Live";
import { EmptyState } from "./chat/EmptyState";
import { JumpToLatest } from "./chat/JumpToLatest";
import { HeldSends } from "./chat/HeldSends";
import { onAsk, peekAsk, takeAsk } from "@/lib/chatAsk";
import { keysFor, platformOf } from "@/lib/shortcuts";
import { confirm } from "@/components/ui/confirm";
import { createPortal } from "react-dom";
import { useTitlebarSlot } from "@/lib/titlebarSlot";

/**
 * Which messages should animate in: ones that arrive while you're
 * watching, never the backlog when you open a thread. Opening a chat and
 * seeing forty bubbles fly in would be noise, not feedback.
 */
function useArrivals(botId: string, messages: Message[]): Set<string> {
  const seen = useRef<Set<string>>(new Set());
  const [arrivals, setArrivals] = useState<Set<string>>(new Set());

  useEffect(() => {
    // switching threads: adopt the whole transcript silently
    seen.current = new Set(messages.map((m) => m.id));
    setArrivals(new Set());
  }, [botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // a message that waited arrives here when it goes, so it rises into
  // the conversation like anything else said now
  useEffect(() => {
    const fresh = messages.filter((m) => !seen.current.has(m.id)).map((m) => m.id);
    if (!fresh.length) return;
    fresh.forEach((id) => seen.current.add(id));
    setArrivals(new Set(fresh));
  }, [messages]);

  return arrivals;
}

/** Toggling a reaction is a fire and forget write: the server answers
 * with a patched message and the event stream puts it on every screen,
 * so there is nothing local to keep in step. */
function editMessage(threadId: string, messageId: string, text: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

function deleteMessage(threadId: string, messageId: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}`, { method: "DELETE" }).catch(() => {});
}

function reactTo(threadId: string, messageId: string, emoji: string) {
  void api(`/api/threads/${threadId}/messages/${messageId}/react`, {
    method: "POST",
    body: JSON.stringify({ emoji }),
  }).catch(() => {});
}

/** Something the agent said, as the way back counts new ones: not its
 * tool calls, frames or quiet check-ins, which arrive by the dozen. */
const isReply = (m: Message) =>
  m.role === "bot" && !m.quiet && !m.deleted && m.kind !== "activity" && m.kind !== "screen" && m.kind !== "notice";

/** Typed here and sent, rather than said for you by a routine, a goal,
 * a watcher, another agent or someone on Telegram. */
const sentByYou = (m: Message) => m.role === "user" && !m.via && !m.agent && !m.telegramPerson && !m.telegramDelegate && !m.telegramGroup;

/** Somebody on Telegram who is not the owner, let in or given full access. */
const telegramSpeaker = (m: Message) => {
  const sender = m.telegramPerson ?? m.telegramDelegate ?? m.telegramGroup;
  const group = m.telegramPerson?.group ?? m.telegramGroup?.group;
  return sender ? { personId: "personId" in sender ? sender.personId : "owner", name: sender.name + (group ? " in " + group.title : "") } : undefined;
};

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The brief wash behind a message the palette sent you to, a little
 * wider than its row. Drawn first in the row, so a bubble, positioned
 * itself, paints over it and keeps its own colours. */
function LandMark({ on }: { on: boolean }) {
  return (
    <AnimatePresence>
      {on && (
        <motion.span
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.15, ease: "easeOut" } }}
          exit={{ opacity: 0, transition: { duration: 0.28, ease: "easeOut" } }}
          className="pointer-events-none absolute -inset-x-2 -inset-y-1 rounded-xl bg-warning/12"
        />
      )}
    </AnimatePresence>
  );
}

export function ChatView({ bot }: { bot: Bot }) {
  // people by the name a conversation calls them, told apart where two
  // share a first name (src/lib/names.ts)
  const nameOf = useNamer();
  const personName = (id: string) => nameOf(id, "A former member");
  // On a desktop the conversation's tabs sit up in the title bar, in the
  // row with the window's own buttons; on a phone they stay under the header
  const titleSlot = useTitlebarSlot();
  const inTitleBar = (tabs: React.ReactNode) => (titleSlot ? createPortal(tabs, titleSlot) : tabs);
  const { state, dispatch } = useStore();
  // Only a frame that arrived during this turn is live. The one held from
  // the last turn is already in the transcript, and showing it again as
  // live would be a picture of the past with a click handler on it.
  const frame = state.screens[bot.id];
  const frameAtTurnStart = useMemo(() => state.screens[bot.id], [bot.busy, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveBrowser =
    bot.busy && frame?.source === "browser" && frame !== frameAtTurnStart ? frame : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // The conversation, and what waits to join it above the composer.
  const { said, waiting } = useMemo(() => splitWaiting(bot.messages), [bot.messages]);
  const arrivals = useArrivals(bot.id, said);

  // More than two in this conversation (src/lib/participants.ts): a team
  // agent's shared one with somebody else on its list or speaking, or
  // anyone writing in from Telegram. Then every message is a bubble, and
  // "Seen by" says who has read how far. A chat with one agent stays as
  // it always was.
  const roster = useWorkspaceRoster();
  const groupLane = bot.tasks?.find((t) => t.id === (bot.activeTaskId ?? bot.threadId));
  const participants = useMemo(() => {
    const humans = groupLane?.team ? teamHumans(bot.access, roster.members) : new Set<string>(["owner"]);
    for (const id of speakers(said)) humans.add(id);
    return { humans, agents: new Set([bot.id]) };
  }, [groupLane?.team, bot.access, bot.id, roster.members, said]);
  const group = isGroup(participants);
  const withPeople = group && otherHumans(participants, "owner") > 0;
  const reads = useReads(withPeople ? bot.threadId : null);
  useEffect(() => {
    if (!withPeople) return;
    api(`/api/threads/${bot.threadId}/reads`)
      .then((r: { reads?: unknown }) => seedReads(bot.threadId, r.reads))
      .catch(() => {});
  }, [withPeople, bot.threadId]);
  useReadPosition({
    threadId: withPeople ? bot.threadId : null,
    scroller: scrollRef,
    enabled: withPeople,
    post: (threadId, messageId) => api(`/api/threads/${threadId}/read`, { method: "POST", body: JSON.stringify({ messageId }) }),
    tick: said.length,
  });
  // which rows are bubbles, where each sits in its sender's run, and
  // under which one each other person's place is shown
  const isBubble = (m: Message) =>
    !m.deleted && !m.quiet && !m.takeBack && !(m.agent && m.agent.dir !== "reply" && (m.kind === "text" || m.kind === "activity")) && (m.kind === "text" || m.kind === "component");
  const groupRuns = useMemo(() => (group ? runs(said, isBubble, bot.id) : new Map<string, { first: boolean; last: boolean }>()), [group, said, bot.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const receiptRows = useMemo(
    () => (withPeople ? receiptsAt(said.map((m) => m.id), new Set(groupRuns.keys()), reads, "owner", new Map(said.map((m) => [m.id, senderOf(m)]))) : new Map<string, string[]>()),
    [withPeople, said, groupRuns, reads],
  );
  const readerName = (id: string) => (id === "owner" ? (roster.owner ?? "You") : personName(id));
  const receiptsFor = (id: string) => {
    const who = receiptRows.get(id);
    return who?.length ? <SeenBy people={who.map((p) => ({ id: p, name: readerName(p) }))} /> : undefined;
  };
  const faceOf = (m: Message) =>
    m.role === "bot" ? (
      <AgentAvatar bot={bot} size={28} />
    ) : telegramSpeaker(m) ? (
      <PersonAvatar id={telegramSpeaker(m)!.personId} name={telegramSpeaker(m)!.name} />
    ) : (
      <PersonAvatar id={m.author ?? "owner"} name={m.author ? personName(m.author) : (roster.owner ?? "You")} />
    );
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  const [forwarding, setForwarding] = useState<{ message: Message; author: string } | null>(null);
  // A rewind hands your message back to the composer, to send again or
  // change first. The nonce makes the same words land twice in a row.
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  // ↑ in the empty composer opens your last message for editing in its
  // bubble, the same edit as the bubble's own Edit button. The bubble
  // watches the nonce, so every press is heard.
  const [editAsk, setEditAsk] = useState<{ id: string; nonce: number } | null>(null);
  const editLast = () => {
    const mine = lastEditable(bot.messages);
    if (!mine) return false;
    setEditAsk({ id: mine.id, nonce: Date.now() });
    return true;
  };
  // Asked once. The bubble has opened by the time this runs (a child's
  // effects run first), and one drawn again later, after a trip to
  // another agent, must not open itself a second time.
  useEffect(() => {
    if (editAsk) setEditAsk(null);
  }, [editAsk]);
  // Sent again as what it says now, at the end of the conversation like
  // anything said now, and the one that never went is cleared from the
  // strip once the new one is in.
  const sendAgain = (message: Message) => {
    const threadId = bot.threadId;
    api(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: message.text, taskId: threadId }),
    })
      .then(() => api(`/api/threads/${threadId}/messages/${message.id}`, { method: "DELETE" }))
      .catch((e) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  const rewindTo = (threadId: string, messageId: string) => {
    api(`/api/threads/${threadId}/rewind`, { method: "POST", body: JSON.stringify({ messageId }) })
      .then((r) => setPrefill({ text: r.text ?? "", nonce: Date.now() }))
      .catch((e) => dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  };
  // Redo is one call: the server stops the agent, rewinds and sends, so
  // nothing here can leave a rewound conversation with nothing sent. A
  // refusal takes nothing back and is said in the editor. If the rewind
  // went through and the send did not, the words come back to the box,
  // as they do after a rewind.
  const previewRedo = (threadId: string, messageId: string): Promise<RedoPreview> =>
    api(`/api/threads/${threadId}/messages/${messageId}/redo`);
  const redoFrom = (threadId: string, messageId: string, text: string): Promise<string | null> =>
    api(`/api/threads/${threadId}/messages/${messageId}/redo`, { method: "POST", body: JSON.stringify({ text }) })
      .then((r) => {
        if (r.sent === false) {
          setPrefill({ text: r.text ?? text, nonce: Date.now() });
          dispatch({ type: "error", message: r.error ?? "Rewound, but your message wasn't sent." });
        }
        return null;
      })
      .catch((e) => (e instanceof Error ? e.message : String(e)));
  // The terminal. Only whether it is on screen lives here, and where it
  // sits lives with the dock: the shells themselves are on the server and
  // outlive this component, so hiding the panel is closing a window onto
  // them rather than ending them.
  const [terminalOpen, setTerminalOpen] = useState(false);
  // bumped by ⌃⇧` to ask the panel for a new tab as it opens
  const [terminalAskNew, setTerminalAskNew] = useState(0);
  const terminalShown = useRef(terminalOpen);
  terminalShown.current = terminalOpen;

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];

  // A finished turn's work is one line above its result
  // (src/lib/turnFold.ts). These are the ones opened to read the work.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  // ── landing on a message picked in the palette ──
  // The palette opens the conversation (src/lib/chatAsk.ts); this brings
  // the message itself into view and marks it for a moment, so the eye
  // knows which line it was sent to. The landing stays once done, so the
  // rows opened back to reach it stay open while the reader looks around.
  const [landing, setLanding] = useState<{ id: string; nonce: number } | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const landed = useRef<number | null>(null);
  const threadKey = `${bot.id}:${bot.threadId}`;
  const lastThreadKey = useRef(threadKey);
  if (lastThreadKey.current !== threadKey) {
    lastThreadKey.current = threadKey;
    setOpenFolds(new Set());
    // A quote is of a message in the conversation it was picked in, and a
    // rewind's words belong to theirs: neither goes with you to another.
    setReplyTo(null);
    setPrefill(null);
    // a landing is on a message in the conversation it was asked for
    setLanding(null);
    setLit(null);
  }
  // ── find within this conversation ──
  // The palette answers "which thread was that in"; this answers "where
  // in this one", which is a different question and needs the whole
  // thread rather than the rendered tail of it.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hitAt, setHitAt] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  // Opening find again while it is open goes back to its field with the
  // words selected, as a browser's does, rather than doing nothing.
  const openFind = () => {
    setFinding(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };
  const closeFind = () => {
    setFinding(false);
    setQuery("");
  };
  const hits = useMemo(() => findHits(said, query), [said, query]);
  // The last turn folds once it has ended, and not before: this
  // conversation's turn, whatever the agent's other ones are doing.
  const openLane = bot.tasks?.find((t) => t.id === (bot.activeTaskId ?? bot.threadId));
  const running = turnRunning(
    openLane?.state,
    Boolean(bot.busy),
    said,
    Boolean(bot.tasks?.some((t) => t !== openLane && t.state !== "idle")),
  );
  const folded = useMemo(() => foldTurns(said, running, !bot.olderMessages), [said, running, bot.olderMessages]);

  // Approvals stacked up while the user was away. One or two are a
  // conversation; several are a queue, and a queue deserves queue
  // controls rather than a scroll of identical presses. Only approvals:
  // a question waiting beside them is not something "Allow all" answers.
  const pendingApprovals = useMemo(
    () =>
      bot.messages.filter(
        (m) =>
          m.kind === "options" && m.card && isApproval(m.card) && !m.card.answered && !m.card.dismissed,
      ),
    [bot.messages],
  );
  const currentHit = hits.length ? hits[Math.min(hitAt, hits.length - 1)] : -1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      // ⌃` shows and hides the terminal; ⌃⇧` opens it on a new tab. With
      // the panel open, the new tab is the panel's to make.
      const chord = e.defaultPrevented ? null : terminalChord(e, platformOf());
      if (chord === "toggle") {
        e.preventDefault();
        setTerminalOpen((open) => !open);
      } else if (chord === "new" && !terminalShown.current) {
        e.preventDefault();
        setTerminalAskNew((n) => n + 1);
        setTerminalOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const earlier = useHistoryPaging("bot", bot, said, scrollRef, pinned, !finding);
  const start = earlier.start;
  const landAt = landing ? said.findIndex((m) => m.id === landing.id) : -1;
  // A hit above the rendered slice would be invisible and unscrollable,
  // so finding one opens the window far enough back to show it. So does
  // a landing.
  const reach = [currentHit, landAt].filter((i) => i >= 0 && i < start);
  const visibleStart = reach.length ? Math.max(0, Math.min(...reach) - 4) : start;
  const visibleRows = useMemo(() => rowsFrom(folded.rows, visibleStart), [folded, visibleStart]);
  // A hit in folded work would be just as invisible, so its fold opens,
  // and stays open as the reader steps on to the next.
  const hitFold = currentHit >= 0 ? foldHolding(folded.rows, currentHit) : null;
  const hitShown = !hitFold || openFolds.has(hitFold);
  const landFold = landAt >= 0 ? foldHolding(folded.rows, landAt) : null;
  const landShown = !landFold || openFolds.has(landFold);

  // follow the tail only while the reader is actually at the tail
  const { away, toLatest } = useStickToBottom(scrollRef, pinned);
  // What stood at the end the last time the reader was following it.
  // What the agent says after that, while they read further up, is what
  // the way back counts as new.
  const seenThrough = useRef<string | undefined>(undefined);
  if (pinned.current) seenThrough.current = said[said.length - 1]?.id;
  const seenAt = seenThrough.current ? said.findIndex((m) => m.id === seenThrough.current) : -1;
  const freshBelow = !away || seenAt < 0 ? 0 : said.slice(seenAt + 1).filter(isReply).length;

  // What you send is followed to the end, wherever you were reading: the
  // reply you are now waiting for will arrive down there.
  useEffect(() => {
    const last = said[said.length - 1];
    if (last && arrivals.has(last.id) && sentByYou(last) && !pinned.current) toLatest();
  }, [arrivals]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pinned.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [bot.id, said.length, waiting.length, streaming, bot.busy]);

  // When a turn ends its work folds, and the reply stays where it is on
  // screen for a reader who is not at the end. After the effect above:
  // that one adds to where the reader is, and this one then finds the
  // reply already in place.
  useHoldPlace(
    scrollRef,
    pinned,
    threadKey,
    lastFoldKey(folded.rows),
    folded.hold ? `[data-msg-index="${folded.hold.index}"]` : null,
  );

  // Opening a fold leaves its line where it was pressed. At the end of a
  // conversation, following the end would scroll the line away instead.
  const toggleFold = (key: string) => {
    pinned.current = false;
    setOpenFolds((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  useEffect(() => {
    for (const fold of [hitFold, landFold]) {
      if (!fold) continue;
      pinned.current = false;
      setOpenFolds((open) => (open.has(fold) ? open : new Set(open).add(fold)));
    }
  }, [hitFold, landFold]);

  // Walk to a hit: render it, then bring it to the middle of the view.
  useEffect(() => {
    if (currentHit < 0) return;
    pinned.current = false;
    const row = scrollRef.current?.querySelector(`[data-msg-index="${currentHit}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentHit, visibleStart, hitShown]);

  // Land once, when the message is drawn: from far away at once, since a
  // long glide through a conversation you just opened is only waiting,
  // and close by with the same smooth step find takes.
  useEffect(() => {
    if (!landing || landAt < 0 || !landShown || landed.current === landing.nonce) return;
    const el = scrollRef.current;
    const row = el?.querySelector(`[data-msg-index="${landAt}"]`);
    if (!el || !row) return;
    landed.current = landing.nonce;
    pinned.current = false;
    const far = Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top) > el.clientHeight * 2;
    row.scrollIntoView({ block: "center", behavior: far || reducedMotion() ? "auto" : "smooth" });
    setLit(landing.id);
  }, [landing, landAt, visibleStart, landShown]);
  // the mark is a moment, not a state
  useEffect(() => {
    if (!lit) return;
    const t = setTimeout(() => setLit(null), 1600);
    return () => clearTimeout(t);
  }, [lit, landing]);

  // Asks from outside, the palette's above all (src/lib/chatAsk.ts):
  // taken once they are for this agent, and a landing once its
  // conversation is the open one and the message is in hand. One further
  // back than what has arrived is paged in until it is.
  const [askTick, setAskTick] = useState(0);
  useEffect(() => onAsk(() => setAskTick((n) => n + 1)), []);
  useEffect(() => {
    const ask = peekAsk(bot.id);
    if (!ask) return;
    if (ask.kind === "find") {
      takeAsk(ask);
      openFind();
    } else if (ask.kind === "terminal") {
      takeAsk(ask);
      setTerminalOpen(true);
    } else if (ask.threadId === bot.threadId) {
      if (said.some((m) => m.id === ask.messageId)) {
        takeAsk(ask);
        setLanding({ id: ask.messageId, nonce: Date.now() });
      } else if (earlier.remaining > 0 && !earlier.loading) {
        earlier.showEarlier();
      }
    }
  }, [askTick, bot.id, bot.threadId, said, earlier.remaining, earlier.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // A starter from the empty page goes into the message box, never out:
  // the words are there to read, change or finish, and the box has the
  // keyboard with the caret at their end.
  const mainRef = useRef<HTMLElement>(null);
  // How wide the header's buttons are, so the name in the middle can keep
  // the same room on both sides at any width. The buttons come and go
  // (calls, meeting notes), so it is measured rather than guessed.
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsWidth, setActionsWidth] = useState(0);
  useLayoutEffect(() => {
    const el = actionsRef.current;
    if (!el) return;
    const measure = () => setActionsWidth(el.offsetWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // The room each side keeps: the buttons plus the header's own padding and
  // a little air, and never less than the menu button a narrow window puts
  // on the left.
  const headerSide = Math.max(actionsWidth + 24, 72);
  const focusBox = () =>
    requestAnimationFrame(() => {
      // the composer's field is the one drawn over its skill marks
      const box = mainRef.current?.querySelector<HTMLTextAreaElement>("[data-skill-layer] ~ textarea");
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  const startWith = (prompt: string) => {
    setPrefill({ text: prompt, nonce: Date.now() });
    focusBox();
  };

  const terminal = useTerminalDock({
    open: terminalOpen,
    botId: bot.id,
    botName: bot.name,
    askNew: terminalAskNew,
    onClose: () => {
      setTerminalOpen(false);
      // the keyboard goes back where you were typing before
      focusBox();
    },
  });
  useSettingsObservation({
    "terminal.height": { status: "observed", value: terminal.layout.sizes.bottom },
    "terminal.open": { status: "observed", value: terminalOpen },
    "terminal.position": { status: "observed", value: terminal.layout.position },
    "terminal.arrangement": { status: "observed", value: terminal.layout.arrangement },
  });

  // the two-agent exchange opened from one of its rows, if any
  const [exchange, setExchange] = useState<{ peerId: string; messageId: string; text: string } | null>(null);
  const lanesInSidebar = useLanesInSidebar();
  // One conversation is the usual agent (GitHub 237): with nothing to
  // switch to, the strip would only be a "+" inviting a second. New
  // conversation and Clear stay on the agent's row in the sidebar.
  // The conversations as tabs, wherever the sidebar is not listing them:
  // its conversations switched off, or the sidebar folded away. Even one
  // shows, as a browser shows its one tab, so a new one is always a +
  // away.
  const strip = !lanesInSidebar && (bot.tasks?.length ?? 0) > 0;


  const first = said[0];
  // this conversation, not the agent: another one may be the one working
  const working = openLaneWorking(bot);
  // Nothing said, nothing on its way, and nothing still loading: a new
  // conversation, which shows who is here and a few ways to begin.
  const empty =
    said.length === 0 &&
    waiting.length === 0 &&
    !bot.olderMessages &&
    !state.laneLoads[bot.id] &&
    !streaming &&
    !provisioning &&
    !working &&
    !liveBrowser;

  // One stretch of the conversation as its rows: what stays in the open,
  // or a fold's work once it is opened. A run (a rewind, quiet check-ins,
  // tool calls) is counted within its stretch, since rows with a fold
  // between them are not next to each other on the page.
  const rowsOf = (list: readonly Message[], indexOf: (offset: number) => number) =>
    list.map((m, offset) => {
      const fresh = arrivals.has(m.id);
      const absolute = indexOf(offset);
      if (m.deleted && m.rewound) {
        // a run of one rewind shows once, at its first message
        const before = list[offset - 1];
        if (before?.deleted && before.rewound === m.rewound) return null;
        const run: Message[] = [];
        for (let i = offset; i < list.length; i++) {
          const next = list[i];
          if (!next.deleted || next.rewound !== m.rewound) break;
          run.push(next);
        }
        return <Rewound key={m.id} messages={run} />;
      }
      if (m.deleted) return <TakenBack key={m.id} user={m.role === "user"} />;
      // a run of quiet check-ins shows once, at its first message
      if (m.quiet) {
        const run = quietRunAt(list, offset);
        return run ? <QuietCheckIns key={m.id} messages={run} /> : null;
      }
      // to or from another agent: a compact row, not a bubble that
      // looks like the person's own words
      // A reply the agent wrote in its own chat is never compacted,
      // whoever started the turn (older ones were marked dir "reply").
      if (m.takeBack || (m.agent && m.agent.dir !== "reply" && (m.kind === "text" || m.kind === "activity"))) {
        return (
          <div key={m.id} data-msg-index={absolute} data-message-id={m.id} className="relative">
              <LandMark on={lit === m.id} />
            <AgentExchangeRow
              message={m}
              botId={bot.id}
              fresh={fresh}
              onOpen={(peerId, messageId, text) => setExchange({ peerId, messageId, text })}
            />
          </div>
        );
      }
      switch (m.kind) {
        case "options":
          // marked like any other row, so Find and the approvals bar can
          // reach a card by its message
          return (
            <div key={m.id} data-msg-index={absolute} data-message-id={m.id} className={cn("relative", group && "pl-9")}>
              <LandMark on={lit === m.id} />
              <OptionCard botId={bot.id} message={m} />
            </div>
          );
        case "activity": {
          // a run of tool calls is one line; it starts at the first
          const before = list[offset - 1];
          if (before?.kind === "activity" && !before.deleted && !before.agent && !before.takeBack && !before.quiet) return null;
          const run: Message[] = [];
          for (let i = offset; i < list.length; i++) {
            const next = list[i];
            if (next.kind !== "activity" || next.deleted || next.agent || next.takeBack || next.quiet) break;
            run.push(next);
          }
          return <ToolRun key={m.id} messages={run} fresh={fresh} className={group ? "pl-9" : undefined} />;
        }
        case "notice":
          return <Notice key={m.id} message={m} fresh={fresh} />;
        case "screen":
          return m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
        case "artifact":
          return m.artifact ? (
            <div key={m.id} className={cn("flex", fresh && "animate-receive-in")}>
              <ArtifactCard botId={bot.id} artifact={m.artifact} />
            </div>
          ) : null;
        case "component":
          if (m.component && group) {
            // an answer drawn as interface keeps the whole bubble's width
            const place = groupRuns.get(m.id) ?? { first: true, last: true };
            return (
              <GroupMessage
                key={m.id}
                mine={false}
                first={place.first}
                last={place.last}
                face={faceOf(m)}
                name={bot.name}
                at={m.at}
                rich
                readId={m.id}
                className={cn(fresh && "animate-receive-in", !place.first && "-mt-2")}
                bubble={<MessageComponent message={m} threadId={bot.threadId} />}
                receipts={receiptsFor(m.id)}
              />
            );
          }
          return m.component ? (
            <div key={m.id} className={cn("flex", fresh && "animate-receive-in")}>
              <MessageComponent message={m} threadId={bot.threadId} />
            </div>
          ) : null;
        case "connector":
          return <ConnectorCard key={m.id} botId={bot.id} message={m} />;
        case "secret":
          return <SecretCard key={m.id} botId={bot.id} message={m} />;
        case "changes":
          return <ChangesCard key={m.id} message={m} fresh={fresh} />;
        default: {
          // context for a reply in a turn another agent started: what
          // prompted it, a click from the exchange, and nothing more.
          // Once its turn has folded, the line above it says who asked.
          const after = folded.named.has(m.id) ? undefined : (m.afterAgent ?? (m.agent?.dir === "reply" ? m.agent : undefined));
          // a run from one sender sits close together
          const continued = group && groupRuns.get(m.id)?.first === false && !after;
          return (
            <div key={m.id} data-msg-index={absolute} data-message-id={m.id} className={cn("relative", continued && "-mt-2")}>
              <LandMark on={lit === m.id} />
            {/* in a group the bubble names its sender; with one agent, a
                line over the words says whose they are */}
            {!group && (m.telegramPerson || m.telegramGroup) && <div className="mb-1 text-small text-muted-foreground">Message from {telegramSpeaker(m)!.name} (Telegram)</div>}
            {!group && m.telegramDelegate && <div className="mb-1 text-small text-muted-foreground">Message from {m.telegramDelegate.name} (Telegram, full access)</div>}
            {!group && m.role === "user" && m.author && <div className="mb-1 text-small font-medium text-muted-foreground">{personName(m.author)}</div>}
            {m.telegramSent && <div className="mb-1 text-small text-muted-foreground">To {m.telegramSent.name} (Telegram): {m.telegramSent.state === "sent" ? "sent" : m.telegramSent.state === "sending" ? "sending" : m.telegramSent.state === "failed" ? "failed" : "delivery uncertain"}</div>}
            {after && (
              <AfterAgentLink
                peerId={after.peerId}
                peerName={after.peerName}
                onOpen={() => setExchange({ peerId: after.peerId, messageId: m.id, text: m.text ?? "" })}
              />
            )}
            <Bubble
              message={m}
              // a folded check-in below says no time of its own
              hideTime={list[offset + 1]?.quiet ? false : timeSaidBelow(m, list[offset + 1])}
              fresh={fresh}
              author={telegramSpeaker(m)?.name ?? (m.role === "user" ? (m.author ? personName(m.author) : "You") : bot.name)}
              onReply={setReplyTo}
              onForward={(message, author) => setForwarding({ message, author })}
              onReact={(messageId, emoji) => reactTo(bot.threadId, messageId, emoji)}
              onEdit={(messageId, next) => editMessage(bot.threadId, messageId, next)}
              onDelete={(messageId) => deleteMessage(bot.threadId, messageId)}
              onRewind={(messageId) => rewindTo(bot.threadId, messageId)}
              previewRedo={(messageId) => previewRedo(bot.threadId, messageId)}
              onRedo={(messageId, next) => redoFrom(bot.threadId, messageId, next)}
              redoTick={`${bot.messages.length}:${working}`}
              agentName={bot.name}
              highlight={finding ? query : ""}
              isHit={absolute === currentHit}
              editNow={editAsk?.id === m.id ? editAsk.nonce : undefined}
              nameOf={(id) => (id === "user" ? "You" : (state.bots.find((b) => b.id === id)?.name ?? bot.name))}
              group={
                group
                  ? {
                      mine: m.role === "user" && !m.author && !telegramSpeaker(m),
                      ...(groupRuns.get(m.id) ?? { first: true, last: true }),
                      face: faceOf(m),
                      receipts: receiptsFor(m.id),
                      readId: m.id,
                    }
                  : undefined
              }
            />
            </div>
          );
        }
      }
    });

  return (
    <main ref={mainRef} className="@container/chat relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Header. Who you are talking to sits in the middle at every width,
          with the same room kept on both sides, so a narrow window does not
          push the name against the menu button and leave the right empty.
          A long name truncates before it reaches either side. */}
      <div className="titlebar-drag relative flex h-[52px] shrink-0 items-center justify-between gap-2 px-3 max-md:pl-16 md:px-4">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="absolute left-1/2 flex min-w-0 -translate-x-1/2 items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors duration-150 hover:bg-accent"
          style={{ maxWidth: `calc(100% - ${headerSide * 2}px)` }}
          title="Agent settings"
        >
          <AgentAvatar bot={bot} size={28} />
          <span className="flex min-w-0 items-baseline gap-2 text-left">
            <span className="truncate text-ui font-semibold text-foreground">{bot.name}</span>
            {(working || bot.title) && (
              <span className="hidden truncate text-small text-muted-foreground sm:block">
                {working ? <WorkingClock threadKey={threadKey} working={working} messages={said} /> : bot.title}
              </span>
            )}
          </span>
        </button>
        <div ref={actionsRef} className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* the model is picked where you type, in the composer's footer */}
          <CallButton bot={bot} />
          {/* meeting notes listen through the Mac's own microphone, so a
              window onto a hosted workspace does not offer them */}
          {window.bloks?.meetingStart && !state.config?.hosted?.on && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => dispatch({ type: "openMeeting", botId: bot.id })}
              title="Take meeting notes"
              aria-label="Meeting notes"
            >
              <AudioLines size={17} />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTerminalOpen((open) => !open)}
            className={cn(terminalOpen && "bg-accent text-foreground")}
            title={`Terminal in ${bot.name}'s folder  ${keysFor("terminalToggle", platformOf())[0]}`}
            aria-label="Terminal"
            aria-pressed={terminalOpen}
          >
            <SquareTerminal size={17} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(state.computerOpen && "bg-accent text-foreground")}
            title="Agent computer"
          >
            <Monitor size={17} />
          </Button>
        </div>
      </div>

      {/* A hairline under the header, faint and fading out at both ends,
          so the header and what follows read as one surface. */}
      <div aria-hidden className="h-px shrink-0 bg-linear-to-r from-transparent via-border to-transparent" />

      {/* Messages. The strip repeats what the sidebar lists when it lists
          conversations, so it only shows when the sidebar does not, and
          only once there is more than one to choose between. */}
      {strip && inTitleBar(<TaskStrip
        inTitleBar={!!titleSlot}
        tasks={bot.tasks ?? []}
        activeId={bot.activeTaskId ?? bot.threadId}
        onSelect={(taskId) => taskId !== bot.activeTaskId && dispatch({ type: "selectTask", botId: bot.id, taskId })}
        onNew={() => dispatch({ type: "newTask", botId: bot.id })}
        onClose={(taskId) => {
          // Closing deletes the transcript, and on a phone the X sits right
          // where a thumb lands, so a lane with anything in it asks first,
          // in the words the sidebar's Close uses. An empty one just goes.
          const lane = bot.tasks?.find((t) => t.id === taskId);
          const open = taskId === (bot.activeTaskId ?? bot.threadId);
          const said = laneHasMessages(lane) || (open && bot.messages.length > 0);
          if (!said) return dispatch({ type: "closeTask", botId: bot.id, taskId });
          void confirm({
            title: `Close "${lane?.title ?? "this conversation"}"?`,
            body: "Its messages are deleted.",
            confirmLabel: "Close",
            destructive: true,
          }).then((yes) => yes && dispatch({ type: "closeTask", botId: bot.id, taskId }));
        }}
        onClear={(taskId) => {
          void confirm({
            title: "Clear this conversation?",
            body: "Its messages are deleted.",
            confirmLabel: "Clear",
            destructive: true,
          }).then((yes) => yes && dispatch({ type: "clearTask", botId: bot.id, taskId }));
        }}
        onRename={(taskId, title) => dispatch({ type: "renameTask", botId: bot.id, taskId, title })}
      />)}
      {finding && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-background/95 px-4 py-2 md:px-6">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={findRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHitAt(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // the keyboard goes back to the message box it came from
                e.preventDefault();
                closeFind();
                focusBox();
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                setHitAt((at) => stepHit(at, hits.length, e.shiftKey ? -1 : 1));
              }
            }}
            placeholder="Find in this conversation"
            aria-label="Find in this conversation"
            className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span aria-live="polite" className="shrink-0 text-small tabular-nums text-muted-foreground">
            {query.trim().length < 2
              ? ""
              : hits.length === 0
                ? "No matches"
                : `${Math.min(hitAt, hits.length - 1) + 1} of ${hits.length}`}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => setHitAt((at) => stepHit(at, hits.length, -1))}
              disabled={hits.length === 0}
              aria-label="Previous match"
              title={`Previous match  ${keysFor("findStep", platformOf())[1]}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronUp size={15} />
            </button>
            <button
              onClick={() => setHitAt((at) => stepHit(at, hits.length, 1))}
              disabled={hits.length === 0}
              aria-label="Next match"
              title={`Next match  ${keysFor("findStep", platformOf())[0]}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown size={15} />
            </button>
            <button
              onClick={closeFind}
              aria-label="Close find"
              title={`Close  ${keysFor("close", platformOf())[0]}`}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      {/* The conversation and the terminal, which can sit on any side of
          it (terminal/TerminalDock.tsx). */}
      <div ref={terminal.body} className="flex min-h-0 min-w-0 flex-1">
      {terminal.slot("left")}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {terminal.slot("top")}
      {/* The transcript, and the way back to its end floating over it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={earlier.onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6 [overflow-anchor:none]"
      >
        {/* Full height only when empty, to centre the welcome: paging
            measures this column to tell a short history from a full one. */}
        <div className={cn("mx-auto flex max-w-[var(--transcript-width,760px)] flex-col gap-2.5 pb-4 pt-2", empty && "min-h-full")}>
          {empty ? (
            <EmptyState key={threadKey} bot={bot} onStart={startWith} />
          ) : start > 0 || earlier.remaining > 0 ? (
            <button
              onClick={earlier.showEarlier}
              disabled={earlier.loading}
              className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-small text-muted-foreground transition-colors duration-150 hover:border-foreground/25 hover:text-foreground disabled:opacity-60"
            >
              {earlier.loading && <Loader2 size={12} className="animate-spin" />}
              Show earlier messages ({start + earlier.remaining} more)
            </button>
          ) : (
            first && (
              <div className="py-3 text-center text-small text-muted-foreground">
                {dayLine(first.at)}
              </div>
            )
          )}
          {/* a click in an answer drawn as interface goes back to this
              agent, in the conversation on screen (genui/host.tsx) */}
          <GenUiHost target={{ kind: "chat", botId: bot.id }}>
            {visibleRows.flatMap((row) =>
              row.kind === "said"
                ? rowsOf(
                    row.items.map((item) => item.message),
                    (offset) => row.items[offset].index,
                  )
                : [
                    <TurnFoldLine
                      key={`fold:${row.fold.key}`}
                      fold={row.fold}
                      open={openFolds.has(row.fold.key)}
                      onToggle={() => toggleFold(row.fold.key)}
                      onOpenExchange={(asker) =>
                        setExchange({ peerId: asker.peerId, messageId: asker.message.id, text: asker.message.text ?? "" })
                      }
                    >
                      {openFolds.has(row.fold.key) && rowsOf(row.fold.messages, (offset) => row.fold.indices[offset])}
                    </TurnFoldLine>,
                  ],
            )}
            {liveBrowser && <LiveBrowser botId={bot.id} frame={liveBrowser} />}
            {streaming &&
              (group ? (
                <GroupMessage
                  mine={false}
                  first={said[said.length - 1]?.role !== "bot" || !isBubble(said[said.length - 1])}
                  last={false}
                  face={<AgentAvatar bot={bot} size={28} />}
                  name={bot.name}
                  at={Date.now()}
                  rich={streaming.length > 400}
                  bubble={
                    <div className="streaming-text">
                      <Markdownish text={streaming} streaming />
                    </div>
                  }
                />
              ) : (
                <StreamingBubble text={streaming} />
              ))}
          </GenUiHost>
          {/* sent while your hosted workspace wakes, faded until it goes */}
          <HeldSends conversation={`${bot.id}:${bot.activeTaskId ?? bot.threadId}`} said={said} queued={waiting} group={group} />
          <WorkingLine
            threadKey={threadKey}
            working={working}
            streaming={streaming}
            messages={said}
            provisioning={provisioning}
            speed={openLane?.codexDispatch}
            onStop={() => dispatch({ type: "interrupt", botId: bot.id })}
          />
        </div>
      </div>
      <JumpToLatest show={away && !empty} fresh={freshBelow} onJump={toLatest} />
      </div>

      {terminal.slot("bottom")}
      <GoalDialog />
      {/* approvals, other conversations, the engine, what waits, guest
          mail and the goal all speak through the composer's one tray */}
      <Composer
        key={`${bot.id}:${bot.activeTaskId ?? bot.threadId}`}
        bot={bot}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        prefill={prefill}
        onEditLast={editLast}
        approvals={pendingApprovals}
        waiting={waiting}
        editAsk={editAsk}
        onSendAgain={sendAgain}
      />
      </div>
      {terminal.slot("right")}
      </div>
      {terminal.overlay}
      {terminal.panel}
      {exchange && (
        <AgentExchangeDialog
          botId={bot.id}
          peerId={exchange.peerId}
          focusId={exchange.messageId}
          focusText={exchange.text}
          onClose={() => setExchange(null)}
        />
      )}
      {state.meetingFor === bot.id && <MeetingPanel bot={bot} />}
      {forwarding && (
        <ForwardDialog
          message={forwarding.message}
          author={forwarding.author}
          onClose={() => setForwarding(null)}
        />
      )}
    </main>
  );
}
